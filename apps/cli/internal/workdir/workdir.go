// Package workdir keeps the persistent per-repository working directories of
// `kvarm runner`: slot locking, the recorded-state manifest of the exact tree
// a checkout produced, warm delta syncs, pruning, and fallback to a full
// checkout.
//
// Layout: `<workRoot>/<owner>/<repo>/slot-<n>/{work,staging,state.json}` with
// the slot's lock beside it (`slot-<n>.lock`). One runner process owns a slot
// for its whole lifetime; a concurrent runner for the same repository takes
// the next free slot, so a workdir is never shared.
//
// The first job in a slot is a full snapshot checkout, and the exact tree it
// produced is recorded in the state manifest: every tracked path with its git
// blob hash and mode. A later job asks the runner's delta fetcher for only the
// paths that changed between the recorded commit and the new head and applies
// them to `work`: deleted paths disappear, modified and added paths are
// written with their exact bytes and modes, and any tracked file a previous
// job dirtied is restored even when the delta does not touch it (the recorded
// hashes prove which files drifted). Anything else untracked is removed unless
// it lies inside a dependency-cache directory (CacheDirs), which is kept so
// installs do not repeat. Any failure on that path falls back to a full
// checkout into an emptied `work`, so a warm job downloads the whole tree only
// as that fallback.
package workdir

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"kvarm/cli/internal/errs"
	"kvarm/cli/internal/repo"
)

// CacheDirs are the untracked directories that survive a warm sync: an install
// into one of them must not repeat job after job. They are matched by name at
// any depth, the way the JS module matched them.
var CacheDirs = map[string]bool{
	"node_modules":  true,
	".venv":         true,
	"venv":          true,
	"target":        true,
	".cache":        true,
	".gradle":       true,
	".turbo":        true,
	"__pycache__":   true,
	".pytest_cache": true,
	".mypy_cache":   true,
	".tox":          true,
}

// MaxSlots is how many runner slots one repository gets before further runners
// fall back to a temporary directory.
const MaxSlots = 16

// SlotPathsResult is one slot's layout.
type SlotPathsResult struct {
	Dir     string // slot-<n>, holding work, staging and state.json
	Lock    string // slot-<n>.lock, beside Dir
	Work    string
	Staging string
	State   string
}

// Slot is a locked working directory: a persistent slot, or a per-process
// temporary directory when every slot is busy or the root is unusable. The
// runner releases it when it stops; nothing is released on process exit, so a
// slot dropped by a crash stays locked until its owner is provably gone.
type Slot struct {
	Dir        string
	Lock       string // empty on a temporary slot, which takes no lock
	Work       string
	Staging    string
	State      string
	Persistent bool

	token string // the lock body's owner token, while this process holds the lock
}

// lockOwner is a lock file's body: enough to tell a live owner of this machine
// from one that is provably gone.
type lockOwner struct {
	PID   int    `json:"pid"`
	Host  string `json:"host"`
	Token string `json:"token"`
}

// OpenOptions is one Open call.
type OpenOptions struct {
	WorkRoot string
	Repo     string // <owner>/<name>
	TempRoot string // parent of the fallback temporary directory
	Stderr   func(line string)
}

// SlotPaths returns the layout of slot index for a repository.
func SlotPaths(workRoot, repoID string, index int) (SlotPathsResult, error) {
	parsed, err := repo.Parse(repoID)
	if err != nil {
		return SlotPathsResult{}, err
	}
	// repo.Parse refuses a `.`/`..` name too; the check stays because a slot
	// that resolved outside <workRoot>/<owner> would work in the parent
	// repository's directory, and that must not depend on another package's
	// pattern.
	if parsed.Name == "." || parsed.Name == ".." {
		return SlotPathsResult{}, errs.NewUsage("invalid repository %q, expected <owner>/<repo>", repoID)
	}
	dir := filepath.Join(workRoot, parsed.Owner, parsed.Name, fmt.Sprintf("slot-%d", index))
	return SlotPathsResult{
		Dir:     dir,
		Lock:    dir + ".lock",
		Work:    filepath.Join(dir, "work"),
		Staging: filepath.Join(dir, "staging"),
		State:   filepath.Join(dir, "state.json"),
	}, nil
}

