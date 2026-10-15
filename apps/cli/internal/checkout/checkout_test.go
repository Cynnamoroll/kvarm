package checkout

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/base64"
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

	"github.com/klauspost/compress/zstd"

	"kvarm/cli/internal/errs"
	"kvarm/cli/internal/gitx"
	"kvarm/cli/internal/httpx"
	"kvarm/cli/internal/ui"
)

const (
	fixtureSHA = "0123456789abcdef0123456789abcdef01234567"
	otherSHA   = "fedcba9876543210fedcba9876543210fedcba98"
	cloneSHA   = "cafebabecafebabecafebabecafebabecafebabe"
)

// tarFixture is a small tree as a plain tar, the shape a snapshot download
// serves: three files, one of them executable.
func tarFixture(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	files := []struct {
		name string
		body string
		mode int64
	}{
		{"README.md", "kvarm\n", 0o644},
		{"src/main.go", "package main\n", 0o644},
		{"bin/run.sh", "#!/bin/sh\necho hi\n", 0o755},
	}
	for _, f := range files {
		hdr := &tar.Header{Name: f.name, Mode: f.mode, Size: int64(len(f.body)), Typeflag: tar.TypeReg, Format: tar.FormatUSTAR}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatalf("writing %s: %v", f.name, err)
		}
		if _, err := tw.Write([]byte(f.body)); err != nil {
			t.Fatalf("writing %s: %v", f.name, err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("closing the tar: %v", err)
	}
	return buf.Bytes()
}

// bigTarFixture is a tar over the 1 MiB size slack, so a declared size below
// it trips a byte budget.
func bigTarFixture(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	body := bytes.Repeat([]byte("x"), 1200*1024)
	hdr := &tar.Header{Name: "big.bin", Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg, Format: tar.FormatUSTAR}
	if err := tw.WriteHeader(hdr); err != nil {
		t.Fatalf("writing the header: %v", err)
	}
	if _, err := tw.Write(body); err != nil {
		t.Fatalf("writing the body: %v", err)
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("closing the tar: %v", err)
	}
	return buf.Bytes()
}

// zstdFrames compresses each chunk into its own frame and concatenates them,
// the way the snapshot builder stores one frame per build step.
func zstdFrames(t *testing.T, chunks ...[]byte) []byte {
	t.Helper()
	var out bytes.Buffer
	for _, chunk := range chunks {
		enc, err := zstd.NewWriter(&out)
		if err != nil {
			t.Fatalf("zstd writer: %v", err)
		}
		if _, err := enc.Write(chunk); err != nil {
			t.Fatalf("zstd write: %v", err)
		}
		if err := enc.Close(); err != nil {
			t.Fatalf("zstd close: %v", err)
		}
	}
	return out.Bytes()
}

// recorder is an httptest server that remembers every request line.
type recorder struct {
	mu       sync.Mutex
	requests []string
}

func (s *recorder) record(r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, r.Method+" "+r.RequestURI)
}

func (s *recorder) seen() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.requests...)
}

// metadataJSON builds one snapshot metadata reply.
func metadataJSON(t *testing.T, fields map[string]any) string {
	t.Helper()
	data, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("marshalling metadata: %v", err)
	}
	return string(data)
}

// runCheckout runs one checkout and returns its streams.
func runCheckout(t *testing.T, o Options) (Result, string, string) {
	t.Helper()
	res, stdout, stderr, err := tryCheckout(t, o)
	if err != nil {
		t.Fatalf("Checkout: %v", err)
	}
	return res, stdout, stderr
}

func tryCheckout(t *testing.T, o Options) (Result, string, string, error) {
	t.Helper()
	var out, errOut bytes.Buffer
	o.Stdout = ui.New(&out)
	o.Stderr = ui.New(&errOut)
	if o.Client == nil {
		o.Client = httpx.New()
	}
	res, err := Checkout(context.Background(), o)
	return res, out.String(), errOut.String(), err
}

// snapshotDir returns a destination path that does not exist yet.
func snapshotDir(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "work")
}

// gitCall is one recorded git child.
type gitCall struct {
	args []string
	cwd  string
	env  map[string]string
}

// fakeGit answers git children by subcommand and records every call.
func fakeGit(t *testing.T, calls *[]gitCall, results map[string]gitx.Result) func([]string, string, map[string]string) gitx.Result {
	return func(args []string, cwd string, env map[string]string) gitx.Result {
		if calls != nil {
			*calls = append(*calls, gitCall{args: append([]string(nil), args...), cwd: cwd, env: env})
		}
		res, ok := results[args[0]]
		if !ok {
			t.Errorf("unexpected git call %v", args)
			return gitx.Result{Code: 127, Stderr: "unexpected"}
		}
		return res
	}
}

