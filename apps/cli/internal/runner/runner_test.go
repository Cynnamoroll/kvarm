package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"kvarm/cli/internal/checkout"
	"kvarm/cli/internal/errs"
	"kvarm/cli/internal/executor"
	"kvarm/cli/internal/httpx"
	"kvarm/cli/internal/ui"
	"kvarm/cli/internal/workdir"
)

const (
	jobSHA   = "1111111111111111111111111111111111111111"
	otherSHA = "2222222222222222222222222222222222222222"
)

func TestIdleDelayMS(t *testing.T) {
	// Doubling from 2 s to a 10 s cap (the JS idleDelayMs).
	tests := []struct {
		consecutive int
		want        int64
	}{
		{0, 2_000}, {1, 4_000}, {2, 8_000}, {3, 10_000}, {9, 10_000}, {-1, 2_000}, {-100, 2_000},
	}
	for _, tt := range tests {
		if got := IdleDelayMS(tt.consecutive); got != tt.want {
			t.Errorf("IdleDelayMS(%d) = %d, want %d", tt.consecutive, got, tt.want)
		}
	}
}

func TestClaimRetryMS(t *testing.T) {
	// The JS claimRetryMs: a usable Retry-After wins, otherwise the ramp.
	tests := []struct {
		name       string
		retryAfter string
		fails      int
		want       int64
	}{
		{"first failure ramps from 2 s", "", 0, 2_000},
		{"second failure doubles", "", 1, 4_000},
		{"the ramp caps at 60 s", "", 5, 60_000},
		{"a huge failure count stays capped", "", 100, 60_000},
		{"Retry-After seconds win", "3", 4, 3_000},
		{"fractional Retry-After", "1.5", 0, 1_500},
		{"Retry-After zero", "0", 7, 0},
		{"Retry-After caps at 60 s", "120", 0, 60_000},
		{"an unparseable Retry-After falls to the ramp", "later", 0, 2_000},
		{"an HTTP-date falls to the ramp", "Wed, 21 Oct 2015 07:28:00 GMT", 1, 4_000},
		{"a negative Retry-After falls to the ramp", "-1", 0, 2_000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ClaimRetryMS(tt.retryAfter, tt.fails); got != tt.want {
				t.Errorf("ClaimRetryMS(%q, %d) = %d, want %d", tt.retryAfter, tt.fails, got, tt.want)
			}
		})
	}
}

func TestJitteredBounds(t *testing.T) {
	// Half jitter, [50%, 100%) of the ramp delay, as the JS jittered does.
	for _, ms := range []int64{2_000, 10_000, 60_000} {
		for i := 0; i < 200; i++ {
			got := jittered(ms)
			if got < ms/2 || got > ms {
				t.Fatalf("jittered(%d) = %d, want [%d, %d]", ms, got, ms/2, ms)
			}
		}
	}
}

func TestParseClaim(t *testing.T) {
	validJob := func() map[string]any {
		return map[string]any{
			"id": "job-1", "name": "build", "sha": jobSHA, "command": "make test",
			"generation": float64(2), "timeoutSeconds": float64(30),
			"provenance": map[string]any{"authorKind": "human"},
		}
	}
	with := func(field string, value any) any {
		job := validJob()
		if value == nil {
			delete(job, field)
		} else {
			job[field] = value
		}
		return map[string]any{"job": job}
	}

	tests := []struct {
		name     string
		body     any
		wantErr  bool
		wantName string
		timeout  int64
	}{
		{name: "valid", body: with("", nil), wantName: "build", timeout: 30},
		{name: "name defaults to the id", body: with("name", nil), wantName: "job-1", timeout: 30},
		{name: "an empty name is kept", body: with("name", ""), wantName: "", timeout: 30},
		{name: "a non-string name falls back", body: with("name", 7), wantName: "job-1", timeout: 30},
		{name: "timeout is optional", body: with("timeoutSeconds", nil), wantName: "build", timeout: 900},
		{name: "timeout below the floor falls back", body: with("timeoutSeconds", float64(0)), wantName: "build", timeout: 900},
		{name: "timeout above the ceiling falls back", body: with("timeoutSeconds", float64(3601)), wantName: "build", timeout: 900},
		{name: "a fractional timeout falls back", body: with("timeoutSeconds", 1.5), wantName: "build", timeout: 900},
		{name: "the ceiling is allowed", body: with("timeoutSeconds", float64(3600)), wantName: "build", timeout: 3600},
		{name: "the floor is allowed", body: with("timeoutSeconds", float64(1)), wantName: "build", timeout: 1},
		{name: "generation as a literal number", body: map[string]any{"job": map[string]any{
			"id": "job-1", "sha": jobSHA, "command": "make", "generation": json.Number("3"),
		}}, wantName: "job-1", timeout: 900},
		{name: "no body", body: nil, wantErr: true},
		{name: "body is not an object", body: "nope", wantErr: true},
		{name: "no job", body: map[string]any{}, wantErr: true},
		{name: "job is not an object", body: map[string]any{"job": 7}, wantErr: true},
		{name: "bad id", body: with("id", "job/1"), wantErr: true},
		{name: "empty id", body: with("id", ""), wantErr: true},
		{name: "id is not a string", body: with("id", 7), wantErr: true},
		{name: "bad sha", body: with("sha", "abc"), wantErr: true},
		{name: "uppercase sha", body: with("sha", strings.ToUpper("abcdef0123456789abcdef0123456789abcdef01")), wantErr: true},
		{name: "sha is not a string", body: with("sha", 7), wantErr: true},
		{name: "command is not a string", body: with("command", 7), wantErr: true},
		{name: "missing command", body: with("command", nil), wantErr: true},
		{name: "empty command", body: with("command", ""), wantName: "build", timeout: 30},
		{name: "missing generation", body: with("generation", nil), wantErr: true},
		{name: "zero generation", body: with("generation", float64(0)), wantErr: true},
		{name: "negative generation", body: with("generation", float64(-1)), wantErr: true},
		{name: "fractional generation", body: with("generation", 1.5), wantErr: true},
		{name: "generation is not a number", body: with("generation", "2"), wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			job, err := parseClaim(tt.body)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseClaim = %+v, want an error", job)
				}
				if !strings.Contains(err.Error(), "claim returned an invalid job") {
					t.Errorf("error = %q", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseClaim: %v", err)
			}
			if job.Name != tt.wantName || job.TimeoutSeconds != tt.timeout {
				t.Errorf("job = %+v, want name %q timeout %d", job, tt.wantName, tt.timeout)
			}
			if job.ID != "job-1" || job.SHA != jobSHA {
				t.Errorf("job = %+v", job)
			}
		})
	}

	// A job with no provenance at all still parses; the trust policy is what
	// refuses it.
	job, err := parseClaim(map[string]any{"job": map[string]any{
		"id": "job-2", "sha": jobSHA, "command": "true", "generation": float64(1),
	}})
	if err != nil || job.Provenance != nil {
		t.Errorf("parseClaim = %+v, %v", job, err)
	}
}

