// Package runner is the user-owned CI runner: claim one immutable job,
// materialize its exact SHA in the runner's persistent per-repository
// workdir — a fresh snapshot checkout for the first job in a slot, then warm
// delta syncs that fetch only the paths changed since the recorded commit
// — execute the repository command under the execution-trust policy (on
// the host or in an isolated container) with a timeout, and report through
// the fenced claim generation. Idle claim polls back off adaptively (2 s
// doubling to a 10 s cap), and a failed claim retries with a ramp doubling
// to 60 s (the platform's Retry-After when it sends one): the runner is a
// long-lived daemon and no claim failure is made better by dying.
package runner

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"math"
	mrand "math/rand"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"kvarm/cli/internal/checkout"
	"kvarm/cli/internal/errs"
	"kvarm/cli/internal/executor"
	"kvarm/cli/internal/httpx"
	"kvarm/cli/internal/opcli"
	"kvarm/cli/internal/repo"
	"kvarm/cli/internal/ui"
	"kvarm/cli/internal/workdir"
)

// Summary budget: the platform's server limit minus a safety margin for the
// JSON envelope the summary travels in.
const (
	summaryServerLimit  = 64 * 1024
	summarySafetyMargin = 1024
	summaryLimit        = summaryServerLimit - summarySafetyMargin
)

const (
	idleMinMS       = 2_000
	idleMaxMS       = 10_000
	claimRetryMinMS = 2_000
	claimRetryMaxMS = 60_000
	// Past this many changed paths a whole-tree checkout is cheaper than the delta.
	maxDeltaChanges = 1_000
	// Total decoded file content fetched by one warm delta before falling back.
	maxDeltaReadBytes = 64 * 1024 * 1024
	// The platform's own CI bounds (services/ciConfig.ts).
	jobTimeoutMaxSeconds     = 3_600
	jobTimeoutDefaultSeconds = 900
	// How long a failed container-runtime probe is remembered.
	runtimeRetryMS = 60_000
)

// RefusalHint is the advice a refused job's summary carries.
const RefusalHint = "A runner with a container runtime (docker or podman) and --executor auto or container can run it isolated; a runner started with --trust all runs it on the host."

// Options is one runner invocation.
type Options struct {
	BaseURL string
	PAT     string
	Repo    string

	Once            bool
	DrainUntilEmpty bool
	Fresh           bool
	WorkRoot        string

	Trust     executor.TrustMode
	Executor  executor.ExecutorMode
	Container executor.ContainerConfig

	// HostWarning: nil (the default) warns on every host job under
	// --trust all; explicit false silences it, for hosts that are themselves
	// throwaway sandboxes.
	HostWarning *bool

	Stdout *ui.Output
	Stderr *ui.Output
	Client *httpx.Client

	// TempRoot backs the temporary workdir fallback (tests).
	TempRoot string
	// CheckoutFn overrides the snapshot flow (tests).
	CheckoutFn func(ctx context.Context, o checkout.Options) (checkout.Result, error)
}

// Result is what one runner run did.
type Result struct {
	Claimed  int
	Reported int
}

// apiError is an API refusal with the status and Retry-After that produced
// it; plain errors say the reply was not an API answer at all. The claim
// loop reads both to decide what is worth retrying.
type apiError struct {
	message    string
	status     int
	retryAfter string
}

func (e *apiError) Error() string { return e.message }

// claimedJob is the job the claim returned, with every field the runner
// dereferences validated: id, sha and command must be strings, generation a
// positive integer, and an out-of-range timeoutSeconds falls back to the
// platform's own default. Anything else is retried, never a crash.
type claimedJob struct {
	ID             string
	Name           string
	SHA            string
	Command        string
	Generation     int64
	TimeoutSeconds int64
	Provenance     map[string]any
}

var (
	jobIDRe    = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	sha40Re    = regexp.MustCompile(`^[0-9a-f]{40}$`)
	repoSlugRe = regexp.MustCompile(`^[^/\s]+/[^/\s]+$`)
)

