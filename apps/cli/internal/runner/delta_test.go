package runner

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"kvarm/cli/internal/httpx"
	"kvarm/cli/internal/ui"
	"kvarm/cli/internal/workdir"
)

// blobHash is a deterministic 40-hex blob hash for one fixture file.
func blobHash(seed int) string {
	return fmt.Sprintf("%040x", seed+1)
}

// newDeltaRunner is a runner wired to an in-process platform, for the delta
// fetcher's own tests.
func newDeltaRunner(t *testing.T, baseURL string) *runner {
	t.Helper()
	return &runner{
		baseURL:  baseURL,
		pat:      "kvarm_pat_test",
		reposURL: "/api/v1/repos/alice/demo",
		client:   httpx.New(),
		stdout:   ui.New(io.Discard),
		stderr:   ui.New(io.Discard),
	}
}

func recordedState() workdir.RecordedState {
	return workdir.RecordedState{
		SHA:   jobSHA,
		Files: []string{"a.txt"},
		Blobs: map[string]string{"a.txt": blobHash(0)},
		Modes: map[string]string{"a.txt": "100644"},
	}
}

// fetch runs the delta fetcher against the platform.
func fetch(t *testing.T, platform *fakePlatform, previous workdir.RecordedState, sha string) (workdir.DeltaManifest, error) {
	t.Helper()
	baseURL := startPlatform(t, platform)
	return newDeltaRunner(t, baseURL).fetchDelta(context.Background(), Options{}, previous, sha)
}

// contentsPaths returns the path query of every contents request.
func contentsPaths(platform *fakePlatform) []string {
	var out []string
	for _, call := range platform.callsContaining("/contents") {
		query, err := url.ParseQuery(call.query)
		if err != nil {
			continue
		}
		out = append(out, query.Get("path"))
	}
	return out
}

func countPath(paths []string, want string) int {
	n := 0
	for _, path := range paths {
		if path == want {
			n++
		}
	}
	return n
}

func TestFetchDeltaHappyPath(t *testing.T) {
	platform := &fakePlatform{
		compare: func(cursor string) (int, string) {
			if cursor == "" {
				return 200, fmt.Sprintf(`{"files":[
					{"path":"a.txt","status":"modified","oldHash":%q,"newHash":%q,"oldMode":"100644","newMode":"100644"},
					{"path":"b.txt","status":"added","oldHash":null,"newHash":%q,"oldMode":null,"newMode":"100644"},
					{"path":"c.txt","status":"removed","oldHash":%q,"newHash":null,"oldMode":"100644","newMode":null},
					{"path":"d.txt","status":"renamed","oldHash":%q,"newHash":%q,"oldMode":"100644","newMode":"100644","oldPath":"old-d.txt"}
				],"nextCursor":"page-2"}`, blobHash(0), blobHash(1), blobHash(2), blobHash(3), blobHash(4), blobHash(5))
			}
			if cursor != "page-2" {
				t.Errorf("cursor = %q", cursor)
			}
			return 200, fmt.Sprintf(`{"files":[{"path":"e.txt","status":"added","oldHash":null,"newHash":%q,"oldMode":null,"newMode":"100755"}]}`, blobHash(6))
		},
		contents: func(path, ref string) (int, string) {
			if ref != otherSHA {
				t.Errorf("contents ref = %q, want the new head", ref)
			}
			switch path {
			case "a.txt":
				return 200, `{"content":"aGVsbG8gYmluYXJ5AA==","encoding":"base64"}`
			default:
				return 200, fmt.Sprintf(`{"content":"content of %s\n","encoding":"utf-8"}`, path)
			}
		},
	}

	manifest, err := fetch(t, platform, recordedState(), otherSHA)
	if err != nil {
		t.Fatalf("fetchDelta: %v", err)
	}
	if manifest.SHA != otherSHA || manifest.Source != "delta" {
		t.Errorf("manifest = %+v", manifest)
	}
	if len(manifest.Changes) != 5 {
		t.Fatalf("changes = %d, want 5: %+v", len(manifest.Changes), manifest.Changes)
	}
	// The pages keep their wire order.
	wantPaths := []string{"a.txt", "b.txt", "c.txt", "d.txt", "e.txt"}
	for i, want := range wantPaths {
		if manifest.Changes[i].Path != want {
			t.Errorf("change %d = %+v, want path %q", i, manifest.Changes[i], want)
		}
	}
	if status := manifest.Changes[2].Status; status != "removed" {
		t.Errorf("change 2 status = %q", status)
	}
	if manifest.Changes[3].OldPath == nil || *manifest.Changes[3].OldPath != "old-d.txt" {
		t.Errorf("rename old path = %v", manifest.Changes[3].OldPath)
	}
	if mode := manifest.Changes[4].NewMode; mode == nil || *mode != "100755" {
		t.Errorf("change 4 new mode = %v", mode)
	}

	// Read decodes base64 and passes utf-8 through.
	got, err := manifest.Read("a.txt")
	if err != nil || string(got) != "hello binary\x00" {
		t.Errorf("Read(a.txt) = %q, %v", got, err)
	}
	got, err = manifest.Read("b.txt")
	if err != nil || string(got) != "content of b.txt\n" {
		t.Errorf("Read(b.txt) = %q, %v", got, err)
	}
	// A removed path carries no new bytes: the read goes to the platform.
	got, err = manifest.Read("c.txt")
	if err != nil || string(got) != "content of c.txt\n" {
		t.Errorf("Read(c.txt) = %q, %v", got, err)
	}

	// Every page was followed, in order, with the cursor encoded.
	compares := platform.callsContaining("/compare/")
	if len(compares) != 2 {
		t.Fatalf("compare calls = %d, want two pages", len(compares))
	}
	if compares[0].path != "/api/v1/repos/alice/demo/compare/"+jobSHA+"..."+otherSHA {
		t.Errorf("first compare path = %q", compares[0].path)
	}
	if compares[1].query != "cursor=page-2" {
		t.Errorf("second compare query = %q", compares[1].query)
	}
}