func TestSummaryMapFitsTheBudget(t *testing.T) {
	huge := strings.Repeat("x", 200_000)
	// The JS boundedSummary: the command first, then the outputs, then a
	// forced second pass.

	t.Run("already small", func(t *testing.T) {
		in := map[string]any{"command": "make", "stdout": "ok\n"}
		got := summaryMap(in)
		if got["command"] != "make" || got["stdout"] != "ok\n" {
			t.Errorf("summary = %v", got)
		}
	})

	t.Run("command first", func(t *testing.T) {
		// The command is display metadata and is tried first, so an oversized
		// claim can never make the report unshrinkable.
		in := map[string]any{"command": huge, "stdout": "ok\n", "stderr": ""}
		got := summaryMap(in)
		if jsonBytes(got) > summaryLimit {
			t.Fatalf("summary = %d bytes, over the %d limit", jsonBytes(got), summaryLimit)
		}
		if !strings.HasSuffix(got["command"].(string), executor.CommandTruncated) {
			t.Errorf("command was not trimmed: %q", got["command"].(string)[:40])
		}
		if got["stdout"] != "ok\n" || got["stderr"] != "" {
			t.Errorf("the outputs were trimmed when the command sufficed: %v", got)
		}
	})

	t.Run("outputs follow", func(t *testing.T) {
		in := map[string]any{"command": "make", "stdout": huge, "stderr": "small"}
		got := summaryMap(in)
		if jsonBytes(got) > summaryLimit {
			t.Fatalf("summary = %d bytes, over the %d limit", jsonBytes(got), summaryLimit)
		}
		if got["command"] != "make" {
			t.Errorf("command = %q, want it untouched", got["command"])
		}
		if got["stderr"] != "small" {
			t.Errorf("stderr = %q, want it untouched", got["stderr"])
		}
		if text, _ := got["stdout"].(string); !strings.HasSuffix(text, executor.Truncated) {
			t.Errorf("stdout was not trimmed: %q", text[:40])
		}
	})

	t.Run("forced pass", func(t *testing.T) {
		// Two oversized fields: no single unforced cut fits, so the second,
		// forced pass must leave the command at its marker.
		in := map[string]any{"command": huge, "stdout": huge, "stderr": ""}
		got := summaryMap(in)
		if jsonBytes(got) > summaryLimit {
			t.Fatalf("summary = %d bytes, over the %d limit", jsonBytes(got), summaryLimit)
		}
		if got["command"] != executor.CommandTruncated {
			t.Errorf("command = %q, want the bare marker from the forced pass", got["command"])
		}
		if text, _ := got["stdout"].(string); !strings.HasSuffix(text, executor.Truncated) {
			t.Errorf("stdout was not trimmed: %q", text[:40])
		}
	})
}

