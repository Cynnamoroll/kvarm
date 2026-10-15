package runner

import (
	"context"
	"encoding/base64"
	"fmt"
	"regexp"
	"sync"

	"kvarm/cli/internal/errs"
	"kvarm/cli/internal/opcli"
	"kvarm/cli/internal/workdir"
)

// fetchDelta fetches the difference between the recorded commit and the new
// head: the compare API's changed paths (following pages, refusing
// truncation), with every directory↔file transition expanded into leaf files
// through the tree API so each change names exactly one file. Any failure
// falls back to a full checkout; a warm job never transfers the whole tree
// this way.
func (r *runner) fetchDelta(ctx context.Context, o Options, previous workdir.RecordedState, sha string) (workdir.DeltaManifest, error) {
	var changes []workdir.DeltaChange
	cursor := ""
	for {
		path := fmt.Sprintf("compare/%s...%s", previous.SHA, sha)
		if cursor != "" {
			path += "?cursor=" + opcli.EncodeURIComponent(cursor)
		}
		body, err := r.getJSON(ctx, path)
		if err != nil {
			return workdir.DeltaManifest{}, err
		}
		if body["truncated"] == true {
			reason, _ := body["truncatedReason"].(string)
			if reason == "" {
				reason = "budget"
			}
			return workdir.DeltaManifest{}, fmt.Errorf("compare is truncated (%s); the delta would be incomplete", reason)
		}
		files, ok := body["files"].([]any)
		if !ok {
			return workdir.DeltaManifest{}, errs.NewFailure("compare: malformed response")
		}
		for _, file := range files {
			change, err := parseChange(file)
			if err != nil {
				return workdir.DeltaManifest{}, err
			}
			changes = append(changes, change)
		}
		next, _ := body["nextCursor"].(string)
		if next == "" {
			break
		}
		cursor = next
	}

	var expanded []workdir.DeltaChange
	for _, c := range changes {
		if isTreeMode(c.OldMode) || isTreeMode(c.NewMode) {
			// The compare wire folds a directory↔file transition into one
			// typechange whose tree side carries no leaf files.
			if isTreeMode(c.OldMode) {
				// The removed leaves live in the recorded commit, not the new
				// head, where the path is a file or gone (the JS CLI listed
				// them from o.previous.sha).
				if err := r.collectTreeSide(ctx, previous.SHA, c.Path, "removed", &expanded); err != nil {
					return workdir.DeltaManifest{}, err
				}
			} else if c.OldHash != nil {
				expanded = append(expanded, workdir.DeltaChange{Path: c.Path, Status: "removed", OldHash: c.OldHash, OldMode: c.OldMode})
			}
			if isTreeMode(c.NewMode) {
				if err := r.collectTreeSide(ctx, sha, c.Path, "added", &expanded); err != nil {
					return workdir.DeltaManifest{}, err
				}
			} else if c.NewHash != nil {
				expanded = append(expanded, workdir.DeltaChange{Path: c.Path, Status: "added", NewHash: c.NewHash, NewMode: c.NewMode})
			}
		} else {
			expanded = append(expanded, c)
		}
	}
	if len(expanded) > maxDeltaChanges {
		return workdir.DeltaManifest{}, fmt.Errorf("delta of %d changed paths exceeds the warm budget of %d", len(expanded), maxDeltaChanges)
	}

	manifest := workdir.DeltaManifest{
		SHA:     sha,
		Source:  "delta",
		Changes: expanded,
	}
	budget := &byteBudget{max: maxDeltaReadBytes}
	cache := &prefetchCache{data: map[string][]byte{}}
	fetch := func(path string) ([]byte, error) {
		body, err := r.getJSON(ctx, fmt.Sprintf("contents?path=%s&ref=%s", opcli.EncodeURIComponent(path), opcli.EncodeURIComponent(sha)))
		if err != nil {
			return nil, err
		}
		content, _ := body["content"].(string)
		encoding, _ := body["encoding"].(string)
		if content == "" || (encoding != "utf-8" && encoding != "base64") {
			return nil, errs.NewFailure("contents: malformed response")
		}
		var data []byte
		if encoding == "base64" {
			data, err = base64.StdEncoding.DecodeString(content)
			if err != nil {
				return nil, errs.NewFailure("contents: malformed response")
			}
		} else {
			data = []byte(content)
		}
		// Per-response caps do not bound a delta that reads hundreds of
		// individually valid files; one aggregate budget does.
		if err := budget.add(int64(len(data))); err != nil {
			return nil, err
		}
		return data, nil
	}
	// The Node CLI fetched one file at a time as the apply loop touched it;
	// Go makes the round-trips parallel. Prefetch the paths that certainly
	// need new bytes (every change carrying a new blob side), with a bounded
	// worker pool; the apply loop then reads from the cache, and the rare
	// dirty-file restore still fetches on demand. A prefetch failure or an
	// exhausted budget just leaves the path uncached — the sequential read
	// surfaces the real error at the moment it matters.
	prefetchPaths := make([]string, 0, len(expanded))
	seen := map[string]bool{}
	for _, c := range expanded {
		if c.NewHash == nil || isGitlinkMode(c.NewMode) || seen[c.Path] {
			continue
		}
		seen[c.Path] = true
		prefetchPaths = append(prefetchPaths, c.Path)
	}
	paths := make(chan string)
	var wg sync.WaitGroup
	workers := prefetchWorkers
	if workers > len(prefetchPaths) {
		workers = len(prefetchPaths)
	}
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for path := range paths {
				if budget.exceeded() {
					continue
				}
				data, err := fetch(path)
				if err != nil {
					continue
				}
				cache.put(path, data)
			}
		}()
	}
	for _, p := range prefetchPaths {
		paths <- p
	}
	close(paths)
	wg.Wait()

	manifest.Read = func(path string) ([]byte, error) {
		if data, ok := cache.get(path); ok {
			return data, nil
		}
		return fetch(path)
	}
	return manifest, nil
}