func successfulClone() map[string]gitx.Result {
	return map[string]gitx.Result{
		"clone":     {Code: 0},
		"checkout":  {Code: 0},
		"rev-parse": {Code: 0, Stdout: cloneSHA},
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	return string(data)
}

func TestCheckoutSnapshotIdentity(t *testing.T) {
	tarBytes := tarFixture(t)
	sha := fixtureSHA
	dir := snapshotDir(t)
	rec := &recorder{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.record(r)
		switch {
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/snapshots/main"):
			w.Header().Set("content-type", "application/json")
			io.WriteString(w, metadataJSON(t, map[string]any{
				"state": "ready", "sha": sha, "size": len(tarBytes), "encodedSize": len(tarBytes),
			}))
		case strings.HasSuffix(r.URL.Path, "/snapshots/"+sha+"/download"):
			w.Header().Set("content-type", "application/x-tar")
			w.Header().Set("x-kvarm-snapshot-sha", sha)
			w.Write(tarBytes)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	res, stdout, stderr := runCheckout(t, Options{
		BaseURL: server.URL, PAT: "kvarm_pat_test", Repo: "alice/demo", Ref: "main", Dir: dir,
	})

	if res.Source != "snapshot" || res.SHA != sha || res.Files != 3 || res.Bytes != int64(len(tarBytes)) {
		t.Errorf("result = %+v", res)
	}
	if res.TransferBytes != int64(len(tarBytes)) || res.Encoding != "identity" {
		t.Errorf("transfer/encoding = %d/%s", res.TransferBytes, res.Encoding)
	}
	want := strings.Join([]string{
		"source: snapshot",
		"sha: " + sha,
		"files: 3",
		fmt.Sprintf("bytes: %d", len(tarBytes)),
		fmt.Sprintf("transfer: %d", len(tarBytes)),
		"encoding: identity",
	}, "\n") + "\n"
	if stdout != want {
		t.Errorf("stdout = %q, want %q", stdout, want)
	}
	if !strings.Contains(stderr, dir+" holds the tree only (no .git)") {
		t.Errorf("stderr = %q, want the .git note", stderr)
	}
	if got := readFile(t, filepath.Join(dir, "README.md")); got != "kvarm\n" {
		t.Errorf("README.md = %q", got)
	}
	if got := readFile(t, filepath.Join(dir, "src/main.go")); got != "package main\n" {
		t.Errorf("src/main.go = %q", got)
	}
	info, err := os.Stat(filepath.Join(dir, "bin/run.sh"))
	if err != nil {
		t.Fatalf("stat run.sh: %v", err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Errorf("run.sh mode = %v, want 0755", info.Mode().Perm())
	}
	if _, err := os.Stat(filepath.Join(dir, ".git")); !os.IsNotExist(err) {
		t.Error("a snapshot checkout must hold the tree only, with no .git")
	}
	if seen := rec.seen(); len(seen) != 2 || !strings.HasPrefix(seen[0], "POST ") {
		t.Errorf("requests = %v, want a POST demand then a download", seen)
	}
}

func TestCheckoutSnapshotWithoutPATUsesGET(t *testing.T) {
	dir := snapshotDir(t)
	rec := &recorder{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.record(r)
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, `{"error":"no snapshot"}`)
	}))
	defer server.Close()

	var calls []gitCall
	res, _, stderr := runCheckout(t, Options{
		BaseURL: server.URL, Repo: "alice/demo", Ref: "main", Dir: dir,
		Git: fakeGit(t, &calls, successfulClone()),
	})

	if res.Source != "clone" || res.Reason != "snapshot API returned 404 no snapshot" {
		t.Errorf("result = %+v", res)
	}
	if !strings.Contains(stderr, "snapshot API returned 404 no snapshot; falling back to git clone") {
		t.Errorf("stderr = %q", stderr)
	}
	// Without a PAT the CLI must not demand a build: a metadata GET only.
	seen := rec.seen()
	if len(seen) != 1 || seen[0] != "GET /api/v1/repos/alice/demo/snapshots/main" {
		t.Errorf("requests = %v, want a single GET", seen)
	}
}

func TestCheckoutSnapshotZstd(t *testing.T) {
	tarBytes := tarFixture(t)
	compressed := zstdFrames(t, tarBytes)
	sha := fixtureSHA

	tests := []struct {
		name        string
		contentType string
		body        []byte
	}{
		{"declared", "application/zstd", compressed},
		{"sniffed from the magic", "application/x-tar", compressed},
		// The builder stores one frame per build step; the decoder continues
		// across frame boundaries the way `zstd -d` does.
		{"two frames", "application/zstd", zstdFrames(t, tarBytes[:600], tarBytes[600:])},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := snapshotDir(t)
			body := tt.body
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "POST" {
					w.Header().Set("content-type", "application/json")
					io.WriteString(w, metadataJSON(t, map[string]any{
						"state": "ready", "sha": sha, "size": len(tarBytes), "encodedSize": len(body), "encoding": "zstd",
					}))
					return
				}
				w.Header().Set("content-type", tt.contentType)
				w.Header().Set("x-kvarm-snapshot-sha", sha)
				w.Write(body)
			}))
			defer server.Close()

			res, stdout, _ := runCheckout(t, Options{
				BaseURL: server.URL, PAT: "kvarm_pat_test", Repo: "alice/demo", Ref: "main", Dir: dir,
			})
			if res.Encoding != "zstd" || res.Bytes != int64(len(tarBytes)) || res.Files != 3 {
				t.Errorf("result = %+v", res)
			}
			if res.TransferBytes != int64(len(body)) {
				t.Errorf("transfer = %d, want the whole wire body %d", res.TransferBytes, len(body))
			}
			if !strings.Contains(stdout, "encoding: zstd\n") {
				t.Errorf("stdout = %q", stdout)
			}
			if got := readFile(t, filepath.Join(dir, "bin/run.sh")); got != "#!/bin/sh\necho hi\n" {
				t.Errorf("run.sh = %q", got)
			}
		})
	}
}

