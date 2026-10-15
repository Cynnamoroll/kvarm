package workdir

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"kvarm/cli/internal/errs"
)

const (
	testSHA  = "0123456789abcdef0123456789abcdef01234567"
	otherSHA = "fedcba9876543210fedcba9876543210fedcba98"
)

// sink collects the diagnostic lines a runner's stderr would show.
type sink struct{ lines []string }

func (s *sink) write(line string) { s.lines = append(s.lines, line) }

func (s *sink) joined() string { return strings.Join(s.lines, "\n") }

// put writes one file below dir, creating its parents and setting its mode.
func put(t *testing.T, dir, name, content string, perm os.FileMode) string {
	t.Helper()
	full := underPath(dir, name)
	if err := os.MkdirAll(filepath.Dir(full), 0o777); err != nil {
		t.Fatalf("mkdir for %s: %v", name, err)
	}
	if err := os.WriteFile(full, []byte(content), perm); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	if err := os.Chmod(full, perm); err != nil {
		t.Fatalf("chmod %s: %v", name, err)
	}
	return full
}

// link points name at target, both below dir.
func link(t *testing.T, dir, name, target string) {
	t.Helper()
	full := underPath(dir, name)
	if err := os.MkdirAll(filepath.Dir(full), 0o777); err != nil {
		t.Fatalf("mkdir for %s: %v", name, err)
	}
	if err := os.Symlink(target, full); err != nil {
		t.Fatalf("symlink %s: %v", name, err)
	}
}

func readAt(t *testing.T, dir, name string) string {
	t.Helper()
	content, err := os.ReadFile(underPath(dir, name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(content)
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// recordDir is the state a slot records right after a checkout of dir.
func recordDir(t *testing.T, dir string) RecordedState {
	t.Helper()
	files, err := ListTree(dir)
	if err != nil {
		t.Fatalf("ListTree: %v", err)
	}
	tree, err := scanTree(dir, files)
	if err != nil {
		t.Fatalf("scanTree: %v", err)
	}
	return RecordedState{SHA: testSHA, Files: tree.Files, Blobs: tree.Blobs, Modes: tree.Modes}
}

func parseStateFile(t *testing.T, path string) RecordedState {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	state, err := ParseState(body)
	if err != nil {
		t.Fatalf("ParseState: %v", err)
	}
	return state
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func str(s string) *string { return &s }

// writeLock puts a lock body at path, creating the slot directory around it.
func writeLock(t *testing.T, path string, owner lockOwner) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
		t.Fatalf("mkdir for lock: %v", err)
	}
	body, err := json.Marshal(owner)
	if err != nil {
		t.Fatalf("marshal lock: %v", err)
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatalf("write lock: %v", err)
	}
}

// deadPID runs a process to completion and returns a pid the kernel has
// reaped, so a lock naming it is provably reclaimable.
func deadPID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command("/bin/sh", "-c", "exit 0")
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot start a helper process: %v", err)
	}
	pid := cmd.Process.Pid
	// Wait reaps the child; an unreaped zombie still answers signal 0.
	if err := cmd.Wait(); err != nil {
		t.Skipf("helper process failed: %v", err)
	}
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Skipf("pid %d is still live after reaping; cannot prove a dead owner here", pid)
	}
	return pid
}

func TestSlotPathsLayout(t *testing.T) {
	got, err := SlotPaths("/work", "alice/demo", 3)
	if err != nil {
		t.Fatalf("SlotPaths: %v", err)
	}
	dir := filepath.Join("/work", "alice", "demo", "slot-3")
	want := SlotPathsResult{
		Dir:     dir,
		Lock:    dir + ".lock",
		Work:    filepath.Join(dir, "work"),
		Staging: filepath.Join(dir, "staging"),
		State:   filepath.Join(dir, "state.json"),
	}
	if got != want {
		t.Fatalf("SlotPaths = %+v, want %+v", got, want)
	}
}

