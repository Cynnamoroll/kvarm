package workdir

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeCheckout writes a small tree, the way a snapshot checkout would.
func fakeCheckout(files map[string]string, sha, source string) func(dir string) (CheckoutOutcome, error) {
	return func(dir string) (CheckoutOutcome, error) {
		if err := os.MkdirAll(dir, 0o777); err != nil {
			return CheckoutOutcome{}, err
		}
		for name, content := range files {
			full := underPath(dir, name)
			if err := os.MkdirAll(filepath.Dir(full), 0o777); err != nil {
				return CheckoutOutcome{}, err
			}
			if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
				return CheckoutOutcome{}, err
			}
		}
		return CheckoutOutcome{Source: source, SHA: sha, Bytes: 42, Files: len(files)}, nil
	}
}

// openTestSlot is a persistent slot on its own work and temp roots.
func openTestSlot(t *testing.T) *Slot {
	t.Helper()
	slot := Open(OpenOptions{WorkRoot: t.TempDir(), Repo: "alice/demo", TempRoot: t.TempDir(), Stderr: func(string) {}})
	if !slot.Persistent {
		t.Fatalf("expected a persistent slot, got %+v", slot)
	}
	t.Cleanup(slot.Release)
	return slot
}

// materializeFresh runs the first job in a slot: a full snapshot checkout.
func materializeFresh(t *testing.T, slot *Slot, files map[string]string, sha string) Materialized {
	t.Helper()
	got, err := Materialize(slot, MaterializeOptions{
		SHA:      sha,
		Checkout: fakeCheckout(files, sha, "snapshot"),
		Delta:    neverDelta(t),
		Stderr:   func(string) {},
	})
	if err != nil {
		t.Fatalf("fresh Materialize: %v", err)
	}
	return got
}

// neverDelta fails the test if a delta is fetched.
func neverDelta(t *testing.T) DeltaFetch {
	return func(RecordedState, string) (DeltaManifest, error) {
		t.Error("the delta fetcher ran when it should not have")
		return DeltaManifest{}, errors.New("unexpected delta")
	}
}

// neverCheckout fails the test if the full checkout runs.
func neverCheckout(t *testing.T) func(string) (CheckoutOutcome, error) {
	return func(string) (CheckoutOutcome, error) {
		t.Error("the full checkout ran when the warm sync should have succeeded")
		return CheckoutOutcome{}, errors.New("unexpected checkout")
	}
}

func TestMaterializeFreshRecordsTheCheckout(t *testing.T) {
	slot := openTestSlot(t)
	stderr := &sink{}
	files := map[string]string{"README.md": "v1\n", "bin/run.sh": "#!/bin/sh\n"}
	got, err := Materialize(slot, MaterializeOptions{
		SHA:      testSHA,
		Checkout: fakeCheckout(files, testSHA, "snapshot"),
		Delta:    neverDelta(t),
		Stderr:   stderr.write,
	})
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if got.WorkdirKind != "fresh" {
		t.Errorf("workdir = %s, want fresh", got.WorkdirKind)
	}
	if got.Source != "snapshot" || got.SHA != testSHA || got.Bytes != 42 || got.Files != len(files) || got.Reason != "" {
		t.Errorf("materialized = %+v", got)
	}
	if stderr.joined() != "" {
		t.Errorf("stderr = %q, want nothing", stderr.joined())
	}

	state := parseStateFile(t, slot.State)
	if state.SHA != testSHA {
		t.Errorf("recorded sha = %s, want %s", state.SHA, testSHA)
	}
	if !equalStrings(state.Files, []string{"README.md", "bin/run.sh"}) {
		t.Errorf("recorded files = %v", state.Files)
	}
	if state.Blobs["README.md"] != BlobHash([]byte("v1\n")) || state.Modes["README.md"] != "100644" {
		t.Errorf("recorded README.md = %s/%s", state.Blobs["README.md"], state.Modes["README.md"])
	}
	if got := readAt(t, slot.Work, "bin/run.sh"); got != "#!/bin/sh\n" {
		t.Errorf("bin/run.sh = %q", got)
	}
	if exists(slot.Staging) {
		t.Error("the fresh checkout left a staging tree behind")
	}
}

func TestMaterializeFreshSkipsTheDelta(t *testing.T) {
	slot := openTestSlot(t)
	materializeFresh(t, slot, map[string]string{"a.txt": "one\n"}, testSHA)

	got, err := Materialize(slot, MaterializeOptions{
		SHA:      otherSHA,
		Fresh:    true,
		Checkout: fakeCheckout(map[string]string{"a.txt": "two\n"}, otherSHA, "snapshot"),
		Delta:    neverDelta(t),
		Stderr:   func(string) {},
	})
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if got.WorkdirKind != "fresh" {
		t.Errorf("workdir = %s, want fresh", got.WorkdirKind)
	}
	if content := readAt(t, slot.Work, "a.txt"); content != "two\n" {
		t.Errorf("a.txt = %q, want %q", content, "two\n")
	}
	if state := parseStateFile(t, slot.State); state.SHA != otherSHA {
		t.Errorf("recorded sha = %s, want %s", state.SHA, otherSHA)
	}
}

