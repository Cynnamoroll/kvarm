package ui

import (
	"bytes"
	"os"
	"testing"
)

func TestPad(t *testing.T) {
	tests := []struct {
		s    string
		w    int
		want string
	}{
		{"status", 10, "status    "},
		// Already wide enough: unchanged, never truncated.
		{"workspaces", 5, "workspaces"},
		{"", 3, "   "},
		// Width counts runes, not bytes, so a unicode word lines up.
		{"héllo", 6, "héllo "},
		{"日本", 4, "日本  "},
	}
	for _, tt := range tests {
		if got := Pad(tt.s, tt.w); got != tt.want {
			t.Errorf("Pad(%q, %d) = %q, want %q", tt.s, tt.w, got, tt.want)
		}
	}
}

func TestIndent(t *testing.T) {
	// Every non-empty line gains the prefix; empty lines stay empty so a
	// paragraph keeps its blank separators.
	if got, want := Indent("a\n\nb", "  "), "  a\n\n  b"; got != want {
		t.Errorf("Indent = %q, want %q", got, want)
	}
	if got, want := Indent("one", "> "), "> one"; got != want {
		t.Errorf("Indent = %q, want %q", got, want)
	}
}

func TestFirstSentence(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		// The boundary period is kept; the rest is dropped.
		{"Change sets of the repository, newest first. More detail here.", "Change sets of the repository, newest first."},
		{"No period at all", "No period at all"},
		{"", ""},
	}
	for _, tt := range tests {
		if got := FirstSentence(tt.in); got != tt.want {
			t.Errorf("FirstSentence(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestOutputIsPlainOffTerminal(t *testing.T) {
	var buf bytes.Buffer
	out := New(&buf)
	// A bytes.Buffer is not a terminal, so captured output stays plain and
	// machine-readable regardless of the environment.
	if out.Color() {
		t.Fatal("Color() = true for a non-terminal writer, want false")
	}
	for name, styled := range map[string]func(string) string{
		"Bold":    out.Bold,
		"Dim":     out.Dim,
		"Red":     out.Red,
		"Green":   out.Green,
		"Yellow":  out.Yellow,
		"Cyan":    out.Cyan,
		"Magenta": out.Magenta,
	} {
		if got := styled("x"); got != "x" {
			t.Errorf("%s(\"x\") = %q, want %q", name, got, "x")
		}
	}
	// Line skips empty strings so a screen never gains stray blank lines.
	out.Line("")
	if buf.Len() != 0 {
		t.Errorf("Line(\"\") wrote %d bytes, want 0", buf.Len())
	}
	out.Line("hello")
	if got, want := buf.String(), "hello\n"; got != want {
		t.Errorf("after Line = %q, want %q", got, want)
	}
	buf.Reset()
	out.Plain("n=%d", 3)
	if got, want := buf.String(), "n=3\n"; got != want {
		t.Errorf("Plain = %q, want %q", got, want)
	}
	buf.Reset()
	out.ErrorLine("boom")
	if got, want := buf.String(), "kvarm: boom\n"; got != want {
		t.Errorf("ErrorLine = %q, want %q", got, want)
	}
	buf.Reset()
	if n, err := out.Write([]byte("raw")); n != 3 || err != nil || buf.String() != "raw" {
		t.Errorf("Write = (%d, %v), buffer %q, want (3, nil), %q", n, err, buf.String(), "raw")
	}
}

func TestJSONColorizePlainWithoutColor(t *testing.T) {
	var buf bytes.Buffer
	doc := `{"key": "value", "n": 1, "yes": true, "no": null}`
	// A plain output gets the text back unchanged: callers may colorize
	// unconditionally.
	if got := JSONColorize(New(&buf), doc); got != doc {
		t.Errorf("JSONColorize = %q, want %q", got, doc)
	}
}

func TestJSONColorizeOnColoredOutput(t *testing.T) {
	// /dev/null is a character device, so ui.New treats it as a terminal
	// and color then depends on the environment only.
	t.Setenv("TERM", "xterm")
	t.Setenv("NO_COLOR", "")
	t.Setenv("CLICOLOR_FORCE", "")
	devNull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Skipf("cannot open %s: %v", os.DevNull, err)
	}
	defer devNull.Close()
	out := New(devNull)
	if !out.Color() {
		t.Fatal("Color() = false with TERM set and a character device, want true")
	}
	doc := `{"key":"value","n":1}`
	// Keys cyan, string values green, numbers magenta; punctuation untouched.
	want := "{\x1b[36m\"key\"\x1b[0m:\x1b[32m\"value\"\x1b[0m,\x1b[36m\"n\"\x1b[0m:\x1b[35m1\x1b[0m}"
	if got := JSONColorize(out, doc); got != want {
		t.Errorf("JSONColorize = %q, want %q", got, want)
	}
}

func TestSuggest(t *testing.T) {
	tests := []struct {
		name       string
		typed      string
		candidates []string
		want       []string
	}{
		{"exact match", "checkout", []string{"checkout", "runner"}, []string{"checkout"}},
		{"edit distance 1", "chckout", []string{"checkout", "runner", "status"}, []string{"checkout"}},
		{"edit distance 2 counts", "checkou", []string{"checkout", "runner", "status"}, []string{"checkout"}},
		{"edit distance 3 does not", "checkx", []string{"checkout"}, nil},
		{
			// A typed prefix keeps candidates whose edit distance is over 2:
			// dropping a tail is the most common typo.
			"prefix match",
			"che",
			[]string{"checkout", "runner"},
			[]string{"checkout"},
		},
		{
			// Closest first; distance ties break by name.
			"ordering closest first",
			"lis",
			[]string{"lost", "list", "last", "status"},
			[]string{"list", "last", "lost"},
		},
		{
			// A prefix match outranks a same-distance tie.
			"prefix ahead of distance ties",
			"lis",
			[]string{"lint", "list"},
			[]string{"list", "lint"},
		},
		{"no candidates", "zzzzzz", []string{"checkout", "runner"}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Suggest(tt.typed, tt.candidates)
			if len(got) != len(tt.want) {
				t.Fatalf("Suggest(%q, %v) = %v, want %v", tt.typed, tt.candidates, got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("Suggest(%q, %v)[%d] = %q, want %q", tt.typed, tt.candidates, i, got[i], tt.want[i])
				}
			}
		})
	}
}
