package app

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"kvarm/cli/internal/registry"
)

// recordedRequest is what a test server saw of one request.
type recordedRequest struct {
	method, path, rawQuery string
}

// recordingServer wraps an httptest server that records every request.
type recordingServer struct {
	*httptest.Server
	mu       sync.Mutex
	requests []recordedRequest
}

func newRecordingServer(reply http.HandlerFunc) *recordingServer {
	rs := &recordingServer{}
	rs.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rs.mu.Lock()
		rs.requests = append(rs.requests, recordedRequest{r.Method, r.URL.Path, r.URL.RawQuery})
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

func replyJSON(status int, body string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, body)
	}
}

func runMain(argv []string, env map[string]string) (stdout, stderr string, code int) {
	var out, errOut strings.Builder
	code = Main(argv, env, &out, &errOut)
	return out.String(), errOut.String(), code
}

// statusReply is the merged view `kvarm status` prints.
type statusReply struct {
	Repo                string           `json:"repo"`
	Workspaces          []map[string]any `json:"workspaces"`
	WorkspacesTruncated bool             `json:"workspacesTruncated"`
}

func TestMainRootScreen(t *testing.T) {
	tests := []struct {
		name string
		argv []string
		code int
	}{
		// Bare `kvarm` shows the root screen and exits 2, the way the JS
		// CLI's empty-command branch did.
		{"bare kvarm exits 2", nil, 2},
		{"help exits 0", []string{"help"}, 0},
		{"--help exits 0", []string{"--help"}, 0},
		{"-h exits 0", []string{"-h"}, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stdout, stderr, code := runMain(tt.argv, map[string]string{})
			if code != tt.code {
				t.Errorf("Main = %d, want %d", code, tt.code)
			}
			// The hierarchy never dumps every command: the root screen
			// lists only the parents plus one line per API group.
			for _, want := range []string{
				"kvarm 0.1.0",
				"checkout", "runner", "status", "help",
				"user", "change", "workspace", // three group names
				"KVARM_BASE_URL", "KVARM_PAT",
			} {
				if !strings.Contains(stdout, want) {
					t.Errorf("root screen missing %q:\n%s", want, stdout)
				}
			}
			if strings.Contains(stdout, "user whoami") {
				t.Error("root screen lists a group's command, want parents only")
			}
			if stderr != "" {
				t.Errorf("stderr = %q, want empty", stderr)
			}
		})
	}

	t.Run("configuration state is shown", func(t *testing.T) {
		env := map[string]string{
			"KVARM_BASE_URL": "http://platform.example.com",
			"KVARM_PAT":      "kvarm_pat_test-token",
		}
		stdout, _, code := runMain(nil, env)
		if code != 2 {
			t.Errorf("Main = %d, want 2", code)
		}
		if !strings.Contains(stdout, "set → http://platform.example.com") {
			t.Errorf("root screen missing the set KVARM_BASE_URL:\n%s", stdout)
		}
		// Without the environment the same line says "not set".
		stdout, _, _ = runMain(nil, map[string]string{})
		if !strings.Contains(stdout, "not set") {
			t.Errorf("root screen missing \"not set\":\n%s", stdout)
		}
	})
}

func TestMainVersion(t *testing.T) {
	for _, argv := range [][]string{{"--version"}, {"-v"}, {"version"}} {
		stdout, stderr, code := runMain(argv, map[string]string{})
		if code != 0 {
			t.Errorf("Main(%v) = %d, want 0", argv, code)
		}
		if got, want := stdout, "kvarm 0.1.0\n"; got != want {
			t.Errorf("stdout = %q, want %q", got, want)
		}
		if stderr != "" {
			t.Errorf("stderr = %q, want empty", stderr)
		}
	}
}

func TestMainHelpSpecialCommands(t *testing.T) {
	tests := []struct {
		name string
		argv []string
		want []string
	}{
		{"checkout", []string{"help", "checkout"}, []string{
			"kvarm checkout — materialize a ref into a directory",
			"source: snapshot",
			"source: clone",
		}},
		{"runner", []string{"help", "runner"}, []string{
			"kvarm runner — claim and run CI jobs on this machine",
			"--trust humans",
			"--pids-limit <n>",
		}},
		{"status", []string{"help", "status"}, []string{
			"kvarm status — one read-only view of a repository's live state",
			"Reads only: GET workspaces?status=active",
			"Exit status: 0 success; 1 API or network failure",
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stdout, stderr, code := runMain(tt.argv, map[string]string{})
			if code != 0 {
				t.Fatalf("Main(%v) = %d, want 0; stderr:\n%s", tt.argv, code, stderr)
			}
			for _, want := range tt.want {
				if !strings.Contains(stdout, want) {
					t.Errorf("help screen missing %q:\n%s", want, stdout)
				}
			}
		})
	}
}