func TestCheckoutSnapshotWithoutSizeFields(t *testing.T) {
	tarBytes := tarFixture(t)
	sha := fixtureSHA
	dir := snapshotDir(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			w.Header().Set("content-type", "application/json")
			io.WriteString(w, metadataJSON(t, map[string]any{"state": "ready", "sha": sha}))
			return
		}
		w.Header().Set("content-type", "application/x-tar")
		w.Write(tarBytes)
	}))
	defer server.Close()

	res, _, _ := runCheckout(t, Options{
		BaseURL: server.URL, PAT: "kvarm_pat_test", Repo: "alice/demo", Ref: "main", Dir: dir,
	})
	if res.Bytes != int64(len(tarBytes)) || res.TransferBytes != int64(len(tarBytes)) || res.Encoding != "identity" {
		t.Errorf("result = %+v", res)
	}
}

func TestCheckoutSnapshotShaMismatchFallsBack(t *testing.T) {
	tarBytes := tarFixture(t)
	sha := fixtureSHA
	wrong := otherSHA
	dir := snapshotDir(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			w.Header().Set("content-type", "application/json")
			io.WriteString(w, metadataJSON(t, map[string]any{"state": "ready", "sha": sha, "size": len(tarBytes)}))
			return
		}
		w.Header().Set("content-type", "application/x-tar")
		// The bytes are pinned to the metadata sha: a branch that moved must
		// not swap them (the JS `servedSha !== meta.sha` check).
		w.Header().Set("x-kvarm-snapshot-sha", wrong)
		w.Write(tarBytes)
	}))
	defer server.Close()

	var calls []gitCall
	res, stdout, stderr := runCheckout(t, Options{
		BaseURL: server.URL, PAT: "kvarm_pat_test", Repo: "alice/demo", Ref: "main", Dir: dir,
		Git: fakeGit(t, &calls, successfulClone()),
	})
	if res.Source != "clone" || res.SHA != cloneSHA {
		t.Errorf("result = %+v", res)
	}
	wantReason := fmt.Sprintf("download served %s, expected %s", wrong, sha)
	if !strings.Contains(res.Reason, wantReason) || !strings.Contains(stderr, "snapshot download failed: "+wantReason) {
		t.Errorf("reason/stderr = %q/%q", res.Reason, stderr)
	}
	if stdout != "source: clone\nsha: "+cloneSHA+"\n" {
		t.Errorf("stdout = %q", stdout)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Error("a failed download must leave no half-extracted directory behind")
	}
}

func TestCheckoutSnapshotSizeMismatchFallsBack(t *testing.T) {
	tarBytes := tarFixture(t)
	sha := fixtureSHA
	dir := snapshotDir(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			w.Header().Set("content-type", "application/json")
			// A declared size the extracted byte count cannot match.
			io.WriteString(w, metadataJSON(t, map[string]any{"state": "ready", "sha": sha, "size": 5}))
			return
		}
		w.Header().Set("content-type", "application/x-tar")
		w.Write(tarBytes)
	}))
	defer server.Close()

	var calls []gitCall
	res, _, stderr := runCheckout(t, Options{
		BaseURL: server.URL, PAT: "kvarm_pat_test", Repo: "alice/demo", Ref: "main", Dir: dir,
		Git: fakeGit(t, &calls, successfulClone()),
	})
	want := fmt.Sprintf("downloaded %d bytes, metadata size is 5", len(tarBytes))
	if !strings.Contains(res.Reason, want) || !strings.Contains(stderr, "snapshot download failed: "+want) {
		t.Errorf("reason/stderr = %q/%q", res.Reason, stderr)
	}
	if res.Source != "clone" {
		t.Errorf("result = %+v", res)
	}
}