func parseClaim(body any) (*claimedJob, error) {
	obj, ok := body.(map[string]any)
	if !ok {
		return nil, errs.NewFailure("claim returned an invalid job")
	}
	job, ok := obj["job"].(map[string]any)
	if !ok {
		return nil, errs.NewFailure("claim returned an invalid job")
	}
	id, _ := job["id"].(string)
	sha, _ := job["sha"].(string)
	command, commandOK := job["command"].(string)
	if !jobIDRe.MatchString(id) || !sha40Re.MatchString(sha) || !commandOK {
		return nil, errs.NewFailure("claim returned an invalid job")
	}
	generation, genOK := numberField(job["generation"])
	if !genOK || generation < 1 || generation != float64(int64(generation)) {
		return nil, errs.NewFailure("claim returned an invalid job")
	}
	timeoutSeconds := int64(jobTimeoutDefaultSeconds)
	if timeout, ok := numberField(job["timeoutSeconds"]); ok && timeout >= 1 && timeout <= jobTimeoutMaxSeconds && timeout == float64(int64(timeout)) {
		timeoutSeconds = int64(timeout)
	}
	name, nameOK := job["name"].(string)
	if !nameOK {
		name = id
	}
	provenance, _ := job["provenance"].(map[string]any)
	return &claimedJob{
		ID: id, Name: name, SHA: sha, Command: command,
		Generation: int64(generation), TimeoutSeconds: timeoutSeconds,
		Provenance: provenance,
	}, nil
}

// numberField reads a JSON number field whatever decoder produced it.
func numberField(v any) (float64, bool) {
	switch n := v.(type) {
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case float64:
		return n, true
	default:
		return 0, false
	}
}

// IdleDelayMS is the wait before the next claim after consecutive idle
// polls: doubling from 2 s to a 10 s cap, reset as soon as a job is claimed.
func IdleDelayMS(consecutive int) int64 {
	d := int64(idleMinMS) << uint(max0(consecutive))
	if d > idleMaxMS {
		return idleMaxMS
	}
	return d
}

// ClaimRetryMS is the wait before the next claim after fails retryable
// failures: the response's Retry-After when the platform sent a usable one,
// otherwise a delay doubling from 2 s to a 60 s cap.
func ClaimRetryMS(retryAfter string, fails int) int64 {
	if seconds, err := parseSeconds(retryAfter); err == nil && seconds >= 0 {
		d := int64(seconds * 1000)
		if d > claimRetryMaxMS {
			return claimRetryMaxMS
		}
		return d
	}
	shift := fails
	if shift > 40 {
		shift = 40
	}
	d := int64(claimRetryMinMS) << uint(shift)
	if d > claimRetryMaxMS {
		return claimRetryMaxMS
	}
	return d
}

func parseSeconds(s string) (float64, error) {
	// Strict like the JS Number(retryAfter): "3s" is not a number there and
	// falls to the ramp, so it must here too, never a wrong wait.
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, fmt.Errorf("not a number")
	}
	return v, nil
}

// jittered halves the wait: [50%, 100%) of the ramp delay, so a fleet of
// runners does not retry in lockstep.
func jittered(ms int64) int64 {
	return int64(float64(ms) * (0.5 + mrand.Float64()/2))
}

func max0(n int) int {
	if n < 0 {
		return 0
	}
	return n
}

type runner struct {
	baseURL  string
	pat      string
	reposURL string
	client   *httpx.Client
	stdout   *ui.Output
	stderr   *ui.Output
}

// post sends one runner API POST and reads its reply. 204 means "nothing".
func (r *runner) post(ctx context.Context, path string, body map[string]any) (int, any, error) {
	target := r.baseURL + r.reposURL + "/" + path
	payload, err := json.Marshal(body)
	if err != nil {
		return 0, nil, err
	}
	res, err := r.client.DoText(ctx, "POST", target, map[string]string{
		"authorization": "Bearer " + r.pat,
		"content-type":  "application/json",
	}, payload, httpx.MaxResponseBytes)
	if err != nil {
		return 0, nil, err
	}
	if res.Status == 204 {
		return 204, nil, nil
	}
	var parsed any
	if jsonErr := json.Unmarshal([]byte(res.Text), &parsed); jsonErr != nil {
		parsed = map[string]any{}
	}
	if !res.OK() {
		return res.Status, parsed, apiErrorFor(path, res.Status, parsed, res.RetryAfter())
	}
	return res.Status, parsed, nil
}

