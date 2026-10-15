package opcli

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"kvarm/cli/internal/errs"
	"kvarm/cli/internal/httpx"
	"kvarm/cli/internal/registry"
	"kvarm/cli/internal/ui"
)

// changeListOp mirrors the registry's change list shape with a synthetic
// operation, so tests never depend on the embedded JSON.
func changeListOp() *registry.Operation {
	return &registry.Operation{
		Name:        "list_changes",
		Command:     []string{"change", "list"},
		Description: "Change sets of the repository, newest first.",
		Method:      "GET",
		Path:        "/repos/{repo}/changes",
		Params: []registry.Param{
			{Name: "repo", Type: registry.TypeString, In: "path", Positional: true, Required: true, Format: "repo", Description: "Repository as owner/name"},
			{Name: "state", Type: registry.TypeString, In: "query", Enum: []string{"open", "closed", "merged", "conflicted", "all"}, Description: "filter"},
			{Name: "limit", Type: registry.TypeInteger, In: "query", Description: "page size"},
			{Name: "cursor", Type: registry.TypeString, In: "query", Description: "page cursor"},
		},
		ReadOnly: true,
	}
}

func createWidgetOp() *registry.Operation {
	return &registry.Operation{
		Name:    "create_widget",
		Command: []string{"widget", "create"},
		Method:  "POST",
		Path:    "/repos/{repo}/widgets",
		Params: []registry.Param{
			{Name: "repo", Type: registry.TypeString, In: "path", Positional: true, Required: true, Format: "repo"},
			{Name: "title", Type: registry.TypeString, In: "body", Required: true, Description: "title"},
			{Name: "count", Type: registry.TypeInteger, In: "body", Description: "how many"},
			{Name: "meta", Type: registry.TypeJSON, In: "body", Description: "free-form"},
		},
	}
}

func literalPathsOp() *registry.Operation {
	return &registry.Operation{
		Name:    "check_paths",
		Command: []string{"widget", "paths"},
		Method:  "GET",
		Path:    "/widgets/paths",
		Params: []registry.Param{
			{Name: "paths", Type: registry.TypeStrings, In: "query", Literal: true, Description: "git paths"},
		},
	}
}

func refOp() *registry.Operation {
	return &registry.Operation{
		Name:    "get_ref",
		Command: []string{"widget", "ref"},
		Method:  "GET",
		Path:    "/repos/{repo}/refs/{ref}",
		Params: []registry.Param{
			{Name: "repo", Type: registry.TypeString, In: "path", Positional: true, Required: true, Format: "repo"},
			{Name: "ref", Type: registry.TypeString, In: "path", Required: true, Description: "a ref"},
		},
	}
}

// recordedRequest is what a test server saw of one request.
type recordedRequest struct {
	Method      string
	Path        string // decoded
	RequestURI  string // exactly what was sent, escaping included
	RawQuery    string
	Header      http.Header
	Body        string
	ContentType string
}

// recordingServer wraps an httptest server that records every request.
type recordingServer struct {
	*httptest.Server
	mu       sync.Mutex
	requests []recordedRequest
}

func newServer(reply http.HandlerFunc) *recordingServer {
	rs := &recordingServer{}
	rs.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		rs.mu.Lock()
		rs.requests = append(rs.requests, recordedRequest{
			Method: r.Method, Path: r.URL.Path, RequestURI: r.RequestURI, RawQuery: r.URL.RawQuery,
			Header: r.Header.Clone(), Body: string(body), ContentType: r.Header.Get("Content-Type"),
		})
		rs.mu.Unlock()
		if reply != nil {
			reply(w, r)
		}
	}))
	return rs
}

func (rs *recordingServer) seen() []recordedRequest {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	out := make([]recordedRequest, len(rs.requests))
	copy(out, rs.requests)
	return out
}

// replyJSON answers every request with one status and body.
func replyJSON(status int, body string, headers map[string]string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		for k, v := range headers {
			w.Header().Set(k, v)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, body)
	}
}