func TestCheckoutSnapshotEncodedSizeMismatchFallsBack(t *testing.T) {
	tarBytes := tarFixture(t)
	compressed := zstdFrames(t, tarBytes)
	sha := fixtureSHA
	dir := snapshotDir(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			w.Header().Set("content-type", "application/json")
			io.WriteString(w, metadataJSON(t, map[string]any{
				"state": "ready", "sha": sha, "size": len(tarBytes), "encodedSize": 5,
			}))
			return
		}
		w.Header().Set("content-type", "application/zstd")
		w.Write(compressed)
	}))
	defer server.Close()

	var calls []gitCall
	res, _, stderr := runCheckout(t, Options{
		BaseURL: server.URL, PAT: "kvarm_pat_test", Repo: "alice/demo", Ref: "main", Dir: dir,
		Git: fakeGit(t, &calls, successfulClone()),
	})
	want := fmt.Sprintf("downloaded %d wire bytes, metadata encodedSize is 5", len(compressed))
	if !strings.Contains(res.Reason, want) || !strings.Contains(stderr, want) {
		t.Errorf("reason/stderr = %q/%q", res.Reason, stderr)
	}
}

func TestCheckoutSnapshotOverBudgetFallsBack(t *testing.T) {
	tarBytes := bigTarFixture(t)
	sha := fixtureSHA
	dir := snapshotDir(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			w.Header().Set("content-type", "application/json")
			// A declared size of zero leaves only the 1 MiB slack as the cap
			// (the JS declaredSize + SNAPSHOT_SIZE_SLACK_BYTES rule).
			io.WriteString(w, metadataJSON(t, map[string]any{"state": "ready", "sha": sha, "size": 0}))
			return
		}
		w.Header().Set("content-type", "application/x-tar")
		w.Write(tarBytes)
	}))
	defer server.Close()

	var calls []gitCall
	res, _, stderr := runCheckout(t, Options{
		BaseURL: server.URL, PAT: "kvarm_pat_test", Repo: "alice/demo", Ref: "main", Dir: dir,
		Git: fakeGit(t, &calls, successfulClone()),
	})
	if !strings.Contains(res.Reason, "snapshot download failed:") || !strings.Contains(res.Reason, "budget") {
		t.Errorf("reason = %q, want a budget refusal", res.Reason)
	}
	if !strings.Contains(stderr, "falling back to git clone") {
		t.Errorf("stderr = %q", stderr)
	}
}

func TestCheckoutSnapshotDownloadHTTPErrorFallsBack(t *testing.T) {
	tarBytes := tarFixture(t)
	sha := fixtureSHA
	dir := snapshotDir(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			w.Header().Set("content-type", "application/json")
			io.WriteString(w, metadataJSON(t, map[string]any{"state": "ready", "sha": sha, "size": len(tarBytes)}))
			return
		}
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, `{"error":"gone","code":"SNAPSHOT_GONE"}`)
	}))
	defer server.Close()

	var calls []gitCall
	res, _, _ := runCheckout(t, Options{
		BaseURL: server.URL, PAT: "kvarm_pat_test", Repo: "alice/demo", Ref: "main", Dir: dir,
		Git: fakeGit(t, &calls, successfulClone()),
	})
	if !strings.Contains(res.Reason, "download returned 404 SNAPSHOT_GONE") {
		t.Errorf("reason = %q", res.Reason)
	}
}

func TestCheckoutSnapshotBadZstdFallsBack(t *testing.T) {
	sha := fixtureSHA
	dir := snapshotDir(t)
	garbage := append([]byte{0x28, 0xb5, 0x2f, 0xfd}, bytes.Repeat([]byte("nope"), 64)...)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			w.Header().Set("content-type", "application/json")
			io.WriteString(w, metadataJSON(t, map[string]any{"state": "ready", "sha": sha, "size": 10}))
			return
		}
		w.Header().Set("content-type", "application/x-tar")
		w.Write(garbage)
	}))
	defer server.Close()

	var calls []gitCall
	res, stdout, stderr := runCheckout(t, Options{
		BaseURL: server.URL, PAT: "kvarm_pat_test", Repo: "alice/demo", Ref: "main", Dir: dir,
		Git: fakeGit(t, &calls, successfulClone()),
	})
	if res.Source != "clone" || !strings.Contains(res.Reason, "snapshot download failed:") {
		t.Errorf("result = %+v", res)
	}
	if strings.Contains(stdout, "source: snapshot") {
		t.Errorf("a corrupt snapshot body must not be reported as extracted: %q", stdout)
	}
	if !strings.Contains(stderr, "falling back to git clone") {
		t.Errorf("stderr = %q", stderr)
	}
}