// getJSON sends one runner API GET and requires a JSON object reply.
func (r *runner) getJSON(ctx context.Context, path string) (map[string]any, error) {
	target := r.baseURL + r.reposURL + "/" + path
	res, err := r.client.DoText(ctx, "GET", target, map[string]string{
		"authorization": "Bearer " + r.pat,
		"accept":        "application/json",
	}, nil, httpx.MaxResponseBytes)
	if err != nil {
		return nil, err
	}
	var parsed any
	if res.Text != "" {
		if v, parseErr := jsonDecodeUseNumber(res.Text); parseErr == nil {
			parsed = v
		}
	}
	name := strings.SplitN(path, "?", 2)[0]
	obj, isObject := parsed.(map[string]any)
	if !res.OK() || !isObject {
		return nil, apiErrorFor(name, res.Status, parsed, res.RetryAfter())
	}
	return obj, nil
}

func apiErrorFor(path string, status int, body any, retryAfter string) *apiError {
	detail := fmt.Sprintf("HTTP %d", status)
	code := ""
	if obj, ok := body.(map[string]any); ok {
		if e, _ := obj["error"].(string); e != "" {
			detail = e
		}
		if c, _ := obj["code"].(string); c != "" {
			code = " (" + c + ")"
		}
	}
	return &apiError{message: path + ": " + detail + code, status: status, retryAfter: retryAfter}
}

