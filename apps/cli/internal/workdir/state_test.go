package workdir

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Known git blob hashes: sha1("blob <len>\0" ++ bytes), the identity the
// compare wire agrees on.
const (
	helloWorldBlob = "3b18e512dba79e4c8300dd08aeb37f8e728b8dad"
	emptyBlob      = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
)

func TestWriteStateRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	files := []string{"a.txt", "link", "sub/b.txt"}
	blobs := map[string]string{
		"a.txt":     BlobHash([]byte("one\n")),
		"link":      BlobHash([]byte("a.txt")),
		"sub/b.txt": BlobHash([]byte("two\n")),
	}
	modes := map[string]string{"a.txt": "100644", "link": "120000", "sub/b.txt": "100755"}
	if err := WriteState(path, testSHA, Tree{Files: files, Blobs: blobs, Modes: modes}); err != nil {
		t.Fatalf("WriteState: %v", err)
	}

	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	// The field order matches the JS writer's, so the two manifests stay
	// comparable byte for byte.
	if !strings.HasPrefix(string(body), `{"version":2,"sha":"`+testSHA+`","files":[`) {
		t.Fatalf("manifest shape = %s", body)
	}
	state, err := ParseState(body)
	if err != nil {
		t.Fatalf("ParseState: %v", err)
	}
	if state.SHA != testSHA {
		t.Errorf("sha = %s, want %s", state.SHA, testSHA)
	}
	if !equalStrings(state.Files, files) {
		t.Errorf("files = %v, want %v", state.Files, files)
	}
	if !reflect.DeepEqual(state.Blobs, blobs) {
		t.Errorf("blobs = %v, want %v", state.Blobs, blobs)
	}
	if !reflect.DeepEqual(state.Modes, modes) {
		t.Errorf("modes = %v, want %v", state.Modes, modes)
	}
	// The write went through a temp file that no longer exists.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "state.json" {
		t.Fatalf("state directory holds %v, want just state.json", entries)
	}

	// A later write replaces the manifest whole.
	if err := WriteState(path, otherSHA, Tree{Files: []string{}, Blobs: map[string]string{}, Modes: map[string]string{}}); err != nil {
		t.Fatalf("WriteState: %v", err)
	}
	again := parseStateFile(t, path)
	if again.SHA != otherSHA || len(again.Files) != 0 {
		t.Fatalf("rewritten state = %+v, want %s with no files", again, otherSHA)
	}
}

