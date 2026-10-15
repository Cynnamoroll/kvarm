package workdir

import (
	"errors"
	"fmt"
	"os"
)

// CheckoutOutcome is what a checkout of one commit produced.
type CheckoutOutcome struct {
	Source string // "snapshot" | "clone"
	SHA    string
	Bytes  int
	Files  int
	Reason string // why the snapshot was not used
}

// Materialized is the work directory once one job's tree is in it.
type Materialized struct {
	Source string
	SHA    string
	Bytes  int
	Files  int
	Reason string
	// WorkdirKind is "warm" for a delta sync and "fresh" for a full checkout.
	WorkdirKind string
}

// DeltaFetch fetches the difference between a recorded tree and a new head.
type DeltaFetch = func(previous RecordedState, sha string) (DeltaManifest, error)

// MaterializeOptions is one Materialize call.
type MaterializeOptions struct {
	SHA      string
	Fresh    bool // rematerialize from the checkout even when a warm state exists
	Checkout func(dir string) (CheckoutOutcome, error)
	Delta    DeltaFetch
	Stderr   func(line string)
}

// Materialize makes the slot's work directory hold sha: a warm delta sync when
// the slot holds a recorded previous tree, otherwise — or with fresh, or after
// any warm failure — a full checkout into an emptied directory.
func Materialize(slot *Slot, o MaterializeOptions) (Materialized, error) {
	if !o.Fresh {
		warm, err := SyncWarm(slot, o.SHA, o.Delta)
		if err != nil {
			report(o.Stderr, "warm sync failed: %s; falling back to a full snapshot checkout", err)
		}
		// The warm path's cleanup, whatever happened above: a staging tree
		// from an interrupted job never survives into the next one.
		_ = discard(slot.Staging)
		if err == nil && warm != nil {
			return *warm, nil
		}
	}
	// Recursive, so a state path that became a directory is cleared too;
	// removal never follows a symlink.
	if err := os.RemoveAll(slot.State); err != nil {
		return Materialized{}, err
	}
	if err := discard(slot.Work); err != nil {
		return Materialized{}, err
	}
	if err := discard(slot.Staging); err != nil {
		return Materialized{}, err
	}
	got, err := o.Checkout(slot.Work)
	if err != nil {
		return Materialized{}, err
	}
	if got.SHA != o.SHA {
		return Materialized{}, fmt.Errorf("checkout returned %s, expected %s", got.SHA, o.SHA)
	}
	files, err := ListTree(slot.Work)
	if err != nil {
		return Materialized{}, err
	}
	tree, err := scanTree(slot.Work, files)
	if err != nil {
		return Materialized{}, err
	}
	if err := WriteState(slot.State, got.SHA, tree); err != nil {
		return Materialized{}, err
	}
	return Materialized{
		Source:      got.Source,
		SHA:         got.SHA,
		Bytes:       got.Bytes,
		Files:       got.Files,
		Reason:      got.Reason,
		WorkdirKind: "fresh",
	}, nil
}

// SyncWarm applies the delta between the slot's recorded tree and sha, and
// returns nil when the slot has no recorded tree. Reading the state is part of
// the warm path, so an unreadable state returns an error into the caller's
// full-checkout fallback like any other warm failure.
func SyncWarm(slot *Slot, sha string, delta DeltaFetch) (*Materialized, error) {
	recorded, ok, err := readOrNull(slot.State)
	if err != nil || !ok {
		return nil, err
	}
	previous, err := ParseState([]byte(recorded))
	if err != nil {
		return nil, err
	}
	// The manifest goes before the sync starts: a sync that fails must not
	// leave a state claiming a tree the workdir does not hold.
	if err := removeIfPresent(slot.State); err != nil {
		return nil, err
	}
	info, err := lstatOrNull(slot.Work)
	if err != nil {
		return nil, err
	}
	if info == nil || !info.IsDir() {
		return nil, errors.New("workdir is missing")
	}
	if err := discard(slot.Staging); err != nil {
		return nil, err
	}
	manifest, err := delta(previous, sha)
	if err != nil {
		return nil, err
	}
	if manifest.SHA != sha {
		return nil, fmt.Errorf("delta was computed for %s, expected %s", manifest.SHA, sha)
	}
	tree, err := ApplyDelta(slot.Work, previous, manifest)
	if err != nil {
		return nil, err
	}
	if err := WriteState(slot.State, sha, tree); err != nil {
		return nil, err
	}
	return &Materialized{Source: manifest.Source, SHA: sha, Files: len(tree.Files), WorkdirKind: "warm"}, nil
}
