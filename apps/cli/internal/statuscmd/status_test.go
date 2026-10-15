package statuscmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"kvarm/cli/internal/errs"
	"kvarm/cli/internal/httpx"
	"kvarm/cli/internal/opcli"
	"kvarm/cli/internal/ui"
)

// statusServer answers the registry reads `kvarm status` makes with
// deterministic replies, records every sighting and tracks how many
// dependency reads were in flight at once.
type statusServer struct {
	*httptest.Server

	workspaces int    // workspaces in the list
	nextCursor string // reported as nextCursor when non-empty
	failList   bool
	failDeps   bool

	mu        sync.Mutex
	sightings []sighting
	inFlight  atomic.Int64
	maxDeps   atomic.Int64
}

type sighting struct {
	method, path, rawQuery string
}

func newStatusServer(workspaces int, nextCursor string) *statusServer {
	s := &statusServer{workspaces: workspaces, nextCursor: nextCursor}
	s.Server = httptest.NewServer(http.HandlerFunc(s.handle))
	return s
}

func (s *statusServer) handle(w http.ResponseWriter, r *http.Request) {
	isDeps := strings.HasPrefix(r.URL.Path, "/api/v1/repos/acme/app/workspaces/") && strings.HasSuffix(r.URL.Path, "/dependencies")
	if isDeps {
		n := s.inFlight.Add(1)
		for {
			max := s.maxDeps.Load()
			if n <= max || s.maxDeps.CompareAndSwap(max, n) {
				break
			}
		}
		defer s.inFlight.Add(-1)
		// Give the bounded reads time to overlap so the in-flight cap is
		// actually exercised.
		time.Sleep(5 * time.Millisecond)
	}
	s.mu.Lock()
	s.sightings = append(s.sightings, sighting{r.Method, r.URL.Path, r.URL.RawQuery})
	s.mu.Unlock()
	reply := func(status int, body string) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, body)
	}
	switch {
	case r.URL.Path == "/api/v1/repos/acme/app/workspaces":
		if s.failList {
			reply(400, `{"error":"workspaces down","code":"UNAVAILABLE"}`)
			return
		}
		reply(200, workspacesBody(s.workspaces, s.nextCursor))
	case r.URL.Path == "/api/v1/repos/acme/app/train":
		reply(200, `{"entries":[]}`)
	case r.URL.Path == "/api/v1/repos/acme/app/tasks":
		reply(200, `{"tasks":[]}`)
	case isDeps:
		if s.failDeps {
			reply(500, `{"error":"deps down"}`)
			return
		}
		fmt.Fprintf(w, `{"dependencies":[{"id":"d-%s","state":"active"}]}`, workspaceID(r.URL.Path))
	default:
		reply(404, `{"error":"unexpected path"}`)
	}
}

func (s *statusServer) seen() []sighting {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]sighting, len(s.sightings))
	copy(out, s.sightings)
	return out
}

func workspacesBody(n int, cursor string) string {
	var b strings.Builder
	b.WriteString(`{"workspaces":[`)
	for i := 0; i < n; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `{"id":"ws-%d","state":"active"}`, i)
	}
	b.WriteString("]")
	if cursor != "" {
		fmt.Fprintf(&b, `,"nextCursor":%q`, cursor)
	}
	b.WriteString("}")
	return b.String()
}

func workspaceID(path string) string {
	return strings.TrimSuffix(strings.TrimPrefix(path, "/api/v1/repos/acme/app/workspaces/"), "/dependencies")
}

func statusIO(baseURL string, out, errOut *strings.Builder) opcli.IO {
	return opcli.IO{
		Env:    map[string]string{"KVARM_BASE_URL": baseURL},
		Stdout: ui.New(out),
		Stderr: ui.New(errOut),
		Client: httpx.New(),
	}
}

// statusReply is the merged view `kvarm status` prints.
type statusReply struct {
	Repo                string           `json:"repo"`
	Workspaces          []map[string]any `json:"workspaces"`
	WorkspacesTruncated bool             `json:"workspacesTruncated"`
	Train               map[string]any   `json:"train"`
	Tasks               map[string]any   `json:"tasks"`
}

func runStatus(t *testing.T, baseURL string, argv []string) (statusReply, string, string, int) {
	t.Helper()
	var out, errOut strings.Builder
	code, err := Run(context.Background(), argv, statusIO(baseURL, &out, &errOut))
	if err != nil {
		t.Fatalf("Run error: %v", err)
	}
	var reply statusReply
	if code == 0 {
		if err := json.Unmarshal([]byte(out.String()), &reply); err != nil {
			t.Fatalf("stdout is not the status JSON: %v\nstdout: %s", err, out.String())
		}
	}
	return reply, out.String(), errOut.String(), code
}

