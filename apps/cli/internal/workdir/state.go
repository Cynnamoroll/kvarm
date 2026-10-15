package workdir

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// stateVersion is the manifest format this package writes and accepts.
const stateVersion = 2

// shaRe is the commit identity a state file must name.
var shaRe = regexp.MustCompile(`^[0-9a-f]{40}$`)

// RecordedState is the tree a slot recorded after its last successful
// materialize: the file list plus, per file, the git blob hash and normalized
// mode ("100644", "100755", "120000") that prove whether a job dirtied the
// workdir.
type RecordedState struct {
	SHA   string
	Files []string
	Blobs map[string]string
	Modes map[string]string
}

// Tree is the exact tracked tree of a work directory: the file list, sorted,
// with each path's blob hash and normalized mode.
type Tree struct {
	Files []string
	Blobs map[string]string
	Modes map[string]string
}

// stateFile is the manifest's JSON shape; the field order matches the JS
// writer's, so a state file stays comparable between the two CLIs.
type stateFile struct {
	Version int               `json:"version"`
	SHA     string            `json:"sha"`
	Files   []string          `json:"files"`
	Blobs   map[string]string `json:"blobs"`
	Modes   map[string]string `json:"modes"`
}

// ParseState reads a state manifest, validating everything a later warm sync
// relies on: the version, the commit sha, the file list, the per-file hash and
// mode entries, and every path — a path becomes a filesystem name under the
// workdir, so an unsafe one is refused here rather than acted on.
func ParseState(text []byte) (RecordedState, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(text, &fields); err != nil {
		return RecordedState{}, err
	}
	var version float64
	if fields == nil || json.Unmarshal(fields["version"], &version) != nil || version != stateVersion {
		return RecordedState{}, stateManifestErr()
	}
	var sha string
	if json.Unmarshal(fields["sha"], &sha) != nil || !shaRe.MatchString(sha) {
		return RecordedState{}, stateManifestErr()
	}
	var rawFiles []json.RawMessage
	if jsonKind(fields["files"]) != '[' || json.Unmarshal(fields["files"], &rawFiles) != nil {
		return RecordedState{}, stateManifestErr()
	}
	files := make([]string, 0, len(rawFiles))
	for _, raw := range rawFiles {
		path, ok := jsonString(raw)
		if !ok {
			// The JS asserted on the parsed value and printed it as JSON; a
			// non-string entry can only come from a tampered or foreign file.
			return RecordedState{}, unsafePathErr(strings.TrimSpace(string(raw)))
		}
		if err := assertSafePath(path); err != nil {
			return RecordedState{}, err
		}
		files = append(files, path)
	}
	var rawBlobs, rawModes map[string]json.RawMessage
	if jsonKind(fields["blobs"]) != '{' || json.Unmarshal(fields["blobs"], &rawBlobs) != nil {
		return RecordedState{}, stateManifestErr()
	}
	if jsonKind(fields["modes"]) != '{' || json.Unmarshal(fields["modes"], &rawModes) != nil {
		return RecordedState{}, stateManifestErr()
	}
	blobs := make(map[string]string, len(files))
	modes := make(map[string]string, len(files))
	for _, path := range files {
		hash, hasHash := jsonString(rawBlobs[path])
		mode, hasMode := jsonString(rawModes[path])
		if !hasHash || !hasMode {
			return RecordedState{}, fmt.Errorf("state file is missing the recorded entry for %s", jsonQuote(path))
		}
		blobs[path] = hash
		modes[path] = mode
	}
	return RecordedState{SHA: sha, Files: files, Blobs: blobs, Modes: modes}, nil
}

// WriteState records the tree in a manifest beside the work directory, written
// to a temp file and renamed so a reader never sees half of one.
func WriteState(path, sha string, tree Tree) error {
	files := tree.Files
	if files == nil {
		files = []string{}
	}
	blobs := tree.Blobs
	if blobs == nil {
		blobs = map[string]string{}
	}
	modes := tree.Modes
	if modes == nil {
		modes = map[string]string{}
	}
	body, err := json.Marshal(stateFile{Version: stateVersion, SHA: sha, Files: files, Blobs: blobs, Modes: modes})
	if err != nil {
		return err
	}
	tmp := path + "." + newUUID() + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		// removeTrash only knows `.trash-` names, so a stray temp here would
		// outlive every later job in the slot.
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// BlobHash is the git blob hash of these bytes: the identity the compare wire
// agrees on. sha1 is what git names an object by, not a security choice.
func BlobHash(data []byte) string {
	h := sha1.New()
	fmt.Fprintf(h, "blob %d\x00", len(data))
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

// NormalizedMode is the class a recorded mode belongs to: `120000` (symlink),
// `100755` (executable) and `100644` for everything else, the way a snapshot
// tarball collapses git's other file modes.
func NormalizedMode(mode string) string {
	switch mode {
	case "120000":
		return "120000"
	case "100755":
		return "100755"
	default:
		return "100644"
	}
}

// isTreeMode accepts both spellings: raw tree entries are never padded.
func isTreeMode(mode *string) bool {
	return mode != nil && (*mode == "40000" || *mode == "040000")
}

// isGitlink reports a submodule entry, which a snapshot checkout never holds.
func isGitlink(mode *string) bool {
	return mode != nil && *mode == "160000"
}

// assertSafePath refuses a path that could name anything but a file below the
// workdir: empty, absolute, or carrying an empty, `.` or `..` segment.
func assertSafePath(path string) error {
	if path == "" || filepath.IsAbs(path) || hasUnsafeSegment(path) {
		return unsafePathErr(jsonQuote(path))
	}
	return nil
}

func hasUnsafeSegment(path string) bool {
	for _, segment := range strings.Split(path, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return true
		}
	}
	return false
}

func unsafePathErr(label string) error {
	return fmt.Errorf("state lists an unsafe path: %s", label)
}

func stateManifestErr() error {
	return fmt.Errorf("state file is not a version %d manifest", stateVersion)
}

// jsonKind is a JSON value's first significant byte: '[' for an array, '{' for
// an object, '"' for a string, 'n' for null. An absent field is 0, which
// matches none of them, so a missing entry reads as the wrong shape.
func jsonKind(raw json.RawMessage) byte {
	trimmed := bytes.TrimLeft(raw, " \t\r\n")
	if len(trimmed) == 0 {
		return 0
	}
	return trimmed[0]
}

// jsonString reads a JSON string value, reporting false for any other shape.
func jsonString(raw json.RawMessage) (string, bool) {
	if jsonKind(raw) != '"' {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	return s, true
}

// jsonQuote renders a string the way the JS error messages did: JSON, with the
// characters JSON.stringify leaves alone left alone.
func jsonQuote(s string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s) // a string always encodes into a buffer
	return strings.TrimSuffix(buf.String(), "\n")
}