func TestSlotPathsRefusesUnsafeRepo(t *testing.T) {
	for _, repoID := range []string{"", "x", "alice", "alice/..", "../demo", "alice/./demo", "/demo"} {
		_, err := SlotPaths("/work", repoID, 0)
		if err == nil {
			t.Errorf("SlotPaths(%q) accepted an unusable repository", repoID)
			continue
		}
		var cliErr *errs.CliError
		if !errors.As(err, &cliErr) {
			t.Errorf("SlotPaths(%q) error is %T, want *errs.CliError", repoID, err)
			continue
		}
		if cliErr.ExitCode != 2 {
			t.Errorf("SlotPaths(%q) exit code = %d, want 2", repoID, cliErr.ExitCode)
		}
	}
}

func TestOpenTakesNextFreeSlot(t *testing.T) {
	workRoot := t.TempDir()
	first := Open(OpenOptions{WorkRoot: workRoot, Repo: "alice/demo", TempRoot: t.TempDir(), Stderr: func(string) {}})
	defer first.Release()
	want0, err := SlotPaths(workRoot, "alice/demo", 0)
	if err != nil {
		t.Fatalf("SlotPaths: %v", err)
	}
	if first.Dir != want0.Dir || first.Work != want0.Work || first.Staging != want0.Staging || first.State != want0.State {
		t.Fatalf("first slot = %+v, want %+v", first, want0)
	}
	if !first.Persistent {
		t.Fatal("a free slot must be persistent")
	}
	body, err := os.ReadFile(first.Lock)
	if err != nil {
		t.Fatalf("read lock: %v", err)
	}
	var owner lockOwner
	if err := json.Unmarshal(body, &owner); err != nil {
		t.Fatalf("lock body %s: %v", body, err)
	}
	host, err := os.Hostname()
	if err != nil {
		t.Fatalf("hostname: %v", err)
	}
	if owner.PID != os.Getpid() || owner.Host != host || owner.Token != first.token {
		t.Fatalf("lock body %+v does not name this process (pid %d, host %s, token %s)", owner, os.Getpid(), host, first.token)
	}
	if !exists(first.Dir) {
		t.Fatal("open slot directory is missing")
	}

	// The lock belongs to a live owner — this very process — so a second open
	// moves on to the next slot instead of sharing the first.
	second := Open(OpenOptions{WorkRoot: workRoot, Repo: "alice/demo", TempRoot: t.TempDir(), Stderr: func(string) {}})
	defer second.Release()
	want1, err := SlotPaths(workRoot, "alice/demo", 1)
	if err != nil {
		t.Fatalf("SlotPaths: %v", err)
	}
	if second.Dir != want1.Dir {
		t.Fatalf("second slot = %s, want %s", second.Dir, want1.Dir)
	}
}

func TestReleaseRemovesOnlyItsOwnLock(t *testing.T) {
	workRoot := t.TempDir()
	first := Open(OpenOptions{WorkRoot: workRoot, Repo: "alice/demo", TempRoot: t.TempDir(), Stderr: func(string) {}})
	defer first.Release()
	second := Open(OpenOptions{WorkRoot: workRoot, Repo: "alice/demo", TempRoot: t.TempDir(), Stderr: func(string) {}})
	defer second.Release()

	second.Release()
	if !exists(first.Lock) {
		t.Fatal("releasing one slot removed another slot's lock")
	}
	if exists(second.Lock) {
		t.Fatal("releasing a slot left its own lock behind")
	}
	first.Release()
	if exists(first.Lock) {
		t.Fatal("releasing a slot left its own lock behind")
	}
}

func TestReleaseLeavesALockItDoesNotOwn(t *testing.T) {
	workRoot := t.TempDir()
	slot := Open(OpenOptions{WorkRoot: workRoot, Repo: "alice/demo", TempRoot: t.TempDir(), Stderr: func(string) {}})
	defer slot.Release()
	writeLock(t, slot.Lock, lockOwner{PID: os.Getpid(), Host: "somewhere-else.invalid", Token: "someone-else"})

	slot.Release()
	if !exists(slot.Lock) {
		t.Fatal("a lock another owner holds must survive Release")
	}
	body, err := os.ReadFile(slot.Lock)
	if err != nil {
		t.Fatalf("read lock: %v", err)
	}
	if !strings.Contains(string(body), "someone-else") {
		t.Fatalf("Release rewrote the lock: %s", body)
	}
}

