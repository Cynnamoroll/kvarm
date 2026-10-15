// Package executor decides where and whether the runner executes a
// repository command, and executes it: `host` runs the command in a shell as
// this user (environment filtered, nothing else isolated), `container` runs
// it in a throwaway docker or podman container whose only writable host
// mount is the job's working directory. The execution-trust policy decides,
// before anything runs, which executor a claimed job gets or whether it is
// refused, from the provenance the platform returns with the claim.
package executor

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"kvarm/cli/internal/errs"
)

// OutputLimit bounds the captured stdout and stderr of a job.
const OutputLimit = 16 * 1024

// Truncated is the marker appended to output cut to fit the budget.
const Truncated = "\n[output truncated]\n"

// CommandTruncated marks the command field of a summary that was cut.
const CommandTruncated = "…[truncated]"

// TrustMode selects which jobs may run on the host.
type TrustMode string

const (
	TrustAll    TrustMode = "all"
	TrustHumans TrustMode = "humans"
	TrustNone   TrustMode = "none"
)

// TrustModes are the valid --trust values.
var TrustModes = []string{"all", "humans", "none"}

// ExecutorMode selects where jobs run.
type ExecutorMode string

const (
	ExecutorAuto      ExecutorMode = "auto"
	ExecutorHost      ExecutorMode = "host"
	ExecutorContainer ExecutorMode = "container"
)

// ExecutorModes are the valid --executor values.
var ExecutorModes = []string{"auto", "host", "container"}

// ContainerRuntime is docker or podman.
type ContainerRuntime string

const (
	RuntimeDocker ContainerRuntime = "docker"
	RuntimePodman ContainerRuntime = "podman"
)

// ContainerRuntimes are the runtimes the runner can drive.
var ContainerRuntimes = []string{"docker", "podman"}

// DefaultImage is the official Node.js LTS image, pinned to the major line.
// Pin a patch tag or digest (`--image node:24.x.y-bookworm@sha256:…`) for
// reproducible jobs; the full (non-slim) variant carries git, which snapshot
// jobs need for `git init`.
const DefaultImage = "node:24-bookworm"

// Container defaults and the fixed mount point of the job's working
// directory inside the container.
const (
	DefaultCPUS      = "2"
	DefaultMemory    = "4g"
	DefaultPidsLimit = int64(1024)
	ContainerWorkdir = "/workspace"
)

// KillGraceMS is the delay between SIGTERM and SIGKILL.
const KillGraceMS = 5_000

// DetectTimeoutMS bounds one container-runtime probe.
const DetectTimeoutMS = 15_000

// CreateTimeoutMS bounds `docker create`, which includes pulling a missing
// image and so must not count against the job's timeout.
const CreateTimeoutMS = 15 * 60_000

// Bounded cuts text to the output limit on rune boundaries, keeping the
// truncation marker.
func Bounded(text string) string {
	runes := []rune(text)
	if len(runes) <= OutputLimit {
		return text
	}
	return string(runes[:OutputLimit]) + Truncated
}

// TrustOf decides whether the policy trusts a job's code enough to run it
// on the host. `humans` trusts only the exact head of a change a human
// opened on a ref no agent credential could write; anything it cannot
// establish is untrusted. The provenance comes in as raw JSON fields, so a
// malformed or missing field is the same refusal the JS CLI made of it.
func TrustOf(trust TrustMode, provenance map[string]any) (trusted bool, reason string) {
	switch trust {
	case TrustAll:
		return true, "--trust all trusts every job"
	case TrustNone:
		return false, "--trust none trusts no job"
	}
	if provenance == nil {
		return false, "the platform sent no provenance for this job"
	}
	change := "the job"
	if n, ok := numberValue(provenance["changeNumber"]); ok {
		change = fmt.Sprintf("change #%s", trimNumber(n))
	}
	if kind, _ := provenance["authorKind"].(string); kind == "agent" {
		who := "an agent"
		if agent, ok := provenance["agent"].(map[string]any); ok {
			if name, _ := agent["name"].(string); name != "" {
				who = fmt.Sprintf("agent %q", name)
			}
		}
		if who == "an agent" {
			if ref, _ := provenance["headRef"].(string); ref != "" && booleanValue(provenance["agentWorkspaceRef"]) {
				who = "agent workspace ref " + ref
			}
		}
		return false, change + " is agent-authored (" + who + ")"
	}
	if booleanValue(provenance["agentWorkspaceRef"]) {
		return false, change + " heads an agent workspace ref"
	}
	if kind, _ := provenance["authorKind"].(string); kind != "human" {
		return false, "the author of " + change + " is unknown"
	}
	if !booleanValueIs(provenance["agentWritableRef"], false) {
		head := "the head"
		if ref, _ := provenance["headRef"].(string); ref != "" {
			head = "the head ref " + ref
		}
		return false, "an agent token may push " + head + " of " + change
	}
	if commit, _ := provenance["commit"].(string); commit != "head" {
		return false, "the job runs a platform-prepared commit of " + change + ", which can include other changes"
	}
	login, _ := provenance["authorLogin"].(string)
	if login != "" {
		return true, change + " is human-authored (" + login + ")"
	}
	return true, change + " is human-authored"
}

func booleanValue(v any) bool {
	b, _ := v.(bool)
	return b
}

// booleanValueIs reports whether v is a JSON boolean equal to want (missing
// and non-boolean values are not).
func booleanValueIs(v any, want bool) bool {
	b, ok := v.(bool)
	return ok && b == want
}