func TestMaterializeWarmAppliesTheDelta(t *testing.T) {
	slot := openTestSlot(t)
	materializeFresh(t, slot, map[string]string{"README.md": "v1\n", "keep.txt": "keep\n"}, testSHA)
	// A staging tree from an interrupted job must not survive the warm sync.
	put(t, slot.Staging, "leftover.txt", "leftover\n", 0o644)

	next := []byte("v2\n")
	ran := false
	delta := func(previous RecordedState, sha string) (DeltaManifest, error) {
		ran = true
		if sha != otherSHA {
			t.Errorf("delta sha = %s, want %s", sha, otherSHA)
		}
		if previous.SHA != testSHA {
			t.Errorf("previous sha = %s, want %s", previous.SHA, testSHA)
		}
		if previous.Blobs["README.md"] != BlobHash([]byte("v1\n")) || previous.Modes["keep.txt"] != "100644" {
			t.Errorf("previous tree = %v / %v", previous.Blobs, previous.Modes)
		}
		// The manifest is dropped before the delta is fetched, so a failure
		// cannot leave a state that describes a tree the workdir lost.
		if exists(slot.State) {
			t.Error("the state file must be gone before the delta runs")
		}
		if info, err := os.Lstat(slot.Work); err != nil || !info.IsDir() {
			t.Errorf("the work directory must exist before the delta runs (%v)", err)
		}
		changes := []DeltaChange{{
			Path: "README.md", Status: "modified",
			OldHash: str(previous.Blobs["README.md"]), OldMode: str("100644"),
			NewHash: str(BlobHash(next)), NewMode: str("100644"),
		}}
		manifest, _ := manifestFor(changes, map[string][]byte{"README.md": next})
		return manifest, nil
	}

	stderr := &sink{}
	got, err := Materialize(slot, MaterializeOptions{
		SHA:      otherSHA,
		Checkout: neverCheckout(t),
		Delta:    delta,
		Stderr:   stderr.write,
	})
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if !ran {
		t.Fatal("the delta never ran")
	}
	if got.WorkdirKind != "warm" || got.Source != "delta" || got.SHA != otherSHA {
		t.Errorf("materialized = %+v, want a warm delta of %s", got, otherSHA)
	}
	if got.Files != 2 {
		t.Errorf("files = %d, want 2", got.Files)
	}
	if content := readAt(t, slot.Work, "README.md"); content != "v2\n" {
		t.Errorf("README.md = %q, want %q", content, "v2\n")
	}
	if content := readAt(t, slot.Work, "keep.txt"); content != "keep\n" {
		t.Errorf("keep.txt = %q, want %q", content, "keep\n")
	}
	state := parseStateFile(t, slot.State)
	if state.SHA != otherSHA || state.Blobs["README.md"] != BlobHash(next) {
		t.Errorf("recorded state = %+v", state)
	}
	if stderr.joined() != "" {
		t.Errorf("stderr = %q, want nothing", stderr.joined())
	}
	if exists(slot.Staging) {
		t.Error("the warm sync left the staging tree behind")
	}
}

func TestMaterializeWarmFailureFallsBackToFresh(t *testing.T) {
	slot := openTestSlot(t)
	materializeFresh(t, slot, map[string]string{"README.md": "v1\n"}, testSHA)

	stderr := &sink{}
	boom := errors.New("compare is truncated (changed file budget exhausted)")
	delta := func(RecordedState, string) (DeltaManifest, error) { return DeltaManifest{}, boom }
	got, err := Materialize(slot, MaterializeOptions{
		SHA:      otherSHA,
		Checkout: fakeCheckout(map[string]string{"README.md": "v2\n"}, otherSHA, "snapshot"),
		Delta:    delta,
		Stderr:   stderr.write,
	})
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if got.WorkdirKind != "fresh" || got.SHA != otherSHA {
		t.Errorf("materialized = %+v, want a fresh checkout of %s", got, otherSHA)
	}
	want := "warm sync failed: " + boom.Error() + "; falling back to a full snapshot checkout"
	if !strings.Contains(stderr.joined(), want) {
		t.Errorf("stderr = %q, want it to hold %q", stderr.joined(), want)
	}
	if content := readAt(t, slot.Work, "README.md"); content != "v2\n" {
		t.Errorf("README.md = %q, want %q", content, "v2\n")
	}
	if state := parseStateFile(t, slot.State); state.SHA != otherSHA {
		t.Errorf("recorded sha = %s, want %s", state.SHA, otherSHA)
	}
}