func TestMainHelpRegistryCommand(t *testing.T) {
	reg := registry.Load()
	op := reg.FindCommand([]string{"change", "list"})
	if op == nil {
		t.Fatal("registry has no change list operation")
	}
	stdout, stderr, code := runMain([]string{"help", "change", "list"}, map[string]string{})
	if code != 0 {
		t.Fatalf("Main = %d, want 0; stderr:\n%s", code, stderr)
	}
	for _, want := range []string{
		"change list — ", // the screen header carries no extra "kvarm" prefix
		"MCP tool: " + op.Name,
		"REST: GET /api/v1/repos/{repo}/changes",
		"--json",
		"Exit codes: 0 success · 1 API or network failure · 2 usage error",
	} {
		if !strings.Contains(stdout, want) {
			t.Errorf("command screen missing %q:\n%s", want, stdout)
		}
	}
}

func TestMainHelpGroupScreen(t *testing.T) {
	tests := []struct {
		name string
		argv []string
	}{
		{"help change", []string{"help", "change"}},
		// A group name still routes to the group screen even when the
		// second word is not one of its verbs.
		{"help change lis", []string{"help", "change", "lis"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stdout, stderr, code := runMain(tt.argv, map[string]string{})
			if code != 0 {
				t.Fatalf("Main(%v) = %d, want 0; stderr:\n%s", tt.argv, code, stderr)
			}
			for _, want := range []string{
				"change — change sets: open, review, update and merge",
				"change list",
				"Run \"kvarm change <command> --help\" for details on a command.",
			} {
				if !strings.Contains(stdout, want) {
					t.Errorf("group screen missing %q:\n%s", want, stdout)
				}
			}
		})
	}
}

func TestMainHelpUnknownTarget(t *testing.T) {
	t.Run("an unknown word with no near candidate", func(t *testing.T) {
		stdout, stderr, code := runMain([]string{"help", "bogus"}, map[string]string{})
		if code != 2 {
			t.Errorf("Main = %d, want 2", code)
		}
		if want := "kvarm: nothing to help about \"bogus\"\n"; stderr != want {
			t.Errorf("stderr = %q, want %q", stderr, want)
		}
		if stdout != "" {
			t.Errorf("stdout = %q, want empty", stdout)
		}
	})

	t.Run("a typo is suggested", func(t *testing.T) {
		_, stderr, code := runMain([]string{"help", "chckout"}, map[string]string{})
		if code != 2 {
			t.Errorf("Main = %d, want 2", code)
		}
		for _, want := range []string{
			"kvarm: nothing to help about \"chckout\"",
			"did you mean \"checkout\"?",
		} {
			if !strings.Contains(stderr, want) {
				t.Errorf("stderr = %q, want it to contain %q", stderr, want)
			}
		}
	})
}

func TestMainUnknownCommand(t *testing.T) {
	stdout, stderr, code := runMain([]string{"chckout"}, map[string]string{})
	if code != 2 {
		t.Errorf("Main = %d, want 2", code)
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty", stdout)
	}
	for _, want := range []string{
		"kvarm: unknown command \"chckout\"",
		"did you mean \"checkout\"?",
		"Run \"kvarm\" to list every command group.",
	} {
		if !strings.Contains(stderr, want) {
			t.Errorf("stderr = %q, want it to contain %q", stderr, want)
		}
	}
}

func TestMainUnknownGroupVerb(t *testing.T) {
	stdout, stderr, code := runMain([]string{"change", "lis"}, map[string]string{})
	if code != 2 {
		t.Errorf("Main = %d, want 2", code)
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty", stdout)
	}
	for _, want := range []string{
		"kvarm: unknown command \"change lis\"",
		"did you mean \"change list\"? Try \"kvarm change\" to list the group's commands.",
	} {
		if !strings.Contains(stderr, want) {
			t.Errorf("stderr = %q, want it to contain %q", stderr, want)
		}
	}
}

