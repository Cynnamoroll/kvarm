package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"kvarm/cli/internal/errs"
)

func int64Ptr(n int64) *int64 { return &n }

// humanProvenance is the only shape `--trust humans` trusts: the exact head of
// a change a human opened on a ref no agent token can push.
func humanProvenance() map[string]any {
	return map[string]any{
		"changeNumber":      float64(7),
		"headRef":           "refs/heads/feature/x",
		"commit":            "head",
		"authorKind":        "human",
		"authorLogin":       "alice",
		"agentWorkspaceRef": false,
		"agentWritableRef":  false,
	}
}

func TestTrustOf(t *testing.T) {
	// The JS trustOf truth table: `humans` trusts only the exact head of a
	// change a human opened on a ref no agent credential could write.
	agentNamed := map[string]any{
		"changeNumber": float64(12),
		"authorKind":   "agent",
		"agent":        map[string]any{"id": "a1", "name": "coder"},
	}
	agentOnWorkspaceRef := map[string]any{
		"changeNumber":      float64(12),
		"authorKind":        "agent",
		"agentWorkspaceRef": true,
		"headRef":           "refs/heads/agents/w1/fix",
	}
	agentAnonymous := map[string]any{"changeNumber": float64(12), "authorKind": "agent"}

	tests := []struct {
		name       string
		trust      TrustMode
		provenance map[string]any
		trusted    bool
		reason     string
	}{
		{"all trusts every job", TrustAll, nil, true, "--trust all trusts every job"},
		{"none trusts no job", TrustNone, humanProvenance(), false, "--trust none trusts no job"},
		{"humans without provenance", TrustHumans, nil, false, "the platform sent no provenance for this job"},
		{"agent-authored, named", TrustHumans, agentNamed, false, `change #12 is agent-authored (agent "coder")`},
		{"agent-authored on a workspace ref", TrustHumans, agentOnWorkspaceRef, false, "change #12 is agent-authored (agent workspace ref refs/heads/agents/w1/fix)"},
		{"agent-authored, anonymous", TrustHumans, agentAnonymous, false, "change #12 is agent-authored (an agent)"},
		{"agent workspace ref", TrustHumans, map[string]any{
			"changeNumber": float64(7), "authorKind": "human", "agentWorkspaceRef": true,
		}, false, "change #7 heads an agent workspace ref"},
		{"unknown author kind", TrustHumans, map[string]any{
			"changeNumber": float64(7), "authorKind": "robot",
		}, false, "the author of change #7 is unknown"},
		{"missing author kind", TrustHumans, map[string]any{
			"changeNumber": float64(7),
		}, false, "the author of change #7 is unknown"},
		{"agent-writable head ref", TrustHumans, map[string]any{
			"changeNumber": float64(7), "authorKind": "human", "agentWritableRef": true, "headRef": "refs/heads/main",
		}, false, "an agent token may push the head ref refs/heads/main of change #7"},
		{"agentWritableRef missing is not false", TrustHumans, map[string]any{
			"changeNumber": float64(7), "authorKind": "human", "commit": "head",
		}, false, "an agent token may push the head of change #7"},
		{"platform-prepared commit", TrustHumans, map[string]any{
			"changeNumber": float64(7), "authorKind": "human", "agentWritableRef": false, "commit": "prepared",
		}, false, "the job runs a platform-prepared commit of change #7, which can include other changes"},
		{"missing commit field", TrustHumans, map[string]any{
			"changeNumber": float64(7), "authorKind": "human", "agentWritableRef": false,
		}, false, "the job runs a platform-prepared commit of change #7, which can include other changes"},
		{"human-authored head", TrustHumans, humanProvenance(), true, "change #7 is human-authored (alice)"},
		{"human-authored without a login", TrustHumans, map[string]any{
			"changeNumber": float64(7), "authorKind": "human", "agentWritableRef": false, "commit": "head",
		}, true, "change #7 is human-authored"},
		{"no change number", TrustHumans, map[string]any{
			"authorKind": "human", "agentWritableRef": false, "commit": "head",
		}, true, "the job is human-authored"},
		{"json.Number change number", TrustHumans, map[string]any{
			"changeNumber": json.Number("12"), "authorKind": "human", "agentWritableRef": false, "commit": "head",
		}, true, "change #12 is human-authored"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			trusted, reason := TrustOf(tt.trust, tt.provenance)
			if trusted != tt.trusted || reason != tt.reason {
				t.Errorf("TrustOf = (%v, %q), want (%v, %q)", trusted, reason, tt.trusted, tt.reason)
			}
		})
	}
}