func TestCheckoutSnapshotInvalidMetadataShaFallsBack(t *testing.T) {
	dir := snapshotDir(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		io.WriteString(w, metadataJSON(t, map[string]any{"state": "ready", "sha": "not-a-sha"}))
	}))
	defer server.Close()

	var calls []gitCall
	res, _, _ := runCheckout(t, Options{
		BaseURL: server.URL, PAT: "kvarm_pat_test", Repo: "alice/demo", Ref: "main", Dir: dir,
		Git: fakeGit(t, &calls, successfulClone()),
	})
	if res.Reason != "snapshot metadata contains an invalid commit sha" {
		t.Errorf("reason = %q", res.Reason)
	}
}

func TestCheckoutSnapshotNotReadyFallsBack(t *testing.T) {
	sha := fixtureSHA
	tests := []struct {
		name     string
		status   int
		pat      string
		body     map[string]any
		wantLine string
	}{
		{
			name: "building, demanded and started", status: 200, pat: "kvarm_pat_test",
			body:     map[string]any{"state": "building", "sha": sha, "started": true},
			wantLine: "snapshot building for " + sha[:12] + " (build started)",
		},
		{
			name: "building, demanded but not started", status: 202, pat: "kvarm_pat_test",
			body:     map[string]any{"state": "building", "sha": sha},
			wantLine: "snapshot building for " + sha[:12] + " (build in progress)",
		},
		{
			name: "building, not demanded", status: 200,
			body:     map[string]any{"state": "building", "sha": sha, "started": true},
			wantLine: "snapshot building for " + sha[:12],
		},
		{
			name: "absent without a token", status: 409,
			body:     map[string]any{"state": "absent", "sha": sha},
			wantLine: "snapshot absent for " + sha[:12] + " (set KVARM_PAT to request a build)",
		},
		{
			name: "absent with a token", status: 200, pat: "kvarm_pat_test",
			body:     map[string]any{"state": "absent"},
			wantLine: "snapshot absent",
		},
		{
			name: "failed", status: 200, pat: "kvarm_pat_test",
			body:     map[string]any{"state": "failed", "sha": sha},
			wantLine: "snapshot failed for " + sha[:12],
		},
		{
			name: "unknown state", status: 200, pat: "kvarm_pat_test",
			body:     map[string]any{"state": "queued"},
			wantLine: "snapshot state queued",
		},
		{
			name: "refused token", status: 401, pat: "kvarm_pat_test",
			body:     map[string]any{"error": "bad token"},
			wantLine: "snapshot API refused the token (401 bad token)",
		},
		{
			name: "forbidden", status: 403, pat: "kvarm_pat_test",
			body:     map[string]any{"error": "no access"},
			wantLine: "snapshot API refused the token (403 no access)",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := snapshotDir(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("content-type", "application/json")
				w.WriteHeader(tt.status)
				io.WriteString(w, metadataJSON(t, tt.body))
			}))
			defer server.Close()

			var calls []gitCall
			res, stdout, stderr := runCheckout(t, Options{
				BaseURL: server.URL, PAT: tt.pat, Repo: "alice/demo", Ref: "main", Dir: dir,
				Git: fakeGit(t, &calls, successfulClone()),
			})
			if res.Source != "clone" || res.Reason != tt.wantLine {
				t.Errorf("result = %+v, want the clone fallback with reason %q", res, tt.wantLine)
			}
			if !strings.Contains(stderr, tt.wantLine+"; falling back to git clone") {
				t.Errorf("stderr = %q, want the not-ready line", stderr)
			}
			if stdout != "source: clone\nsha: "+cloneSHA+"\n" {
				t.Errorf("stdout = %q", stdout)
			}
		})
	}
}