// prefetchWorkers bounds the concurrent content fetches of one warm delta.
const prefetchWorkers = 8

// prefetchCache holds bytes fetched ahead of the apply loop.
type prefetchCache struct {
	mu   sync.Mutex
	data map[string][]byte
}

func (c *prefetchCache) get(path string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	data, ok := c.data[path]
	return data, ok
}

func (c *prefetchCache) put(path string, data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.data[path] = data
}

// byteBudget bounds the total decoded content one warm delta may read
// before falling back to a full checkout.
type byteBudget struct {
	mu    sync.Mutex
	total int64
	max   int64
}

func (b *byteBudget) add(n int64) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if n > b.max-b.total {
		return fmt.Errorf("delta content exceeds the warm read budget of %d bytes", b.max)
	}
	b.total += n
	return nil
}

// exceeded reports whether the budget is spent, so prefetch workers stop
// without racing the sequential reader that must still see the real error.
func (b *byteBudget) exceeded() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.total >= b.max
}

var (
	hashRe   = regexp.MustCompile(`^[0-9a-f]{40}$`)
	modeRe   = regexp.MustCompile(`^\d{1,6}$`)
	statuses = map[string]bool{"added": true, "removed": true, "modified": true, "renamed": true, "typechange": true}
)

// isTreeMode matches tree modes as the compare API reports them (raw git
// never pads).
func isTreeMode(mode *string) bool {
	if mode == nil {
		return false
	}
	return *mode == "40000" || *mode == "040000"
}

// isGitlinkMode matches a submodule entry; a snapshot checkout never holds
// one, so delta sides carrying it are skipped rather than fetched.
func isGitlinkMode(mode *string) bool {
	return mode != nil && *mode == "160000"
}