func TestMaterializeFallsBackWhenTheStatePathIsADirectory(t *testing.T) {
	slot := openTestSlot(t)
	materializeFresh(t, slot, map[string]string{"README.md": "v1\n"}, testSHA)

	if err := os.Remove(slot.State); err != nil {
		t.Fatalf("remove state: %v", err)
	}
	put(t, slot.State, "nested/leftover.txt", "leftover\n", 0o644)

	stderr := &sink{}
	got, err := Materialize(slot, MaterializeOptions{
		SHA:      otherSHA,
		Checkout: fakeCheckout(map[string]string{"README.md": "v2\n"}, otherSHA, "snapshot"),
		Delta:    neverDelta(t),
		Stderr:   stderr.write,
	})
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if got.WorkdirKind != "fresh" {
		t.Errorf("workdir = %s, want fresh", got.WorkdirKind)
	}
	if !strings.Contains(stderr.joined(), "warm sync failed: ") {
		t.Errorf("stderr = %q, want a warm failure", stderr.joined())
	}
	info, err := os.Lstat(slot.State)
	if err != nil || !info.Mode().IsRegular() {
		t.Fatalf("the state path is not a file again (%v)", err)
	}
	if state := parseStateFile(t, slot.State); state.SHA != otherSHA {
		t.Errorf("recorded sha = %s, want %s", state.SHA, otherSHA)
	}
}

func TestMaterializeFallsBackWhenTheStateIsUnreadable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads a 0-permission file anyway")
	}
	slot := openTestSlot(t)
	materializeFresh(t, slot, map[string]string{"README.md": "v1\n"}, testSHA)

	if err := os.Chmod(slot.State, 0o000); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(slot.State, 0o644) })

	stderr := &sink{}
	got, err := Materialize(slot, MaterializeOptions{
		SHA:      otherSHA,
		Checkout: fakeCheckout(map[string]string{"README.md": "v2\n"}, otherSHA, "snapshot"),
		Delta:    neverDelta(t),
		Stderr:   stderr.write,
	})
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if got.WorkdirKind != "fresh" {
		t.Errorf("workdir = %s, want fresh", got.WorkdirKind)
	}
	if !strings.Contains(stderr.joined(), "warm sync failed: ") {
		t.Errorf("stderr = %q, want a warm failure", stderr.joined())
	}

	// The bad file was replaced, so the next job warms through the delta again.
	delta := func(_ RecordedState, sha string) (DeltaManifest, error) {
		return DeltaManifest{SHA: sha, Source: "delta", Read: func(string) ([]byte, error) {
			return nil, errors.New("the empty delta holds no content")
		}}, nil
	}
	warm, err := Materialize(slot, MaterializeOptions{
		SHA:      testSHA,
		Checkout: neverCheckout(t),
		Delta:    delta,
		Stderr:   stderr.write,
	})
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if warm.WorkdirKind != "warm" {
		t.Errorf("workdir = %s, want warm once the state is readable again", warm.WorkdirKind)
	}
}

func TestMaterializeRejectsACheckoutOfAnotherCommit(t *testing.T) {
	slot := openTestSlot(t)
	_, err := Materialize(slot, MaterializeOptions{
		SHA:      testSHA,
		Checkout: fakeCheckout(map[string]string{"a.txt": "one\n"}, otherSHA, "snapshot"),
		Delta:    neverDelta(t),
		Stderr:   func(string) {},
	})
	want := "checkout returned " + otherSHA + ", expected " + testSHA
	if err == nil || err.Error() != want {
		t.Fatalf("Materialize = %v, want %q", err, want)
	}
}

func TestSyncWarmWithoutAState(t *testing.T) {
	slot := openTestSlot(t)
	got, err := SyncWarm(slot, testSHA, neverDelta(t))
	if err != nil || got != nil {
		t.Fatalf("SyncWarm = (%v, %v), want (nil, nil) with no recorded tree", got, err)
	}
}

func TestSyncWarmRejectsADeltaForAnotherCommit(t *testing.T) {
	slot := openTestSlot(t)
	if err := os.MkdirAll(slot.Work, 0o777); err != nil {
		t.Fatalf("mkdir work: %v", err)
	}
	if err := WriteState(slot.State, testSHA, Tree{}); err != nil {
		t.Fatalf("WriteState: %v", err)
	}
	delta := func(RecordedState, string) (DeltaManifest, error) {
		return DeltaManifest{SHA: otherSHA}, nil
	}
	_, err := SyncWarm(slot, testSHA, delta)
	want := "delta was computed for " + otherSHA + ", expected " + testSHA
	if err == nil || err.Error() != want {
		t.Fatalf("SyncWarm = %v, want %q", err, want)
	}
}

func TestSyncWarmErrorsWhenTheWorkDirectoryIsMissing(t *testing.T) {
	slot := openTestSlot(t)
	if err := WriteState(slot.State, testSHA, Tree{}); err != nil {
		t.Fatalf("WriteState: %v", err)
	}
	_, err := SyncWarm(slot, testSHA, neverDelta(t))
	if err == nil || err.Error() != "workdir is missing" {
		t.Fatalf("SyncWarm = %v, want the missing-workdir error", err)
	}
	// A failed sync never leaves the manifest behind.
	if exists(slot.State) {
		t.Error("a failed sync left the state file in place")
	}
}