func testIO(env map[string]string, out, errOut *strings.Builder) IO {
	return IO{Env: env, Stdout: ui.New(out), Stderr: ui.New(errOut), Client: httpx.New()}
}

func TestCallOperationGETQuery(t *testing.T) {
	rs := newServer(replyJSON(200, `{"changes":[]}`, nil))
	defer rs.Close()
	env := map[string]string{"KVARM_BASE_URL": rs.URL, "KVARM_PAT": "kvarm_pat_test-token"}
	io := testIO(env, &strings.Builder{}, &strings.Builder{})

	_, err := CallOperation(context.Background(), changeListOp(), map[string]any{
		"repo": "acme/app", "state": "open", "limit": int64(5),
	}, io)
	if err != nil {
		t.Fatalf("CallOperation error: %v", err)
	}
	got := rs.seen()
	if len(got) != 1 {
		t.Fatalf("server saw %d requests, want 1", len(got))
	}
	req := got[0]
	if req.Method != "GET" || req.Path != "/api/v1/repos/acme/app/changes" {
		t.Errorf("method/path = %s %q, want GET /api/v1/repos/acme/app/changes", req.Method, req.Path)
	}
	// url.Values.Encode sorts keys; JS URLSearchParams also encoded the
	// space of a query value as '+', so both spellings agree server-side.
	if want := "limit=5&state=open"; req.RawQuery != want {
		t.Errorf("RawQuery = %q, want %q", req.RawQuery, want)
	}
	if req.Header.Get("Accept") != "application/json" {
		t.Errorf("Accept = %q, want application/json", req.Header.Get("Accept"))
	}
	if want := "Bearer kvarm_pat_test-token"; req.Header.Get("Authorization") != want {
		t.Errorf("Authorization = %q, want %q", req.Header.Get("Authorization"), want)
	}
	if req.ContentType != "" {
		t.Errorf("Content-Type = %q, want empty on a GET with no body", req.ContentType)
	}
}

func TestCallOperationQueryEscaping(t *testing.T) {
	rs := newServer(replyJSON(200, `{}`, nil))
	defer rs.Close()
	io := testIO(map[string]string{"KVARM_BASE_URL": rs.URL}, &strings.Builder{}, &strings.Builder{})

	// A cursor needing escaping: space, slash and '~'. Go's query escaping
	// keeps '~' raw where JS URLSearchParams sent %7E; both decode to the
	// same value on the platform.
	_, err := CallOperation(context.Background(), changeListOp(), map[string]any{
		"repo": "acme/app", "cursor": "hello world/~",
	}, io)
	if err != nil {
		t.Fatalf("CallOperation error: %v", err)
	}
	req := rs.seen()[0]
	if want := "cursor=hello+world%2F~"; req.RawQuery != want {
		t.Errorf("RawQuery = %q, want %q", req.RawQuery, want)
	}
}

func TestCallOperationPathPercentEncoding(t *testing.T) {
	rs := newServer(replyJSON(200, `{}`, nil))
	defer rs.Close()
	io := testIO(map[string]string{"KVARM_BASE_URL": rs.URL}, &strings.Builder{}, &strings.Builder{})

	// A path segment is encodeURIComponent-encoded: spaces %20 and '~'
	// unescaped, exactly like the JS CLI's path parameters.
	_, err := CallOperation(context.Background(), refOp(), map[string]any{
		"repo": "acme/app", "ref": "hello world/~x",
	}, io)
	if err != nil {
		t.Fatalf("CallOperation error: %v", err)
	}
	req := rs.seen()[0]
	if want := "/api/v1/repos/acme/app/refs/hello%20world%2F~x"; req.RequestURI != want {
		t.Errorf("RequestURI = %q, want %q", req.RequestURI, want)
	}
}