// numberValue reads a JSON number field (json.Number from a UseNumber
// decoder, or float64 from an ordinary decode).
func numberValue(v any) (string, bool) {
	switch n := v.(type) {
	case json.Number:
		return n.String(), true
	case float64:
		return strconv.FormatFloat(n, 'f', -1, 64), true
	default:
		return "", false
	}
}

func trimNumber(s string) string {
	// The platform sends integer change numbers; drop a float tail if any.
	if i := strings.IndexAny(s, "."); i >= 0 {
		s = s[:i]
	}
	return s
}

// RuntimeProbe is an answering container runtime and whether it runs
// rootless.
type RuntimeProbe struct {
	Runtime  ContainerRuntime
	Rootless bool
}

// Plan is the executor decision for one job, made before any byte of the
// job's code reaches this machine. `container` always isolates; `host` runs
// trusted jobs and refuses the rest; `auto` runs trusted jobs on the host
// and isolates the rest when a container runtime answers.
type Plan struct {
	Run     string // host | container | "" (refused)
	Trusted bool
	Reason  string
	Runtime *RuntimeProbe
}

// PlanExecution decides the executor for one job, probing a runtime only
// when the plan needs one.
func PlanExecution(trust TrustMode, executorMode ExecutorMode, provenance map[string]any, runtime func() *RuntimeProbe) (Plan, error) {
	trusted, reason := TrustOf(trust, provenance)
	if trusted && executorMode != ExecutorContainer {
		return Plan{Run: "host", Trusted: trusted, Reason: reason}, nil
	}
	if executorMode == ExecutorHost {
		return Plan{Trusted: trusted, Reason: reason + "; --executor host does not run untrusted jobs"}, nil
	}
	probe := runtime()
	if probe != nil {
		return Plan{Run: "container", Trusted: trusted, Reason: reason, Runtime: probe}, nil
	}
	if executorMode == ExecutorContainer {
		return Plan{Trusted: trusted, Reason: reason + "; --executor container needs docker or podman, and none answered"}, nil
	}
	return Plan{Trusted: trusted, Reason: reason + ", and no container runtime (docker or podman) answered to isolate it"}, nil
}

// ContainerConfig carries the container settings; Runtime "" auto-detects
// docker, then podman.
type ContainerConfig struct {
	Runtime   ContainerRuntime
	Image     string
	Network   string
	CPUS      string
	Memory    string
	PidsLimit *int64
	// User: "" maps this user's ids, "image" keeps the image's user, and any
	// other value is passed as --user.
	User     string
	Rootless bool
}

var (
	imageRe   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:@-]*$`)
	networkRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]*$`)
	cpusRe    = regexp.MustCompile(`^(?:\d+(?:\.\d+)?|\.\d+)$`)
	memoryRe  = regexp.MustCompile(`(?i)^\d+[bkmg]?$`)
	userRe    = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)?$`)
	nameRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`)
)

// ConfigError validates container settings; values become separate argv
// entries, but one starting with "-" would still be read as an option by
// the runtime's parser. Returns "" when the config is valid.
func ConfigError(c ContainerConfig) string {
	if c.Runtime != "" && !containsString(ContainerRuntimes, string(c.Runtime)) {
		return fmt.Sprintf("container runtime must be one of %s", strings.Join(ContainerRuntimes, ", "))
	}
	if c.Image != "" && !imageRe.MatchString(c.Image) {
		return fmt.Sprintf("invalid image %q", c.Image)
	}
	if c.Network != "" {
		if !networkRe.MatchString(c.Network) {
			return fmt.Sprintf("invalid network %q", c.Network)
		}
		// Sharing the host's or another container's network namespace would
		// hand an untrusted job every service listening on localhost.
		if c.Network == "host" || strings.HasPrefix(c.Network, "container:") {
			return "--network " + c.Network + " would share a network namespace with the host or another container; use a bridge network or none"
		}
	}
	if c.CPUS != "" && !(cpusRe.MatchString(c.CPUS) && positiveFloat(c.CPUS)) {
		return fmt.Sprintf("invalid cpus %q", c.CPUS)
	}
	if c.Memory != "" && !(memoryRe.MatchString(c.Memory) && positivePrefixInt(c.Memory)) {
		return fmt.Sprintf("invalid memory %q", c.Memory)
	}
	if c.PidsLimit != nil && *c.PidsLimit <= 0 {
		return fmt.Sprintf("invalid pids limit %d", *c.PidsLimit)
	}
	if c.User != "" && c.User != "image" && !userRe.MatchString(c.User) {
		return fmt.Sprintf("invalid container user %q", c.User)
	}
	return ""
}

// ValidateContainerConfig turns the config error into a usage error.
func ValidateContainerConfig(c ContainerConfig) error {
	if problem := ConfigError(c); problem != "" {
		return errs.NewUsage("%s", problem)
	}
	return nil
}

func positiveFloat(s string) bool {
	var v float64
	fmt.Sscanf(s, "%g", &v)
	return v > 0
}

func positivePrefixInt(s string) bool {
	digits := s
	for i := 0; i < len(s); i++ {
		if !isDigit(s[i]) {
			digits = s[:i]
			break
		}
	}
	if digits == "" {
		return false
	}
	var v int64
	fmt.Sscanf(digits, "%d", &v)
	return v > 0
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func containsString(list []string, s string) bool {
	for _, item := range list {
		if item == s {
			return true
		}
	}
	return false
}