func jsonDecodeUseNumber(text string) (any, error) {
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

// Run runs the claim loop until --once, --drain or an error stops it.
func Run(ctx context.Context, o Options) (Result, error) {
	if !repoSlugRe.MatchString(o.Repo) {
		return Result{}, errs.NewUsage("expected --repo <owner/repo>")
	}
	reposURL, err := repoAPIPath(o.Repo)
	if err != nil {
		return Result{}, err
	}
	r := &runner{
		baseURL:  strings.TrimRight(o.BaseURL, "/"),
		pat:      o.PAT,
		reposURL: reposURL,
		client:   o.Client,
		stdout:   o.Stdout,
		stderr:   o.Stderr,
	}
	runnerID := "kvarm-runner-" + uuidV4()
	tempRoot := o.TempRoot
	if tempRoot == "" {
		tempRoot = os.TempDir()
	}
	trust := o.Trust
	if trust == "" {
		trust = executor.TrustHumans
	}
	executorMode := o.Executor
	if executorMode == "" {
		executorMode = executor.ExecutorAuto
	}
	if !containsString(executor.TrustModes, string(trust)) {
		return Result{}, errs.NewUsage("--trust must be one of %s", strings.Join(executor.TrustModes, ", "))
	}
	if !containsString(executor.ExecutorModes, string(executorMode)) {
		return Result{}, errs.NewUsage("--executor must be one of %s", strings.Join(executor.ExecutorModes, ", "))
	}
	if o.Container.Runtime != "" && !containsString(executor.ContainerRuntimes, string(o.Container.Runtime)) {
		return Result{}, errs.NewUsage("--container-runtime must be one of %s", strings.Join(executor.ContainerRuntimes, ", "))
	}
	if err := executor.ValidateContainerConfig(o.Container); err != nil {
		return Result{}, err
	}
	hostWarning := o.HostWarning == nil || *o.HostWarning

	// Container jobs get their own workdir root: an isolated job must not be
	// able to plant files (node_modules/.bin, hooks) that a later host job
	// executes.
	containerWorkRoot := o.WorkRoot + "-container"

	// A runtime that answered stays known; a missing one is asked again
	// after a while, so a long-running runner notices a daemon that starts
	// later.
	var probeMu sync.Mutex
	var probe *executor.RuntimeProbe
	probedAt := time.Time{}
	runtimeFn := func() *executor.RuntimeProbe {
		probeMu.Lock()
		defer probeMu.Unlock()
		if probe != nil && time.Since(probedAt) >= runtimeRetryMS {
			if next := executor.DetectRuntime(ctx, o.Container.Runtime); next != nil {
				probe, probedAt = next, time.Now()
			} else {
				probe = nil
			}
		}
		if probe == nil {
			probe = executor.DetectRuntime(ctx, o.Container.Runtime)
			probedAt = time.Now()
		}
		return probe
	}
	if executorMode == executor.ExecutorContainer {
		if probe := runtimeFn(); probe == nil {
			rt := string(o.Container.Runtime)
			if rt == "" {
				rt = "docker or podman"
			}
			return Result{}, errs.NewUsage("--executor container needs a running %s, and none answered", rt)
		}
	}

	var hostSlot, containerSlot *workdir.Slot
	defer func() {
		if hostSlot != nil {
			hostSlot.Release()
		}
		if containerSlot != nil {
			containerSlot.Release()
		}
	}()
	openSlot := func(root string) *workdir.Slot {
		return workdir.Open(workdir.OpenOptions{
			WorkRoot: root,
			Repo:     o.Repo,
			TempRoot: tempRoot,
			Stderr:   func(line string) { r.stderr.Plain("%s", line) },
		})
	}

	var result Result
	var idle, claimFails int

	// nextClaim claims until one succeeds. A network failure, a 429/5xx or
	// a malformed reply backs off and retries, while bad credentials and
	// any other definite 4xx refusal are actionable and stay fatal:
	// retrying a wrong token or a wrong --repo would only spam.
	nextClaim := func() (*claimedJob, error) {
		for {
			status, body, err := r.post(ctx, "ci/jobs/claim", map[string]any{"runnerId": runnerID})
			if err == nil {
				if status == 204 {
					return nil, nil
				}
				job, parseErr := parseClaim(body)
				if parseErr == nil {
					claimFails = 0
					return job, nil
				}
				err = parseErr
			}
			if api, ok := err.(*apiError); ok && api.status != 429 && api.status < 500 {
				return nil, err
			}
			var retryAfter string
			if api, ok := err.(*apiError); ok {
				retryAfter = api.retryAfter
			}
			wait := ClaimRetryMS(retryAfter, claimFails)
			claimFails++
			sleepMS := wait
			if retryAfter == "" {
				sleepMS = jittered(wait)
			}
			r.stderr.Plain("claim failed: %v; retrying in %.1f s", err, float64(sleepMS)/1000)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(sleepMS) * time.Millisecond):
			}
		}
	}

	for {
		job, err := nextClaim()
		if err != nil {
			return result, err
		}
		if job == nil {
			if o.Once || o.DrainUntilEmpty {
				return result, nil
			}
			select {
			case <-ctx.Done():
				return result, ctx.Err()
			case <-time.After(time.Duration(IdleDelayMS(idle)) * time.Millisecond):
			}
			idle++
			continue
		}
		idle = 0
		claimedAt := time.Now()
		result.Claimed++
		r.stdout.Plain("claimed %s (%s) at %s", job.Name, job.ID, job.SHA)

		reportBody := r.runJob(ctx, o, job, runnerID, trust, executorMode, hostWarning, runtimeFn,
			func(isolated bool) *workdir.Slot {
				if isolated {
					if containerSlot == nil {
						containerSlot = openSlot(containerWorkRoot)
					}
					return containerSlot
				}
				if hostSlot == nil {
					hostSlot = openSlot(o.WorkRoot)
				}
				return hostSlot
			})

		// Report with three attempts: the work already ran, so nothing can
		// improve this job's outcome; a fenced report means the platform
		// requeues the job when the lease expires.
		var reportErr error
		for attempt := 0; attempt < 3; attempt++ {
			_, _, reportErr = r.post(ctx, fmt.Sprintf("ci/jobs/%s/report", job.ID), reportBody)
			if reportErr == nil {
				break
			}
			if attempt < 2 {
				select {
				case <-ctx.Done():
				case <-time.After(time.Duration(250*(1<<attempt)) * time.Millisecond):
				}
			}
		}
		if reportErr != nil {
			r.stderr.Plain("warning: could not report %s (%s) after 3 attempts: %v; the platform requeues the job when the lease expires", job.Name, job.ID, reportErr)
		} else {
			result.Reported++
			conclusion, _ := reportBody["conclusion"].(string)
			r.stdout.Plain("reported %s for %s (%s) in %d ms", conclusion, job.Name, job.ID, time.Since(claimedAt).Milliseconds())
		}
		if o.Once {
			return result, nil
		}
	}
}

