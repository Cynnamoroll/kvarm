// Package checkout implements `kvarm checkout <owner/repo> <ref> <dir>`:
// snapshot first, git clone second.
//
//  1. Ask for the snapshot. With a PAT this is the explicit demand
//     (POST …/snapshots/:ref), which starts a lazy build for a ref that has
//     none; without one it is a metadata read (anonymous callers cannot
//     demand builds).
//  2. If the snapshot is ready, download it by commit SHA (so a moving branch
//     cannot swap the bytes), check the byte count and extract it.
//  3. Otherwise (building, absent, failed, an API error or a bad download)
//     clone with git and check out the ref.
//
// Exactly one "source: snapshot" or "source: clone" line is printed on
// success. A snapshot directory has no .git: it is the tree only.
package checkout

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"kvarm/cli/internal/errs"
	"kvarm/cli/internal/gitx"
	"kvarm/cli/internal/httpx"
	"kvarm/cli/internal/opcli"
	"kvarm/cli/internal/repo"
	"kvarm/cli/internal/tarx"
	"kvarm/cli/internal/ui"
)

// DefaultMaxTarBytes is the largest snapshot tarball the CLI will accept.
const DefaultMaxTarBytes = 1024 * 1024 * 1024

// SizeSlackBytes lets a declared size round up a block before refusing.
const SizeSlackBytes = 1024 * 1024

var (
	commitSHARe  = regexp.MustCompile(`^[0-9a-f]{40}$`)
	httpSchemeRe = regexp.MustCompile(`^https?://`)
	zstdMagic    = []byte{0x28, 0xb5, 0x2f, 0xfd}
)

// Options is one checkout invocation.
type Options struct {
	BaseURL string
	PAT     string
	Repo    string // owner/name
	Ref     string // branch, tag or commit SHA
	Dir     string // destination directory (missing or empty)

	Stdout *ui.Output
	Stderr *ui.Output
	Client *httpx.Client

	// Git overrides the git runner in tests.
	Git func(args []string, cwd string, env map[string]string) gitx.Result
	// CloneURL overrides <base>/<owner>/<name>.git in tests.
	CloneURL string
	// Progress, when set, receives live transfer byte counts for the
	// terminal line (nil in tests and in the runner, which stays quiet).
	Progress *ui.Progress
}

// Result is what a checkout produced.
type Result struct {
	Source        string // snapshot | clone
	SHA           string
	Reason        string // why the snapshot was not used, when it was not
	Bytes         int64  // snapshot tar bytes extracted
	Files         int64
	TransferBytes int64
	Encoding      string // zstd | identity
}