func TestTrimSummaryField(t *testing.T) {
	huge := strings.Repeat("y", 200_000)

	t.Run("unforced restores a field that cannot fit", func(t *testing.T) {
		summary := map[string]any{"command": huge, "stdout": huge}
		trimSummaryField(summary, "stdout", executor.Truncated, false)
		if summary["stdout"] != huge {
			t.Error("an unforced cut that cannot fit must restore the field")
		}
	})

	t.Run("forced keeps the marker", func(t *testing.T) {
		summary := map[string]any{"command": huge, "stdout": huge}
		trimSummaryField(summary, "stdout", executor.Truncated, true)
		if summary["stdout"] != executor.Truncated {
			t.Errorf("stdout = %q, want the bare marker", summary["stdout"])
		}
	})

	t.Run("binary search keeps the longest fit", func(t *testing.T) {
		summary := map[string]any{"command": "make", "stdout": strings.Repeat("z", 100_000)}
		trimSummaryField(summary, "stdout", executor.Truncated, false)
		got, _ := summary["stdout"].(string)
		if !strings.HasSuffix(got, executor.Truncated) {
			t.Fatalf("stdout was not trimmed: %q", got[:40])
		}
		if jsonBytes(summary) > summaryLimit {
			t.Errorf("summary = %d bytes, over the limit", jsonBytes(summary))
		}
		// One more rune must not fit: the search stopped at the boundary.
		body := strings.TrimSuffix(got, executor.Truncated)
		longer := body + "zz" + executor.Truncated
		summary["stdout"] = longer
		if jsonBytes(summary) <= summaryLimit {
			t.Error("the binary search stopped short of the longest fit")
		}
	})

	t.Run("missing and empty fields are left alone", func(t *testing.T) {
		summary := map[string]any{"stdout": ""}
		trimSummaryField(summary, "stdout", executor.Truncated, true)
		trimSummaryField(summary, "stderr", executor.Truncated, true)
		if summary["stdout"] != "" {
			t.Errorf("stdout = %q", summary["stdout"])
		}
		if _, ok := summary["stderr"]; ok {
			t.Error("a missing field was created")
		}
	})
}

func TestJSONNumberPtr(t *testing.T) {
	if got := jsonNumberPtr(nil); got != nil {
		t.Errorf("jsonNumberPtr(nil) = %v", got)
	}
	code := 7
	if got := jsonNumberPtr(&code); got != json.Number("7") {
		t.Errorf("jsonNumberPtr = %v", got)
	}
}

func TestRepoAPIPath(t *testing.T) {
	got, err := repoAPIPath("alice/demo")
	if err != nil || got != "/api/v1/repos/alice/demo" {
		t.Errorf("repoAPIPath = %q, %v", got, err)
	}
	got, err = repoAPIPath("alice/my.repo")
	if err != nil || got != "/api/v1/repos/alice/my.repo" {
		t.Errorf("repoAPIPath = %q, %v", got, err)
	}
	for _, bad := range []string{"alice", "alice/", "/demo", "alice/../x", "alice/%2e%2e", "alice/we ird"} {
		if _, err := repoAPIPath(bad); err == nil {
			t.Errorf("repoAPIPath(%q) accepted an invalid repository", bad)
		}
	}
}

// recordedCall is one request the fake platform saw.
type recordedCall struct {
	method string
	path   string
	query  string
	body   map[string]any
}

// claimReply is one canned claim answer.
type claimReply struct {
	status     int
	body       string
	retryAfter string
}

// fakePlatform is an in-process stand-in for the runner API and the compare,
// tree and contents endpoints a warm delta reads.
type fakePlatform struct {
	mu sync.Mutex
	t  *testing.T

	calls   []recordedCall
	claims  int
	reports []map[string]any
	beats   int

	claimReplies []claimReply
	// claimFallbackStatus answers every claim past claimReplies; 0 means 204.
	claimFallbackStatus int
	reportStatus        int

	compare  func(cursor string) (int, string)
	tree     func(ref, path string) (int, string)
	contents func(path, ref string) (int, string)
}

func (p *fakePlatform) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body := map[string]any{}
	if data, err := io.ReadAll(r.Body); err == nil && len(data) > 0 {
		_ = json.Unmarshal(data, &body)
	}
	p.mu.Lock()
	p.calls = append(p.calls, recordedCall{method: r.Method, path: r.URL.Path, query: r.URL.RawQuery, body: body})
	p.mu.Unlock()

	switch {
	case strings.HasSuffix(r.URL.Path, "/ci/jobs/claim"):
		p.mu.Lock()
		index := p.claims
		p.claims++
		reply := claimReply{status: p.claimFallbackStatus}
		if reply.status == 0 {
			reply.status = http.StatusNoContent
		}
		if index < len(p.claimReplies) {
			reply = p.claimReplies[index]
		}
		p.mu.Unlock()
		if reply.retryAfter != "" {
			w.Header().Set("retry-after", reply.retryAfter)
		}
		if reply.status == 0 {
			reply.status = http.StatusOK
		}
		w.WriteHeader(reply.status)
		if reply.status != http.StatusNoContent {
			io.WriteString(w, reply.body)
		}
	case strings.HasSuffix(r.URL.Path, "/heartbeat"):
		p.mu.Lock()
		p.beats++
		p.mu.Unlock()
		io.WriteString(w, "{}")
	case strings.HasSuffix(r.URL.Path, "/report"):
		p.mu.Lock()
		p.reports = append(p.reports, body)
		status := p.reportStatus
		p.mu.Unlock()
		if status == 0 {
			status = http.StatusOK
		}
		w.WriteHeader(status)
		io.WriteString(w, "{}")
	case strings.Contains(r.URL.Path, "/compare/"):
		p.serveREST(w, p.compare, r.URL.Query().Get("cursor"))
	case strings.HasSuffix(r.URL.Path, "/tree"):
		p.serveREST(w, p.tree, r.URL.Query().Get("ref"), r.URL.Query().Get("path"))
	case strings.HasSuffix(r.URL.Path, "/contents"):
		p.serveREST(w, p.contents, r.URL.Query().Get("path"), r.URL.Query().Get("ref"))
	default:
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, `{"error":"unknown endpoint"}`)
	}
}