func TestPlanExecution(t *testing.T) {
	docker := &RuntimeProbe{Runtime: RuntimeDocker}
	agent := map[string]any{"changeNumber": float64(9), "authorKind": "agent"}

	tests := []struct {
		name       string
		trust      TrustMode
		mode       ExecutorMode
		provenance map[string]any
		probe      *RuntimeProbe
		wantRun    string
		wantTrust  bool
		wantReason string
		wantProbed bool
	}{
		{
			"trusted on the host", TrustHumans, ExecutorHost, humanProvenance(), nil,
			"host", true, "change #7 is human-authored (alice)", false,
		},
		{
			"trusted under auto", TrustHumans, ExecutorAuto, humanProvenance(), nil,
			"host", true, "change #7 is human-authored (alice)", false,
		},
		{
			"trust all isolates on request", TrustAll, ExecutorContainer, nil, docker,
			"container", true, "--trust all trusts every job", true,
		},
		{
			"container without a runtime", TrustHumans, ExecutorContainer, humanProvenance(), nil,
			"", true, "change #7 is human-authored (alice); --executor container needs docker or podman, and none answered", true,
		},
		{
			"host refuses the untrusted", TrustHumans, ExecutorHost, agent, docker,
			"", false, "change #9 is agent-authored (an agent); --executor host does not run untrusted jobs", false,
		},
		{
			"auto isolates the untrusted", TrustHumans, ExecutorAuto, agent, docker,
			"container", false, "change #9 is agent-authored (an agent)", true,
		},
		{
			"auto refuses without a runtime", TrustHumans, ExecutorAuto, agent, nil,
			"", false, "change #9 is agent-authored (an agent), and no container runtime (docker or podman) answered to isolate it", true,
		},
		{
			"none refuses without a runtime", TrustNone, ExecutorAuto, nil, nil,
			"", false, "--trust none trusts no job, and no container runtime (docker or podman) answered to isolate it", true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			probed := false
			plan, err := PlanExecution(tt.trust, tt.mode, tt.provenance, func() *RuntimeProbe {
				probed = true
				return tt.probe
			})
			if err != nil {
				t.Fatalf("PlanExecution: %v", err)
			}
			if plan.Run != tt.wantRun || plan.Trusted != tt.wantTrust || plan.Reason != tt.wantReason {
				t.Errorf("plan = %+v, want run %q trusted %v reason %q", plan, tt.wantRun, tt.wantTrust, tt.wantReason)
			}
			if probed != tt.wantProbed {
				t.Errorf("runtime probed = %v, want %v", probed, tt.wantProbed)
			}
			if tt.wantRun == "container" && plan.Runtime != tt.probe {
				t.Errorf("plan runtime = %+v, want the probe", plan.Runtime)
			}
			if tt.wantRun != "container" && plan.Runtime != nil {
				t.Errorf("plan runtime = %+v, want none", plan.Runtime)
			}
		})
	}
}