func TestCallOperationRepoTwoSegments(t *testing.T) {
	rs := newServer(replyJSON(200, `{}`, nil))
	defer rs.Close()
	io := testIO(map[string]string{"KVARM_BASE_URL": rs.URL}, &strings.Builder{}, &strings.Builder{})

	// A repo expands to two encoded path segments: owner and name.
	_, err := CallOperation(context.Background(), changeListOp(), map[string]any{
		"repo": "team.x/odd~repo",
	}, io)
	if err != nil {
		t.Fatalf("CallOperation error: %v", err)
	}
	if got, want := rs.seen()[0].Path, "/api/v1/repos/team.x/odd~repo/changes"; got != want {
		t.Errorf("Path = %q, want %q", got, want)
	}
}

func TestCallOperationPOSTBody(t *testing.T) {
	rs := newServer(replyJSON(201, `{"id":"w1"}`, nil))
	defer rs.Close()
	io := testIO(map[string]string{"KVARM_BASE_URL": rs.URL, "KVARM_PAT": "kvarm_pat_test-token"}, &strings.Builder{}, &strings.Builder{})

	reply, err := CallOperation(context.Background(), createWidgetOp(), map[string]any{
		"repo":  "acme/app",
		"title": "Fix <b>&co",
		"count": int64(3),
		"meta":  map[string]any{"html": "<a>", "note": "x"},
	}, io)
	if err != nil {
		t.Fatalf("CallOperation error: %v", err)
	}
	if !reply.OK || reply.Status != 201 {
		t.Errorf("reply OK/Status = %v/%d, want true/201", reply.OK, reply.Status)
	}
	req := rs.seen()[0]
	if req.Method != "POST" {
		t.Errorf("Method = %s, want POST", req.Method)
	}
	// Body keys are sorted and HTML is not escaped, matching JSON.stringify
	// in ops.js.
	wantBody := `{"count":3,"meta":{"html":"<a>","note":"x"},"title":"Fix <b>&co"}`
	if req.Body != wantBody {
		t.Errorf("Body = %q, want %q", req.Body, wantBody)
	}
	if req.ContentType != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", req.ContentType)
	}
}

func TestCallOperationRepeatedQueryLiteral(t *testing.T) {
	rs := newServer(replyJSON(200, `{}`, nil))
	defer rs.Close()
	io := testIO(map[string]string{"KVARM_BASE_URL": rs.URL}, &strings.Builder{}, &strings.Builder{})

	_, err := CallOperation(context.Background(), literalPathsOp(), map[string]any{
		"paths": []string{"a/b", "c d"},
	}, io)
	if err != nil {
		t.Fatalf("CallOperation error: %v", err)
	}
	req := rs.seen()[0]
	if want := "paths=a%2Fb&paths=c+d"; req.RawQuery != want {
		t.Errorf("RawQuery = %q, want %q (one parameter per path)", req.RawQuery, want)
	}
}

func TestRunOperationJSONOneLine(t *testing.T) {
	rs := newServer(replyJSON(200, `{"changes":[{"number":1}]}`, nil))
	defer rs.Close()
	var out, errOut strings.Builder
	io := testIO(map[string]string{"KVARM_BASE_URL": rs.URL}, &out, &errOut)

	code, err := RunOperation(context.Background(), changeListOp(), []string{"acme/app", "--json"}, io)
	if err != nil || code != 0 {
		t.Fatalf("RunOperation = (%d, %v), want (0, nil)", code, err)
	}
	if got, want := out.String(), `{"changes":[{"number":1}]}`+"\n"; got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
	if errOut.Len() != 0 {
		t.Errorf("stderr = %q, want empty", errOut.String())
	}
}

func TestRunOperationPrettyOutput(t *testing.T) {
	rs := newServer(replyJSON(200, `{"a":1,"b":[9007199254740993]}`, nil))
	defer rs.Close()
	var out, errOut strings.Builder
	io := testIO(map[string]string{"KVARM_BASE_URL": rs.URL}, &out, &errOut)

	code, err := RunOperation(context.Background(), changeListOp(), []string{"acme/app"}, io)
	if err != nil || code != 0 {
		t.Fatalf("RunOperation = (%d, %v), want (0, nil)", code, err)
	}
	// Two-space indent, and the 64-bit number round-trips exactly: the
	// reply is parsed with UseNumber the way the JS CLI kept JSON numbers.
	want := "{\n  \"a\": 1,\n  \"b\": [\n    9007199254740993\n  ]\n}\n"
	if got := out.String(); got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
}