// serveREST answers from a canned endpoint, or 404 when the test did not
// install one. It runs on the server's goroutine, so failures are Errorf.
func (p *fakePlatform) serveREST(w http.ResponseWriter, handler any, args ...string) {
	if handler == nil {
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, `{"error":"no endpoint"}`)
		return
	}
	var status int
	var body string
	switch fn := handler.(type) {
	case func(string) (int, string):
		status, body = fn(args[0])
	case func(string, string) (int, string):
		status, body = fn(args[0], args[1])
	default:
		p.t.Errorf("unsupported handler %T", handler)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	if status == 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	io.WriteString(w, body)
}

// callsOf returns the recorded calls whose path ends with suffix.
func (p *fakePlatform) callsOf(suffix string) []recordedCall {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []recordedCall
	for _, c := range p.calls {
		if strings.HasSuffix(c.path, suffix) {
			out = append(out, c)
		}
	}
	return out
}

// callsContaining returns the recorded calls whose path holds sub.
func (p *fakePlatform) callsContaining(sub string) []recordedCall {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []recordedCall
	for _, c := range p.calls {
		if strings.Contains(c.path, sub) {
			out = append(out, c)
		}
	}
	return out
}

func (p *fakePlatform) report(t *testing.T, index int) map[string]any {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if index >= len(p.reports) {
		t.Fatalf("report %d was never sent (have %d)", index, len(p.reports))
	}
	return p.reports[index]
}

func (p *fakePlatform) beatsCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.beats
}

// jobReply is one claim answer carrying a job.
func jobReply(id, name, sha, command string, generation int, timeoutSeconds int, provenance map[string]any) claimReply {
	job := map[string]any{
		"id": id, "name": name, "sha": sha, "command": command,
		"generation": generation, "timeoutSeconds": timeoutSeconds,
	}
	if provenance != nil {
		job["provenance"] = provenance
	}
	data, err := json.Marshal(map[string]any{"job": job})
	if err != nil {
		panic(err)
	}
	return claimReply{status: http.StatusOK, body: string(data)}
}

// trustedProvenance is the only provenance `--trust humans` accepts.
func trustedProvenance() map[string]any {
	return map[string]any{
		"changeNumber": 7, "headRef": "refs/heads/main", "commit": "head",
		"authorKind": "human", "authorLogin": "alice",
		"agentWorkspaceRef": false, "agentWritableRef": false,
	}
}

func startPlatform(t *testing.T, p *fakePlatform) string {
	t.Helper()
	p.t = t
	server := httptest.NewServer(p)
	t.Cleanup(server.Close)
	return server.URL
}

// runnerOptions is a one-shot host runner over a temporary workdir root.
func runnerOptions(t *testing.T, baseURL string) (Options, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	var out, errOut bytes.Buffer
	return Options{
		BaseURL:  baseURL,
		PAT:      "kvarm_pat_test",
		Repo:     "alice/demo",
		Once:     true,
		WorkRoot: filepath.Join(t.TempDir(), "runner"),
		TempRoot: t.TempDir(),
		Trust:    executor.TrustHumans,
		Executor: executor.ExecutorHost,
		Stdout:   ui.New(&out),
		Stderr:   ui.New(&errOut),
		Client:   httpx.New(),
	}, &out, &errOut
}

// snapshotCheckout writes one file into the materialized directory, the way a
// snapshot checkout would, and reports the job's sha.
func snapshotCheckout(sha, name, content string, calls *int) func(context.Context, checkout.Options) (checkout.Result, error) {
	return func(_ context.Context, o checkout.Options) (checkout.Result, error) {
		if calls != nil {
			*calls++
		}
		if err := os.MkdirAll(o.Dir, 0o755); err != nil {
			return checkout.Result{}, err
		}
		if err := os.WriteFile(filepath.Join(o.Dir, name), []byte(content), 0o644); err != nil {
			return checkout.Result{}, err
		}
		return checkout.Result{Source: "snapshot", SHA: sha, Bytes: int64(len(content)), Files: 1}, nil
	}
}