func TestConfigError(t *testing.T) {
	tests := []struct {
		name   string
		config ContainerConfig
		want   string
	}{
		{"defaults", ContainerConfig{}, ""},
		{"fully specified", ContainerConfig{
			Runtime: RuntimeDocker, Image: "ghcr.io/acme/tool:1@sha256:abc", Network: "bridge",
			CPUS: "1.5", Memory: "512m", PidsLimit: int64Ptr(256), User: "1000:1000",
		}, ""},
		{"image user", ContainerConfig{User: "image"}, ""},
		{"fractional cpus", ContainerConfig{CPUS: ".5"}, ""},
		{"one pids limit", ContainerConfig{PidsLimit: int64Ptr(1)}, ""},
		{"simple user", ContainerConfig{User: "root"}, ""},
		{"user with a group", ContainerConfig{User: "root:wheel"}, ""},
		{"bad runtime", ContainerConfig{Runtime: "containerd"}, "container runtime must be one of docker, podman"},
		{"option-looking image", ContainerConfig{Image: "-p"}, `invalid image "-p"`},
		{"image with a space", ContainerConfig{Image: "node 24"}, `invalid image "node 24"`},
		{"host network", ContainerConfig{Network: "host"}, "--network host would share a network namespace with the host or another container; use a bridge network or none"},
		{"container network", ContainerConfig{Network: "container:abc"}, "--network container:abc would share a network namespace with the host or another container; use a bridge network or none"},
		{"network with a space", ContainerConfig{Network: "bad net"}, `invalid network "bad net"`},
		{"zero cpus", ContainerConfig{CPUS: "0"}, `invalid cpus "0"`},
		{"negative cpus", ContainerConfig{CPUS: "-1"}, `invalid cpus "-1"`},
		{"non-numeric cpus", ContainerConfig{CPUS: "many"}, `invalid cpus "many"`},
		{"zero memory", ContainerConfig{Memory: "0"}, `invalid memory "0"`},
		{"zero memory with a unit", ContainerConfig{Memory: "0g"}, `invalid memory "0g"`},
		{"unknown memory unit", ContainerConfig{Memory: "1t"}, `invalid memory "1t"`},
		{"zero pids limit", ContainerConfig{PidsLimit: int64Ptr(0)}, "invalid pids limit 0"},
		{"negative pids limit", ContainerConfig{PidsLimit: int64Ptr(-3)}, "invalid pids limit -3"},
		{"option-looking user", ContainerConfig{User: "-root"}, `invalid container user "-root"`},
		{"user with an empty group", ContainerConfig{User: "root:"}, `invalid container user "root:"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ConfigError(tt.config); got != tt.want {
				t.Errorf("ConfigError = %q, want %q", got, tt.want)
			}
			err := ValidateContainerConfig(tt.config)
			if tt.want == "" {
				if err != nil {
					t.Errorf("ValidateContainerConfig = %v, want nil", err)
				}
				return
			}
			cliErr, ok := err.(*errs.CliError)
			if !ok || cliErr.Message != tt.want || cliErr.ExitCode != 2 {
				t.Errorf("ValidateContainerConfig = %#v, want usage error %q", err, tt.want)
			}
		})
	}
}

// argsFor builds the create argv, failing the test when the config is refused.
func argsFor(t *testing.T, config ContainerConfig, name, workdir, command string) []string {
	t.Helper()
	args, err := ContainerCreateArgs(config, name, workdir, command)
	if err != nil {
		t.Fatalf("ContainerCreateArgs: %v", err)
	}
	return args
}

func TestContainerCreateArgs(t *testing.T) {
	// TZ is the only host environment value that crosses into the container,
	// so pin it for a deterministic argv.
	t.Setenv("TZ", "UTC")

	t.Run("explicit settings", func(t *testing.T) {
		got := argsFor(t, ContainerConfig{
			Runtime: RuntimeDocker, Image: "alpine:3.20", Network: "bridge",
			CPUS: "3", Memory: "512m", PidsLimit: int64Ptr(256), User: "1000:1000",
		}, "kvarm-job-abc-12345678", "/tmp/work", "make test")
		want := []string{
			"create", "--rm", "--name", "kvarm-job-abc-12345678", "--init",
			"--mount", "type=bind,source=/tmp/work,target=/workspace",
			"--workdir", "/workspace", "--read-only", "--tmpfs", "/tmp:rw,exec",
			"--cap-drop", "ALL", "--security-opt", "no-new-privileges",
			"--cpus", "3", "--memory", "512m", "--pids-limit", "256",
			"--user", "1000:1000", "--network", "bridge",
			"--env", "GIT_TERMINAL_PROMPT=0", "--env", "HOME=/tmp", "--env", "LANG=C.UTF-8", "--env", "TZ=UTC",
			"--entrypoint", "/bin/sh", "alpine:3.20", "-c", "make test",
		}
		assertArgs(t, got, want)
	})

	t.Run("defaults", func(t *testing.T) {
		got := argsFor(t, ContainerConfig{Runtime: RuntimeDocker}, "kvarm-job-x", "/w", "true")
		want := []string{
			"create", "--rm", "--name", "kvarm-job-x", "--init",
			"--mount", "type=bind,source=/w,target=/workspace",
			"--workdir", "/workspace", "--read-only", "--tmpfs", "/tmp:rw,exec",
			"--cap-drop", "ALL", "--security-opt", "no-new-privileges",
			"--cpus", DefaultCPUS, "--memory", DefaultMemory, "--pids-limit", fmt.Sprintf("%d", DefaultPidsLimit),
			"--user", fmt.Sprintf("%d:%d", os.Getuid(), os.Getgid()),
			"--env", "GIT_TERMINAL_PROMPT=0", "--env", "HOME=/tmp", "--env", "LANG=C.UTF-8", "--env", "TZ=UTC",
			"--entrypoint", "/bin/sh", DefaultImage, "-c", "true",
		}
		assertArgs(t, got, want)
	})

	t.Run("rootless docker runs as container root", func(t *testing.T) {
		// Rootless docker has no keep-id: any other uid maps to a subordinate
		// id that cannot write the bind mount.
		got := argsFor(t, ContainerConfig{Runtime: RuntimeDocker, Rootless: true}, "n", "/w", "true")
		if !containsPair(got, "--user", "0:0") {
			t.Errorf("argv has no --user 0:0: %v", got)
		}
		if containsString(got, "keep-id") {
			t.Errorf("rootless docker must not ask for keep-id: %v", got)
		}
	})

	t.Run("rootless podman keeps the caller's id", func(t *testing.T) {
		got := argsFor(t, ContainerConfig{Runtime: RuntimePodman, Rootless: true}, "n", "/w", "true")
		if !containsPair(got, "--user", fmt.Sprintf("%d:%d", os.Getuid(), os.Getgid())) {
			t.Errorf("argv has no --user for this uid: %v", got)
		}
		if !containsPair(got, "--userns", "keep-id") {
			t.Errorf("argv has no --userns keep-id: %v", got)
		}
	})

	t.Run("image user stays the image's", func(t *testing.T) {
		got := argsFor(t, ContainerConfig{Runtime: RuntimeDocker, User: "image", Rootless: true}, "n", "/w", "true")
		if containsString(got, "--user") || containsString(got, "keep-id") {
			t.Errorf("image user must not add --user or --userns: %v", got)
		}
	})

	t.Run("refusals", func(t *testing.T) {
		if _, err := ContainerCreateArgs(ContainerConfig{Runtime: RuntimeDocker}, "bad name", "/w", "true"); err == nil {
			t.Error("an invalid container name must be refused")
		}
		if _, err := ContainerCreateArgs(ContainerConfig{Runtime: RuntimeDocker}, "ok", "/w,comma", "true"); err == nil {
			t.Error("a working directory with a comma must be refused")
		}
		if _, err := ContainerCreateArgs(ContainerConfig{Network: "host"}, "ok", "/w", "true"); err == nil {
			t.Error("an invalid config must be refused")
		}
	})
}

func assertArgs(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("argv = %v (%d entries), want %v (%d entries)", got, len(got), want, len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("argv[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

// containsPair reports whether the argv holds the option immediately followed
// by the value.
func containsPair(args []string, option, value string) bool {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == option && args[i+1] == value {
			return true
		}
	}
	return false
}

func TestContainerName(t *testing.T) {
	name := ContainerName("job/with spaces!")
	if !strings.HasPrefix(name, "kvarm-job-job-with-spaces--") {
		t.Errorf("ContainerName = %q", name)
	}
	uuidPart := name[strings.LastIndex(name, "-")+1:]
	if len(uuidPart) != 16 {
		t.Errorf("unique suffix = %q, want 16 hex digits", uuidPart)
	}

	long := ContainerName(strings.Repeat("a", 100))
	if want := "kvarm-job-" + strings.Repeat("a", 40) + "-"; !strings.HasPrefix(long, want) {
		t.Errorf("ContainerName of a long id = %q, want prefix %q", long, want)
	}
	if empty := ContainerName(""); !strings.HasPrefix(empty, "kvarm-job-job-") {
		t.Errorf("ContainerName of an empty id = %q", empty)
	}
	// Two attempts of the same job must never collide.
	if ContainerName("job1") == ContainerName("job1") {
		t.Error("two container names for one job are identical")
	}
}

func TestContainerEnvironment(t *testing.T) {
	t.Setenv("TZ", "UTC")
	t.Setenv("PATH", "/some/host/path")
	env := ContainerEnvironment()
	if !hasEnv(env, "GIT_TERMINAL_PROMPT", "0") || !hasEnv(env, "HOME", "/tmp") || !hasEnv(env, "LANG", "C.UTF-8") {
		t.Errorf("container environment = %v", env)
	}
	if !hasEnv(env, "TZ", "UTC") {
		t.Errorf("TZ did not cross into the container: %v", env)
	}
	if hasEnvKey(env, "PATH") {
		t.Errorf("the host PATH crossed into the container: %v", env)
	}

	old, hadTZ := os.LookupEnv("TZ")
	if err := os.Unsetenv("TZ"); err != nil {
		t.Fatalf("unsetenv: %v", err)
	}
	t.Cleanup(func() {
		if hadTZ {
			_ = os.Setenv("TZ", old)
		}
	})
	if hasEnvKey(ContainerEnvironment(), "TZ") {
		t.Error("TZ was set in the container environment with no host TZ")
	}
}

func hasEnv(env [][2]string, key, value string) bool {
	for _, kv := range env {
		if kv[0] == key && kv[1] == value {
			return true
		}
	}
	return false
}

func hasEnvKey(env [][2]string, key string) bool {
	for _, kv := range env {
		if kv[0] == key {
			return true
		}
	}
	return false
}

func TestBounded(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want int // rune length
	}{
		{"short", "hello", len("hello")},
		{"exactly the limit", strings.Repeat("a", OutputLimit), OutputLimit},
		{"over the limit", strings.Repeat("a", OutputLimit+10), OutputLimit + len([]rune(Truncated))},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Bounded(tt.in)
			if n := len([]rune(got)); n != tt.want {
				t.Errorf("Bounded length = %d runes, want %d", n, tt.want)
			}
			if tt.want > OutputLimit && !strings.HasSuffix(got, Truncated) {
				t.Errorf("Bounded output does not end with the marker: %q", got[len(got)-40:])
			}
		})
	}
	// Cutting on rune boundaries must not split a multi-byte character.
	multi := strings.Repeat("é", OutputLimit+5)
	got := Bounded(multi)
	if !strings.HasSuffix(got, Truncated) {
		t.Fatalf("Bounded did not mark the cut: %q", got)
	}
	if !utf8.ValidString(got) {
		t.Error("Bounded split a multi-byte character")
	}
}

func TestExecuteShellCapturesOutput(t *testing.T) {
	tests := []struct {
		name     string
		command  string
		wantCode *int
		stdout   string
		stderr   string
	}{
		{"exit 0", "printf out", intPtr(0), "out", ""},
		{"exit 7", "printf bad >&2; exit 7", intPtr(7), "", "bad"},
		{"both streams", "echo hello; echo oops >&2", intPtr(0), "hello\n", "oops\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := ExecuteShell(tt.command, t.TempDir(), 10)
			if err != nil {
				t.Fatalf("ExecuteShell: %v", err)
			}
			if !equalCodes(res.Code, tt.wantCode) {
				t.Errorf("code = %v, want %v", codeText(res.Code), codeText(tt.wantCode))
			}
			if res.Stdout != tt.stdout || res.Stderr != tt.stderr {
				t.Errorf("stdout/stderr = %q/%q, want %q/%q", res.Stdout, res.Stderr, tt.stdout, tt.stderr)
			}
			if res.TimedOut {
				t.Error("TimedOut = true for a command that finished")
			}
			if res.DurationMS < 0 {
				t.Errorf("DurationMS = %d", res.DurationMS)
			}
		})
	}
}

func TestExecuteShellRunsInTheGivenDirectory(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "marker.txt"), []byte("here\n"), 0o644); err != nil {
		t.Fatalf("writing the marker: %v", err)
	}
	res, err := ExecuteShell("pwd; cat marker.txt", dir, 10)
	if err != nil {
		t.Fatalf("ExecuteShell: %v", err)
	}
	want, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("resolving the temp dir: %v", err)
	}
	if !strings.Contains(res.Stdout, want) || !strings.Contains(res.Stdout, "here") {
		t.Errorf("stdout = %q, want the cwd %q and the marker", res.Stdout, want)
	}
}

func TestExecuteShellFiltersTheEnvironment(t *testing.T) {
	// Inherited credentials must never reach a repository command.
	t.Setenv("KVARM_PAT", "kvarm_pat_secret")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "aws-secret")
	t.Setenv("GIT_CONFIG_GLOBAL", "/home/user/.gitconfig")
	t.Setenv("LANG", "C")
	t.Setenv("LC_ALL", "C")
	t.Setenv("TZ", "UTC")
	t.Setenv("TMPDIR", t.TempDir())

	res, err := ExecuteShell("env", t.TempDir(), 10)
	if err != nil {
		t.Fatalf("ExecuteShell: %v", err)
	}
	got := map[string]string{}
	for _, line := range strings.Split(res.Stdout, "\n") {
		if i := strings.IndexByte(line, '='); i > 0 {
			got[line[:i]] = line[i+1:]
		}
	}
	// PWD (and possibly SHLVL/_ on other shells) is the shell's own addition.
	tolerated := map[string]bool{"PWD": true, "SHLVL": true, "_": true}
	for key := range got {
		upper := strings.ToUpper(key)
		allowed := tolerated[key] || strings.HasPrefix(upper, "LC_") ||
			upper == "PATH" || upper == "HOME" || upper == "LANG" || upper == "TZ" ||
			upper == "TMPDIR" || upper == "GIT_TERMINAL_PROMPT"
		if !allowed {
			t.Errorf("%s crossed into the repository command", key)
		}
	}
	for key, want := range map[string]string{
		"LANG": "C", "LC_ALL": "C", "TZ": "UTC", "GIT_TERMINAL_PROMPT": "0", "TMPDIR": os.Getenv("TMPDIR"),
	} {
		if got[key] != want {
			t.Errorf("%s = %q, want %q", key, got[key], want)
		}
	}
	if _, ok := got["PATH"]; !ok {
		t.Error("PATH is missing from the repository command's environment")
	}
}

func TestExecuteShellTimeoutKillsTheCommand(t *testing.T) {
	started := time.Now()
	res, err := ExecuteShell("sleep 5", t.TempDir(), 1)
	if err != nil {
		t.Fatalf("ExecuteShell: %v", err)
	}
	if !res.TimedOut {
		t.Fatalf("TimedOut = false after the 1 s timeout (code %v)", codeText(res.Code))
	}
	if res.Code != nil {
		t.Errorf("code = %d, want nil for a killed process", *res.Code)
	}
	if elapsed := time.Since(started); elapsed > 4*time.Second {
		t.Errorf("the command took %s; the kill did not take effect", elapsed)
	}
}

func TestExecuteShellTruncatesLongOutput(t *testing.T) {
	// 20 KiB of output through a 16 KiB budget.
	res, err := ExecuteShell("head -c 20000 /dev/zero | tr '\\0' 'x'", t.TempDir(), 10)
	if err != nil {
		t.Fatalf("ExecuteShell: %v", err)
	}
	if !strings.HasSuffix(res.Stdout, Truncated) {
		t.Fatalf("stdout does not end with the truncation marker: %q", res.Stdout)
	}
	if n := len([]rune(res.Stdout)); n != OutputLimit+len([]rune(Truncated)) {
		t.Errorf("stdout = %d runes, want %d", n, OutputLimit+len([]rune(Truncated)))
	}
}

func TestDetectRuntime(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	if _, err := exec.LookPath("podman"); err != nil {
		if probe := DetectRuntime(ctx, RuntimePodman); probe != nil {
			t.Errorf("DetectRuntime(podman) = %+v with no podman installed", probe)
		}
	}
	probe := DetectRuntime(ctx, "")
	if probe == nil {
		t.Skip("no container runtime answered; docker/podman tests need one")
	}
	if probe.Runtime != RuntimeDocker && probe.Runtime != RuntimePodman {
		t.Errorf("DetectRuntime = %+v", probe)
	}
	if preferred := DetectRuntime(ctx, probe.Runtime); preferred == nil || preferred.Runtime != probe.Runtime {
		t.Errorf("DetectRuntime(preferred=%s) = %+v", probe.Runtime, preferred)
	}
}

// installFakeRuntime puts a stand-in docker and podman first on PATH: each
// invocation appends its argv to the call log and then runs body.
func installFakeRuntime(t *testing.T, body string) (logPath string) {
	t.Helper()
	dir := t.TempDir()
	logPath = filepath.Join(dir, "calls.log")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$KVARM_TEST_RUNTIME_LOG\"\n" + body + "\n"
	for _, name := range []string{"docker", "podman"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0o755); err != nil {
			t.Fatalf("writing the fake %s: %v", name, err)
		}
	}
	t.Setenv("KVARM_TEST_RUNTIME_LOG", logPath)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return logPath
}

// waitForCalls waits for the log to hold at least want invocations.
func waitForCalls(t *testing.T, logPath string, want int) []string {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	var last string
	for {
		data, err := os.ReadFile(logPath)
		if err == nil {
			last = string(data)
			if lines := splitLines(last); len(lines) >= want {
				return lines
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("the runtime was not called %d times within the deadline (log %q)", want, last)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func splitLines(text string) []string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		if line != "" {
			out = append(out, line)
		}
	}
	return out
}

func TestExecuteContainerCreatesThenStarts(t *testing.T) {
	logPath := installFakeRuntime(t, `case "$1" in
  create) exit 0 ;;
  start) echo "hello from the container"; exit 0 ;;
  *) exit 0 ;;
