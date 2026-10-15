package opcli

import (
	"net/url"
	"reflect"
	"testing"

	"kvarm/cli/internal/errs"
	"kvarm/cli/internal/registry"
)

// widgetOp is a synthetic operation with one of every parameter kind: a
// positional repo, a kebab-case flag, an integer, a strict boolean, a comma
// list, a literal list and a JSON flag. Tests construct operations directly
// so the embedded registry JSON never constrains what shapes are covered.
func widgetOp() *registry.Operation {
	return &registry.Operation{
		Name:    "deploy_widget",
		Command: []string{"widget", "deploy"},
		Method:  "POST",
		Path:    "/repos/{repo}/widgets",
		Params: []registry.Param{
			{Name: "repo", Type: registry.TypeString, In: "path", Positional: true, Required: true, Format: "repo", Description: "Repository as owner/name"},
			{Name: "baseBranch", Type: registry.TypeString, In: "query", Description: "target branch"},
			{Name: "limit", Type: registry.TypeInteger, In: "query", Description: "page size"},
			{Name: "force", Type: registry.TypeBoolean, In: "query", Description: "skip checks"},
			{Name: "tags", Type: registry.TypeStrings, In: "query", Description: "comma list"},
			{Name: "paths", Type: registry.TypeStrings, In: "query", Literal: true, Description: "git paths"},
			{Name: "meta", Type: registry.TypeJSON, In: "body", Description: "free-form"},
		},
	}
}

func usageError(t *testing.T, err error, wantMsg string) {
	t.Helper()
	if err == nil {
		t.Fatalf("want usage error %q, got nil", wantMsg)
	}
	ce := errs.From(err)
	if ce.ExitCode != 2 {
		t.Errorf("ExitCode = %d, want 2 (a usage error)", ce.ExitCode)
	}
	if ce.Message != wantMsg {
		t.Errorf("error = %q, want %q", ce.Message, wantMsg)
	}
}