// Open locks a persistent slot for this process, or falls back to a
// per-process temporary directory when every slot is busy or the root is
// unusable. The caller must call Slot.Release when it stops.
//
// A repository that does not parse is a usage error, which the JS module
// rethrew to its caller; this signature has no error result, so it panics with
// the *errs.CliError instead. Callers validate their repository once, as
// runRunner does, and pass a parsed identifier.
func Open(opts OpenOptions) *Slot {
	token := newUUID()
	body, err := json.Marshal(lockOwner{PID: os.Getpid(), Host: hostname(), Token: token})
	if err != nil {
		panic(err) // a struct of an int and two strings always marshals
	}
	for index := 0; index < MaxSlots; index++ {
		paths, err := SlotPaths(opts.WorkRoot, opts.Repo, index)
		if err != nil {
			panic(err)
		}
		slot, err := lockSlot(paths, string(body), token)
		if err != nil {
			report(opts.Stderr, "workdir: %s is unusable (%s); using a temporary directory", opts.WorkRoot, err)
			return tempSlot(opts)
		}
		if slot != nil {
			return slot
		}
	}
	report(opts.Stderr, "workdir: all %d slots for %s are in use; using a temporary directory", MaxSlots, opts.Repo)
	return tempSlot(opts)
}

// Release gives up the slot: its lock when that lock is still this process's,
// or the whole temporary directory. It is idempotent and best effort — a lock
// this process did not write is left alone rather than guessed at, so a
// release can never hand away another runner's slot.
func (s *Slot) Release() {
	if !s.Persistent {
		_ = os.RemoveAll(s.Dir)
		return
	}
	content, ok, err := readOrNull(s.Lock)
	if err != nil || !ok {
		return
	}
	var owner lockOwner
	if err := json.Unmarshal([]byte(content), &owner); err != nil {
		return
	}
	if owner.Token == s.token {
		_ = os.Remove(s.Lock)
	}
}

// lockSlot takes one slot's lock: a slot when this process won it, nil when a
// live owner holds it, and the error that made the work root unusable.
func lockSlot(paths SlotPathsResult, body, token string) (*Slot, error) {
	if err := os.MkdirAll(filepath.Dir(paths.Dir), 0o777); err != nil {
		return nil, err
	}
	locked, err := tryLock(paths.Lock, body)
	if err != nil {
		return nil, err
	}
	if !locked {
		return nil, nil
	}
	slot := &Slot{
		Dir:        paths.Dir,
		Lock:       paths.Lock,
		Work:       paths.Work,
		Staging:    paths.Staging,
		State:      paths.State,
		Persistent: true,
		token:      token,
	}
	if err := os.MkdirAll(paths.Dir, 0o777); err != nil {
		slot.Release()
		return nil, err
	}
	if err := removeTrash(paths.Dir); err != nil {
		slot.Release()
		return nil, err
	}
	return slot, nil
}

// tempSlot is the last-resort fallback: a fresh temporary directory with the
// same layout, removed whole on release.
func tempSlot(opts OpenOptions) *Slot {
	dir, err := os.MkdirTemp(opts.TempRoot, "kvarm-ci-")
	if err != nil {
		// There is nothing left to fall back to; the JS module let mkdtempSync
		// throw here, and the runner can no more continue without a workdir.
		panic(fmt.Errorf("workdir: cannot create a temporary directory under %s: %w", opts.TempRoot, err))
	}
	return &Slot{
		Dir:     dir,
		Work:    filepath.Join(dir, "work"),
		Staging: filepath.Join(dir, "staging"),
		State:   filepath.Join(dir, "state.json"),
	}
}

// createExclusive creates path with body only if it does not exist. The body
// is written first and hard-linked into place, so a reader never sees an empty
// lock left by a crash between create and write.
func createExclusive(path, body string) (bool, error) {
	tmp := path + "." + newUUID() + ".tmp"
	if err := os.WriteFile(tmp, []byte(body), 0o644); err != nil {
		return false, err
	}
	defer func() { _ = os.Remove(tmp) }()
	err := os.Link(tmp, path)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, fs.ErrExist):
		return false, nil
	default:
		return false, err
	}
}