func TestMainGroupWithoutVerb(t *testing.T) {
	tests := []struct {
		name string
		argv []string
		code int
	}{
		{"a bare group lists its commands and exits 2", []string{"change"}, 2},
		{"--help on a group exits 0", []string{"change", "--help"}, 0},
		{"-h on a group exits 0", []string{"change", "-h"}, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stdout, stderr, code := runMain(tt.argv, map[string]string{})
			if code != tt.code {
				t.Errorf("Main(%v) = %d, want %d", tt.argv, code, tt.code)
			}
			if !strings.Contains(stdout, "change list") {
				t.Errorf("stdout misses the group's verbs:\n%s", stdout)
			}
			if stderr != "" {
				t.Errorf("stderr = %q, want empty", stderr)
			}
		})
	}
}

func TestMainRegistryCommandRun(t *testing.T) {
	t.Run("a registry command runs against the platform", func(t *testing.T) {
		rs := newRecordingServer(replyJSON(200, `{"changes":[]}`))
		defer rs.Close()
		env := map[string]string{"KVARM_BASE_URL": rs.URL}
		stdout, stderr, code := runMain([]string{"change", "list", "acme/app", "--limit", "5"}, env)
		if code != 0 {
			t.Fatalf("Main = %d, want 0; stderr:\n%s", code, stderr)
		}
		if got, want := stdout, "{\n  \"changes\": []\n}\n"; got != want {
			t.Errorf("stdout = %q, want %q", got, want)
		}
		seen := rs.seen()
		if len(seen) != 1 {
			t.Fatalf("%d requests, want 1", len(seen))
		}
		if seen[0].method != "GET" || seen[0].path != "/api/v1/repos/acme/app/changes" {
			t.Errorf("request = %s %q, want GET /api/v1/repos/acme/app/changes", seen[0].method, seen[0].path)
		}
		if got, want := seen[0].rawQuery, "limit=5"; got != want {
			t.Errorf("query = %q, want %q", got, want)
		}
	})

	t.Run("an API failure keeps the report the command printed", func(t *testing.T) {
		rs := newRecordingServer(replyJSON(500, `{"error":"boom","code":"X"}`))
		defer rs.Close()
		env := map[string]string{"KVARM_BASE_URL": rs.URL}
		stdout, stderr, code := runMain([]string{"change", "list", "acme/app"}, env)
		if code != 1 {
			t.Fatalf("Main = %d, want 1", code)
		}
		if stdout != "" {
			t.Errorf("stdout = %q, want empty", stdout)
		}
		want := "kvarm change list: X (HTTP 500): boom\n" +
			"hint: platform or storage error; retry shortly\n"
		if stderr != want {
			t.Errorf("stderr = %q, want %q", stderr, want)
		}
	})

	t.Run("a configuration problem is a usage error with the help pointer", func(t *testing.T) {
		stdout, stderr, code := runMain([]string{"change", "list", "acme/app"}, map[string]string{})
		if code != 2 {
			t.Fatalf("Main = %d, want 2 (the CliError's code overrides the 1 RunOperation returned)", code)
		}
		if stdout != "" {
			t.Errorf("stdout = %q, want empty", stdout)
		}
		want := "kvarm change list: KVARM_BASE_URL is not set (e.g. https://kvarm.example.com)\n" +
			"run \"kvarm help change list\" for usage\n"
		if stderr != want {
			t.Errorf("stderr = %q, want %q", stderr, want)
		}
	})
}

