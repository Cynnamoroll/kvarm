package executor

import (
	"bytes"
	"context"
	"crypto/rand"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
	"time"
)

// ExecResult is one executed command's outcome. Code is nil when the process
// died by signal (the JS CLI's `code: null`).
type ExecResult struct {
	Code       *int
	Stdout     string
	Stderr     string
	TimedOut   bool
	DurationMS int64
}

// repositoryEnvironment is the environment a repository command may see:
// locale, time zone and the host paths a host shell needs. Inherited
// credentials (KVARM_*, GIT_*, cloud keys) never pass. This is not a
// sandbox: a host command still has this user's files and network.
func repositoryEnvironment() map[string]string {
	portable := map[string]bool{"PATH": true, "HOME": true, "LANG": true, "TZ": true, "TMPDIR": true}
	env := map[string]string{}
	for _, kv := range os.Environ() {
		i := strings.IndexByte(kv, '=')
		if i <= 0 {
			continue
		}
		key, value := kv[:i], kv[i+1:]
		upper := strings.ToUpper(key)
		if portable[upper] || strings.HasPrefix(upper, "LC_") {
			env[key] = value
		}
	}
	env["GIT_TERMINAL_PROMPT"] = "0"
	return env
}

// ContainerEnvironment is the filtered environment for a container: host
// paths (PATH, HOME, TMPDIR) would be wrong inside the image and host
// locales often name ones the image lacks (macOS sets LC_CTYPE=UTF-8), so
// only TZ crosses; the locale is the image's C.UTF-8 and HOME its /tmp.
func ContainerEnvironment() [][2]string {
	out := [][2]string{
		{"GIT_TERMINAL_PROMPT", "0"},
		{"HOME", "/tmp"},
		{"LANG", "C.UTF-8"},
	}
	if tz, ok := repositoryEnvironment()["TZ"]; ok {
		out = append(out, [2]string{"TZ", tz})
	}
	return out
}

// hostUser is the container user that keeps bind-mount files owned by this
// user, when the platform has numeric ids.
func hostUser() string {
	uid, gid := os.Getuid(), os.Getgid()
	if uid < 0 || gid < 0 {
		return ""
	}
	return fmt.Sprintf("%d:%d", uid, gid)
}

// ContainerName is a container name unique to one job attempt.
func ContainerName(jobID string) string {
	safe := make([]byte, 0, len(jobID))
	for i := 0; i < len(jobID); i++ {
		c := jobID[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '.' || c == '-' {
			safe = append(safe, c)
		} else {
			safe = append(safe, '-')
		}
	}
	name := string(safe)
	if len(name) > 40 {
		name = name[:40]
	}
	if name == "" {
		name = "job"
	}
	return fmt.Sprintf("kvarm-job-%s-%s", name, uuid8())
}

func uuid8() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "00000000"
	}
	return fmt.Sprintf("%x", b)
}

// ContainerCreateArgs builds `<runtime> create …` for one job: removed on
// exit, named so a timeout can kill it, the working directory as the only
// writable host mount, a read-only root with a private /tmp, no
// capabilities, no privilege escalation, CPU/memory/pids limits and the
// filtered environment.
func ContainerCreateArgs(config ContainerConfig, name, workdir, command string) ([]string, error) {
	if problem := ConfigError(config); problem != "" {
		return nil, fmt.Errorf("%s", problem)
	}
	if !nameRe.MatchString(name) {
		return nil, fmt.Errorf("invalid container name %q", name)
	}
	// --mount is comma-separated key=value; a comma in the path would split it.
	if strings.Contains(workdir, ",") {
		return nil, fmt.Errorf("the working directory %q contains a comma, which a bind mount cannot carry", workdir)
	}
	cpus, memory, pids := DefaultCPUS, DefaultMemory, DefaultPidsLimit
	if config.CPUS != "" {
		cpus = config.CPUS
	}
	if config.Memory != "" {
		memory = config.Memory
	}
	if config.PidsLimit != nil {
		pids = *config.PidsLimit
	}
	user := ""
	switch config.User {
	case "image":
		// Keep the image's user, often root, whose files a rootful runtime
		// then leaves root-owned in the working directory.
	case "":
		// Rootless docker has no keep-id: container root is this user on the
		// host, while any other uid maps to a subordinate id that cannot
		// write the bind mount.
		if config.Runtime == RuntimeDocker && config.Rootless {
			user = "0:0"
		} else {
			user = hostUser()
		}
	default:
		user = config.User
	}
	args := []string{
		"create",
		"--rm",
		"--name", name,
		"--init",
		"--mount", "type=bind,source=" + workdir + ",target=" + ContainerWorkdir,
		"--workdir", ContainerWorkdir,
		"--read-only",
		"--tmpfs", "/tmp:rw,exec",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--cpus", cpus,
		"--memory", memory,
		"--pids-limit", fmt.Sprintf("%d", pids),
	}
	if user != "" {
		args = append(args, "--user", user)
		// Rootless podman maps container ids into subordinate ranges; keep-id
		// maps this user's id through so the bind mount stays writable.
		if config.Runtime == RuntimePodman && config.Rootless {
			args = append(args, "--userns", "keep-id")
		}
	}
	if config.Network != "" {
		args = append(args, "--network", config.Network)
	}
	for _, kv := range ContainerEnvironment() {
		args = append(args, "--env", kv[0]+"="+kv[1])
	}
	image := config.Image
	if image == "" {
		image = DefaultImage
	}
	args = append(args, "--entrypoint", "/bin/sh", image, "-c", command)
	return args, nil
}