// parseChange validates one wire entry of the compare API.
func parseChange(value any) (workdir.DeltaChange, error) {
	obj, ok := value.(map[string]any)
	if !ok {
		return workdir.DeltaChange{}, errs.NewFailure("compare: malformed entry")
	}
	path, _ := obj["path"].(string)
	status, _ := obj["status"].(string)
	if path == "" || !statuses[status] {
		return workdir.DeltaChange{}, errs.NewFailure("compare: malformed entry")
	}
	c := workdir.DeltaChange{Path: path, Status: status}
	var err error
	if c.OldHash, err = hashOrNull(obj["oldHash"]); err != nil {
		return workdir.DeltaChange{}, errs.NewFailure("compare: malformed entry")
	}
	if c.NewHash, err = hashOrNull(obj["newHash"]); err != nil {
		return workdir.DeltaChange{}, errs.NewFailure("compare: malformed entry")
	}
	if c.OldMode, err = modeOrNull(obj["oldMode"]); err != nil {
		return workdir.DeltaChange{}, errs.NewFailure("compare: malformed entry")
	}
	if c.NewMode, err = modeOrNull(obj["newMode"]); err != nil {
		return workdir.DeltaChange{}, errs.NewFailure("compare: malformed entry")
	}
	if raw, has := obj["oldPath"]; has {
		oldPath, ok := raw.(string)
		if !ok {
			return workdir.DeltaChange{}, errs.NewFailure("compare: malformed entry")
		}
		c.OldPath = &oldPath
	}
	return c, nil
}

func hashOrNull(v any) (*string, error) {
	if v == nil {
		return nil, nil
	}
	s, ok := v.(string)
	if !ok || !hashRe.MatchString(s) {
		return nil, errs.NewFailure("malformed blob hash")
	}
	return &s, nil
}

func modeOrNull(v any) (*string, error) {
	if v == nil {
		return nil, nil
	}
	s, ok := v.(string)
	if !ok || !modeRe.MatchString(s) {
		return nil, errs.NewFailure("malformed mode")
	}
	return &s, nil
}

// collectTreeSide lists the subtree prefix of one commit through the tree
// API and appends its leaf files as status changes. Gitlinks never appear in
// a snapshot checkout and are skipped.
func (r *runner) collectTreeSide(ctx context.Context, ref, prefix, status string, out *[]workdir.DeltaChange) error {
	if len(*out) >= maxDeltaChanges {
		return fmt.Errorf("delta of %q exceeds the changed-path budget", prefix)
	}
	body, err := r.getJSON(ctx, fmt.Sprintf("tree?ref=%s&path=%s", opcli.EncodeURIComponent(ref), opcli.EncodeURIComponent(prefix)))
	if err != nil {
		return err
	}
	entries, ok := body["entries"].([]any)
	if !ok {
		return errs.NewFailure("tree: malformed response")
	}
	for _, raw := range entries {
		entry, ok := raw.(map[string]any)
		if !ok {
			return errs.NewFailure("tree: malformed entry")
		}
		path, _ := entry["path"].(string)
		mode, _ := entry["mode"].(string)
		hash, _ := entry["hash"].(string)
		kind, _ := entry["type"].(string)
		if path == "" || mode == "" || hash == "" || kind == "" {
			return errs.NewFailure("tree: malformed entry")
		}
		switch kind {
		case "tree":
			if err := r.collectTreeSide(ctx, ref, path, status, out); err != nil {
				return err
			}
		case "blob":
			*out = append(*out, treeSideChange(status, path, hash, mode))
		default:
			// 'commit' entries are gitlinks: a snapshot checkout never holds them.
		}
	}
	return nil
}

func treeSideChange(status, path, hash, mode string) workdir.DeltaChange {
	if status == "added" {
		return workdir.DeltaChange{Path: path, Status: "added", NewHash: &hash, NewMode: &mode}
	}
	return workdir.DeltaChange{Path: path, Status: "removed", OldHash: &hash, OldMode: &mode}
}