func TestFetchDeltaRefusesATruncatedCompare(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{
			name: "with a reason",
			body: `{"truncated":true,"truncatedReason":"path budget","files":[]}`,
			want: "compare is truncated (path budget); the delta would be incomplete",
		},
		{
			name: "without a reason",
			body: `{"truncated":true,"files":[]}`,
			want: "compare is truncated (budget); the delta would be incomplete",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			platform := &fakePlatform{compare: func(string) (int, string) { return 200, tt.body }}
			manifest, err := fetch(t, platform, recordedState(), otherSHA)
			if err == nil || err.Error() != tt.want {
				t.Fatalf("error = %v, want %q", err, tt.want)
			}
			if manifest.Source != "" || manifest.Changes != nil {
				t.Errorf("manifest = %+v, want the zero manifest", manifest)
			}
			if len(contentsPaths(platform)) != 0 {
				t.Error("a truncated compare must not fetch content")
			}
		})
	}
}

func TestFetchDeltaCompareAPIError(t *testing.T) {
	platform := &fakePlatform{compare: func(string) (int, string) {
		return 404, `{"error":"no such commit","code":"UNKNOWN_COMMIT"}`
	}}
	_, err := fetch(t, platform, recordedState(), otherSHA)
	want := "compare/" + jobSHA + "..." + otherSHA + ": no such commit (UNKNOWN_COMMIT)"
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %q", err, want)
	}
}