func TestRunMergesDependencies(t *testing.T) {
	rs := newStatusServer(25, "")
	defer rs.Close()

	reply, _, stderr, code := runStatus(t, rs.URL, []string{"acme/app"})
	if code != 0 {
		t.Fatalf("Run = %d, want 0; stderr:\n%s", code, stderr)
	}

	seen := rs.seen()
	var depIDs []string
	byPath := map[string]string{}
	for _, s := range seen {
		if strings.HasSuffix(s.path, "/dependencies") {
			depIDs = append(depIDs, workspaceID(s.path))
			if s.rawQuery != "" {
				t.Errorf("dependencies read %q carried query %q, want none (repo and workspace are path parameters)", s.path, s.rawQuery)
			}
			continue
		}
		byPath[s.path] = s.rawQuery
	}
	// The three initial reads: url.Values.Encode sorts each query's keys.
	if got, want := byPath["/api/v1/repos/acme/app/workspaces"], "limit=100&status=active"; got != want {
		t.Errorf("workspaces read query = %q, want %q", got, want)
	}
	if got, want := byPath["/api/v1/repos/acme/app/train"], "limit=100"; got != want {
		t.Errorf("train read query = %q, want %q", got, want)
	}
	if got, want := byPath["/api/v1/repos/acme/app/tasks"], "limit=100&status=open"; got != want {
		t.Errorf("tasks read query = %q, want %q", got, want)
	}

	// Pins are read only for the first DependencyReads workspaces, once each.
	depSet := map[string]bool{}
	for _, id := range depIDs {
		if depSet[id] {
			t.Errorf("dependency read repeated for workspace %q", id)
		}
		depSet[id] = true
	}
	if len(depSet) != DependencyReads {
		t.Fatalf("%d dependency reads, want %d", len(depSet), DependencyReads)
	}
	for i := 0; i < DependencyReads; i++ {
		if want := fmt.Sprintf("ws-%d", i); !depSet[want] {
			t.Errorf("no dependency read for workspace %q", want)
		}
	}

	// The merged view keeps every workspace, with pins on the first 20 only.
	if got := len(reply.Workspaces); got != 25 {
		t.Fatalf("workspaces = %d, want 25", got)
	}
	for i, ws := range reply.Workspaces {
		if got, want := ws["id"], fmt.Sprintf("ws-%d", i); got != want {
			t.Errorf("workspace %d id = %v, want %v", i, got, want)
		}
		deps, has := ws["dependencies"]
		if i < DependencyReads {
			if !has {
				t.Errorf("workspace %d has no dependencies key, want one", i)
				continue
			}
			list, ok := deps.([]any)
			if !ok || len(list) != 1 {
				t.Errorf("workspace %d dependencies = %#v, want one entry", i, deps)
				continue
			}
			if got, want := list[0].(map[string]any)["id"], fmt.Sprintf("d-ws-%d", i); got != want {
				t.Errorf("workspace %d first dependency id = %v, want %v", i, got, want)
			}
		} else if has {
			t.Errorf("workspace %d has a dependencies key, want none past the read limit", i)
		}
	}
	if !reply.WorkspacesTruncated {
		t.Error("workspacesTruncated = false, want true (25 listed, 20 pinned)")
	}
	if _, ok := reply.Train["entries"]; !ok {
		t.Errorf("train = %#v, want the platform's train reply", reply.Train)
	}
	if _, ok := reply.Tasks["tasks"]; !ok {
		t.Errorf("tasks = %#v, want the platform's tasks reply", reply.Tasks)
	}

	// At most InFlight dependency reads in flight at once.
	if max := rs.maxDeps.Load(); max > InFlight {
		t.Errorf("%d dependency reads in flight at once, want at most %d", max, InFlight)
	}
}

func TestRunTruncationFlag(t *testing.T) {
	tests := []struct {
		name       string
		workspaces int
		cursor     string
		truncated  bool
	}{
		{"under the limit without a cursor", 5, "", false},
		{"exactly at the limit", DependencyReads, "", false},
		{"one past the limit", DependencyReads + 1, "", true},
		{"a nextCursor alone truncates", 5, "next-page", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rs := newStatusServer(tt.workspaces, tt.cursor)
			defer rs.Close()
			reply, _, _, code := runStatus(t, rs.URL, []string{"acme/app"})
			if code != 0 {
				t.Fatalf("Run = %d, want 0", code)
			}
			if reply.WorkspacesTruncated != tt.truncated {
				t.Errorf("workspacesTruncated = %v, want %v", reply.WorkspacesTruncated, tt.truncated)
			}
			if got := len(reply.Workspaces); got != tt.workspaces {
				t.Errorf("workspaces = %d, want %d", got, tt.workspaces)
			}
		})
	}
}