// runJob takes one claimed job from plan to report body: decide the executor
// (refusing before any byte of the job's code reaches this machine),
// materialize the workspace, run the command, and build the bounded summary.
// A refusal or any failure is reported as a failure summary, never skipped.
func (r *runner) runJob(
	ctx context.Context,
	o Options,
	job *claimedJob,
	runnerID string,
	trust executor.TrustMode,
	executorMode executor.ExecutorMode,
	hostWarning bool,
	runtimeFn func() *executor.RuntimeProbe,
	slotFor func(isolated bool) *workdir.Slot,
) map[string]any {
	plan, planErr := executor.PlanExecution(trust, executorMode, job.Provenance, runtimeFn)
	if planErr != nil {
		return r.reportBody(job, runnerID, "failure", summaryMap(map[string]any{
			"command":    job.Command,
			"exitCode":   nil,
			"timedOut":   false,
			"durationMs": 0,
			"stdout":     "",
			"stderr":     executor.Bounded(planErr.Error()),
			"sha":        job.SHA,
		}))
	}
	fail := func(err error) map[string]any {
		return r.reportBody(job, runnerID, "failure", summaryMap(map[string]any{
			"command":    job.Command,
			"exitCode":   nil,
			"timedOut":   false,
			"durationMs": 0,
			"stdout":     "",
			"stderr":     executor.Bounded(err.Error()),
			"sha":        job.SHA,
		}))
	}
	if plan.Run == "" {
		// A refusal reports why and never runs the command.
		r.stderr.Plain("refused %s (%s): %s", job.Name, job.ID, plan.Reason)
		return r.reportBody(job, runnerID, "failure", summaryMap(map[string]any{
			"command":    job.Command,
			"exitCode":   nil,
			"timedOut":   false,
			"durationMs": 0,
			"stdout":     "",
			"stderr":     executor.Bounded(fmt.Sprintf("kvarm runner refused to run this job: %s. %s", plan.Reason, RefusalHint)),
			"sha":        job.SHA,
			"refused":    true,
			"trust":      string(trust),
			"executor":   string(executorMode),
		}))
	}

	stop := startHeartbeat(ctx, r, job, runnerID)
	defer stop()

	isolated := plan.Run == "container"
	slot := slotFor(isolated)
	materialized, err := r.materialize(ctx, o, slot, job)
	if err != nil {
		return fail(err)
	}
	r.stdout.Plain("workdir: %s", materialized.WorkdirKind)

	var execResult executor.ExecResult
	if isolated {
		probe := plan.Runtime
		image := o.Container.Image
		if image == "" {
			image = executor.DefaultImage
		}
		rootless := ""
		if probe.Rootless {
			rootless = " rootless"
		}
		r.stdout.Plain("executor: container (%s%s, %s): %s", probe.Runtime, rootless, image, plan.Reason)
		config := o.Container
		config.Runtime = probe.Runtime
		config.Rootless = probe.Rootless
		execResult, err = executor.ExecuteContainer(ctx, job.Command, slot.Work, int(job.TimeoutSeconds), config, executor.ContainerName(job.ID), 0)
	} else {
		if trust == executor.TrustAll && hostWarning {
			r.stderr.Plain("warning: running %s on the host with --trust all; its code has this user's files and network", job.Name)
		} else if trust != executor.TrustAll {
			r.stdout.Plain("executor: host: %s", plan.Reason)
		}
		execResult, err = executor.ExecuteShell(job.Command, slot.Work, int(job.TimeoutSeconds))
	}
	if err != nil {
		return fail(err)
	}
	conclusion := "failure"
	if execResult.Code != nil && *execResult.Code == 0 && !execResult.TimedOut {
		conclusion = "success"
	}
	summary := summaryMap(map[string]any{
		"command":    job.Command,
		"exitCode":   jsonNumberPtr(execResult.Code),
		"timedOut":   execResult.TimedOut,
		"durationMs": execResult.DurationMS,
		"stdout":     execResult.Stdout,
		"stderr":     execResult.Stderr,
		"source":     materialized.Source,
		"sha":        materialized.SHA,
		"executor":   plan.Run,
	})
	if isolated {
		image := o.Container.Image
		if image == "" {
			image = executor.DefaultImage
		}
		summary["image"] = image
	}
	return r.reportBody(job, runnerID, conclusion, summary)
}

// reportBody assembles the fenced report for one job.
func (r *runner) reportBody(job *claimedJob, runnerID, conclusion string, summary map[string]any) map[string]any {
	return map[string]any{
		"runnerId":   runnerID,
		"generation": job.Generation,
		"conclusion": conclusion,
		"summary":    summary,
	}
}

func jsonNumberPtr(code *int) any {
	if code == nil {
		return nil
	}
	return json.Number(fmt.Sprintf("%d", *code))
}