func TestRunOperationNonJSONSuccessReply(t *testing.T) {
	// A 200 with a text body is printed as a JSON string, matching
	// JSON.stringify(raw) in ops.js.
	rs := newServer(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(200)
		io.WriteString(w, "just text")
	})
	defer rs.Close()
	var out, errOut strings.Builder
	io := testIO(map[string]string{"KVARM_BASE_URL": rs.URL}, &out, &errOut)

	code, err := RunOperation(context.Background(), changeListOp(), []string{"acme/app"}, io)
	if err != nil || code != 0 {
		t.Fatalf("RunOperation = (%d, %v), want (0, nil)", code, err)
	}
	if got, want := out.String(), "\"just text\"\n"; got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
}

func TestRunOperationFailureReport(t *testing.T) {
	rs := newServer(replyJSON(400, `{"error":"bad input","code":"INVALID","field":"limit"}`, nil))
	defer rs.Close()
	var out, errOut strings.Builder
	io := testIO(map[string]string{"KVARM_BASE_URL": rs.URL}, &out, &errOut)

	code, err := RunOperation(context.Background(), changeListOp(), []string{"acme/app"}, io)
	if err != nil || code != 1 {
		t.Fatalf("RunOperation = (%d, %v), want (1, nil)", code, err)
	}
	if out.Len() != 0 {
		t.Errorf("stdout = %q, want empty without --json", out.String())
	}
	want := "kvarm change list: INVALID (HTTP 400): bad input\n" +
		"details: {\"field\":\"limit\"}\n" +
		"hint: fix the argument named in the error; run \"kvarm change list --help\"\n"
	if got := errOut.String(); got != want {
		t.Errorf("stderr = %q, want %q", got, want)
	}
}

func TestRunOperationFailureReportJSON(t *testing.T) {
	rs := newServer(replyJSON(400, `{"error":"bad input","code":"INVALID","field":"limit"}`, nil))
	defer rs.Close()
	var out, errOut strings.Builder
	io := testIO(map[string]string{"KVARM_BASE_URL": rs.URL}, &out, &errOut)

	code, err := RunOperation(context.Background(), changeListOp(), []string{"acme/app", "--json"}, io)
	if err != nil || code != 1 {
		t.Fatalf("RunOperation = (%d, %v), want (1, nil)", code, err)
	}
	// ops.js printed the same {status, ...body} shape on one line.
	want := `{"code":"INVALID","error":"bad input","field":"limit","status":400}` + "\n"
	if got := out.String(); got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
	// The human report goes to stderr even in --json mode.
	if got := errOut.String(); !strings.Contains(got, "kvarm change list: INVALID (HTTP 400): bad input") {
		t.Errorf("stderr = %q, want the failure report", got)
	}
}

func TestRunOperationNonJSONErrorBody(t *testing.T) {
	rs := newServer(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(500)
		io.WriteString(w, "boom <internal>")
	})
	defer rs.Close()
	var out, errOut strings.Builder
	io := testIO(map[string]string{"KVARM_BASE_URL": rs.URL}, &out, &errOut)

	code, err := RunOperation(context.Background(), changeListOp(), []string{"acme/app"}, io)
	if err != nil || code != 1 {
		t.Fatalf("RunOperation = (%d, %v), want (1, nil)", code, err)
	}
	// A non-object error body becomes the error text; no code, no details.
	want := "kvarm change list: (HTTP 500): boom <internal>\n" +
		"hint: platform or storage error; retry shortly\n"
	if got := errOut.String(); got != want {
		t.Errorf("stderr = %q, want %q", got, want)
	}
}