// Checkout runs the flow and returns what it produced. Failures are CliError
// with their exit code (1 for failures, 2 for usage).
func Checkout(ctx context.Context, o Options) (Result, error) {
	baseURL := strings.TrimRight(o.BaseURL, "/")
	if baseURL == "" {
		return Result{}, errs.NewUsage("KVARM_BASE_URL is not set (e.g. https://kvarm.example.com)")
	}
	if !httpSchemeRe.MatchString(baseURL) {
		return Result{}, errs.NewUsage("KVARM_BASE_URL must be an http(s) URL, got %q", baseURL)
	}
	parsed, err := repo.Parse(o.Repo)
	if err != nil {
		return Result{}, err
	}
	if o.Ref == "" {
		return Result{}, errs.NewUsage("missing <ref>")
	}
	if o.Dir == "" {
		return Result{}, errs.NewUsage("missing <dir>")
	}
	dir, err := filepath.Abs(o.Dir)
	if err != nil {
		return Result{}, errs.NewFailure("resolving %q: %v", o.Dir, err)
	}
	existed, err := prepareDir(dir)
	if err != nil {
		return Result{}, err
	}
	refPath, err := encodeRefPath(o.Ref)
	if err != nil {
		return Result{}, err
	}
	base := fmt.Sprintf("%s/api/v1/repos/%s/%s/snapshots", baseURL, opcli.EncodeURIComponent(parsed.Owner), opcli.EncodeURIComponent(parsed.Name))

	var reason string
	meta, metaErr := requestSnapshot(ctx, o, base, refPath)
	switch {
	case metaErr != nil:
		reason = fmt.Sprintf("snapshot API unreachable: %v", metaErr)
	case meta.Status == 200 && objectField(meta.Body, "state") == "ready":
		sha, _ := objectField(meta.Body, "sha").(string)
		if !commitSHARe.MatchString(sha) {
			reason = "snapshot metadata contains an invalid commit sha"
		} else {
			got, err := downloadSnapshot(ctx, o, fmt.Sprintf("%s/%s", base, opcli.EncodeURIComponent(sha)), meta.Body, dir)
			if err != nil {
				reason = fmt.Sprintf("snapshot download failed: %v", err)
				resetDir(dir, existed)
			} else {
				o.Stdout.Plain("source: snapshot")
				o.Stdout.Plain("sha: %s", sha)
				o.Stdout.Plain("files: %d", got.Files)
				o.Stdout.Plain("bytes: %d", got.Bytes)
				o.Stdout.Plain("transfer: %d", got.TransferBytes)
				o.Stdout.Plain("encoding: %s", got.Encoding)
				o.Stderr.Plain("note: %s holds the tree only (no .git); see \"kvarm help checkout\" before committing or pushing", o.Dir)
				return Result{Source: "snapshot", SHA: sha, Bytes: got.Bytes, Files: got.Files, TransferBytes: got.TransferBytes, Encoding: got.Encoding}, nil
			}
		}
	case meta.Status == 200 || meta.Status == 202 || meta.Status == 409:
		reason = describeNotReady(meta.Body, o.PAT != "")
	case meta.Status == 401 || meta.Status == 403:
		reason = fmt.Sprintf("snapshot API refused the token (%d%s)", meta.Status, errorSuffix(meta.Body))
	default:
		reason = fmt.Sprintf("snapshot API returned %d%s", meta.Status, errorSuffix(meta.Body))
	}

	o.Stderr.Plain("%s; falling back to git clone", reason)
	cloneURL := o.CloneURL
	if cloneURL == "" {
		cloneURL = fmt.Sprintf("%s/%s/%s.git", baseURL, parsed.Owner, parsed.Name)
	}
	sha, err := cloneCheckout(o, cloneURL, dir)
	if err != nil {
		resetDir(dir, existed)
		return Result{}, err
	}
	o.Stdout.Plain("source: clone")
	o.Stdout.Plain("sha: %s", sha)
	return Result{Source: "clone", SHA: sha, Reason: reason}, nil
}

// encodeRefPath percent-encodes each segment of a ref, refusing the segments
// that could escape the URL path.
func encodeRefPath(ref string) (string, error) {
	if ref == "" {
		return "", errs.NewUsage("invalid ref: path segments must be non-empty and cannot be \".\" or \"..\"")
	}
	parts := strings.Split(ref, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return "", errs.NewUsage("invalid ref: path segments must be non-empty and cannot be \".\" or \"..\"")
		}
	}
	encoded := make([]string, len(parts))
	for i, part := range parts {
		encoded[i] = opcli.EncodeURIComponent(part)
	}
	return strings.Join(encoded, "/"), nil
}