func TestRunOnceClaimsExecutesAndReports(t *testing.T) {
	platform := &fakePlatform{claimReplies: []claimReply{
		jobReply("job1", "build", jobSHA, "cat marker.txt", 2, 30, trustedProvenance()),
	}}
	baseURL := startPlatform(t, platform)

	var checkoutCalls int
	var checkoutDir string
	options, out, errOut := runnerOptions(t, baseURL)
	options.CheckoutFn = func(ctx context.Context, o checkout.Options) (checkout.Result, error) {
		checkoutDir = o.Dir
		if o.Ref != jobSHA || o.Repo != "alice/demo" || o.PAT != "kvarm_pat_test" || o.BaseURL != baseURL {
			t.Errorf("checkout options = %+v", o)
		}
		return snapshotCheckout(jobSHA, "marker.txt", "from the checkout\n", &checkoutCalls)(ctx, o)
	}

	result, err := Run(context.Background(), options)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Claimed != 1 || result.Reported != 1 {
		t.Errorf("result = %+v, want one claim and one report", result)
	}
	if checkoutCalls != 1 {
		t.Errorf("checkout ran %d times, want once", checkoutCalls)
	}

	if claims := platform.callsOf("/ci/jobs/claim"); len(claims) != 1 {
		t.Errorf("claim calls = %d, want 1", len(claims))
	} else if runnerID, _ := claims[0].body["runnerId"].(string); !strings.HasPrefix(runnerID, "kvarm-runner-") {
		t.Errorf("claim body = %v, want a runnerId", claims[0].body)
	}
	if reports := platform.callsOf("/report"); len(reports) != 1 {
		t.Fatalf("report calls = %d, want 1", len(reports))
	}

	body := platform.report(t, 0)
	if runnerID, _ := body["runnerId"].(string); !strings.HasPrefix(runnerID, "kvarm-runner-") {
		t.Errorf("report runnerId = %v", body["runnerId"])
	}
	if body["generation"] != float64(2) || body["conclusion"] != "success" {
		t.Errorf("report = %v", body)
	}
	summary, ok := body["summary"].(map[string]any)
	if !ok {
		t.Fatalf("report summary = %v", body["summary"])
	}
	if summary["command"] != "cat marker.txt" || summary["exitCode"] != float64(0) ||
		summary["timedOut"] != false || summary["source"] != "snapshot" ||
		summary["sha"] != jobSHA || summary["executor"] != "host" {
		t.Errorf("summary = %v", summary)
	}
	if summary["stdout"] != "from the checkout\n" || summary["stderr"] != "" {
		t.Errorf("summary output = %q/%q", summary["stdout"], summary["stderr"])
	}
	if duration, _ := summary["durationMs"].(float64); duration < 0 {
		t.Errorf("durationMs = %v", summary["durationMs"])
	}
	if _, ok := summary["refused"]; ok {
		t.Errorf("a successful job must not be marked refused: %v", summary)
	}

	for _, want := range []string{
		"claimed build (job1) at " + jobSHA,
		"workdir: fresh",
		"executor: host: change #7 is human-authored (alice)",
		"reported success for build (job1) in ",
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("stdout = %q, want %q", out.String(), want)
		}
	}
	if errOut.Len() != 0 {
		t.Errorf("stderr = %q, want nothing", errOut.String())
	}
	if checkoutDir == "" {
		t.Error("the checkout never ran")
	}
}

func TestRunOnceWithNoJobReturnsTheZeroResult(t *testing.T) {
	platform := &fakePlatform{}
	baseURL := startPlatform(t, platform)
	options, out, errOut := runnerOptions(t, baseURL)

	result, err := Run(context.Background(), options)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Claimed != 0 || result.Reported != 0 {
		t.Errorf("result = %+v, want the zero result", result)
	}
	if claims := platform.callsOf("/ci/jobs/claim"); len(claims) != 1 {
		t.Errorf("claim calls = %d, want 1", len(claims))
	}
	if reports := platform.callsOf("/report"); len(reports) != 0 {
		t.Errorf("report calls = %d, want none", len(reports))
	}
	if out.Len() != 0 || errOut.Len() != 0 {
		t.Errorf("output = %q/%q, want nothing", out.String(), errOut.String())
	}
}

func TestRunOnceRefusesAnUntrustedJob(t *testing.T) {
	provenance := map[string]any{
		"changeNumber": 3, "headRef": "refs/heads/agents/w1/fix",
		"authorKind": "agent", "agent": map[string]any{"id": "a1", "name": "bot"},
	}
	platform := &fakePlatform{claimReplies: []claimReply{
		jobReply("job1", "build", jobSHA, "echo should-not-run", 1, 30, provenance),
	}}
	baseURL := startPlatform(t, platform)

	options, out, errOut := runnerOptions(t, baseURL)
	options.CheckoutFn = func(context.Context, checkout.Options) (checkout.Result, error) {
		t.Error("a refused job must not materialize a workspace")
		return checkout.Result{}, nil
	}

	result, err := Run(context.Background(), options)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Claimed != 1 || result.Reported != 1 {
		t.Errorf("result = %+v, want the refusal reported", result)
	}
	if !strings.Contains(errOut.String(), "refused build (job1): change #3 is agent-authored") {
		t.Errorf("stderr = %q, want the refusal line", errOut.String())
	}
	if strings.Contains(out.String(), "workdir:") {
		t.Errorf("stdout = %q, want no materialize for a refused job", out.String())
	}

	body := platform.report(t, 0)
	if body["conclusion"] != "failure" {
		t.Errorf("conclusion = %v", body["conclusion"])
	}
	summary := body["summary"].(map[string]any)
	if summary["refused"] != true || summary["trust"] != "humans" || summary["executor"] != "host" {
		t.Errorf("summary = %v", summary)
	}
	if summary["exitCode"] != nil || summary["durationMs"] != float64(0) || summary["stdout"] != "" {
		t.Errorf("summary = %v", summary)
	}
	stderr, _ := summary["stderr"].(string)
	wantPrefix := `kvarm runner refused to run this job: change #3 is agent-authored (agent "bot"); --executor host does not run untrusted jobs. `
	if !strings.HasPrefix(stderr, wantPrefix) {
		t.Errorf("summary stderr = %q, want prefix %q", stderr, wantPrefix)
	}
	if !strings.HasSuffix(stderr, RefusalHint) {
		t.Errorf("summary stderr = %q, want the refusal hint", stderr)
	}
}