func TestMainCheckout(t *testing.T) {
	t.Run("help", func(t *testing.T) {
		stdout, stderr, code := runMain([]string{"checkout", "--help"}, map[string]string{})
		if code != 0 {
			t.Fatalf("Main = %d, want 0; stderr:\n%s", code, stderr)
		}
		if !strings.Contains(stdout, "kvarm checkout — materialize a ref into a directory") {
			t.Errorf("stdout misses the checkout help:\n%s", stdout)
		}
	})

	usageCases := []struct {
		name string
		argv []string
		want string
	}{
		{"missing positionals", []string{"checkout"}, "expected <owner/repo> <ref> <dir>"},
		{"one positional short", []string{"checkout", "acme/app", "main"}, "expected <owner/repo> <ref> <dir>"},
		{"too many positionals", []string{"checkout", "acme/app", "main", "dir", "extra"}, "expected <owner/repo> <ref> <dir>"},
		{"unknown option", []string{"checkout", "--bogus"}, `unknown option "--bogus"`},
		{"missing KVARM_BASE_URL", []string{"checkout", "acme/app", "main", "dir"}, "KVARM_BASE_URL is not set (e.g. https://kvarm.example.com)"},
	}
	for _, tt := range usageCases {
		t.Run(tt.name, func(t *testing.T) {
			stdout, stderr, code := runMain(tt.argv, map[string]string{})
			if code != 2 {
				t.Errorf("Main(%v) = %d, want 2", tt.argv, code)
			}
			if stdout != "" {
				t.Errorf("stdout = %q, want empty", stdout)
			}
			if !strings.Contains(stderr, "kvarm checkout: "+tt.want) {
				t.Errorf("stderr = %q, want it to contain %q", stderr, "kvarm checkout: "+tt.want)
			}
			if !strings.Contains(stderr, "run \"kvarm help checkout\" for usage") {
				t.Errorf("stderr = %q, want the usage pointer", stderr)
			}
		})
	}
}

func TestMainRunnerValidation(t *testing.T) {
	// Every runner case runs against a live server to prove the runner
	// never reaches the network before its validation refuses the command.
	rs := newRecordingServer(replyJSON(200, `{}`))
	defer rs.Close()
	fullEnv := map[string]string{"KVARM_BASE_URL": rs.URL, "KVARM_PAT": "kvarm_pat_test-token"}
	workdir := t.TempDir()

	tests := []struct {
		name string
		argv []string
		env  map[string]string
		want string
	}{
		{"missing --repo", []string{"runner"}, fullEnv, "expected --repo <owner/repo>"},
		{"--repo without a value", []string{"runner", "--repo"}, fullEnv, `option '--repo' requires a value`},
		{"--repo is not a slug", []string{"runner", "--repo", "nope"}, fullEnv, "expected --repo <owner/repo>"},
		{"unknown option", []string{"runner", "--bogus"}, fullEnv, `unknown option '--bogus'`},
		{"--once takes no value", []string{"runner", "--once=1"}, fullEnv, `option '--once' does not take a value`},
		{"unexpected positional", []string{"runner", "extra"}, fullEnv, `unexpected positional argument "extra"`},
		{"missing KVARM_BASE_URL", []string{"runner", "--repo", "acme/app"},
			map[string]string{"KVARM_PAT": "kvarm_pat_test-token"}, "KVARM_BASE_URL is not set"},
		{"missing KVARM_PAT", []string{"runner", "--repo", "acme/app"},
			map[string]string{"KVARM_BASE_URL": rs.URL}, "KVARM_PAT is not set (the runner requires ci scope)"},
		{"non-numeric --pids-limit", []string{"runner", "--repo", "acme/app", "--pids-limit", "NaN"}, fullEnv,
			`invalid pids limit "NaN"`},
		{"zero --pids-limit", []string{"runner", "--repo", "acme/app", "--pids-limit", "0"}, fullEnv,
			`invalid pids limit "0"`},
		{"relative --workdir", []string{"runner", "--repo", "acme/app", "--workdir", "relative/dir"}, fullEnv,
			"--workdir must be an absolute path"},
		// The app hands --trust through; runner.Run refuses the bad value
		// as a usage error before any claim poll.
		{"bad --trust is refused by the runner", []string{"runner", "--repo", "acme/app", "--trust", "bogus", "--workdir", workdir}, fullEnv,
			"--trust must be one of all, humans, none"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stdout, stderr, code := runMain(tt.argv, tt.env)
			if code != 2 {
				t.Errorf("Main(%v) = %d, want 2", tt.argv, code)
			}
			if stdout != "" {
				t.Errorf("stdout = %q, want empty", stdout)
			}
			if !strings.Contains(stderr, "kvarm runner: "+tt.want) {
				t.Errorf("stderr = %q, want it to contain %q", stderr, "kvarm runner: "+tt.want)
			}
			if !strings.Contains(stderr, "run \"kvarm help runner\" for usage") {
				t.Errorf("stderr = %q, want the usage pointer", stderr)
			}
			if n := len(rs.seen()); n != 0 {
				t.Errorf("validation error sent %d requests, want 0 (validation precedes the network)", n)
			}
		})
	}

	t.Run("help", func(t *testing.T) {
		stdout, stderr, code := runMain([]string{"runner", "--help"}, map[string]string{})
		if code != 0 {
			t.Fatalf("Main = %d, want 0; stderr:\n%s", code, stderr)
		}
		if !strings.Contains(stdout, "kvarm runner — claim and run CI jobs on this machine") {
			t.Errorf("stdout misses the runner help:\n%s", stdout)
		}
	})
}