esac`)

	res, err := ExecuteContainer(context.Background(), "echo hi", "/tmp/work", 10,
		ContainerConfig{Runtime: RuntimeDocker, User: "1000:1000"}, "kvarm-job-abc", 5_000)
	if err != nil {
		t.Fatalf("ExecuteContainer: %v", err)
	}
	if res.Code == nil || *res.Code != 0 || res.TimedOut {
		t.Errorf("result = %+v, want exit 0", res)
	}
	if res.Stdout != "hello from the container\n" {
		t.Errorf("stdout = %q", res.Stdout)
	}
	calls := waitForCalls(t, logPath, 2)
	if !strings.HasPrefix(calls[0], "create --rm --name kvarm-job-abc ") {
		t.Errorf("first call = %q, want create", calls[0])
	}
	if calls[1] != "start --attach kvarm-job-abc" {
		t.Errorf("second call = %q, want start --attach", calls[1])
	}
	if !strings.Contains(calls[0], "--mount type=bind,source=/tmp/work,target=/workspace") {
		t.Errorf("create call = %q, want the bind mount", calls[0])
	}
}

func TestExecuteContainerCreateFailure(t *testing.T) {
	logPath := installFakeRuntime(t, `case "$1" in
  create) echo "no such image" >&2; exit 3 ;;
  *) exit 0 ;;