func TestRunReportsAFailedCommand(t *testing.T) {
	platform := &fakePlatform{claimReplies: []claimReply{
		jobReply("job1", "build", jobSHA, "echo oops >&2; exit 9", 1, 30, trustedProvenance()),
	}}
	baseURL := startPlatform(t, platform)
	options, _, _ := runnerOptions(t, baseURL)
	options.CheckoutFn = snapshotCheckout(jobSHA, "f.txt", "x", nil)

	if _, err := Run(context.Background(), options); err != nil {
		t.Fatalf("Run: %v", err)
	}
	body := platform.report(t, 0)
	if body["conclusion"] != "failure" {
		t.Errorf("conclusion = %v", body["conclusion"])
	}
	summary := body["summary"].(map[string]any)
	if summary["exitCode"] != float64(9) || summary["timedOut"] != false || summary["stderr"] != "oops\n" {
		t.Errorf("summary = %v", summary)
	}
}

func TestRunReportsAMaterializeFailure(t *testing.T) {
	platform := &fakePlatform{claimReplies: []claimReply{
		jobReply("job1", "build", jobSHA, "echo hi", 1, 30, trustedProvenance()),
	}}
	baseURL := startPlatform(t, platform)
	options, _, _ := runnerOptions(t, baseURL)
	options.CheckoutFn = func(context.Context, checkout.Options) (checkout.Result, error) {
		return checkout.Result{}, errs.NewFailure("snapshot API unreachable")
	}

	result, err := Run(context.Background(), options)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Reported != 1 {
		t.Errorf("result = %+v", result)
	}
	summary := platform.report(t, 0)["summary"].(map[string]any)
	if summary["exitCode"] != nil || summary["stderr"] != "snapshot API unreachable" {
		t.Errorf("summary = %v", summary)
	}
	if _, ok := summary["refused"]; ok {
		t.Error("a materialize failure is not a refusal")
	}
}

func TestRunRetriesARetryableClaimFailure(t *testing.T) {
	// Retry-After: 0 keeps the retry immediate, so the loop is exercised
	// without a real backoff sleep.
	platform := &fakePlatform{claimReplies: []claimReply{
		{status: http.StatusInternalServerError, body: `{"error":"boom"}`, retryAfter: "0"},
		jobReply("job1", "build", jobSHA, "echo ok", 1, 30, trustedProvenance()),
	}}
	baseURL := startPlatform(t, platform)
	options, _, errOut := runnerOptions(t, baseURL)
	options.CheckoutFn = snapshotCheckout(jobSHA, "f.txt", "x", nil)

	result, err := Run(context.Background(), options)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Claimed != 1 || result.Reported != 1 {
		t.Errorf("result = %+v", result)
	}
	if claims := platform.callsOf("/ci/jobs/claim"); len(claims) != 2 {
		t.Errorf("claim calls = %d, want a retry then the job", len(claims))
	}
	if !strings.Contains(errOut.String(), "claim failed: ci/jobs/claim: boom; retrying in 0.0 s") {
		t.Errorf("stderr = %q, want the retry line", errOut.String())
	}
}

func TestRunStopsRetryingWhenTheContextIsDone(t *testing.T) {
	// Every claim fails retryably, so the loop is in its backoff when the
	// context expires.
	platform := &fakePlatform{claimFallbackStatus: http.StatusInternalServerError}
	baseURL := startPlatform(t, platform)

	options, _, errOut := runnerOptions(t, baseURL)
	options.Once = false
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	if _, err := Run(ctx, options); err == nil {
		t.Fatal("Run returned no error after the context expired")
	}
	if !strings.Contains(errOut.String(), "claim failed: ci/jobs/claim: HTTP 500; retrying in ") {
		t.Errorf("stderr = %q, want a claim failure line", errOut.String())
	}
}

func TestRunClaimRefusalIsFatal(t *testing.T) {
	platform := &fakePlatform{claimReplies: []claimReply{
		{status: http.StatusUnauthorized, body: `{"error":"bad token","code":"BAD_TOKEN"}`},
	}}
	baseURL := startPlatform(t, platform)
	options, _, _ := runnerOptions(t, baseURL)

	_, err := Run(context.Background(), options)
	if err == nil || err.Error() != "ci/jobs/claim: bad token (BAD_TOKEN)" {
		t.Fatalf("error = %v, want the API refusal", err)
	}
	if claims := platform.callsOf("/ci/jobs/claim"); len(claims) != 1 {
		t.Errorf("claim calls = %d, want no retry for a definite refusal", len(claims))
	}
}