func TestParseStateRejectsTamperedManifests(t *testing.T) {
	sha := `"` + testSHA + `"`
	cases := []struct {
		name string
		body string
		want string
	}{
		{
			name: "bad version",
			body: `{"version":1,"sha":` + sha + `,"files":[],"blobs":{},"modes":{}}`,
			want: "state file is not a version 2 manifest",
		},
		{
			name: "no version",
			body: `{"sha":` + sha + `,"files":[],"blobs":{},"modes":{}}`,
			want: "state file is not a version 2 manifest",
		},
		{
			name: "bad sha",
			body: `{"version":2,"sha":"not-a-sha","files":[],"blobs":{},"modes":{}}`,
			want: "state file is not a version 2 manifest",
		},
		{
			name: "uppercase sha",
			body: `{"version":2,"sha":"` + strings.ToUpper(testSHA) + `","files":[],"blobs":{},"modes":{}}`,
			want: "state file is not a version 2 manifest",
		},
		{
			name: "files not an array",
			body: `{"version":2,"sha":` + sha + `,"files":{},"blobs":{},"modes":{}}`,
			want: "state file is not a version 2 manifest",
		},
		{
			name: "files missing",
			body: `{"version":2,"sha":` + sha + `,"blobs":{},"modes":{}}`,
			want: "state file is not a version 2 manifest",
		},
		{
			name: "blobs missing",
			body: `{"version":2,"sha":` + sha + `,"files":[],"modes":{}}`,
			want: "state file is not a version 2 manifest",
		},
		{
			name: "blobs null",
			body: `{"version":2,"sha":` + sha + `,"files":[],"blobs":null,"modes":{}}`,
			want: "state file is not a version 2 manifest",
		},
		{
			name: "modes is an array",
			body: `{"version":2,"sha":` + sha + `,"files":[],"blobs":{},"modes":[]}`,
			want: "state file is not a version 2 manifest",
		},
		{
			name: "null manifest",
			body: `null`,
			want: "state file is not a version 2 manifest",
		},
		{
			name: "missing entry",
			body: `{"version":2,"sha":` + sha + `,"files":["a.txt"],"blobs":{},"modes":{"a.txt":"100644"}}`,
			want: `state file is missing the recorded entry for "a.txt"`,
		},
		{
			name: "entry is not a string",
			body: `{"version":2,"sha":` + sha + `,"files":["a.txt"],"blobs":{"a.txt":1},"modes":{"a.txt":"100644"}}`,
			want: `state file is missing the recorded entry for "a.txt"`,
		},
		{
			name: "parent path",
			body: `{"version":2,"sha":` + sha + `,"files":["../x"],"blobs":{"../x":"h"},"modes":{"../x":"100644"}}`,
			want: `state lists an unsafe path: "../x"`,
		},
		{
			name: "absolute path",
			body: `{"version":2,"sha":` + sha + `,"files":["/etc/passwd"],"blobs":{"/etc/passwd":"h"},"modes":{"/etc/passwd":"100644"}}`,
			want: `state lists an unsafe path: "/etc/passwd"`,
		},
		{
			name: "empty segment",
			body: `{"version":2,"sha":` + sha + `,"files":["a//b"],"blobs":{"a//b":"h"},"modes":{"a//b":"100644"}}`,
			want: `state lists an unsafe path: "a//b"`,
		},
		{
			name: "dot segment",
			body: `{"version":2,"sha":` + sha + `,"files":["a/./b"],"blobs":{"a/./b":"h"},"modes":{"a/./b":"100644"}}`,
			want: `state lists an unsafe path: "a/./b"`,
		},
		{
			name: "trailing segment",
			body: `{"version":2,"sha":` + sha + `,"files":["a/"],"blobs":{"a/":"h"},"modes":{"a/":"100644"}}`,
			want: `state lists an unsafe path: "a/"`,
		},
		{
			name: "empty path",
			body: `{"version":2,"sha":` + sha + `,"files":[""],"blobs":{"":"h"},"modes":{"":"100644"}}`,
			want: `state lists an unsafe path: ""`,
		},
		{
			name: "path is not a string",
			body: `{"version":2,"sha":` + sha + `,"files":[1],"blobs":{},"modes":{}}`,
			want: `state lists an unsafe path: 1`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseState([]byte(tc.body))
			if err == nil {
				t.Fatalf("ParseState accepted a tampered manifest: %s", tc.body)
			}
			if err.Error() != tc.want {
				t.Fatalf("ParseState(%s) = %q, want %q", tc.body, err, tc.want)
			}
		})
	}

	// Malformed JSON is the JSON parser's own error, as JSON.parse's was in JS.
	if _, err := ParseState([]byte("{")); err == nil {
		t.Fatal("ParseState accepted malformed JSON")
	}
}

func TestBlobHash(t *testing.T) {
	if got := BlobHash([]byte("hello world\n")); got != helloWorldBlob {
		t.Errorf("BlobHash(hello world) = %s, want %s", got, helloWorldBlob)
	}
	if got := BlobHash(nil); got != emptyBlob {
		t.Errorf("BlobHash(empty) = %s, want %s", got, emptyBlob)
	}

	git, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git is not installed; the hard-coded blob vectors above are all that can be checked")
	}
	dir := t.TempDir()
	for _, data := range [][]byte{[]byte("hello world\n"), nil, {0, 1, 2, 255}, []byte("no trailing newline")} {
		cmd := exec.Command(git, "hash-object", "--stdin")
		cmd.Dir = dir // hash-object --stdin needs no repository; stay out of this one
		cmd.Stdin = bytes.NewReader(data)
		out, err := cmd.Output()
		if err != nil {
			t.Skipf("git hash-object --stdin failed: %v", err)
		}
		if got, want := strings.TrimSpace(string(out)), BlobHash(data); got != want {
			t.Errorf("BlobHash(%q) = %s, git says %s", data, want, got)
		}
	}
}

func TestNormalizedMode(t *testing.T) {
	cases := map[string]string{
		"120000": "120000",
		"100755": "100755",
		"100644": "100644",
		"100664": "100644",
		"":       "100644",
	}
	for mode, want := range cases {
		if got := NormalizedMode(mode); got != want {
			t.Errorf("NormalizedMode(%q) = %q, want %q", mode, got, want)
		}
	}
}