esac`)

	res, err := ExecuteContainer(context.Background(), "echo hi", "/tmp/work", 10,
		ContainerConfig{Runtime: RuntimeDocker, User: "1000:1000"}, "kvarm-job-abc", 5_000)
	if err != nil {
		t.Fatalf("ExecuteContainer: %v", err)
	}
	if res.Code == nil || *res.Code != 3 || res.TimedOut {
		t.Errorf("result = %+v, want exit 3 and no timeout", res)
	}
	if res.Stdout != "" || res.Stderr != "docker create failed\nno such image\n" {
		t.Errorf("stdout/stderr = %q/%q", res.Stdout, res.Stderr)
	}
	// A container that never ran must still be force-removed.
	calls := waitForCalls(t, logPath, 2)
	if calls[1] != "rm --force kvarm-job-abc" {
		t.Errorf("second call = %q, want the force remove", calls[1])
	}
}

func TestExecuteContainerCreateTimeout(t *testing.T) {
	// `exec` makes the sleeper the direct child, so the create timeout's kill
	// does not have to wait for an orphaned grandchild holding the pipe.
	installFakeRuntime(t, `case "$1" in
  create) exec sleep 10 ;;
  *) exit 0 ;;
esac`)

	res, err := ExecuteContainer(context.Background(), "echo hi", "/tmp/work", 10,
		ContainerConfig{Runtime: RuntimePodman, User: "1000:1000"}, "kvarm-job-slow", 1_000)
	if err != nil {
		t.Fatalf("ExecuteContainer: %v", err)
	}
	if res.TimedOut {
		t.Error("a create timeout is not a job timeout")
	}
	if res.Code != nil {
		t.Errorf("code = %d, want nil for a killed create", *res.Code)
	}
	if !strings.Contains(res.Stderr, "creating the container (pulling node:24-bookworm) took longer than 1 s") {
		t.Errorf("stderr = %q", res.Stderr)
	}
}

func TestExecuteContainerTimeout(t *testing.T) {
	installFakeRuntime(t, `case "$1" in
  create) exit 0 ;;
  start) sleep 2; exit 0 ;;
  *) exit 0 ;;