func TestOpenReclaimsDeadOwnerLock(t *testing.T) {
	workRoot := t.TempDir()
	paths, err := SlotPaths(workRoot, "alice/demo", 0)
	if err != nil {
		t.Fatalf("SlotPaths: %v", err)
	}
	host, err := os.Hostname()
	if err != nil {
		t.Fatalf("hostname: %v", err)
	}
	writeLock(t, paths.Lock, lockOwner{PID: deadPID(t), Host: host, Token: "crashed"})

	slot := Open(OpenOptions{WorkRoot: workRoot, Repo: "alice/demo", TempRoot: t.TempDir(), Stderr: func(string) {}})
	defer slot.Release()
	if slot.Dir != paths.Dir {
		t.Fatalf("a dead owner's slot was not reclaimed: got %s, want %s", slot.Dir, paths.Dir)
	}
	body, err := os.ReadFile(slot.Lock)
	if err != nil {
		t.Fatalf("read lock: %v", err)
	}
	if strings.Contains(string(body), "crashed") {
		t.Fatalf("the reclaimed lock still names the dead owner: %s", body)
	}
	if exists(paths.Lock + ".steal") {
		t.Fatal("the reclaim left its steal file behind")
	}
}

func TestOpenTreatsForeignHostLockAsHeld(t *testing.T) {
	workRoot := t.TempDir()
	paths, err := SlotPaths(workRoot, "alice/demo", 0)
	if err != nil {
		t.Fatalf("SlotPaths: %v", err)
	}
	// A foreign host cannot be probed for liveness, so its lock stays held
	// even though the pid names a live process here.
	writeLock(t, paths.Lock, lockOwner{PID: os.Getpid(), Host: "another-machine.invalid", Token: "elsewhere"})

	slot := Open(OpenOptions{WorkRoot: workRoot, Repo: "alice/demo", TempRoot: t.TempDir(), Stderr: func(string) {}})
	defer slot.Release()
	next, err := SlotPaths(workRoot, "alice/demo", 1)
	if err != nil {
		t.Fatalf("SlotPaths: %v", err)
	}
	if slot.Dir != next.Dir {
		t.Fatalf("slot = %s, want the next free slot %s", slot.Dir, next.Dir)
	}
	if body := readAt(t, workRoot, filepath.Join("alice", "demo", "slot-0.lock")); !strings.Contains(body, "elsewhere") {
		t.Fatalf("the foreign lock was touched: %s", body)
	}
}

func TestOpenFallsBackToTempWhenAllSlotsAreBusy(t *testing.T) {
	workRoot := t.TempDir()
	tempRoot := t.TempDir()
	for index := 0; index < MaxSlots; index++ {
		paths, err := SlotPaths(workRoot, "alice/demo", index)
		if err != nil {
			t.Fatalf("SlotPaths: %v", err)
		}
		writeLock(t, paths.Lock, lockOwner{PID: os.Getpid(), Host: "another-machine.invalid", Token: "busy"})
	}

	stderr := &sink{}
	slot := Open(OpenOptions{WorkRoot: workRoot, Repo: "alice/demo", TempRoot: tempRoot, Stderr: stderr.write})
	if slot.Persistent {
		t.Fatalf("slot with every slot busy is persistent: %+v", slot)
	}
	want := "workdir: all 16 slots for alice/demo are in use; using a temporary directory"
	if stderr.joined() != want {
		t.Fatalf("stderr = %q, want %q", stderr.joined(), want)
	}
	if root, err := filepath.Rel(tempRoot, slot.Dir); err != nil || !strings.HasPrefix(filepath.Base(slot.Dir), "kvarm-ci-") {
		t.Fatalf("temporary slot %s is not a kvarm-ci- directory under %s (%v)", slot.Dir, tempRoot, err)
	} else if strings.HasPrefix(root, ".") {
		t.Fatalf("temporary slot %s is not under %s", slot.Dir, tempRoot)
	}
	if slot.Lock != "" {
		t.Fatalf("a temporary slot takes no lock, got %s", slot.Lock)
	}
	if slot.Work != filepath.Join(slot.Dir, "work") || slot.State != filepath.Join(slot.Dir, "state.json") {
		t.Fatalf("temporary slot layout = %+v", slot)
	}
	slot.Release()
	if exists(slot.Dir) {
		t.Fatalf("releasing a temporary slot left %s behind", slot.Dir)
	}
}