// prepareDir requires the destination to be missing or an empty directory,
// reporting whether it already existed.
func prepareDir(dir string) (bool, error) {
	st, err := os.Stat(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	if !st.IsDir() {
		return false, errs.NewFailure("destination %s exists and is not a directory", dir)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false, err
	}
	if len(entries) > 0 {
		return false, errs.NewFailure("destination %s already exists and is not empty", dir)
	}
	return true, nil
}

// resetDir removes what this run wrote: the directory itself when it was
// created here, otherwise only its contents (it was empty before).
func resetDir(dir string, existed bool) {
	if !existed {
		os.RemoveAll(dir)
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		os.RemoveAll(filepath.Join(dir, e.Name()))
	}
}

func objectField(v any, key string) any {
	if m, ok := v.(map[string]any); ok {
		return m[key]
	}
	return nil
}

func errorSuffix(body any) string {
	if e, ok := objectField(body, "error").(string); ok && e != "" {
		return " " + e
	}
	return ""
}

// snapshotMeta is one snapshot metadata reply.
type snapshotMeta struct {
	Status   int
	Body     any // parsed JSON, or nil
	Demanded bool
}

func requestSnapshot(ctx context.Context, o Options, base, refPath string) (*snapshotMeta, error) {
	method := "GET"
	if o.PAT != "" {
		method = "POST"
	}
	headers := map[string]string{"accept": "application/json"}
	if o.PAT != "" {
		headers["authorization"] = "Bearer " + o.PAT
	}
	res, err := o.Client.DoText(ctx, method, fmt.Sprintf("%s/%s", base, refPath), headers, nil, httpx.MaxResponseBytes)
	if err != nil {
		return nil, err
	}
	body, parseErr := res.JSONValue()
	if parseErr != nil {
		body = nil
	}
	return &snapshotMeta{Status: res.Status, Body: body, Demanded: o.PAT != ""}, nil
}

// downloaded is a snapshot download's outcome.
type downloaded struct {
	tarx.Counts
	TransferBytes int64
	Encoding      string
}

// downloadSnapshot downloads a ready snapshot by commit SHA, checks the
// served identity and byte budgets, and extracts it into dir.
func downloadSnapshot(ctx context.Context, o Options, base string, meta any, dir string) (downloaded, error) {
	var zero downloaded
	headers := map[string]string{
		// The Go client always carries a zstd decoder, so it always offers to
		// receive one (the JS CLI had to check the runtime first).
		"accept": "application/zstd, application/x-tar;q=0.5",
	}
	if o.PAT != "" {
		headers["authorization"] = "Bearer " + o.PAT
	}
	res, err := o.Client.DoStream(ctx, "GET", fmt.Sprintf("%s/download", base), headers)
	if err != nil {
		return zero, err
	}
	defer res.Close()
	if res.Status != 200 {
		body, parseErr := streamedJSON(res)
		if parseErr != nil {
			body = nil
		}
		return zero, fmt.Errorf("download returned %d%s", res.Status, codeSuffix(body))
	}
	// The download is pinned to the metadata's commit SHA: a branch that
	// moved between the metadata read and this request must not swap bytes.
	servedSHA := res.Header.Get("x-kvarm-snapshot-sha")
	expectedSHA, _ := objectField(meta, "sha").(string)
	if servedSHA != "" && servedSHA != expectedSHA {
		return zero, fmt.Errorf("download served %s, expected %s", servedSHA, expectedSHA)
	}

	size, sizeOK := numberField(meta, "size")
	encodedSize, encodedOK := numberField(meta, "encodedSize")
	maxBytes := declaredCap(sizeOK, size)
	maxTransfer := declaredCap(encodedOK, encodedSize)
	if maxTransfer > maxBytes {
		maxTransfer = maxBytes
	}

	transferBytes := int64(0)
	wire := &budgetedBody{inner: res.Body, total: &transferBytes, max: maxTransfer}
	if o.Progress != nil {
		wire.notify = func(n int64) { o.Progress.Set(n) }
	}
	// A zstd body is declared by the content type or sniffed from the magic
	// of the first bytes, which are then re-fed to the stream.
	head := make([]byte, 4)
	n, _ := io.ReadFull(wire, head)
	head = head[:n]
	zstdBody := strings.HasPrefix(res.Header.Get("content-type"), "application/zstd")
	if !zstdBody && len(head) == 4 && bytes.Equal(head, zstdMagic) {
		zstdBody = true
	}
	stream := io.MultiReader(bytes.NewReader(head), wire)
	if zstdBody {
		decoded, err := newZstdReader(stream)
		if err != nil {
			return zero, err
		}
		defer decoded.Close()
		stream = decoded
	}
	counts, err := tarx.Extract(stream, dir, tarx.Budgets{MaxBytes: maxBytes})
	if err != nil {
		return zero, err
	}
	if sizeOK && counts.Bytes != size {
		return zero, fmt.Errorf("downloaded %d bytes, metadata size is %d", counts.Bytes, size)
	}
	if zstdBody && encodedOK && transferBytes != encodedSize {
		return zero, fmt.Errorf("downloaded %d wire bytes, metadata encodedSize is %d", transferBytes, encodedSize)
	}
	encoding := "identity"
	if zstdBody {
		encoding = "zstd"
	}
	return downloaded{Counts: counts, TransferBytes: transferBytes, Encoding: encoding}, nil
}

// numberField reads a non-negative safe-integer field of a metadata reply
// (the JS CLI's Number.isSafeInteger gate).
func numberField(body any, key string) (int64, bool) {
	num, ok := objectField(body, key).(json.Number)
	if !ok {
		return 0, false
	}
	v, err := num.Int64()
	if err != nil || v < 0 || v > 1<<53 {
		return 0, false
	}
	return v, true
}

// declaredCap bounds a download by its declared size plus one block of
// slack, capped by the overall default (which also applies when the metadata
// carries no usable number).
func declaredCap(ok bool, declared int64) int64 {
	if !ok {
		return DefaultMaxTarBytes
	}
	capped := declared + SizeSlackBytes
	if capped > DefaultMaxTarBytes {
		return DefaultMaxTarBytes
	}
	return capped
}

func codeSuffix(body any) string {
	if c, ok := objectField(body, "code").(string); ok && c != "" {
		return " " + c
	}
	return ""
}

// streamedJSON parses a streaming reply's body as JSON under the JSON read
// cap. A streaming response never fills Response.Text, so a failed download's
// error code — the JS CLI read it with res.json() — would otherwise be lost.
func streamedJSON(res *httpx.Response) (any, error) {
	data, err := io.ReadAll(io.LimitReader(res.Body, httpx.MaxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > httpx.MaxResponseBytes {
		return nil, fmt.Errorf("response body exceeds the %d-byte read cap", httpx.MaxResponseBytes)
	}
	var v any
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

// budgetedBody counts wire bytes, reports them to the progress line, and
// refuses a transfer over its budget: a broken platform must not be able to
// stream an unbounded body.
type budgetedBody struct {
	inner  io.Reader
	total  *int64
	max    int64
	notify func(int64)
}

func (b *budgetedBody) Read(p []byte) (int, error) {
	n, err := b.inner.Read(p)
	*b.total += int64(n)
	if b.notify != nil {
		b.notify(*b.total)
	}
	if *b.total > b.max {
		return n, fmt.Errorf("snapshot download exceeds the %d-byte transfer budget", b.max)
	}
	return n, err
}

// cloneCheckout clones over smart HTTP and checks out the ref.
func cloneCheckout(o Options, url, dir string) (string, error) {
	env := gitx.Env(hostEnv(), o.BaseURL, o.PAT)
	git := o.Git
	if git == nil {
		git = gitx.Run
	}
	clone := git([]string{"clone", "-q", "--no-checkout", url, dir}, "", env)
	if clone.Code != 0 {
		msg := clone.Stderr
		if msg == "" {
			msg = fmt.Sprintf("exit %d", clone.Code)
		}
		return "", errs.NewFailure("git clone failed: %s", msg)
	}
	target := strings.TrimPrefix(o.Ref, "refs/heads/")
	co := git([]string{"checkout", "-q", target}, dir, env)
	if co.Code != 0 {
		msg := co.Stderr
		if msg == "" {
			msg = fmt.Sprintf("exit %d", co.Code)
		}
		return "", errs.NewFailure("git checkout %s failed: %s", o.Ref, msg)
	}
	head := git([]string{"rev-parse", "HEAD"}, dir, env)
	if head.Code != 0 {
		return "", errs.NewFailure("git rev-parse HEAD failed: %s", head.Stderr)
	}
	return head.Stdout, nil
}

// hostEnv is the process environment as a map, for git children.
func hostEnv() map[string]string {
	env := map[string]string{}
	for _, kv := range os.Environ() {
		if i := strings.IndexByte(kv, '='); i > 0 {
			env[kv[:i]] = kv[i+1:]
		}
	}
	return env
}

// describeNotReady explains why the snapshot was not used.
func describeNotReady(meta any, demanded bool) string {
	state, _ := objectField(meta, "state").(string)
	if state == "" {
		state = "unknown"
	}
	sha, _ := objectField(meta, "sha").(string)
	suffix := ""
	if len(sha) >= 12 {
		suffix = " for " + sha[:12]
	}
	started := objectField(meta, "started") == true
	switch state {
	case "building":
		switch {
		case demanded && started:
			return "snapshot building" + suffix + " (build started)"
		case demanded:
			return "snapshot building" + suffix + " (build in progress)"
		default:
			return "snapshot building" + suffix
		}
	case "absent":
		if !demanded {
			return "snapshot absent" + suffix + " (set KVARM_PAT to request a build)"
		}
		return "snapshot absent" + suffix
	case "failed":
		return "snapshot failed" + suffix
	default:
		return "snapshot state " + state + suffix
	}
}