func TestMainStatusDispatch(t *testing.T) {
	// The four reads `kvarm status` makes, on one recording server.
	rs := newRecordingServer(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/repos/acme/app/workspaces":
			io.WriteString(w, `{"workspaces":[{"id":"ws-0","state":"active"}]}`)
		case "/api/v1/repos/acme/app/workspaces/ws-0/dependencies":
			io.WriteString(w, `{"dependencies":[]}`)
		case "/api/v1/repos/acme/app/train":
			io.WriteString(w, `{"entries":[]}`)
		case "/api/v1/repos/acme/app/tasks":
			io.WriteString(w, `{"tasks":[]}`)
		default:
			w.WriteHeader(404)
			io.WriteString(w, `{"error":"unexpected path"}`)
		}
	})
	defer rs.Close()
	env := map[string]string{"KVARM_BASE_URL": rs.URL}

	t.Run("status runs the composite read", func(t *testing.T) {
		stdout, stderr, code := runMain([]string{"status", "acme/app"}, env)
		if code != 0 {
			t.Fatalf("Main = %d, want 0; stderr:\n%s", code, stderr)
		}
		var reply statusReply
		if err := json.Unmarshal([]byte(stdout), &reply); err != nil {
			t.Fatalf("stdout is not the status JSON: %v\n%s", err, stdout)
		}
		if reply.Repo != "acme/app" || reply.WorkspacesTruncated || len(reply.Workspaces) != 1 {
			t.Errorf("reply = %+v, want repo acme/app, one workspace, not truncated", reply)
		}
		if _, ok := reply.Workspaces[0]["dependencies"]; !ok {
			t.Errorf("workspace 0 = %#v, want a dependencies key", reply.Workspaces[0])
		}
		if n := len(rs.seen()); n != 4 {
			t.Errorf("%d requests, want 4 (three reads plus one pin read)", n)
		}
	})

	t.Run("status help", func(t *testing.T) {
		stdout, stderr, code := runMain([]string{"status", "--help"}, env)
		if code != 0 {
			t.Fatalf("Main = %d, want 0; stderr:\n%s", code, stderr)
		}
		if !strings.Contains(stdout, "kvarm status — one read-only view of a repository's live state") {
			t.Errorf("stdout misses the status help:\n%s", stdout)
		}
	})

	t.Run("usage errors carry the status label", func(t *testing.T) {
		tests := []struct {
			argv []string
			want string
		}{
			{[]string{"status"}, "expected <owner/repo>"},
			{[]string{"status", "--bogus"}, `unknown option "--bogus" for kvarm status`},
		}
		for _, tt := range tests {
			stdout, stderr, code := runMain(tt.argv, env)
			if code != 2 {
				t.Errorf("Main(%v) = %d, want 2", tt.argv, code)
			}
			if stdout != "" {
				t.Errorf("stdout = %q, want empty", stdout)
			}
			if !strings.Contains(stderr, "kvarm status: "+tt.want) {
				t.Errorf("stderr = %q, want it to contain %q", stderr, "kvarm status: "+tt.want)
			}
			if !strings.Contains(stderr, "run \"kvarm help status\" for usage") {
				t.Errorf("stderr = %q, want the usage pointer", stderr)
			}
		}
	})

	t.Run("a failed read is reported under the status label", func(t *testing.T) {
		failRS := newRecordingServer(replyJSON(500, `{"error":"workspaces down"}`))
		defer failRS.Close()
		failEnv := map[string]string{"KVARM_BASE_URL": failRS.URL}
		stdout, stderr, code := runMain([]string{"status", "acme/app"}, failEnv)
		if code != 1 {
			t.Fatalf("Main = %d, want 1", code)
		}
		if stdout != "" {
			t.Errorf("stdout = %q, want empty", stdout)
		}
		want := "kvarm status: (HTTP 500): workspaces down\n" +
			"hint: platform or storage error; retry shortly\n"
		if stderr != want {
			t.Errorf("stderr = %q, want %q", stderr, want)
		}
	})
}