// ownerAlive reports whether a lock's owner may still be running. An
// unreadable or foreign-host lock counts as held: only a lock whose owner is
// provably gone from this machine is ever reclaimed.
func ownerAlive(content string) bool {
	var owner lockOwner
	if err := json.Unmarshal([]byte(content), &owner); err != nil {
		return true
	}
	if owner.Host != hostname() || owner.PID <= 0 {
		return true
	}
	proc, err := os.FindProcess(owner.PID)
	if err != nil {
		return true
	}
	if err := proc.Signal(syscall.Signal(0)); err != nil {
		// ESRCH is the syscall's "no such process"; ErrProcessDone is what Go
		// answers, without asking the kernel, for a process this one already
		// reaped. Either one proves the owner is gone; anything else (EACCES,
		// an out-of-range pid) leaves it a possible live owner.
		return !errors.Is(err, syscall.ESRCH) && !errors.Is(err, os.ErrProcessDone)
	}
	return true
}

// tryLock takes a lock whose current owner is dead, under a second exclusive
// file. Without that file two reclaimers that both read the dead owner could
// each delete the lock the other just created.
func tryLock(lock, body string) (bool, error) {
	created, err := createExclusive(lock, body)
	if err != nil || created {
		return created, err
	}
	current, ok, err := readOrNull(lock)
	if err != nil {
		return false, err
	}
	if !ok {
		return createExclusive(lock, body)
	}
	if ownerAlive(current) {
		return false, nil
	}
	steal := lock + ".steal"
	stolen, err := createExclusive(steal, body)
	if err != nil || !stolen {
		return false, err
	}
	defer func() { _ = os.Remove(steal) }()
	again, ok, err := readOrNull(lock)
	if err != nil {
		return false, err
	}
	if ok {
		if again != current {
			return false, nil
		}
		if err := os.Remove(lock); err != nil {
			return false, err
		}
	}
	return createExclusive(lock, body)
}

// removeTrash deletes the leftovers discard moved aside while opening a slot,
// the way the JS module cleaned a slot directory before using it.
func removeTrash(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".trash-") {
			if err := os.RemoveAll(filepath.Join(dir, entry.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}

// discard moves path aside before deleting it, so a partly undeletable tree
// never blocks the fresh checkout that follows; leftovers are retried on the
// next slot open.
func discard(path string) error {
	trash := path + ".trash-" + newUUID()
	if err := os.Rename(path, trash); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	_ = os.RemoveAll(trash)
	return nil
}

// ListTree returns the relative, /-separated paths of every non-directory
// entry below dir. A symlink is an entry and never followed: only real
// directories are walked. os.ReadDir sorts each directory, so the walk is
// deterministic, unlike the JS module's readdir order.
func ListTree(dir string) ([]string, error) {
	var out []string
	var walk func(rel string) error
	walk = func(rel string) error {
		full := dir
		if rel != "" {
			full = filepath.Join(dir, filepath.FromSlash(rel))
		}
		entries, err := os.ReadDir(full)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			path := entry.Name()
			if rel != "" {
				path = rel + "/" + entry.Name()
			}
			if entry.IsDir() {
				if err := walk(path); err != nil {
					return err
				}
				continue
			}
			out = append(out, path)
		}
		return nil
	}
	if err := walk(""); err != nil {
		return nil, err
	}
	return out, nil
}

// lstatOrNull stats path without following a symlink, returning nil when it
// does not exist and the error for anything else, as the JS lstatOrNull did.
func lstatOrNull(path string) (fs.FileInfo, error) {
	info, err := os.Lstat(path)
	if err == nil {
		return info, nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return nil, err
}

// readOrNull reads a small text file, reporting ok=false when it does not
// exist.
func readOrNull(path string) (text string, ok bool, err error) {
	content, err := os.ReadFile(path)
	if err == nil {
		return string(content), true, nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return "", false, nil
	}
	return "", false, err
}

// removeIfPresent removes one entry, tolerating a path that is already gone,
// the way rm with force does.
func removeIfPresent(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// hostname is the lock body's host field. A host that cannot be read yields
// "", which matches no other machine's lock and so leaves every lock held.
func hostname() string {
	name, err := os.Hostname()
	if err != nil {
		return ""
	}
	return name
}

// newUUID is the random name component the lock, state and trash temp files
// carry; the dashed shape matches the JS layout.
func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Errorf("workdir: no randomness for a temp name: %w", err))
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 1
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// report writes one diagnostic line to a runner's stderr sink, tolerating a
// caller that has none.
func report(sink func(string), format string, args ...any) {
	if sink != nil {
		sink(fmt.Sprintf(format, args...))
	}
}