// boundedWriter accumulates output up to a hair over the limit; the final
// trim happens in Bounded so the marker keeps its place.
type boundedWriter struct {
	buf bytes.Buffer
}

func (w *boundedWriter) Write(p []byte) (int, error) {
	if w.buf.Len() >= OutputLimit+1 {
		return len(p), nil
	}
	w.buf.Write(p)
	if w.buf.Len() > OutputLimit+1 {
		w.buf.Truncate(OutputLimit + 1)
	}
	return len(p), nil
}

func (w *boundedWriter) String() string { return Bounded(w.buf.String()) }

// ExecuteShell runs a command in a host shell with the filtered
// environment, killing its whole process group on timeout. shell:true in
// Node picked /bin/sh on POSIX and cmd.exe on Windows; the same here.
func ExecuteShell(command, cwd string, timeoutSeconds int) (ExecResult, error) {
	grouped := runtime.GOOS != "windows"
	env := repositoryEnvironment()
	started := time.Now()
	cmd := exec.Command("sh", "-c", command)
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd", "/C", command)
	}
	cmd.Dir = cwd
	cmd.Env = envMapSlice(env)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: grouped}
	var stdout, stderr boundedWriter
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Start(); err != nil {
		return ExecResult{}, err
	}
	timedOut := false
	timer := time.AfterFunc(time.Duration(timeoutSeconds)*time.Second, func() {
		timedOut = true
		signalGroup(cmd, syscall.SIGTERM, grouped)
		time.AfterFunc(KillGraceMS*time.Millisecond, func() { signalGroup(cmd, syscall.SIGKILL, grouped) })
	})
	err := cmd.Wait()
	timer.Stop()
	code := exitCode(cmd, err)
	return ExecResult{Code: code, Stdout: stdout.String(), Stderr: stderr.String(), TimedOut: timedOut, DurationMS: millisSince(started)}, nil
}

// signalGroup kills the whole process group, best-effort: an exited child
// must not throw from a timer callback.
func signalGroup(cmd *exec.Cmd, sig syscall.Signal, grouped bool) {
	if cmd.Process == nil {
		return
	}
	if grouped {
		_ = syscall.Kill(-cmd.Process.Pid, sig)
		return
	}
	_ = cmd.Process.Signal(sig)
}

// exitCode maps a Wait result onto the JS CLI's number|null.
func exitCode(cmd *exec.Cmd, err error) *int {
	if err == nil {
		code := cmd.ProcessState.ExitCode()
		return &code
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		if code := exitErr.ExitCode(); code >= 0 {
			return &code
		}
	}
	return nil
}

func millisSince(start time.Time) int64 {
	return time.Since(start).Milliseconds()
}

// runClient runs a runtime client to completion with bounded output and a
// hard timeout (SIGKILL).
func runClient(ctx context.Context, name string, args []string, timeoutMS int64) (ExecResult, error) {
	started := time.Now()
	cancelCtx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(cancelCtx, name, args...)
	var stdout, stderr boundedWriter
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	timer := time.AfterFunc(time.Duration(timeoutMS)*time.Millisecond, cancel)
	err := cmd.Run()
	timer.Stop()
	timedOut := cancelCtx.Err() != nil
	cancel()
	code := exitCode(cmd, err)
	return ExecResult{Code: code, Stdout: stdout.String(), Stderr: stderr.String(), TimedOut: timedOut, DurationMS: millisSince(started)}, nil
}