func TestKebab(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{"repo", "repo"},
		{"baseBranch", "base-branch"},
		{"baseURL", "base-u-r-l"}, // consecutive capitals each get a dash
		{"onWorkspace", "on-workspace"},
	}
	for _, tt := range tests {
		if got := Kebab(tt.in); got != tt.want {
			t.Errorf("Kebab(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestParseArgsPositionals(t *testing.T) {
	// Positionals fill in declaration order; extras are refused.
	parsed, err := ParseArgs(widgetOp(), []string{"acme/app"})
	if err != nil {
		t.Fatalf("ParseArgs error: %v", err)
	}
	if got, want := parsed.Args["repo"], "acme/app"; got != want {
		t.Errorf("repo = %v, want %v", got, want)
	}
	if parsed.Help || parsed.JSONOutput {
		t.Errorf("Help/JSONOutput = %v/%v, want false/false", parsed.Help, parsed.JSONOutput)
	}
	_, err = ParseArgs(widgetOp(), []string{"acme/app", "extra"})
	usageError(t, err, `unexpected argument "extra"`)
}

func TestParseArgsIntegerPositional(t *testing.T) {
	op := &registry.Operation{
		Name: "show_widget", Command: []string{"widget", "show"}, Path: "/widgets/{number}",
		Params: []registry.Param{{Name: "number", Type: registry.TypeInteger, In: "path", Positional: true, Required: true}},
	}
	// A leading '-' belongs to the number, not to a flag: single-dash tokens
	// are positionals, the way ops.js's startsWith('--') check read them.
	parsed, err := ParseArgs(op, []string{"-5"})
	if err != nil {
		t.Fatalf("ParseArgs error: %v", err)
	}
	if got, want := parsed.Args["number"], int64(-5); got != want {
		t.Errorf("number = %v, want %v", got, want)
	}
	_, err = ParseArgs(op, []string{"x"})
	usageError(t, err, `argument "number" must be an integer, got "x"`)
}

func TestParseArgsFlags(t *testing.T) {
	tests := []struct {
		name    string
		argv    []string
		key     string
		want    any
		wantErr string
	}{
		{"kebab flag", []string{"acme/app", "--base-branch", "main"}, "baseBranch", "main", ""},
		{"kebab flag with =", []string{"acme/app", "--base-branch=dev"}, "baseBranch", "dev", ""},
		{"first equal sign splits, the rest is the value", []string{"acme/app", "--base-branch=a=b"}, "baseBranch", "a=b", ""},
		{"negative integer flag", []string{"acme/app", "--limit=-7"}, "limit", int64(-7), ""},
		{"integer flag", []string{"acme/app", "--limit", "42"}, "limit", int64(42), ""},
		{"float refused", []string{"acme/app", "--limit", "4.5"}, "", nil, `argument "limit" must be an integer, got "4.5"`},
		{"beyond int64 refused", []string{"acme/app", "--limit", "99999999999999999999"}, "", nil, `argument "limit" must be an integer, got "99999999999999999999"`},
		{"boolean flag bare", []string{"acme/app", "--force"}, "force", true, ""},
		{"boolean =true", []string{"acme/app", "--force=true"}, "force", true, ""},
		{"boolean =false", []string{"acme/app", "--force=false"}, "force", false, ""},
		{"boolean =1 refused", []string{"acme/app", "--force=1"}, "", nil, `argument "force" must be true or false, got "1"`},
		// ops.js refused anything but the two spellings: "yes" is not truthy.
		{"boolean yes refused", []string{"acme/app", "--force=yes"}, "", nil, `argument "force" must be true or false, got "yes"`},
		// A bare boolean flag takes no separate value, exactly like
		// ops.js: the next word is an unexpected positional instead.
		{"bare boolean consumes no value", []string{"acme/app", "--force", "false"}, "", nil, `unexpected argument "false"`},
		{"unknown option", []string{"acme/app", "--nope", "x"}, "", nil, `unknown option "--nope" for kvarm widget deploy`},
		{"flag at end needs a value", []string{"--base-branch"}, "", nil, `option "--base-branch" needs a value`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			parsed, err := ParseArgs(widgetOp(), tt.argv)
			if tt.wantErr != "" {
				usageError(t, err, tt.wantErr)
				return
			}
			if err != nil {
				t.Fatalf("ParseArgs error: %v", err)
			}
			if got := parsed.Args[tt.key]; !reflect.DeepEqual(got, tt.want) {
				t.Errorf("Args[%q] = %#v, want %#v", tt.key, got, tt.want)
			}
		})
	}
}

func TestParseArgsLists(t *testing.T) {
	// A literal list repeats the flag once per path and never splits on
	// commas — a git path may contain one.
	parsed, err := ParseArgs(widgetOp(), []string{"acme/app", "--paths", "a,b", "--paths", "c"})
	if err != nil {
		t.Fatalf("ParseArgs error: %v", err)
	}
	if got, want := parsed.Args["paths"], []string{"a,b", "c"}; !reflect.DeepEqual(got, want) {
		t.Errorf("paths = %#v, want %#v", got, want)
	}
	// A comma list splits on commas and drops empty pieces, matching
	// ops.js's split(',').filter(s => s.length > 0).
	parsed, err = ParseArgs(widgetOp(), []string{"acme/app", "--tags", "x,,y", "--tags", "z"})
	if err != nil {
		t.Fatalf("ParseArgs error: %v", err)
	}
	if got, want := parsed.Args["tags"], []string{"x", "y", "z"}; !reflect.DeepEqual(got, want) {
		t.Errorf("tags = %#v, want %#v", got, want)
	}
}

func TestParseArgsJSONFlag(t *testing.T) {
	parsed, err := ParseArgs(widgetOp(), []string{"acme/app", "--meta", `{"a":1,"b":["x"]}`})
	if err != nil {
		t.Fatalf("ParseArgs error: %v", err)
	}
	want := map[string]any{"a": float64(1), "b": []any{"x"}}
	if got := parsed.Args["meta"]; !reflect.DeepEqual(got, want) {
		t.Errorf("meta = %#v, want %#v", got, want)
	}
	// Invalid JSON is a usage error naming the value the way ops.js's
	// JSON.stringify did.
	_, err = ParseArgs(widgetOp(), []string{"acme/app", "--meta", "not json"})
	usageError(t, err, `argument "meta" must be JSON, got "not json"`)
}

func TestParseArgsHelpAndJSON(t *testing.T) {
	tests := []struct {
		name    string
		argv    []string
		help    bool
		json    bool
		wantErr string
	}{
		{"--help", []string{"acme/app", "--help"}, true, false, ""},
		{"-h", []string{"-h"}, true, false, ""},
		// Help wins immediately: later arguments are not even parsed.
		{"help stops parsing", []string{"--help", "junk"}, true, false, ""},
		{"--json", []string{"acme/app", "--json"}, false, true, ""},
		{"--json before --help keeps both", []string{"--json", "--help"}, true, true, ""},
		{"--json then a bad flag still errors", []string{"acme/app", "--json", "--nope"}, false, true, `unknown option "--nope" for kvarm widget deploy`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			parsed, err := ParseArgs(widgetOp(), tt.argv)
			if tt.wantErr != "" {
				usageError(t, err, tt.wantErr)
				return
			}
			if err != nil {
				t.Fatalf("ParseArgs error: %v", err)
			}
			if parsed.Help != tt.help || parsed.JSONOutput != tt.json {
				t.Errorf("Help/JSONOutput = %v/%v, want %v/%v", parsed.Help, parsed.JSONOutput, tt.help, tt.json)
			}
		})
	}
}