func TestRunJSONOutput(t *testing.T) {
	rs := newStatusServer(3, "")
	defer rs.Close()

	var out, errOut strings.Builder
	code, err := Run(context.Background(), []string{"--json", "acme/app"}, statusIO(rs.URL, &out, &errOut))
	if err != nil || code != 0 {
		t.Fatalf("Run = (%d, %v), want (0, nil)", code, err)
	}
	// One line of JSON, exactly, with the five merged keys.
	if got := out.String(); strings.Count(got, "\n") != 1 || strings.HasPrefix(got, " ") {
		t.Errorf("stdout = %q, want a single unindented line", got)
	}
	var reply statusReply
	if err := json.Unmarshal([]byte(out.String()), &reply); err != nil {
		t.Fatalf("stdout is not JSON: %v\nstdout: %s", err, out.String())
	}
	if reply.Repo != "acme/app" {
		t.Errorf("repo = %q, want acme/app", reply.Repo)
	}
	if len(reply.Workspaces) != 3 || reply.WorkspacesTruncated {
		t.Errorf("workspaces/truncated = %d/%v, want 3/false", len(reply.Workspaces), reply.WorkspacesTruncated)
	}
}

func TestRunHelp(t *testing.T) {
	for _, flag := range []string{"--help", "-h"} {
		t.Run(flag, func(t *testing.T) {
			rs := newStatusServer(0, "")
			defer rs.Close()
			var out, errOut strings.Builder
			code, err := Run(context.Background(), []string{flag}, statusIO(rs.URL, &out, &errOut))
			if err != nil || code != 0 {
				t.Fatalf("Run = (%d, %v), want (0, nil)", code, err)
			}
			screen := out.String()
			for _, want := range []string{
				"kvarm status — one read-only view of a repository's live state",
				"Reads only: GET workspaces?status=active",
				fmt.Sprintf("up to %d active workspaces", DependencyReads),
			} {
				if !strings.Contains(screen, want) {
					t.Errorf("help screen missing %q:\n%s", want, screen)
				}
			}
			// Help answers without touching the platform.
			if n := len(rs.seen()); n != 0 {
				t.Errorf("help sent %d requests, want 0", n)
			}
		})
	}
}

func TestRunUsageErrors(t *testing.T) {
	tests := []struct {
		name    string
		argv    []string
		wantErr string
	}{
		{"no positional", nil, "expected <owner/repo>"},
		{"two positionals", []string{"a", "b"}, "expected <owner/repo>"},
		{"unknown option", []string{"--bogus"}, `unknown option "--bogus" for kvarm status`},
		{"unknown option after the repo", []string{"acme/app", "--bogus"}, `unknown option "--bogus" for kvarm status`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rs := newStatusServer(0, "")
			defer rs.Close()
			var out, errOut strings.Builder
			code, err := Run(context.Background(), tt.argv, statusIO(rs.URL, &out, &errOut))
			if code != 2 {
				t.Errorf("Run = %d, want 2", code)
			}
			if errs.From(err).ExitCode != 2 || err.Error() != tt.wantErr {
				t.Errorf("error = %v, want a usage error %q", err, tt.wantErr)
			}
			if out.Len() != 0 {
				t.Errorf("stdout = %q, want empty", out.String())
			}
			if n := len(rs.seen()); n != 0 {
				t.Errorf("usage error sent %d requests, want 0", n)
			}
		})
	}
}

func TestRunFirstReadFailure(t *testing.T) {
	rs := newStatusServer(5, "")
	rs.failList = true
	defer rs.Close()

	var out, errOut strings.Builder
	code, err := Run(context.Background(), []string{"acme/app"}, statusIO(rs.URL, &out, &errOut))
	if err != nil {
		t.Fatalf("Run error: %v, want a printed report", err)
	}
	if code != 1 {
		t.Fatalf("Run = %d, want 1", code)
	}
	if out.Len() != 0 {
		t.Errorf("stdout = %q, want empty", out.String())
	}
	// status.js reported under the "kvarm status" label; the hint names the
	// underlying registry command that failed.
	want := "kvarm status: UNAVAILABLE (HTTP 400): workspaces down\n" +
		"hint: fix the argument named in the error; run \"kvarm workspace list --help\"\n"
	if got := errOut.String(); got != want {
		t.Errorf("stderr = %q, want %q", got, want)
	}
	// The other two reads still ran; no pins were read after the failure.
	if got := len(rs.seen()); got != 3 {
		t.Errorf("%d requests, want 3 (the initial reads only)", got)
	}
}

func TestRunDependenciesReadFailure(t *testing.T) {
	rs := newStatusServer(5, "")
	rs.failDeps = true
	defer rs.Close()

	var out, errOut strings.Builder
	code, err := Run(context.Background(), []string{"acme/app"}, statusIO(rs.URL, &out, &errOut))
	if err != nil {
		t.Fatalf("Run error: %v, want a printed report", err)
	}
	if code != 1 {
		t.Fatalf("Run = %d, want 1", code)
	}
	if out.Len() != 0 {
		t.Errorf("stdout = %q, want empty", out.String())
	}
	want := "kvarm status: (HTTP 500): deps down\n" +
		"hint: platform or storage error; retry shortly\n"
	if got := errOut.String(); got != want {
		t.Errorf("stderr = %q, want %q", got, want)
	}
}