// ExecuteContainer runs a command in a container. The container is created
// first, so an image pull never counts against the job's timeout and the
// container exists before the timer can fire; then `start --attach` runs
// it. On timeout the container is killed by name (killing only the attached
// client would leave it running), then the client after a grace period, then
// the container is force-removed in case --rm never saw it stop.
func ExecuteContainer(ctx context.Context, command, cwd string, timeoutSeconds int, config ContainerConfig, name string, createTimeoutMS int64) (ExecResult, error) {
	if createTimeoutMS <= 0 {
		createTimeoutMS = CreateTimeoutMS
	}
	createArgs, err := ContainerCreateArgs(config, name, cwd, command)
	if err != nil {
		return ExecResult{}, err
	}
	// The runtime client needs its own configuration (DOCKER_HOST, config
	// dirs); it forwards nothing to the container beyond the --env pairs.
	created, err := runClient(ctx, string(config.Runtime), createArgs, createTimeoutMS)
	if err != nil {
		fireAndForget(string(config.Runtime), "rm", "--force", name)
		return ExecResult{}, err
	}
	if created.Code == nil || *created.Code != 0 || created.TimedOut {
		fireAndForget(string(config.Runtime), "rm", "--force", name)
		why := fmt.Sprintf("%s create failed", config.Runtime)
		if created.TimedOut {
			why = fmt.Sprintf("creating the container (pulling %s) took longer than %.0f s", imageOrDefault(config), float64(createTimeoutMS)/1000)
		}
		return ExecResult{Code: created.Code, Stdout: "", Stderr: Bounded(why + "\n" + created.Stderr), TimedOut: false, DurationMS: created.DurationMS}, nil
	}
	started := time.Now()
	cancelCtx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(cancelCtx, string(config.Runtime), "start", "--attach", name)
	var stdout, stderr boundedWriter
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Start(); err != nil {
		cancel()
		fireAndForget(string(config.Runtime), "rm", "--force", name)
		return ExecResult{}, err
	}
	timedOut := false
	timer := time.AfterFunc(time.Duration(timeoutSeconds)*time.Second, func() {
		timedOut = true
		fireAndForget(string(config.Runtime), "kill", name)
		time.AfterFunc(KillGraceMS*time.Millisecond, func() {
			cancel()
			fireAndForget(string(config.Runtime), "rm", "--force", name)
		})
	})
	err = cmd.Wait()
	timer.Stop()
	code := exitCode(cmd, err)
	cancel()
	return ExecResult{Code: code, Stdout: stdout.String(), Stderr: stderr.String(), TimedOut: timedOut, DurationMS: millisSince(started)}, nil
}

func imageOrDefault(config ContainerConfig) string {
	if config.Image != "" {
		return config.Image
	}
	return DefaultImage
}

// fireAndForget runs a best-effort runtime command whose outcome does not
// matter.
func fireAndForget(rtName string, args ...string) {
	cmd := exec.Command(rtName, args...)
	cmd.Stdout, cmd.Stderr, cmd.Stdin = nil, nil, nil
	_ = cmd.Start()
}

// probeArgs asks each runtime whether its daemon answers and whether it
// runs rootless.
var probeArgs = map[ContainerRuntime][]string{
	RuntimeDocker: {"info", "--format", "{{json .SecurityOptions}}"},
	RuntimePodman: {"info", "--format", "{{.Host.Security.Rootless}}"},
}

// DetectRuntime returns the first container runtime whose daemon answers
// `info`, the preferred one only when set, or nil.
func DetectRuntime(ctx context.Context, preferred ContainerRuntime) *RuntimeProbe {
	candidates := ContainerRuntimes
	if preferred != "" {
		candidates = []string{string(preferred)}
	}
	for _, name := range candidates {
		result, err := runClient(ctx, name, probeArgs[ContainerRuntime(name)], DetectTimeoutMS)
		if err != nil || result.Code == nil || *result.Code != 0 || result.TimedOut {
			continue
		}
		runtimeName := ContainerRuntime(name)
		rootless := false
		if runtimeName == RuntimeDocker {
			rootless = strings.Contains(result.Stdout, "rootless")
		} else {
			rootless = strings.TrimSpace(result.Stdout) == "true"
		}
		return &RuntimeProbe{Runtime: runtimeName, Rootless: rootless}
	}
	return nil
}

func envMapSlice(env map[string]string) []string {
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}