esac`)

	started := time.Now()
	res, err := ExecuteContainer(context.Background(), "echo hi", "/tmp/work", 1,
		ContainerConfig{Runtime: RuntimeDocker, User: "1000:1000"}, "kvarm-job-slow", 5_000)
	if err != nil {
		t.Fatalf("ExecuteContainer: %v", err)
	}
	if !res.TimedOut {
		t.Fatalf("TimedOut = false after the 1 s deadline (code %v)", codeText(res.Code))
	}
	if res.DurationMS < 1_000 {
		t.Errorf("DurationMS = %d, want the time the attach ran", res.DurationMS)
	}
	if elapsed := time.Since(started); elapsed > 4*time.Second {
		t.Errorf("the container run took %s", elapsed)
	}
}

func TestExecuteContainerRefusesABadConfig(t *testing.T) {
	installFakeRuntime(t, "exit 0")
	if _, err := ExecuteContainer(context.Background(), "echo hi", "/tmp/work,comma", 10,
		ContainerConfig{Runtime: RuntimeDocker}, "kvarm-job-abc", 5_000); err == nil {
		t.Fatal("a comma in the working directory must be refused before anything runs")
	}
}

func intPtr(n int) *int { return &n }

func equalCodes(got, want *int) bool {
	if got == nil || want == nil {
		return got == nil && want == nil
	}
	return *got == *want
}

func codeText(code *int) string {
	if code == nil {
		return "null"
	}
	return fmt.Sprintf("%d", *code)
}