func TestReportFailureTruncatesLongText(t *testing.T) {
	long := strings.Repeat("x", 250)
	rs := newServer(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		io.WriteString(w, long)
	})
	defer rs.Close()
	var out, errOut strings.Builder
	io := testIO(map[string]string{"KVARM_BASE_URL": rs.URL}, &out, &errOut)

	code, err := RunOperation(context.Background(), changeListOp(), []string{"acme/app"}, io)
	if err != nil || code != 1 {
		t.Fatalf("RunOperation = (%d, %v), want (1, nil)", code, err)
	}
	// Only the first 200 characters of a raw error body are shown.
	want := "kvarm change list: (HTTP 500): " + strings.Repeat("x", 200) + "\n" +
		"hint: platform or storage error; retry shortly\n"
	if got := errOut.String(); got != want {
		t.Errorf("stderr = %q, want %q", got, want)
	}
}

func TestRunOperationHintLines(t *testing.T) {
	tests := []struct {
		name       string
		status     int
		body       string
		retryAfter string
		wantHint   string
	}{
		{"401", 401, `{"error":"unauthorized"}`, "",
			"hint: set KVARM_PAT to a valid personal access token with the api scope (or an unexpired agent token)"},
		{"403 insufficient scope", 403, `{"error":"forbidden","code":"INSUFFICIENT_SCOPE"}`, "",
			"hint: the token lacks the api scope or role this needs; use a token minted with the api scope"},
		{"403 names the repo", 403, `{"error":"forbidden"}`, "",
			"hint: your account or token lacks the role this needs on acme/app; ask an admin for a grant"},
		{"404 not found", 404, `{"error":"missing","code":"NOT_FOUND"}`, "",
			"hint: acme/app does not exist or is private to you; check owner/name and that KVARM_PAT can read it"},
		{"404 without code", 404, `{"error":"missing"}`, "",
			"hint: check the identifiers you passed to kvarm change list"},
		{"409", 409, `{"error":"conflict"}`, "",
			"hint: the current state conflicts with this request; read the current state (details above) and retry"},
		{"422", 422, `{"error":"invalid"}`, "",
			"hint: fix the argument named in the error; run \"kvarm change list --help\""},
		{"429 with Retry-After", 429, `{"error":"slow down","code":"RATE_LIMITED"}`, "5",
			"hint: rate limited; retry after 5 seconds"},
		{"429 without Retry-After", 429, `{"error":"slow down","code":"RATE_LIMITED"}`, "",
			"hint: rate limited; retry after 60 seconds"},
		{"502", 502, `{"error":"bad gateway"}`, "",
			"hint: platform or storage error; retry shortly"},
		{"418 default", 418, `{"error":"teapot"}`, "",
			"hint: run \"kvarm change list --help\""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			headers := map[string]string{}
			if tt.retryAfter != "" {
				headers["Retry-After"] = tt.retryAfter
			}
			rs := newServer(replyJSON(tt.status, tt.body, headers))
			defer rs.Close()
			var out, errOut strings.Builder
			io := testIO(map[string]string{"KVARM_BASE_URL": rs.URL}, &out, &errOut)

			code, err := RunOperation(context.Background(), changeListOp(), []string{"acme/app"}, io)
			if err != nil || code != 1 {
				t.Fatalf("RunOperation = (%d, %v), want (1, nil)", code, err)
			}
			if got := errOut.String(); !strings.Contains(got, tt.wantHint) {
				t.Errorf("stderr = %q, want it to contain %q", got, tt.wantHint)
			}
		})
	}
}

func TestCallOperation429RetryAfterPassthrough(t *testing.T) {
	rs := newServer(replyJSON(429, `{"error":"slow down"}`, map[string]string{"Retry-After": "5"}))
	defer rs.Close()
	io := testIO(map[string]string{"KVARM_BASE_URL": rs.URL}, &strings.Builder{}, &strings.Builder{})

	reply, err := CallOperation(context.Background(), changeListOp(), map[string]any{"repo": "acme/app"}, io)
	if err != nil {
		t.Fatalf("CallOperation error: %v", err)
	}
	if reply.OK || reply.Status != 429 {
		t.Errorf("reply OK/Status = %v/%d, want false/429", reply.OK, reply.Status)
	}
	if reply.RetryAfter != "5" {
		t.Errorf("RetryAfter = %q, want \"5\"", reply.RetryAfter)
	}
}