func TestParseArgsDoubleDash(t *testing.T) {
	// ops.js had no `--` terminator in parseOperationArgs either: a bare
	// "--" is just an option with an empty name, so it is an unknown option.
	_, err := ParseArgs(widgetOp(), []string{"--"})
	usageError(t, err, `unknown option "--" for kvarm widget deploy`)
}

func TestBuildRequest(t *testing.T) {
	t.Run("path, query and body split", func(t *testing.T) {
		built, err := BuildRequest(widgetOp(), map[string]any{
			"repo":       "acme/app",
			"baseBranch": "main",
			"limit":      int64(5),
			"force":      true,
			"meta":       map[string]any{"k": "v"},
		})
		if err != nil {
			t.Fatalf("BuildRequest error: %v", err)
		}
		if want := "/api/v1/repos/acme/app/widgets"; built.Path != want {
			t.Errorf("Path = %q, want %q", built.Path, want)
		}
		// url.Values.Encode sorts keys.
		if want := "baseBranch=main&force=true&limit=5"; built.Query != want {
			t.Errorf("Query = %q, want %q", built.Query, want)
		}
		if want := "/api/v1/repos/acme/app/widgets?baseBranch=main&force=true&limit=5"; built.Target() != want {
			t.Errorf("Target() = %q, want %q", built.Target(), want)
		}
		if !built.HasBody {
			t.Error("HasBody = false, want true (meta is a body parameter)")
		}
		if got, want := built.Body["meta"], map[string]any{"k": "v"}; !reflect.DeepEqual(got, want) {
			t.Errorf("Body[meta] = %#v, want %#v", got, want)
		}
	})

	t.Run("no query means no question mark", func(t *testing.T) {
		built, err := BuildRequest(widgetOp(), map[string]any{"repo": "acme/app"})
		if err != nil {
			t.Fatalf("BuildRequest error: %v", err)
		}
		if built.Query != "" || built.Target() != built.Path {
			t.Errorf("Query = %q, Target = %q, want empty and the bare path", built.Query, built.Target())
		}
	})

	t.Run("repo path parameter becomes two encoded segments", func(t *testing.T) {
		// Each half of owner/name is encoded on its own, exactly like
		// ops.js's s.split('/').map(encodeURIComponent).join('/'), so a
		// '%', '#' or '/' inside a half never leaks into the URL shape.
		built, err := BuildRequest(widgetOp(), map[string]any{"repo": "own%er/na#me"})
		if err != nil {
			t.Fatalf("BuildRequest error: %v", err)
		}
		if want := "/api/v1/repos/own%25er/na%23me/widgets"; built.Path != want {
			t.Errorf("Path = %q, want %q", built.Path, want)
		}
	})

	t.Run("query scalars render their value", func(t *testing.T) {
		built, err := BuildRequest(widgetOp(), map[string]any{
			"repo":  "acme/app",
			"limit": int64(7),
			"force": false,
		})
		if err != nil {
			t.Fatalf("BuildRequest error: %v", err)
		}
		if want := "force=false&limit=7"; built.Query != want {
			t.Errorf("Query = %q, want %q", built.Query, want)
		}
	})
}

func TestBuildRequestValidation(t *testing.T) {
	tests := []struct {
		name    string
		args    map[string]any
		wantErr string
	}{
		{
			"unknown argument",
			map[string]any{"nope": "x"},
			`unknown argument "nope" for deploy_widget`,
		},
		{
			"required missing",
			map[string]any{"limit": int64(1)},
			`argument "repo" is required (Repository as owner/name)`,
		},
		{
			"wrong type: string",
			map[string]any{"repo": "acme/app", "limit": "5"},
			`argument "limit" must be an integer`,
		},
		{
			"wrong type: integer",
			map[string]any{"repo": "acme/app", "baseBranch": int64(5)},
			`argument "baseBranch" must be a string`,
		},
		{
			"wrong type: boolean",
			map[string]any{"repo": "acme/app", "force": "true"},
			`argument "force" must be a boolean`,
		},
		{
			"wrong type: list",
			map[string]any{"repo": "acme/app", "tags": "a,b"},
			`argument "tags" must be a list of strings`,
		},
		{
			"empty required string",
			map[string]any{"repo": ""},
			`argument "repo" must be a non-empty string`,
		},
		{
			"repo shape enforced",
			map[string]any{"repo": "acme"},
			`argument "repo" must be a repository as owner/name`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := BuildRequest(widgetOp(), tt.args)
			usageError(t, err, tt.wantErr)
		})
	}
}