// startHeartbeat renews the 120-second lease while the job runs; a heartbeat
// failure is only logged (a lapsed lease requeues the job).
func startHeartbeat(ctx context.Context, r *runner, job *claimedJob, runnerID string) func() {
	// At least a third of the 120 s lease, and never faster than 10 s.
	every := 120_000 / 3
	if every < 10_000 {
		every = 10_000
	}
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(time.Duration(every) * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				hbCtx, hbCancel := context.WithTimeout(context.Background(), httpx.IdleTimeout)
				_, _, err := r.post(hbCtx, fmt.Sprintf("ci/jobs/%s/heartbeat", job.ID), map[string]any{"runnerId": runnerID, "generation": job.Generation})
				hbCancel()
				if err != nil {
					r.stderr.Plain("heartbeat: %v", err)
				}
			}
		}
	}()
	return func() {
		cancel()
		<-done
	}
}

// materialize fills the slot's work directory with the job's exact SHA.
func (r *runner) materialize(ctx context.Context, o Options, slot *workdir.Slot, job *claimedJob) (workdir.Materialized, error) {
	quiet := ui.New(io.Discard)
	return workdir.Materialize(slot, workdir.MaterializeOptions{
		SHA:   job.SHA,
		Fresh: o.Fresh,
		Stderr: func(line string) {
			r.stderr.Plain("checkout: %s", line)
		},
		Checkout: func(dir string) (workdir.CheckoutOutcome, error) {
			co := o.CheckoutFn
			if co == nil {
				co = checkout.Checkout
			}
			res, err := co(ctx, checkout.Options{
				BaseURL: o.BaseURL,
				PAT:     o.PAT,
				Repo:    o.Repo,
				Ref:     job.SHA,
				Dir:     dir,
				Stdout:  quiet,
				Stderr:  quiet,
				Client:  o.Client,
			})
			if err != nil {
				return workdir.CheckoutOutcome{}, err
			}
			return workdir.CheckoutOutcome{Source: res.Source, SHA: res.SHA, Bytes: int(res.Bytes), Files: int(res.Files), Reason: res.Reason}, nil
		},
		Delta: func(previous workdir.RecordedState, sha string) (workdir.DeltaManifest, error) {
			return r.fetchDelta(ctx, o, previous, sha)
		},
	})
}

// summaryMap fits a summary under the report budget: the command is display
// metadata and is tried first, so an oversized claim can never make the
// report unshrinkable; the outputs follow. A second, forced pass guarantees
// a fit, because the markers alone sit far under the limit.
func summaryMap(fields map[string]any) map[string]any {
	if jsonBytes(fields) <= summaryLimit {
		return fields
	}
	result := copyMap(fields)
	cuts := []struct{ field, marker string }{
		{"command", executor.CommandTruncated},
		{"stdout", executor.Truncated},
		{"stderr", executor.Truncated},
	}
	for _, forced := range []bool{false, true} {
		for _, c := range cuts {
			trimSummaryField(result, c.field, c.marker, forced)
			if jsonBytes(result) <= summaryLimit {
				return result
			}
		}
	}
	return result
}

// trimSummaryField cuts one field as far as necessary while retaining its
// marker. A field whose whole value cannot bring the summary under the limit
// is restored (unless forced): cutting it would only lose content, and a
// later field may be the one whose cut fits.
func trimSummaryField(summary map[string]any, field, marker string, forced bool) {
	original, ok := summary[field].(string)
	if !ok || original == "" {
		return
	}
	points := []rune(original)
	summary[field] = marker
	if jsonBytes(summary) > summaryLimit {
		if !forced {
			summary[field] = original
		}
		return
	}
	low, high := 0, len(points)
	best := ""
	for low <= high {
		middle := (low + high) / 2
		candidate := string(points[:middle]) + marker
		summary[field] = candidate
		if jsonBytes(summary) <= summaryLimit {
			best = candidate
			low = middle + 1
		} else {
			high = middle - 1
		}
	}
	if best != "" {
		summary[field] = best
	} else {
		summary[field] = marker
	}
}

func jsonBytes(v any) int64 {
	data, err := json.Marshal(v)
	if err != nil {
		return math.MaxInt64
	}
	return int64(len(data))
}

func copyMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// repoAPIPath is /api/v1/repos/<owner>/<name> for the runner's repository,
// validated and encoded once.
func repoAPIPath(r string) (string, error) {
	parsed, err := repo.Parse(r)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("/api/v1/repos/%s/%s", opcli.EncodeURIComponent(parsed.Owner), opcli.EncodeURIComponent(parsed.Name)), nil
}

func uuidV4() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "00000000000000000000000000000000"
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func containsString(list []string, s string) bool {
	for _, item := range list {
		if item == s {
			return true
		}
	}
	return false
}