func TestOpenFallsBackWhenWorkRootIsUnusable(t *testing.T) {
	parent := t.TempDir()
	workRoot := filepath.Join(parent, "afile")
	if err := os.WriteFile(workRoot, []byte("not a directory\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	tempRoot := t.TempDir()
	stderr := &sink{}
	slot := Open(OpenOptions{WorkRoot: workRoot, Repo: "alice/demo", TempRoot: tempRoot, Stderr: stderr.write})
	defer slot.Release()
	if slot.Persistent {
		t.Fatalf("slot on an unusable root is persistent: %+v", slot)
	}
	prefix := "workdir: " + workRoot + " is unusable ("
	if !strings.HasPrefix(stderr.joined(), prefix) || !strings.HasSuffix(stderr.joined(), "); using a temporary directory") {
		t.Fatalf("stderr = %q, want the unusable-root line", stderr.joined())
	}
	if filepath.Dir(slot.Dir) != tempRoot {
		t.Fatalf("temporary slot %s is not under %s", slot.Dir, tempRoot)
	}
}

func TestOpenRemovesTrashLeftByAnInterruptedJob(t *testing.T) {
	workRoot := t.TempDir()
	paths, err := SlotPaths(workRoot, "alice/demo", 0)
	if err != nil {
		t.Fatalf("SlotPaths: %v", err)
	}
	if err := os.MkdirAll(paths.Dir, 0o777); err != nil {
		t.Fatalf("mkdir slot: %v", err)
	}
	put(t, paths.Dir, "work.trash-abc/file.txt", "leftover\n", 0o644)
	put(t, paths.Dir, "staging.trash-def", "leftover\n", 0o644)
	put(t, paths.Dir, "state.json", "{}", 0o644)

	slot := Open(OpenOptions{WorkRoot: workRoot, Repo: "alice/demo", TempRoot: t.TempDir(), Stderr: func(string) {}})
	defer slot.Release()
	if exists(filepath.Join(paths.Dir, "work.trash-abc")) || exists(filepath.Join(paths.Dir, "staging.trash-def")) {
		t.Fatal("open left a trash entry behind")
	}
	if readAt(t, paths.Dir, "state.json") != "{}" {
		t.Fatal("open removed a file that is not trash")
	}
}

func TestOwnerAlive(t *testing.T) {
	host, err := os.Hostname()
	if err != nil {
		t.Fatalf("hostname: %v", err)
	}
	pid := strconv.Itoa(os.Getpid())
	cases := []struct {
		name    string
		content string
		want    bool
	}{
		{"this process", `{"pid":` + pid + `,"host":` + jsonQuote(host) + `,"token":"t"}`, true},
		{"malformed", "not json", true},
		{"missing pid", `{"host":` + jsonQuote(host) + `}`, true},
		{"zero pid", `{"pid":0,"host":` + jsonQuote(host) + `}`, true},
		{"fractional pid", `{"pid":1.5,"host":` + jsonQuote(host) + `}`, true},
		{"foreign host", `{"pid":1,"host":"another-machine.invalid"}`, true},
		{"dead child", `{"pid":` + strconv.Itoa(deadPID(t)) + `,"host":` + jsonQuote(host) + `}`, false},
	}
	for _, tc := range cases {
		if got := ownerAlive(tc.content); got != tc.want {
			t.Errorf("ownerAlive(%s) = %v, want %v", tc.name, got, tc.want)
		}
	}
}