func TestDescribeNotReady(t *testing.T) {
	sha := fixtureSHA
	tests := []struct {
		name     string
		meta     any
		demanded bool
		want     string
	}{
		{"nil metadata", nil, true, "snapshot state unknown"},
		{"non-object metadata", "x", false, "snapshot state unknown"},
		{"building demanded", map[string]any{"state": "building", "sha": sha, "started": true}, true, "snapshot building for " + sha[:12] + " (build started)"},
		{"building demanded, not started", map[string]any{"state": "building", "sha": sha}, true, "snapshot building for " + sha[:12] + " (build in progress)"},
		{"building idle", map[string]any{"state": "building", "sha": sha}, false, "snapshot building for " + sha[:12]},
		{"absent idle", map[string]any{"state": "absent", "sha": sha}, false, "snapshot absent for " + sha[:12] + " (set KVARM_PAT to request a build)"},
		{"absent demanded", map[string]any{"state": "absent", "sha": sha}, true, "snapshot absent for " + sha[:12]},
		{"short sha is not shown", map[string]any{"state": "failed", "sha": "abc"}, true, "snapshot failed"},
		{"failed", map[string]any{"state": "failed", "sha": sha}, true, "snapshot failed for " + sha[:12]},
		{"other state", map[string]any{"state": "queued"}, true, "snapshot state queued"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := describeNotReady(tt.meta, tt.demanded); got != tt.want {
				t.Errorf("describeNotReady = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestCheckoutCloneFallback(t *testing.T) {
	dir := snapshotDir(t)
	rec := &recorder{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.record(r)
		w.WriteHeader(http.StatusInternalServerError)
		io.WriteString(w, `{"error":"boom"}`)
	}))
	defer server.Close()

	var calls []gitCall
	res, stdout, stderr := runCheckout(t, Options{
		BaseURL: server.URL, PAT: "kvarm_pat_test", Repo: "alice/demo", Ref: "refs/heads/main", Dir: dir,
		Git: fakeGit(t, &calls, successfulClone()),
	})
	if res.Source != "clone" || res.SHA != cloneSHA || res.Reason != "snapshot API returned 500 boom" {
		t.Errorf("result = %+v", res)
	}
	if stdout != "source: clone\nsha: "+cloneSHA+"\n" {
		t.Errorf("stdout = %q", stdout)
	}
	if !strings.Contains(stderr, "snapshot API returned 500 boom; falling back to git clone") {
		t.Errorf("stderr = %q", stderr)
	}
	if len(calls) != 3 {
		t.Fatalf("git calls = %v, want clone, checkout and rev-parse", calls)
	}
	wantURL := server.URL + "/alice/demo.git"
	wantClone := []string{"clone", "-q", "--no-checkout", wantURL, dir}
	if !equalStrings(calls[0].args, wantClone) || calls[0].cwd != "" {
		t.Errorf("clone call = %v in %q, want %v", calls[0].args, calls[0].cwd, wantClone)
	}
	// A refs/heads/ prefix is stripped for the checkout target.
	if !equalStrings(calls[1].args, []string{"checkout", "-q", "main"}) || calls[1].cwd != dir {
		t.Errorf("checkout call = %v in %q", calls[1].args, calls[1].cwd)
	}
	if !equalStrings(calls[2].args, []string{"rev-parse", "HEAD"}) {
		t.Errorf("rev-parse call = %v", calls[2].args)
	}
	// The PAT travels only as a scoped basic-auth header, never as argv.
	if calls[0].env["GIT_TERMINAL_PROMPT"] != "0" {
		t.Errorf("git env = %v, want GIT_TERMINAL_PROMPT=0", calls[0].env)
	}
	wantBasic := "Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte("kvarm:kvarm_pat_test"))
	found := false
	for _, value := range calls[0].env {
		if value == wantBasic {
			found = true
		}
	}
	if !found {
		t.Errorf("git env has no scoped credential header %q: %v", wantBasic, calls[0].env)
	}
	if strings.Contains(strings.Join(calls[0].args, " "), "kvarm_pat_test") {
		t.Error("the token reached git's argv")
	}
}

func TestCheckoutCloneURLOverride(t *testing.T) {
	dir := snapshotDir(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	var calls []gitCall
	const override = "https://git.example.com/alice/demo.git"
	res, _, _ := runCheckout(t, Options{
		BaseURL: server.URL, Repo: "alice/demo", Ref: "main", Dir: dir,
		CloneURL: override,
		Git:      fakeGit(t, &calls, successfulClone()),
	})
	if res.Source != "clone" {
		t.Errorf("result = %+v", res)
	}
	if calls[0].args[3] != override {
		t.Errorf("clone url = %q, want the override %q", calls[0].args[3], override)
	}
}

func TestCheckoutCloneFailures(t *testing.T) {
	tests := []struct {
		name    string
		results map[string]gitx.Result
		want    string
	}{
		{
			name: "clone",
			results: map[string]gitx.Result{
				"clone": {Code: 128, Stderr: "fatal: repository not found"},
			},
			want: "git clone failed: fatal: repository not found",
		},
		{
			name: "clone without stderr",
			results: map[string]gitx.Result{
				"clone": {Code: 3},
			},
			want: "git clone failed: exit 3",
		},
		{
			name: "checkout",
			results: map[string]gitx.Result{
				"clone":    {Code: 0},
				"checkout": {Code: 1, Stderr: "error: pathspec 'main' did not match"},
			},
			want: "git checkout refs/heads/main failed: error: pathspec 'main' did not match",
		},
		{
			name: "rev-parse",
			results: map[string]gitx.Result{
				"clone":     {Code: 0},
				"checkout":  {Code: 0},
				"rev-parse": {Code: 1, Stderr: "fatal: ambiguous argument"},
			},
			want: "git rev-parse HEAD failed: fatal: ambiguous argument",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := snapshotDir(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusNotFound)
			}))
			defer server.Close()

			var calls []gitCall
			res, _, _, err := tryCheckout(t, Options{
				BaseURL: server.URL, Repo: "alice/demo", Ref: "refs/heads/main", Dir: dir,
				Git: fakeGit(t, &calls, tt.results),
			})
			if err == nil || err.Error() != tt.want {
				t.Fatalf("error = %v, want %q", err, tt.want)
			}
			if res.Source != "" {
				t.Errorf("result = %+v, want the zero result on failure", res)
			}
			if _, statErr := os.Stat(dir); !os.IsNotExist(statErr) {
				t.Error("a failed clone must leave no destination directory behind")
			}
		})
	}
}