func TestFetchDeltaExpandsADirectoryThatBecameAFile(t *testing.T) {
	platform := &fakePlatform{
		compare: func(string) (int, string) {
			return 200, fmt.Sprintf(`{"files":[{"path":"dir","status":"typechange","oldHash":null,"newHash":%q,"oldMode":"40000","newMode":"100644"}]}`, blobHash(9))
		},
		tree: func(ref, path string) (int, string) {
			if ref != jobSHA {
				t.Errorf("tree ref = %q, want the recorded commit", ref)
			}
			switch path {
			case "dir":
				return 200, fmt.Sprintf(`{"entries":[
					{"path":"dir/a.txt","mode":"100644","hash":%q,"type":"blob"},
					{"path":"dir/sub","mode":"40000","hash":%q,"type":"tree"}
				]}`, blobHash(1), blobHash(2))
			case "dir/sub":
				return 200, fmt.Sprintf(`{"entries":[{"path":"dir/sub/b.txt","mode":"100755","hash":%q,"type":"blob"}]}`, blobHash(3))
			default:
				return 404, `{"error":"unknown tree"}`
			}
		},
		contents: func(string, string) (int, string) {
			return 200, `{"content":"x","encoding":"utf-8"}`
		},
	}

	manifest, err := fetch(t, platform, recordedState(), otherSHA)
	if err != nil {
		t.Fatalf("fetchDelta: %v", err)
	}
	if len(manifest.Changes) != 3 {
		t.Fatalf("changes = %+v, want the tree side then the file", manifest.Changes)
	}
	// The tree side lists leaf files recursively, in the order the tree API
	// served them.
	removed := manifest.Changes[0]
	if removed.Path != "dir/a.txt" || removed.Status != "removed" || removed.OldHash == nil || *removed.OldHash != blobHash(1) {
		t.Errorf("change 0 = %+v", removed)
	}
	if nested := manifest.Changes[1]; nested.Path != "dir/sub/b.txt" || nested.Status != "removed" || *nested.OldMode != "100755" {
		t.Errorf("change 1 = %+v", nested)
	}
	added := manifest.Changes[2]
	if added.Path != "dir" || added.Status != "added" || added.NewHash == nil || *added.NewHash != blobHash(9) {
		t.Errorf("change 2 = %+v", added)
	}
	trees := platform.callsContaining("/tree")
	if len(trees) != 2 {
		t.Fatalf("tree calls = %v, want the prefix and its subtree", trees)
	}
	if trees[0].query != "ref="+jobSHA+"&path=dir" || trees[1].query != "ref="+jobSHA+"&path=dir%2Fsub" {
		t.Errorf("tree queries = %q and %q", trees[0].query, trees[1].query)
	}
}

func TestFetchDeltaExpandsAFileThatBecameADirectory(t *testing.T) {
	platform := &fakePlatform{
		compare: func(string) (int, string) {
			return 200, fmt.Sprintf(`{"files":[{"path":"dir","status":"typechange","oldHash":%q,"newHash":null,"oldMode":"100644","newMode":"40000"}]}`, blobHash(0))
		},
		tree: func(ref, path string) (int, string) {
			if ref != otherSHA {
				t.Errorf("tree ref = %q, want the new head", ref)
			}
			return 200, fmt.Sprintf(`{"entries":[
				{"path":"dir/x.txt","mode":"100644","hash":%q,"type":"blob"},
				{"path":"dir/link","mode":"160000","hash":%q,"type":"commit"}
			]}`, blobHash(4), blobHash(5))
		},
		contents: func(string, string) (int, string) {
			return 200, `{"content":"x","encoding":"utf-8"}`
		},
	}

	manifest, err := fetch(t, platform, recordedState(), otherSHA)
	if err != nil {
		t.Fatalf("fetchDelta: %v", err)
	}
	if len(manifest.Changes) != 2 {
		t.Fatalf("changes = %+v, want the removed file and the added leaf", manifest.Changes)
	}
	if removed := manifest.Changes[0]; removed.Path != "dir" || removed.Status != "removed" || *removed.OldHash != blobHash(0) {
		t.Errorf("change 0 = %+v", removed)
	}
	added := manifest.Changes[1]
	if added.Path != "dir/x.txt" || added.Status != "added" || added.NewHash == nil || *added.NewHash != blobHash(4) {
		t.Errorf("change 1 = %+v", added)
	}
	// The gitlink tree entry never becomes a change and is never fetched.
	if paths := contentsPaths(platform); countPath(paths, "dir/link") != 0 {
		t.Errorf("contents requests = %v, want no request for the gitlink", paths)
	}
}

func TestFetchDeltaSkipsGitlinkChanges(t *testing.T) {
	platform := &fakePlatform{
		compare: func(string) (int, string) {
			return 200, fmt.Sprintf(`{"files":[{"path":"sub","status":"modified","oldHash":%q,"newHash":%q,"oldMode":"160000","newMode":"160000"}]}`,
				blobHash(0), blobHash(1))
		},
		contents: func(path, _ string) (int, string) {
			t.Errorf("the gitlink %q was fetched", path)
			return 200, `{"content":"x","encoding":"utf-8"}`
		},
	}

	manifest, err := fetch(t, platform, recordedState(), otherSHA)
	if err != nil {
		t.Fatalf("fetchDelta: %v", err)
	}
	// The change stays in the manifest; only its bytes are never fetched
	// (the JS fetchDelta skips a 160000 side).
	if len(manifest.Changes) != 1 || manifest.Changes[0].Path != "sub" {
		t.Errorf("changes = %+v", manifest.Changes)
	}
	if paths := contentsPaths(platform); len(paths) != 0 {
		t.Errorf("contents requests = %v, want none", paths)
	}
}