func TestHint(t *testing.T) {
	op := changeListOp()
	withRepo := map[string]any{"repo": "acme/app"}
	tests := []struct {
		name       string
		status     int
		body       map[string]any
		args       map[string]any
		retryAfter string
		want       string
	}{
		{"401", 401, map[string]any{}, withRepo, "",
			"set KVARM_PAT to a valid personal access token with the api scope (or an unexpired agent token)"},
		{"403 insufficient scope", 403, map[string]any{"code": "INSUFFICIENT_SCOPE"}, withRepo, "",
			"the token lacks the api scope or role this needs; use a token minted with the api scope"},
		{"403 with repo", 403, map[string]any{}, withRepo, "",
			"your account or token lacks the role this needs on acme/app; ask an admin for a grant"},
		{"403 without repo", 403, map[string]any{}, map[string]any{}, "",
			"your account or token lacks the role this needs; ask an admin for a grant"},
		{"404 with repo", 404, map[string]any{"code": "NOT_FOUND"}, withRepo, "",
			"acme/app does not exist or is private to you; check owner/name and that KVARM_PAT can read it"},
		{"404 without repo", 404, map[string]any{}, map[string]any{}, "",
			"check the identifiers you passed to kvarm change list"},
		{"409", 409, map[string]any{}, withRepo, "",
			"the current state conflicts with this request; read the current state (details above) and retry"},
		{"400", 400, map[string]any{}, withRepo, "",
			"fix the argument named in the error; run \"kvarm change list --help\""},
		{"429 with Retry-After", 429, map[string]any{}, withRepo, "7",
			"rate limited; retry after 7 seconds"},
		{"429 defaults to 60", 429, map[string]any{}, withRepo, "",
			"rate limited; retry after 60 seconds"},
		{"5xx", 503, map[string]any{}, withRepo, "",
			"platform or storage error; retry shortly"},
		{"other statuses point at help", 418, map[string]any{}, withRepo, "",
			"run \"kvarm change list --help\""},

		// Dependency refusals name the explicit recovery commands.
		{"revision not current", 409, map[string]any{"code": "REVISION_NOT_CURRENT", "currentRevision": "rev-9"}, withRepo, "",
			"the source's current revision is rev-9; retry with --revision rev-9"},
		{"stale dependency repins to its source head", 409,
			map[string]any{"code": "DEPENDENCY_STALE", "dependencies": []any{map[string]any{"id": "d1", "workspaceId": "ws1", "sourceHead": "head1"}}},
			withRepo, "",
			"inspect with \"kvarm deps list acme/app ws1\", then recover explicitly: \"kvarm deps repin acme/app ws1 d1 --revision head1\" or \"kvarm deps detach acme/app ws1 d1\""},
		{"broken dependency repins generically", 409,
			map[string]any{"code": "DEPENDENCY_BROKEN", "dependencies": []any{map[string]any{"id": "d1", "workspaceId": "ws1"}}},
			withRepo, "",
			"inspect with \"kvarm deps list acme/app ws1\", then recover explicitly: \"kvarm deps repin acme/app ws1 d1 --on-workspace <live-workspace> --revision <its-head>\" or \"kvarm deps detach acme/app ws1 d1\""},
		{"pending dependency names the workspace to land", 409,
			map[string]any{"code": "DEPENDENCY_PENDING", "dependencies": []any{map[string]any{"id": "d1", "workspaceId": "ws1", "onWorkspace": "ws2"}}},
			withRepo, "",
			"inspect with \"kvarm deps list acme/app ws1\"; land workspace ws2's change first, or \"kvarm deps detach acme/app ws1 d1\""},
		{"pending dependency without onWorkspace says undefined, as ops.js did", 409,
			map[string]any{"code": "DEPENDENCY_PENDING", "dependencies": []any{map[string]any{"id": "d1", "workspaceId": "ws1"}}},
			withRepo, "",
			"inspect with \"kvarm deps list acme/app ws1\"; land workspace undefined's change first, or \"kvarm deps detach acme/app ws1 d1\""},
		{"no repo argument is placeholdered", 409,
			map[string]any{"code": "DEPENDENCY_BROKEN", "dependencies": []any{map[string]any{"id": "d1", "workspaceId": "ws1"}}},
			map[string]any{}, "",
			"inspect with \"kvarm deps list <owner/repo> ws1\", then recover explicitly: \"kvarm deps repin <owner/repo> ws1 d1 --on-workspace <live-workspace> --revision <its-head>\" or \"kvarm deps detach <owner/repo> ws1 d1\""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Hint(op, tt.status, tt.body, tt.args, tt.retryAfter); got != tt.want {
				t.Errorf("Hint = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestHintFallsBackWithoutDependencies(t *testing.T) {
	op := changeListOp()
	// A dependency code without a usable dependencies list falls through to
	// the per-status advice.
	body := map[string]any{"code": "DEPENDENCY_BROKEN"}
	if got, want := Hint(op, 409, body, map[string]any{"repo": "acme/app"}, ""),
		"the current state conflicts with this request; read the current state (details above) and retry"; got != want {
		t.Errorf("Hint = %q, want %q", got, want)
	}
	// REVISION_NOT_CURRENT without a currentRevision has no recovery either.
	if got, want := Hint(op, 400, map[string]any{"code": "REVISION_NOT_CURRENT"}, map[string]any{"repo": "acme/app"}, ""),
		"fix the argument named in the error; run \"kvarm change list --help\""; got != want {
		t.Errorf("Hint = %q, want %q", got, want)
	}
}

func TestCallOperationNetworkUnreachable(t *testing.T) {
	rs := newServer(replyJSON(200, `{}`, nil))
	rs.Close() // the platform is down: connections are refused

	io := testIO(map[string]string{"KVARM_BASE_URL": rs.URL}, &strings.Builder{}, &strings.Builder{})
	_, err := CallOperation(context.Background(), changeListOp(), map[string]any{"repo": "acme/app"}, io)
	if err == nil {
		t.Fatal("CallOperation succeeded against a closed server, want a failure")
	}
	ce := errs.From(err)
	if ce.ExitCode != 1 {
		t.Errorf("ExitCode = %d, want 1 (a failure, not a usage error)", ce.ExitCode)
	}
	// The message names the origin only — never the full request URL, which
	// would leak the path and query the way ops.js's url.origin did not.
	if !strings.Contains(ce.Message, "could not reach "+rs.URL) {
		t.Errorf("message = %q, want it to contain %q", ce.Message, "could not reach "+rs.URL)
	}
	if !strings.Contains(ce.Message, "ECONNREFUSED") {
		t.Errorf("message = %q, want the transport cause ECONNREFUSED", ce.Message)
	}
	if strings.Contains(ce.Message, "/api/v1") {
		t.Errorf("message = %q, want the origin only, not the request path", ce.Message)
	}
}

func TestCallOperationConfiguration(t *testing.T) {
	t.Run("missing KVARM_BASE_URL is a usage error", func(t *testing.T) {
		io := testIO(map[string]string{}, &strings.Builder{}, &strings.Builder{})
		_, err := CallOperation(context.Background(), changeListOp(), map[string]any{"repo": "acme/app"}, io)
		ce := errs.From(err)
		if ce.ExitCode != 2 {
			t.Errorf("ExitCode = %d, want 2", ce.ExitCode)
		}
		if want := "KVARM_BASE_URL is not set (e.g. https://kvarm.example.com)"; ce.Message != want {
			t.Errorf("message = %q, want %q", ce.Message, want)
		}
	})

	t.Run("scheme is validated", func(t *testing.T) {
		for _, baseURL := range []string{"example.com", "ftp://example.com", "unix:///run/kvarm"} {
			io := testIO(map[string]string{"KVARM_BASE_URL": baseURL}, &strings.Builder{}, &strings.Builder{})
			_, err := CallOperation(context.Background(), changeListOp(), map[string]any{"repo": "acme/app"}, io)
			usageError(t, err, "KVARM_BASE_URL must be an http(s) URL, got \""+baseURL+"\"")
		}
	})

	t.Run("the base URL's own path is dropped", func(t *testing.T) {
		// JS parity: new URL(target, base) with an absolute-path target
		// keeps only the base's origin.
		rs := newServer(replyJSON(200, `{}`, nil))
		defer rs.Close()
		io := testIO(map[string]string{"KVARM_BASE_URL": rs.URL + "/ignored/prefix"}, &strings.Builder{}, &strings.Builder{})
		reply, err := CallOperation(context.Background(), changeListOp(), map[string]any{"repo": "acme/app"}, io)
		if err != nil {
			t.Fatalf("CallOperation error: %v", err)
		}
		if !reply.OK {
			t.Errorf("reply OK = false, want true")
		}
		if got, want := rs.seen()[0].Path, "/api/v1/repos/acme/app/changes"; got != want {
			t.Errorf("Path = %q, want %q", got, want)
		}
	})
}

func TestRunOperationExitCodes(t *testing.T) {
	t.Run("success is 0", func(t *testing.T) {
		rs := newServer(replyJSON(200, `{"changes":[]}`, nil))
		defer rs.Close()
		io := testIO(map[string]string{"KVARM_BASE_URL": rs.URL}, &strings.Builder{}, &strings.Builder{})
		code, err := RunOperation(context.Background(), changeListOp(), []string{"acme/app"}, io)
		if err != nil || code != 0 {
			t.Errorf("RunOperation = (%d, %v), want (0, nil)", code, err)
		}
	})

	t.Run("API failure is 1", func(t *testing.T) {
		rs := newServer(replyJSON(500, `{"error":"nope"}`, nil))
		defer rs.Close()
		io := testIO(map[string]string{"KVARM_BASE_URL": rs.URL}, &strings.Builder{}, &strings.Builder{})
		code, err := RunOperation(context.Background(), changeListOp(), []string{"acme/app"}, io)
		if err != nil || code != 1 {
			t.Errorf("RunOperation = (%d, %v), want (1, nil)", code, err)
		}
	})

	t.Run("parse failure is 2", func(t *testing.T) {
		io := testIO(map[string]string{"KVARM_BASE_URL": "http://unused.invalid"}, &strings.Builder{}, &strings.Builder{})
		code, err := RunOperation(context.Background(), changeListOp(), []string{"acme/app", "--nope"}, io)
		if errs.From(err).ExitCode != 2 {
			t.Fatalf("error = %v, want a usage error", err)
		}
		if code != 2 {
			t.Errorf("RunOperation = (%d, %v), want (2, usage error)", code, err)
		}
	})
}

func TestRunOperationHelp(t *testing.T) {
	rs := newServer(replyJSON(200, `{}`, nil))
	defer rs.Close()
	var out, errOut strings.Builder
	io := testIO(map[string]string{"KVARM_BASE_URL": rs.URL}, &out, &errOut)

	code, err := RunOperation(context.Background(), changeListOp(), []string{"acme/app", "--help"}, io)
	if err != nil || code != 0 {
		t.Fatalf("RunOperation = (%d, %v), want (0, nil)", code, err)
	}
	screen := out.String()
	for _, want := range []string{
		"change list — Change sets of the repository, newest first.",
		"Usage:",
		`REST: GET /api/v1/repos/{repo}/changes`,
		"MCP tool: list_changes",
	} {
		if !strings.Contains(screen, want) {
			t.Errorf("help screen missing %q:\n%s", want, screen)
		}
	}
	// Help never touches the network.
	if n := len(rs.seen()); n != 0 {
		t.Errorf("help sent %d requests, want 0", n)
	}
}