func TestCheckoutResetKeepsAPreexistingEmptyDirectory(t *testing.T) {
	tarBytes := tarFixture(t)
	sha := fixtureSHA
	dir := snapshotDir(t)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("creating the destination: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			w.Header().Set("content-type", "application/json")
			io.WriteString(w, metadataJSON(t, map[string]any{"state": "ready", "sha": sha, "size": 5}))
			return
		}
		w.Header().Set("content-type", "application/x-tar")
		w.Write(tarBytes)
	}))
	defer server.Close()

	var calls []gitCall
	_, _, _, err := tryCheckout(t, Options{
		BaseURL: server.URL, PAT: "kvarm_pat_test", Repo: "alice/demo", Ref: "main", Dir: dir,
		Git: fakeGit(t, &calls, map[string]gitx.Result{"clone": {Code: 1, Stderr: "nope"}}),
	})
	if err == nil {
		t.Fatal("the clone was expected to fail")
	}
	entries, readErr := os.ReadDir(dir)
	if readErr != nil {
		t.Fatalf("the destination this run found must survive: %v", readErr)
	}
	if len(entries) != 0 {
		t.Errorf("destination entries = %v, want the half-extracted tree removed", entries)
	}
}

func TestCheckoutSnapshotAPIUnreachable(t *testing.T) {
	dir := snapshotDir(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	baseURL := server.URL
	server.Close()

	var calls []gitCall
	res, _, stderr := runCheckout(t, Options{
		BaseURL: baseURL, Repo: "alice/demo", Ref: "main", Dir: dir,
		Git: fakeGit(t, &calls, successfulClone()),
	})
	if res.Source != "clone" || !strings.HasPrefix(res.Reason, "snapshot API unreachable: ") {
		t.Errorf("result = %+v", res)
	}
	if !strings.Contains(stderr, "snapshot API unreachable: ") {
		t.Errorf("stderr = %q", stderr)
	}
}

func TestCheckoutEncodesTheRefPath(t *testing.T) {
	dir := snapshotDir(t)
	rec := &recorder{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.record(r)
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	var calls []gitCall
	runCheckout(t, Options{
		BaseURL: server.URL, PAT: "kvarm_pat_test", Repo: "alice/demo", Ref: "feature/a b", Dir: dir,
		Git: fakeGit(t, &calls, successfulClone()),
	})
	want := "POST /api/v1/repos/alice/demo/snapshots/feature/a%20b"
	if seen := rec.seen(); len(seen) != 1 || seen[0] != want {
		t.Errorf("requests = %v, want %q", seen, want)
	}
}

func TestCheckoutUsageErrors(t *testing.T) {
	fileDir := filepath.Join(t.TempDir(), "a-file")
	if err := os.WriteFile(fileDir, []byte("x"), 0o644); err != nil {
		t.Fatalf("writing the file: %v", err)
	}
	nonEmpty := t.TempDir()
	if err := os.WriteFile(filepath.Join(nonEmpty, "keep.txt"), []byte("x"), 0o644); err != nil {
		t.Fatalf("writing the file: %v", err)
	}

	tests := []struct {
		name     string
		options  Options
		want     string
		exitCode int
	}{
		{
			name:     "missing base url",
			options:  Options{Repo: "alice/demo", Ref: "main", Dir: snapshotDir(t)},
			want:     "KVARM_BASE_URL is not set (e.g. https://kvarm.example.com)",
			exitCode: 2,
		},
		{
			name:     "non-http base url",
			options:  Options{BaseURL: "ftp://kvarm.example.com", Repo: "alice/demo", Ref: "main", Dir: snapshotDir(t)},
			want:     `KVARM_BASE_URL must be an http(s) URL, got "ftp://kvarm.example.com"`,
			exitCode: 2,
		},
		{
			name:     "bad repository",
			options:  Options{BaseURL: "http://kvarm.example.com", Repo: "alice", Ref: "main", Dir: snapshotDir(t)},
			want:     `invalid repository "alice", expected <owner>/<repo>`,
			exitCode: 2,
		},
		{
			name:     "missing ref",
			options:  Options{BaseURL: "http://kvarm.example.com", Repo: "alice/demo", Dir: snapshotDir(t)},
			want:     "missing <ref>",
			exitCode: 2,
		},
		{
			name:     "missing dir",
			options:  Options{BaseURL: "http://kvarm.example.com", Repo: "alice/demo", Ref: "main"},
			want:     "missing <dir>",
			exitCode: 2,
		},
		{
			name:     "ref with a dot segment",
			options:  Options{BaseURL: "http://kvarm.example.com", Repo: "alice/demo", Ref: "a/../b", Dir: snapshotDir(t)},
			want:     `invalid ref: path segments must be non-empty and cannot be "." or ".."`,
			exitCode: 2,
		},
		{
			name:     "ref with an empty segment",
			options:  Options{BaseURL: "http://kvarm.example.com", Repo: "alice/demo", Ref: "a//b", Dir: snapshotDir(t)},
			want:     `invalid ref: path segments must be non-empty and cannot be "." or ".."`,
			exitCode: 2,
		},
		{
			name:     "destination is not a directory",
			options:  Options{BaseURL: "http://kvarm.example.com", Repo: "alice/demo", Ref: "main", Dir: fileDir},
			want:     "destination " + fileDir + " exists and is not a directory",
			exitCode: 1,
		},
		{
			name:     "destination is not empty",
			options:  Options{BaseURL: "http://kvarm.example.com", Repo: "alice/demo", Ref: "main", Dir: nonEmpty},
			want:     "destination " + nonEmpty + " already exists and is not empty",
			exitCode: 1,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, _, err := tryCheckout(t, tt.options)
			if err == nil {
				t.Fatalf("Checkout returned no error, want %q", tt.want)
			}
			cliErr, ok := err.(*errs.CliError)
			if !ok {
				t.Fatalf("error = %#v, want a CliError", err)
			}
			if cliErr.Message != tt.want || cliErr.ExitCode != tt.exitCode {
				t.Errorf("error = %q (exit %d), want %q (exit %d)", cliErr.Message, cliErr.ExitCode, tt.want, tt.exitCode)
			}
		})
	}
}

func TestCheckoutWithProgress(t *testing.T) {
	tarBytes := tarFixture(t)
	sha := fixtureSHA
	dir := snapshotDir(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			w.Header().Set("content-type", "application/json")
			io.WriteString(w, metadataJSON(t, map[string]any{"state": "ready", "sha": sha, "size": len(tarBytes)}))
			return
		}
		w.Header().Set("content-type", "application/x-tar")
		w.Write(tarBytes)
	}))
	defer server.Close()

	var progress bytes.Buffer
	res, _, _ := runCheckout(t, Options{
		BaseURL: server.URL, PAT: "kvarm_pat_test", Repo: "alice/demo", Ref: "main", Dir: dir,
		Progress: ui.NewProgress(ui.New(&progress), "downloading snapshot"),
	})
	if res.Bytes != int64(len(tarBytes)) {
		t.Errorf("result = %+v", res)
	}
	// A piped output never animates: the progress line stays out of the
	// captured streams.
	if progress.Len() != 0 {
		t.Errorf("progress output = %q, want nothing on a pipe", progress.String())
	}
}

func TestCheckoutResultIsTheZeroValueOnFailure(t *testing.T) {
	res, _, _, err := tryCheckout(t, Options{Repo: "alice/demo"})
	if err == nil {
		t.Fatal("expected a usage error")
	}
	if res.Source != "" || res.SHA != "" || res.Bytes != 0 || res.Files != 0 {
		t.Errorf("result = %+v, want the zero result", res)
	}
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