func TestFetchDeltaRefusesTooManyChanges(t *testing.T) {
	var files []string
	for i := 0; i < maxDeltaChanges+1; i++ {
		files = append(files, fmt.Sprintf(`{"path":"f%04d.txt","status":"added","oldHash":null,"newHash":%q,"oldMode":null,"newMode":"100644"}`, i, blobHash(i)))
	}
	platform := &fakePlatform{compare: func(string) (int, string) {
		return 200, `{"files":[` + strings.Join(files, ",") + `]}`
	}}

	_, err := fetch(t, platform, recordedState(), otherSHA)
	want := fmt.Sprintf("delta of %d changed paths exceeds the warm budget of %d", maxDeltaChanges+1, maxDeltaChanges)
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %q", err, want)
	}
	if paths := contentsPaths(platform); len(paths) != 0 {
		t.Errorf("contents requests = %d, want none past the budget", len(paths))
	}
}

func TestFetchDeltaRefusesMalformedEntries(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{"entry is not an object", `{"files":["nope"]}`, "compare: malformed entry"},
		{"missing path", `{"files":[{"status":"added","newHash":"` + blobHash(0) + `","newMode":"100644"}]}`, "compare: malformed entry"},
		{"empty path", `{"files":[{"path":"","status":"added","newHash":"` + blobHash(0) + `","newMode":"100644"}]}`, "compare: malformed entry"},
		{"unknown status", `{"files":[{"path":"a","status":"bogus","newHash":"` + blobHash(0) + `","newMode":"100644"}]}`, "compare: malformed entry"},
		{"missing status", `{"files":[{"path":"a"}]}`, "compare: malformed entry"},
		{"bad hash", `{"files":[{"path":"a","status":"modified","oldHash":"xyz","newHash":null,"oldMode":"100644","newMode":null}]}`, "compare: malformed entry"},
		{"hash is not a string", `{"files":[{"path":"a","status":"modified","oldHash":7,"newHash":null,"oldMode":"100644","newMode":null}]}`, "compare: malformed entry"},
		{"bad mode", `{"files":[{"path":"a","status":"modified","oldHash":null,"newHash":"` + blobHash(0) + `","oldMode":null,"newMode":"rwx"}]}`, "compare: malformed entry"},
		{"mode is not a string", `{"files":[{"path":"a","status":"modified","oldHash":null,"newHash":"` + blobHash(0) + `","oldMode":null,"newMode":420}]}`, "compare: malformed entry"},
		{"old path is not a string", `{"files":[{"path":"a","status":"renamed","oldHash":null,"newHash":"` + blobHash(0) + `","oldMode":null,"newMode":"100644","oldPath":7}]}`, "compare: malformed entry"},
		{"files is not an array", `{"files":{}}`, "compare: malformed response"},
		{"files is missing", `{}`, "compare: malformed response"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			platform := &fakePlatform{compare: func(string) (int, string) { return 200, tt.body }}
			_, err := fetch(t, platform, recordedState(), otherSHA)
			if err == nil || err.Error() != tt.want {
				t.Fatalf("error = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestFetchDeltaRefusesAMalformedTree(t *testing.T) {
	typechange := `{"files":[{"path":"dir","status":"typechange","oldHash":null,"newHash":null,"oldMode":"40000","newMode":"40000"}]}`
	tests := []struct {
		name string
		tree func(string, string) (int, string)
		want string
	}{
		{
			name: "entries is not an array",
			tree: func(string, string) (int, string) { return 200, `{"entries":{}}` },
			want: "tree: malformed response",
		},
		{
			name: "entry is not an object",
			tree: func(string, string) (int, string) { return 200, `{"entries":["x"]}` },
			want: "tree: malformed entry",
		},
		{
			name: "entry is missing a field",
			tree: func(string, string) (int, string) {
				return 200, `{"entries":[{"path":"dir/a","mode":"100644","type":"blob"}]}`
			},
			want: "tree: malformed entry",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			platform := &fakePlatform{
				compare: func(string) (int, string) { return 200, typechange },
				tree:    tt.tree,
			}
			_, err := fetch(t, platform, recordedState(), otherSHA)
			if err == nil || err.Error() != tt.want {
				t.Fatalf("error = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestFetchDeltaReadRefusesMalformedContents(t *testing.T) {
	added := fmt.Sprintf(`{"files":[{"path":"a.txt","status":"added","oldHash":null,"newHash":%q,"oldMode":null,"newMode":"100644"}]}`, blobHash(0))
	tests := []struct {
		name     string
		contents func(string, string) (int, string)
		want     string
	}{
		{
			name:     "empty content",
			contents: func(string, string) (int, string) { return 200, `{"content":"","encoding":"utf-8"}` },
			want:     "contents: malformed response",
		},
		{
			name:     "unknown encoding",
			contents: func(string, string) (int, string) { return 200, `{"content":"x","encoding":"rot13"}` },
			want:     "contents: malformed response",
		},
		{
			name:     "content is not valid base64",
			contents: func(string, string) (int, string) { return 200, `{"content":"!!!","encoding":"base64"}` },
			want:     "contents: malformed response",
		},
		{
			name:     "the API refuses the read",
			contents: func(string, string) (int, string) { return 404, `{"error":"no such blob"}` },
			want:     "contents: no such blob",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			platform := &fakePlatform{
				compare:  func(string) (int, string) { return 200, added },
				contents: tt.contents,
			}
			// A prefetch failure is swallowed: the sequential read surfaces it.
			manifest, err := fetch(t, platform, recordedState(), otherSHA)
			if err != nil {
				t.Fatalf("fetchDelta: %v", err)
			}
			if _, err := manifest.Read("a.txt"); err == nil || err.Error() != tt.want {
				t.Fatalf("Read error = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestFetchDeltaPrefetchesEachPathOnce(t *testing.T) {
	const files = 20
	var entries []string
	for i := 0; i < files; i++ {
		entries = append(entries, fmt.Sprintf(`{"path":"f%02d.txt","status":"modified","oldHash":%q,"newHash":%q,"oldMode":"100644","newMode":"100644"}`,
			i, blobHash(i), blobHash(100+i)))
	}
	var inFlight, peak int
	var mu sync.Mutex
	platform := &fakePlatform{
		compare: func(string) (int, string) {
			return 200, `{"files":[` + strings.Join(entries, ",") + `]}`
		},
		contents: func(path, _ string) (int, string) {
			mu.Lock()
			inFlight++
			if inFlight > peak {
				peak = inFlight
			}
			mu.Unlock()
			defer func() {
				mu.Lock()
				inFlight--
				mu.Unlock()
			}()
			// Hold the request open so the worker pool's overlap is visible.
			time.Sleep(2 * time.Millisecond)
			return 200, fmt.Sprintf(`{"content":"body of %s","encoding":"utf-8"}`, path)
		},
	}

	manifest, err := fetch(t, platform, recordedState(), otherSHA)
	if err != nil {
		t.Fatalf("fetchDelta: %v", err)
	}
	paths := contentsPaths(platform)
	if len(paths) != files {
		t.Fatalf("contents requests = %d, want one per changed path", len(paths))
	}
	for i := 0; i < files; i++ {
		want := fmt.Sprintf("f%02d.txt", i)
		if countPath(paths, want) != 1 {
			t.Errorf("%s was requested %d times", want, countPath(paths, want))
		}
		got, err := manifest.Read(want)
		if err != nil {
			t.Fatalf("Read(%s): %v", want, err)
		}
		if string(got) != "body of "+want {
			t.Errorf("Read(%s) = %q", want, got)
		}
	}
	// Every read was served from the prefetch cache.
	if after := contentsPaths(platform); len(after) != files {
		t.Errorf("contents requests after the reads = %d, want the %d prefetches", len(after), files)
	}
	mu.Lock()
	defer mu.Unlock()
	if peak > prefetchWorkers {
		t.Errorf("peak concurrent contents requests = %d, want at most %d", peak, prefetchWorkers)
	}
	if peak < 2 {
		t.Errorf("peak concurrency = %d, want the worker pool in use", peak)
	}
}

func TestFetchDeltaStopsPrefetchingAtTheReadBudget(t *testing.T) {
	if testing.Short() {
		t.Skip("the warm read budget is 64 MiB, so this test transfers 64 MiB")
	}
	// Eight 7.5 MiB files fit the 64 MiB budget; the ninth cannot. Prefetch
	// drops it silently and the sequential read surfaces the real error.
	const (
		files      = 9
		fileBytes  = 7500 * 1024
		budgetNote = "delta content exceeds the warm read budget of 67108864 bytes"
	)
	var entries []string
	for i := 0; i < files; i++ {
		entries = append(entries, fmt.Sprintf(`{"path":"big%02d.bin","status":"modified","oldHash":%q,"newHash":%q,"oldMode":"100644","newMode":"100644"}`,
			i, blobHash(i), blobHash(100+i)))
	}
	body := `{"content":"` + strings.Repeat("a", fileBytes) + `","encoding":"utf-8"}`
	platform := &fakePlatform{
		compare:  func(string) (int, string) { return 200, `{"files":[` + strings.Join(entries, ",") + `]}` },
		contents: func(string, string) (int, string) { return 200, body },
	}

	manifest, err := fetch(t, platform, recordedState(), otherSHA)
	if err != nil {
		t.Fatalf("fetchDelta: %v", err)
	}
	failures := 0
	for i := 0; i < files; i++ {
		path := fmt.Sprintf("big%02d.bin", i)
		data, err := manifest.Read(path)
		if err != nil {
			failures++
			if err.Error() != budgetNote {
				t.Errorf("Read(%s) error = %q, want %q", path, err, budgetNote)
			}
			continue
		}
		if len(data) != fileBytes {
			t.Errorf("Read(%s) = %d bytes, want %d", path, len(data), fileBytes)
		}
	}
	if failures != 1 {
		t.Errorf("budget failures = %d, want exactly one uncached path", failures)
	}
	// One prefetch per path, plus the sequential re-read of the path whose
	// prefetch the budget dropped.
	if paths := contentsPaths(platform); len(paths) != files+failures {
		t.Errorf("contents requests = %d, want %d", len(paths), files+failures)
	}
}

func TestByteBudget(t *testing.T) {
	budget := &byteBudget{max: 10}
	if budget.exceeded() {
		t.Error("a fresh budget is not spent")
	}
	if err := budget.add(4); err != nil {
		t.Fatalf("add: %v", err)
	}
	if budget.exceeded() {
		t.Error("the budget is not spent at 4 of 10")
	}
	if err := budget.add(6); err != nil {
		t.Fatalf("add: %v", err)
	}
	if !budget.exceeded() {
		t.Error("the budget is spent at exactly its maximum")
	}
	err := budget.add(1)
	if err == nil || err.Error() != "delta content exceeds the warm read budget of 10 bytes" {
		t.Fatalf("add over the budget = %v", err)
	}
	// A refused add leaves the total untouched.
	if budget.exceeded() != true {
		t.Error("a refused add changed the total")
	}
}

func TestPrefetchCache(t *testing.T) {
	cache := &prefetchCache{data: map[string][]byte{}}
	if _, ok := cache.get("missing"); ok {
		t.Error("a missing path was reported as cached")
	}
	cache.put("a", []byte("one"))
	got, ok := cache.get("a")
	if !ok || string(got) != "one" {
		t.Errorf("get = %q, %v", got, ok)
	}
}

func TestTreeModePredicates(t *testing.T) {
	mode := func(s string) *string { return &s }
	tests := []struct {
		mode   *string
		tree   bool
		link   bool
		reason string
	}{
		{nil, false, false, "absent"},
		{mode("100644"), false, false, "a regular file"},
		{mode("40000"), true, false, "a raw git tree mode"},
		{mode("040000"), true, false, "a padded tree mode"},
		{mode("160000"), false, true, "a gitlink"},
	}
	for _, tt := range tests {
		if got := isTreeMode(tt.mode); got != tt.tree {
			t.Errorf("isTreeMode(%s) = %v, want %v", tt.reason, got, tt.tree)
		}
		if got := isGitlinkMode(tt.mode); got != tt.link {
			t.Errorf("isGitlinkMode(%s) = %v, want %v", tt.reason, got, tt.link)
		}
	}
}

func TestTreeSideChange(t *testing.T) {
	added := treeSideChange("added", "dir/a.txt", blobHash(1), "100644")
	if added.Status != "added" || added.NewHash == nil || *added.NewHash != blobHash(1) ||
		added.NewMode == nil || *added.NewMode != "100644" || added.OldHash != nil {
		t.Errorf("added = %+v", added)
	}
	removed := treeSideChange("removed", "dir/a.txt", blobHash(1), "100755")
	if removed.Status != "removed" || removed.OldHash == nil || *removed.OldHash != blobHash(1) ||
		removed.OldMode == nil || *removed.OldMode != "100755" || removed.NewHash != nil {
		t.Errorf("removed = %+v", removed)
	}
}