func TestRunReportRetriesThreeTimes(t *testing.T) {
	platform := &fakePlatform{
		claimReplies: []claimReply{jobReply("job1", "build", jobSHA, "echo ok", 1, 30, trustedProvenance())},
		reportStatus: http.StatusInternalServerError,
	}
	baseURL := startPlatform(t, platform)
	options, _, errOut := runnerOptions(t, baseURL)
	options.CheckoutFn = snapshotCheckout(jobSHA, "f.txt", "x", nil)

	result, err := Run(context.Background(), options)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Claimed != 1 || result.Reported != 0 {
		t.Errorf("result = %+v, want one claim and no report", result)
	}
	if reports := platform.callsOf("/report"); len(reports) != 3 {
		t.Errorf("report calls = %d, want three attempts", len(reports))
	}
	stderr := errOut.String()
	if !strings.Contains(stderr, "warning: could not report build (job1) after 3 attempts: ci/jobs/job1/report: HTTP 500") {
		t.Errorf("stderr = %q, want the warning", stderr)
	}
	if !strings.Contains(stderr, "the platform requeues the job when the lease expires") {
		t.Errorf("stderr = %q, want the requeue note", stderr)
	}
}

func TestRunValidatesItsOptions(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Options)
		want   string
	}{
		{"bad repo", func(o *Options) { o.Repo = "alice" }, "expected --repo <owner/repo>"},
		{"bad trust", func(o *Options) { o.Trust = "sometimes" }, "--trust must be one of all, humans, none"},
		{"bad executor", func(o *Options) { o.Executor = "vm" }, "--executor must be one of auto, host, container"},
		{"bad container runtime", func(o *Options) { o.Container.Runtime = "containerd" }, "--container-runtime must be one of docker, podman"},
		{"bad container network", func(o *Options) { o.Container.Network = "host" },
			"--network host would share a network namespace with the host or another container; use a bridge network or none"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			options, _, _ := runnerOptions(t, "http://127.0.0.1:1")
			tt.mutate(&options)
			_, err := Run(context.Background(), options)
			if err == nil {
				t.Fatalf("Run returned no error, want %q", tt.want)
			}
			cliErr, ok := err.(*errs.CliError)
			if !ok || cliErr.Message != tt.want || cliErr.ExitCode != 2 {
				t.Errorf("error = %#v, want usage error %q", err, tt.want)
			}
		})
	}
}

// installDeadRuntimes puts docker and podman on PATH answering nothing, so
// the runtime probe fails deterministically whatever the host has installed.
func installDeadRuntimes(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	for _, name := range []string{"docker", "podman"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
			t.Fatalf("writing the fake %s: %v", name, err)
		}
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestRunContainerExecutorNeedsARuntime(t *testing.T) {
	installDeadRuntimes(t)

	tests := []struct {
		name    string
		runtime executor.ContainerRuntime
		want    string
	}{
		{"auto-detected", "", "--executor container needs a running docker or podman, and none answered"},
		{"preferred", executor.RuntimePodman, "--executor container needs a running podman, and none answered"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			options, _, _ := runnerOptions(t, "http://127.0.0.1:1")
			options.Executor = executor.ExecutorContainer
			options.Container.Runtime = tt.runtime
			_, err := Run(context.Background(), options)
			if err == nil {
				t.Fatalf("Run returned no error, want %q", tt.want)
			}
			if err.Error() != tt.want {
				t.Errorf("error = %q, want %q", err, tt.want)
			}
		})
	}
}

func TestRunWarmSecondJobAppliesTheDelta(t *testing.T) {
	firstBlob := workdir.BlobHash([]byte("one\n"))
	secondBlob := workdir.BlobHash([]byte("two\n"))
	platform := &fakePlatform{
		claimReplies: []claimReply{
			jobReply("job1", "first", jobSHA, "cat a.txt", 1, 30, trustedProvenance()),
			jobReply("job2", "second", otherSHA, "cat a.txt", 1, 30, trustedProvenance()),
		},
		compare: func(cursor string) (int, string) {
			if cursor != "" {
				t.Errorf("the first page must not carry a cursor, got %q", cursor)
			}
			return 200, fmt.Sprintf(`{"files":[{"path":"a.txt","status":"modified","oldHash":%q,"newHash":%q,"oldMode":"100644","newMode":"100644"}]}`,
				firstBlob, secondBlob)
		},
		contents: func(path, ref string) (int, string) {
			if path != "a.txt" || ref != otherSHA {
				t.Errorf("contents request = %q at %q", path, ref)
			}
			return 200, `{"content":"two\n","encoding":"utf-8"}`
		},
	}
	baseURL := startPlatform(t, platform)

	// The full checkout runs for the first job only: the second is warm.
	checkouts := 0
	options, out, _ := runnerOptions(t, baseURL)
	options.Once = false
	options.DrainUntilEmpty = true
	options.CheckoutFn = func(ctx context.Context, o checkout.Options) (checkout.Result, error) {
		checkouts++
		return snapshotCheckout(jobSHA, "a.txt", "one\n", nil)(ctx, o)
	}

	result, err := Run(context.Background(), options)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Claimed != 2 || result.Reported != 2 {
		t.Errorf("result = %+v, want two jobs", result)
	}
	if checkouts != 1 {
		t.Errorf("the full checkout ran %d times, want once", checkouts)
	}
	first := platform.report(t, 0)["summary"].(map[string]any)
	second := platform.report(t, 1)["summary"].(map[string]any)
	if first["stdout"] != "one\n" || first["source"] != "snapshot" {
		t.Errorf("first summary = %v", first)
	}
	if second["stdout"] != "two\n" || second["source"] != "delta" || second["sha"] != otherSHA {
		t.Errorf("second summary = %v", second)
	}
	if !strings.Contains(out.String(), "workdir: warm") {
		t.Errorf("stdout = %q, want the warm workdir line", out.String())
	}
	if claims := platform.callsOf("/ci/jobs/claim"); len(claims) != 3 {
		t.Errorf("claim calls = %d, want two jobs then the empty drain", len(claims))
	}
	compares := platform.callsContaining("/compare/")
	if len(compares) != 1 || compares[0].path != "/api/v1/repos/alice/demo/compare/"+jobSHA+"..."+otherSHA {
		t.Errorf("compare calls = %v, want one page for the recorded pair", compares)
	}
}