func TestBuildRequestEnum(t *testing.T) {
	op := &registry.Operation{
		Name: "list_widgets", Command: []string{"widget", "list"}, Method: "GET", Path: "/widgets",
		Params: []registry.Param{{Name: "state", Type: registry.TypeString, In: "query", Enum: []string{"open", "closed"}}},
	}
	if _, err := BuildRequest(op, map[string]any{"state": "open"}); err != nil {
		t.Fatalf("enum member accepted, got error: %v", err)
	}
	_, err := BuildRequest(op, map[string]any{"state": "bogus"})
	usageError(t, err, `argument "state" must be one of open, closed`)
}

func TestBuildRequestQueryLists(t *testing.T) {
	op := &registry.Operation{
		Name: "list_widgets", Command: []string{"widget", "list"}, Method: "GET", Path: "/widgets",
		Params: []registry.Param{
			{Name: "tags", Type: registry.TypeStrings, In: "query"},
			{Name: "paths", Type: registry.TypeStrings, In: "query", Literal: true},
		},
	}
	// A literal list repeats the parameter once per value; a normal list is
	// joined with commas, the way URLSearchParams.set joined them in JS.
	// (Go's query escaping keeps '~' raw where URLSearchParams sent %7E;
	// both decode identically server-side.)
	built, err := BuildRequest(op, map[string]any{
		"tags":  []string{"a", "b c"},
		"paths": []string{"x/y", "z"},
	})
	if err != nil {
		t.Fatalf("BuildRequest error: %v", err)
	}
	if want := "paths=x%2Fy&paths=z&tags=a%2Cb+c"; built.Query != want {
		t.Errorf("Query = %q, want %q", built.Query, want)
	}
}

func TestEncodeURIComponent(t *testing.T) {
	// JavaScript's encodeURIComponent leaves exactly A-Za-z0-9 and
	// - _ . ! ~ * ' ( ) unescaped and encodes everything else per UTF-8 byte.
	tests := []struct {
		in, want string
	}{
		{"", ""},
		{"abc-XYZ_019", "abc-XYZ_019"},
		{"a b", "a%20b"}, // spaces become %20, never '+'
		{"~", "~"},
		{"!", "!"},
		{"*", "*"},
		{"'", "'"},
		{"(", "("},
		{")", ")"},
		{".", "."},
		{"/", "%2F"},
		{"?", "%3F"},
		{":", "%3A"},
		{"@", "%40"},
		{"&", "%26"},
		{"=", "%3D"},
		{"+", "%2B"},
		{"$", "%24"},
		{",", "%2C"},
		{";", "%3B"},
		{"#", "%23"},
		{"héllo", "h%C3%A9llo"}, // UTF-8 bytes, one %XX per byte
	}
	for _, tt := range tests {
		if got := EncodeURIComponent(tt.in); got != tt.want {
			t.Errorf("EncodeURIComponent(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
	// Every encoding must be a valid %XX escape that decodes back to the
	// input, which is what the platform's URL router will do.
	for _, in := range []string{"hello world", "a~b!(c)", "acme/app", "héllo", "own%er"} {
		enc := EncodeURIComponent(in)
		dec, err := url.PathUnescape(enc)
		if err != nil {
			t.Fatalf("PathUnescape(%q): %v", enc, err)
		}
		if dec != in {
			t.Errorf("round trip: %q -> %q -> %q", in, enc, dec)
		}
	}
}

func TestSplitCommaDropsEmptyPieces(t *testing.T) {
	// ops.js: raw.split(',').filter(s => s.length > 0)
	tests := []struct {
		in   string
		want []string
	}{
		{"a", []string{"a"}},
		{"a,b", []string{"a", "b"}},
		{"a,,b", []string{"a", "b"}},
		{",", nil},
		{"", nil},
	}
	for _, tt := range tests {
		if got := splitComma(tt.in); !reflect.DeepEqual(got, tt.want) {
			t.Errorf("splitComma(%q) = %#v, want %#v", tt.in, got, tt.want)
		}
	}
}

func TestCommandWords(t *testing.T) {
	if got, want := commandWords(widgetOp()), "widget deploy"; got != want {
		t.Errorf("commandWords = %q, want %q", got, want)
	}
}