func TestRunDrainStopsOnAnEmptyQueue(t *testing.T) {
	platform := &fakePlatform{}
	baseURL := startPlatform(t, platform)
	options, _, _ := runnerOptions(t, baseURL)
	options.Once = false
	options.DrainUntilEmpty = true

	result, err := Run(context.Background(), options)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Claimed != 0 || result.Reported != 0 {
		t.Errorf("result = %+v", result)
	}
}

func TestStartHeartbeatDoesNotBeatEarlyAndStops(t *testing.T) {
	// startHeartbeat renews the platform's 120 s lease: its interval is
	// max(10 s, 120 s/3) = 40 s, so a short job never beats, and stopping the
	// job must return promptly so the report can go out.
	platform := &fakePlatform{}
	baseURL := startPlatform(t, platform)
	var stderr bytes.Buffer
	r := &runner{
		baseURL:  baseURL,
		pat:      "kvarm_pat_test",
		reposURL: "/api/v1/repos/alice/demo",
		client:   httpx.New(),
		stdout:   ui.New(io.Discard),
		stderr:   ui.New(&stderr),
	}
	job := &claimedJob{ID: "job1", Name: "build", SHA: jobSHA, Generation: 3}

	stop := startHeartbeat(context.Background(), r, job, "kvarm-runner-test")
	time.Sleep(100 * time.Millisecond)
	stopped := make(chan struct{})
	go func() {
		stop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("stop blocked")
	}
	if beats := platform.beatsCount(); beats != 0 {
		t.Errorf("heartbeats = %d, want none within the first 100 ms", beats)
	}
	if stderr.Len() != 0 {
		t.Errorf("stderr = %q", stderr.String())
	}
}

func TestRunDefaultsToHumansAndAuto(t *testing.T) {
	platform := &fakePlatform{claimReplies: []claimReply{
		jobReply("job1", "build", jobSHA, "echo ok", 1, 30, trustedProvenance()),
	}}
	baseURL := startPlatform(t, platform)
	options, out, _ := runnerOptions(t, baseURL)
	options.Trust = ""
	options.Executor = ""
	options.CheckoutFn = snapshotCheckout(jobSHA, "f.txt", "x", nil)

	result, err := Run(context.Background(), options)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Reported != 1 {
		t.Errorf("result = %+v", result)
	}
	if !strings.Contains(out.String(), "executor: host: change #7 is human-authored (alice)") {
		t.Errorf("stdout = %q", out.String())
	}
}

func TestRunWarnsOnAHostJobWithTrustAll(t *testing.T) {
	platform := &fakePlatform{claimReplies: []claimReply{
		jobReply("job1", "build", jobSHA, "echo ok", 1, 30, map[string]any{"authorKind": "agent"}),
	}}
	baseURL := startPlatform(t, platform)
	options, _, errOut := runnerOptions(t, baseURL)
	options.Trust = executor.TrustAll
	options.CheckoutFn = snapshotCheckout(jobSHA, "f.txt", "x", nil)

	if _, err := Run(context.Background(), options); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !strings.Contains(errOut.String(), "warning: running build on the host with --trust all; its code has this user's files and network") {
		t.Errorf("stderr = %q, want the host warning", errOut.String())
	}
}

func TestRunHostWarningCanBeSilenced(t *testing.T) {
	platform := &fakePlatform{claimReplies: []claimReply{
		jobReply("job1", "build", jobSHA, "echo ok", 1, 30, map[string]any{"authorKind": "agent"}),
	}}
	baseURL := startPlatform(t, platform)
	options, _, errOut := runnerOptions(t, baseURL)
	options.Trust = executor.TrustAll
	options.HostWarning = boolPtr(false)
	options.CheckoutFn = snapshotCheckout(jobSHA, "f.txt", "x", nil)

	if _, err := Run(context.Background(), options); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if errOut.Len() != 0 {
		t.Errorf("stderr = %q, want the warning silenced", errOut.String())
	}
}

func boolPtr(b bool) *bool { return &b }
