package workdir

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// manifestFor builds a delta manifest whose reader serves content and records
// every path it was asked for.
func manifestFor(changes []DeltaChange, content map[string][]byte) (DeltaManifest, *[]string) {
	reads := &[]string{}
	return DeltaManifest{
		SHA:     otherSHA,
		Source:  "delta",
		Changes: changes,
		Read: func(path string) ([]byte, error) {
			*reads = append(*reads, path)
			data, ok := content[path]
			if !ok {
				return nil, fmt.Errorf("the test delta holds no content for %q", path)
			}
			return data, nil
		},
	}, reads
}

func TestApplyDeltaUpdatesARecordedFile(t *testing.T) {
	work := t.TempDir()
	put(t, work, "a.txt", "before\n", 0o644)
	previous := recordDir(t, work)

	next := []byte("after\n")
	changes := []DeltaChange{{
		Path: "a.txt", Status: "modified",
		OldHash: str(previous.Blobs["a.txt"]), OldMode: str("100644"),
		NewHash: str(BlobHash(next)), NewMode: str("100644"),
	}}
	manifest, reads := manifestFor(changes, map[string][]byte{"a.txt": next})
	tree, err := ApplyDelta(work, previous, manifest)
	if err != nil {
		t.Fatalf("ApplyDelta: %v", err)
	}
	if got := readAt(t, work, "a.txt"); got != "after\n" {
		t.Errorf("a.txt = %q, want %q", got, "after\n")
	}
	if !equalStrings(tree.Files, []string{"a.txt"}) {
		t.Errorf("tree files = %v, want [a.txt]", tree.Files)
	}
	if tree.Blobs["a.txt"] != BlobHash(next) || tree.Modes["a.txt"] != "100644" {
		t.Errorf("tree entry = %s/%s, want %s/100644", tree.Blobs["a.txt"], tree.Modes["a.txt"], BlobHash(next))
	}
	if !equalStrings(*reads, []string{"a.txt"}) {
		t.Errorf("read %v, want [a.txt]", *reads)
	}
}

func TestApplyDeltaRefusesAMismatchedRecordedHash(t *testing.T) {
	work := t.TempDir()
	put(t, work, "a.txt", "before\n", 0o644)
	put(t, work, "old.txt", "content\n", 0o644)
	previous := recordDir(t, work)

	t.Run("modified", func(t *testing.T) {
		// The delta claims a base the recorded tree does not hold.
		changes := []DeltaChange{{
			Path: "a.txt", Status: "modified",
			OldHash: str(BlobHash([]byte("someone else's bytes\n"))), OldMode: str("100644"),
			NewHash: str(BlobHash([]byte("after\n"))), NewMode: str("100644"),
		}}
		manifest, _ := manifestFor(changes, map[string][]byte{"a.txt": []byte("after\n")})
		_, err := ApplyDelta(work, previous, manifest)
		want := `recorded "a.txt" does not match the delta base tree`
		if err == nil || err.Error() != want {
			t.Fatalf("ApplyDelta = %v, want %q", err, want)
		}
		if got := readAt(t, work, "a.txt"); got != "before\n" {
			t.Errorf("a refused delta wrote a.txt = %q", got)
		}
	})

	t.Run("renamed", func(t *testing.T) {
		changes := []DeltaChange{{
			Path: "new.txt", Status: "renamed", OldPath: str("old.txt"),
			OldHash: str(BlobHash([]byte("someone else's bytes\n"))), OldMode: str("100644"),
			NewHash: str(BlobHash([]byte("moved\n"))), NewMode: str("100644"),
		}}
		manifest, _ := manifestFor(changes, map[string][]byte{"new.txt": []byte("moved\n")})
		_, err := ApplyDelta(work, previous, manifest)
		want := `recorded "old.txt" does not match the delta base tree`
		if err == nil || err.Error() != want {
			t.Fatalf("ApplyDelta = %v, want %q", err, want)
		}
	})

	t.Run("rename of a path the base never held", func(t *testing.T) {
		// A submodule moving away is a rename whose old side was never on disk;
		// nothing recorded can disagree with it.
		changes := []DeltaChange{{
			Path: "new.txt", Status: "renamed", OldPath: str("was-a-gitlink"),
			OldHash: str("1111111111111111111111111111111111111111"), OldMode: str("100644"),
			NewHash: str(BlobHash([]byte("moved\n"))), NewMode: str("100644"),
		}}
		manifest, _ := manifestFor(changes, map[string][]byte{"new.txt": []byte("moved\n")})
		if _, err := ApplyDelta(work, previous, manifest); err != nil {
			t.Fatalf("ApplyDelta: %v", err)
		}
		if got := readAt(t, work, "new.txt"); got != "moved\n" {
			t.Errorf("new.txt = %q, want %q", got, "moved\n")
		}
	})
}

func TestApplyDeltaAddsAndRemovesFiles(t *testing.T) {
	work := t.TempDir()
	put(t, work, "keep.txt", "keep\n", 0o644)
	put(t, work, "gone/deep/old.txt", "old\n", 0o644)
	previous := recordDir(t, work)

	added := []byte("brand new\n")
	changes := []DeltaChange{
		{Path: "gone/deep/old.txt", Status: "removed", OldHash: str(previous.Blobs["gone/deep/old.txt"]), OldMode: str("100644")},
		{Path: "new/added.txt", Status: "added", NewHash: str(BlobHash(added)), NewMode: str("100644")},
	}
	manifest, reads := manifestFor(changes, map[string][]byte{"new/added.txt": added})
	tree, err := ApplyDelta(work, previous, manifest)
	if err != nil {
		t.Fatalf("ApplyDelta: %v", err)
	}
	if exists(underPath(work, "gone")) {
		t.Error("the emptied directory tree survived")
	}
	if got := readAt(t, work, "new/added.txt"); got != "brand new\n" {
		t.Errorf("new/added.txt = %q, want %q", got, "brand new\n")
	}
	if !equalStrings(tree.Files, []string{"keep.txt", "new/added.txt"}) {
		t.Errorf("tree files = %v, want [keep.txt new/added.txt]", tree.Files)
	}
	if !equalStrings(*reads, []string{"new/added.txt"}) {
		t.Errorf("read %v, want [new/added.txt]", *reads)
	}
}

func TestApplyDeltaRenamesAFile(t *testing.T) {
	work := t.TempDir()
	put(t, work, "old.txt", "content\n", 0o644)
	previous := recordDir(t, work)

	moved := []byte("renamed content\n")
	changes := []DeltaChange{{
		Path: "new.txt", Status: "renamed", OldPath: str("old.txt"),
		OldHash: str(previous.Blobs["old.txt"]), OldMode: str("100644"),
		NewHash: str(BlobHash(moved)), NewMode: str("100644"),
	}}
	manifest, reads := manifestFor(changes, map[string][]byte{"new.txt": moved})
	tree, err := ApplyDelta(work, previous, manifest)
	if err != nil {
		t.Fatalf("ApplyDelta: %v", err)
	}
	if exists(underPath(work, "old.txt")) {
		t.Error("the renamed source survived")
	}
	if got := readAt(t, work, "new.txt"); got != "renamed content\n" {
		t.Errorf("new.txt = %q, want %q", got, "renamed content\n")
	}
	if !equalStrings(tree.Files, []string{"new.txt"}) {
		t.Errorf("tree files = %v, want [new.txt]", tree.Files)
	}
	if !equalStrings(*reads, []string{"new.txt"}) {
		t.Errorf("read %v, want [new.txt]", *reads)
	}
}

func TestApplyDeltaRefusesTreeSides(t *testing.T) {
	work := t.TempDir()
	previous := recordDir(t, work)

	for _, tc := range []struct {
		name             string
		oldMode, newMode *string
	}{
		{"old side", str("40000"), str("100644")},
		{"new side", str("100644"), str("040000")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			changes := []DeltaChange{{
				Path: "swap", Status: "typechange",
				OldHash: str(BlobHash([]byte("x"))), OldMode: tc.oldMode,
				NewHash: str(BlobHash([]byte("y"))), NewMode: tc.newMode,
			}}
			manifest, _ := manifestFor(changes, map[string][]byte{"swap": []byte("y")})
			_, err := ApplyDelta(work, previous, manifest)
			want := `delta change for "swap" still carries a tree side`
			if err == nil || err.Error() != want {
				t.Fatalf("ApplyDelta = %v, want %q", err, want)
			}
		})
	}
}

func TestApplyDeltaSkipsGitlinks(t *testing.T) {
	work := t.TempDir()
	put(t, work, "keep.txt", "keep\n", 0o644)
	put(t, work, "sub.txt", "was a file\n", 0o644)
	previous := recordDir(t, work)

	changes := []DeltaChange{
		{Path: "added-sub", Status: "added", NewHash: str("1111111111111111111111111111111111111111"), NewMode: str("160000")},
		{Path: "gone-sub", Status: "removed", OldHash: str("2222222222222222222222222222222222222222"), OldMode: str("160000")},
		{
			Path: "sub.txt", Status: "typechange",
			OldHash: str(previous.Blobs["sub.txt"]), OldMode: str("100644"),
			NewHash: str("3333333333333333333333333333333333333333"), NewMode: str("160000"),
		},
	}
	manifest, reads := manifestFor(changes, nil)
	tree, err := ApplyDelta(work, previous, manifest)
	if err != nil {
		t.Fatalf("ApplyDelta: %v", err)
	}
	if !equalStrings(tree.Files, []string{"keep.txt"}) {
		t.Errorf("tree files = %v, want [keep.txt]", tree.Files)
	}
	if len(*reads) != 0 {
		t.Errorf("a gitlink was read: %v", *reads)
	}
	if exists(underPath(work, "added-sub")) {
		t.Error("a gitlink was materialized")
	}
	if exists(underPath(work, "sub.txt")) {
		t.Error("the file a gitlink replaced survived")
	}
}

func TestApplyDeltaDropsACloneFallbackGitDirectory(t *testing.T) {
	work := t.TempDir()
	put(t, work, "README.md", "v1\n", 0o644)
	put(t, work, ".git/config", "[core]\n", 0o644)
	previous := recordDir(t, work)
	if previous.Files[0] != ".git/config" {
		t.Fatalf("recorded files = %v, want the .git entry the clone left", previous.Files)
	}

	manifest, reads := manifestFor(nil, nil)
	tree, err := ApplyDelta(work, previous, manifest)
	if err != nil {
		t.Fatalf("ApplyDelta: %v", err)
	}
	if exists(underPath(work, ".git")) {
		t.Error(".git survived the warm sync")
	}
	if !equalStrings(tree.Files, []string{"README.md"}) {
		t.Errorf("tree files = %v, want [README.md]", tree.Files)
	}
	if len(*reads) != 0 {
		t.Errorf("read %v, want nothing", *reads)
	}
}

func TestApplyDeltaRestoresDirtyTrackedFiles(t *testing.T) {
	work := t.TempDir()
	put(t, work, "clean.txt", "recorded\n", 0o644)
	put(t, work, "kept.txt", "kept\n", 0o644)
	previous := recordDir(t, work)

	// The previous job dirtied a tracked file the delta does not mention.
	put(t, work, "clean.txt", "dirtied by the job\n", 0o644)

	manifest, reads := manifestFor(nil, map[string][]byte{"clean.txt": []byte("recorded\n")})
	tree, err := ApplyDelta(work, previous, manifest)
	if err != nil {
		t.Fatalf("ApplyDelta: %v", err)
	}
	if got := readAt(t, work, "clean.txt"); got != "recorded\n" {
		t.Errorf("clean.txt = %q, want the recorded bytes", got)
	}
	if got := readAt(t, work, "kept.txt"); got != "kept\n" {
		t.Errorf("kept.txt = %q, want %q", got, "kept\n")
	}
	if !equalStrings(*reads, []string{"clean.txt"}) {
		t.Errorf("read %v, want only the drifted file", *reads)
	}
	if !equalStrings(tree.Files, []string{"clean.txt", "kept.txt"}) {
		t.Errorf("tree files = %v", tree.Files)
	}
}

func TestApplyDeltaFixesModeDriftWithoutReading(t *testing.T) {
	work := t.TempDir()
	put(t, work, "run.sh", "#!/bin/sh\n", 0o755)
	previous := recordDir(t, work)
	if previous.Modes["run.sh"] != "100755" {
		t.Fatalf("recorded mode = %s, want 100755", previous.Modes["run.sh"])
	}
	// The job dropped the executable bit; the delta still touches the path.
	if err := os.Chmod(underPath(work, "run.sh"), 0o644); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	changes := []DeltaChange{{
		Path: "run.sh", Status: "modified",
		OldHash: str(previous.Blobs["run.sh"]), OldMode: str("100755"),
		NewHash: str(previous.Blobs["run.sh"]), NewMode: str("100755"),
	}}
	// The reader fails the test if it is called: the bytes already match.
	manifest, reads := manifestFor(changes, nil)
	tree, err := ApplyDelta(work, previous, manifest)
	if err != nil {
		t.Fatalf("ApplyDelta: %v", err)
	}
	info, err := os.Lstat(underPath(work, "run.sh"))
	if err != nil {
		t.Fatalf("lstat: %v", err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Errorf("run.sh mode = %v, want 0755", info.Mode().Perm())
	}
	if len(*reads) != 0 {
		t.Errorf("the mode fix re-read the file: %v", *reads)
	}
	if tree.Modes["run.sh"] != "100755" {
		t.Errorf("tree mode = %s, want 100755", tree.Modes["run.sh"])
	}
}

func TestApplyDeltaMaterializesSymlinks(t *testing.T) {
	work := t.TempDir()
	put(t, work, "becomes-link", "target.txt\n", 0o644)
	link(t, work, "becomes-file", "target.txt")
	put(t, work, "target.txt", "content\n", 0o644)
	previous := recordDir(t, work)
	if previous.Modes["becomes-link"] != "100644" || previous.Modes["becomes-file"] != "120000" {
		t.Fatalf("recorded modes = %v, want 100644 and 120000", previous.Modes)
	}

	linkTarget := []byte("target.txt")
	fileBytes := []byte("now a file\n")
	changes := []DeltaChange{
		{
			Path: "becomes-link", Status: "typechange",
			OldHash: str(previous.Blobs["becomes-link"]), OldMode: str("100644"),
			NewHash: str(BlobHash(linkTarget)), NewMode: str("120000"),
		},
		{
			Path: "becomes-file", Status: "typechange",
			OldHash: str(previous.Blobs["becomes-file"]), OldMode: str("120000"),
			NewHash: str(BlobHash(fileBytes)), NewMode: str("100644"),
		},
	}
	manifest, _ := manifestFor(changes, map[string][]byte{
		"becomes-link": linkTarget,
		"becomes-file": fileBytes,
	})
	tree, err := ApplyDelta(work, previous, manifest)
	if err != nil {
		t.Fatalf("ApplyDelta: %v", err)
	}
	target, err := os.Readlink(underPath(work, "becomes-link"))
	if err != nil || target != "target.txt" {
		t.Errorf("becomes-link = %q (%v), want a symlink to target.txt", target, err)
	}
	if got := readAt(t, work, "becomes-file"); got != "now a file\n" {
		t.Errorf("becomes-file = %q, want %q", got, "now a file\n")
	}
	if got := readAt(t, work, "target.txt"); got != "content\n" {
		t.Errorf("target.txt = %q, want %q", got, "content\n")
	}
	if tree.Modes["becomes-link"] != "120000" || tree.Modes["becomes-file"] != "100644" {
		t.Errorf("tree modes = %v", tree.Modes)
	}
}

func TestApplyDeltaSwapsFilesAndDirectories(t *testing.T) {
	work := t.TempDir()
	put(t, work, "swap", "a file\n", 0o644)
	put(t, work, "tree/inner.txt", "inner\n", 0o644)
	previous := recordDir(t, work)

	inner := []byte("now inside\n")
	fileBytes := []byte("now a file\n")
	changes := []DeltaChange{
		{Path: "swap", Status: "removed", OldHash: str(previous.Blobs["swap"]), OldMode: str("100644")},
		{Path: "swap/inner.txt", Status: "added", NewHash: str(BlobHash(inner)), NewMode: str("100644")},
		{Path: "tree/inner.txt", Status: "removed", OldHash: str(previous.Blobs["tree/inner.txt"]), OldMode: str("100644")},
		{Path: "tree", Status: "added", NewHash: str(BlobHash(fileBytes)), NewMode: str("100644")},
	}
	manifest, _ := manifestFor(changes, map[string][]byte{"swap/inner.txt": inner, "tree": fileBytes})
	tree, err := ApplyDelta(work, previous, manifest)
	if err != nil {
		t.Fatalf("ApplyDelta: %v", err)
	}
	if got := readAt(t, work, "swap/inner.txt"); got != "now inside\n" {
		t.Errorf("swap/inner.txt = %q, want %q", got, "now inside\n")
	}
	if got := readAt(t, work, "tree"); got != "now a file\n" {
		t.Errorf("tree = %q, want %q", got, "now a file\n")
	}
	if !equalStrings(tree.Files, []string{"swap/inner.txt", "tree"}) {
		t.Errorf("tree files = %v, want [swap/inner.txt tree]", tree.Files)
	}
}

func TestApplyDeltaPrunesUntrackedEntriesButKeepsCaches(t *testing.T) {
	work := t.TempDir()
	put(t, work, "keep.txt", "keep\n", 0o644)
	previous := recordDir(t, work)

	// The job leaves build output and strays, and installs caches at the top
	// level and below untracked directories of its own.
	put(t, work, "stray.log", "stray\n", 0o644)
	put(t, work, "dist/bundle.js", "stale\n", 0o644)
	put(t, work, "node_modules/dep/index.js", "installed\n", 0o644)
	put(t, work, "environments/python/.venv/bin/python", "venv\n", 0o755)
	put(t, work, "environments/python/stray.txt", "stray\n", 0o644)
	put(t, work, "tools/node_modules/x/index.js", "tool cache\n", 0o644)
	put(t, work, "tools/build/out.o", "stale\n", 0o644)
	if err := os.MkdirAll(underPath(work, "empty-dir"), 0o777); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	manifest, reads := manifestFor(nil, nil)
	tree, err := ApplyDelta(work, previous, manifest)
	if err != nil {
		t.Fatalf("ApplyDelta: %v", err)
	}
	if !equalStrings(tree.Files, []string{"keep.txt"}) {
		t.Errorf("tree files = %v, want [keep.txt]", tree.Files)
	}
	if len(*reads) != 0 {
		t.Errorf("read %v, want nothing", *reads)
	}
	for _, gone := range []string{"stray.log", "dist", "empty-dir", "environments/python/stray.txt", "tools/build"} {
		if exists(underPath(work, gone)) {
			t.Errorf("%s survived the prune", gone)
		}
	}
	kept := map[string]string{
		"node_modules/dep/index.js":            "installed\n",
		"environments/python/.venv/bin/python": "venv\n",
		"tools/node_modules/x/index.js":        "tool cache\n",
	}
	for name, content := range kept {
		if got := readAt(t, work, name); got != content {
			t.Errorf("%s = %q, want %q", name, got, content)
		}
	}
	// The ancestors of a kept cache stay beside the tracked tree.
	for _, dir := range []string{"environments", "environments/python", "tools"} {
		info, err := os.Lstat(underPath(work, dir))
		if err != nil || !info.IsDir() {
			t.Errorf("%s should be a directory (%v)", dir, err)
		}
	}
}

// A previous job can leave an untracked symlink exactly where the new tree
// tracks a directory. The parent must be repaired into a real directory before
// the leaf is inspected, chmodded or removed, or those calls act on whatever
// the link points at, outside the workdir.
func TestApplyDeltaNeverActsThroughASymlinkedParent(t *testing.T) {
	content := []byte("tracked file under an untracked cache symlink\n")
	cases := []struct {
		name        string
		outsideByte string
		outsideMode os.FileMode
	}{
		{"different bytes", "external bytes that differ\n", 0o644},
		{"matching bytes", string(content), 0o644},
		{"matching bytes, different mode", string(content), 0o755},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			work := t.TempDir()
			outside := t.TempDir()
			put(t, work, "main.txt", "main\n", 0o644)
			previous := recordDir(t, work)

			put(t, outside, "file.txt", tc.outsideByte, tc.outsideMode)
			put(t, outside, "sibling.txt", "external sibling\n", 0o644)
			if err := os.MkdirAll(underPath(work, "node_modules"), 0o777); err != nil {
				t.Fatalf("mkdir: %v", err)
			}
			if err := os.Symlink(outside, underPath(work, "node_modules/linked")); err != nil {
				t.Fatalf("symlink: %v", err)
			}

			// The new head tracks a file under that untracked cache symlink.
			changes := []DeltaChange{{
				Path: "node_modules/linked/file.txt", Status: "added",
				NewHash: str(BlobHash(content)), NewMode: str("100644"),
			}}
			manifest, _ := manifestFor(changes, map[string][]byte{"node_modules/linked/file.txt": content})
			tree, err := ApplyDelta(work, previous, manifest)
			if err != nil {
				t.Fatalf("ApplyDelta: %v", err)
			}
			if got := readAt(t, work, "node_modules/linked/file.txt"); got != string(content) {
				t.Errorf("linked file = %q, want %q", got, content)
			}
			info, err := os.Lstat(underPath(work, "node_modules/linked"))
			if err != nil || !info.IsDir() {
				t.Fatalf("the symlinked parent was not repaired into a directory (%v)", err)
			}
			// The external directory keeps its exact files, bytes and modes.
			if got := readAt(t, outside, "file.txt"); got != tc.outsideByte {
				t.Errorf("external file.txt = %q, want %q", got, tc.outsideByte)
			}
			info, err = os.Lstat(underPath(outside, "file.txt"))
			if err != nil || info.Mode().Perm() != tc.outsideMode {
				t.Errorf("external file.txt mode = %v (%v), want %v", info.Mode().Perm(), err, tc.outsideMode)
			}
			if got := readAt(t, outside, "sibling.txt"); got != "external sibling\n" {
				t.Errorf("external sibling.txt = %q", got)
			}
			if entries, err := os.ReadDir(outside); err != nil || len(entries) != 2 {
				t.Errorf("external directory holds %v (%v), want its two files", entries, err)
			}
			if !equalStrings(tree.Files, []string{"main.txt", "node_modules/linked/file.txt"}) {
				t.Errorf("tree files = %v", tree.Files)
			}
		})
	}
}

func TestApplyDeltaNeverRemovesThroughASymlinkedParent(t *testing.T) {
	work := t.TempDir()
	outside := t.TempDir()
	put(t, outside, "victim.txt", "external\n", 0o644)
	put(t, work, "main.txt", "main\n", 0o644)

	// A recorded tree that names a path below what is now an untracked symlink.
	previous := recordDir(t, work)
	previous.Files = append(previous.Files, "out/victim.txt")
	previous.Blobs["out/victim.txt"] = BlobHash([]byte("external\n"))
	previous.Modes["out/victim.txt"] = "100644"
	if err := os.Symlink(outside, underPath(work, "out")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	changes := []DeltaChange{{
		Path: "out/victim.txt", Status: "removed",
		OldHash: str(previous.Blobs["out/victim.txt"]), OldMode: str("100644"),
	}}
	manifest, reads := manifestFor(changes, nil)
	tree, err := ApplyDelta(work, previous, manifest)
	if err != nil {
		t.Fatalf("ApplyDelta: %v", err)
	}
	if got := readAt(t, outside, "victim.txt"); got != "external\n" {
		t.Fatalf("the removal followed a symlinked parent: victim.txt = %q", got)
	}
	if exists(underPath(work, "out")) {
		t.Error("the untracked symlink should have been unlinked as an entry")
	}
	if !equalStrings(tree.Files, []string{"main.txt"}) {
		t.Errorf("tree files = %v, want [main.txt]", tree.Files)
	}
	if len(*reads) != 0 {
		t.Errorf("read %v, want nothing", *reads)
	}
}

func TestApplyDeltaRejectsUnsafePaths(t *testing.T) {
	work := t.TempDir()
	previous := recordDir(t, work)
	cases := []struct {
		path    string
		oldPath *string
		want    string
	}{
		{"../escape", nil, `state lists an unsafe path: "../escape"`},
		{"/absolute", nil, `state lists an unsafe path: "/absolute"`},
		{"a/../../b", nil, `state lists an unsafe path: "a/../../b"`},
		{"ok.txt", str("../old"), `state lists an unsafe path: "../old"`},
	}
	for _, tc := range cases {
		changes := []DeltaChange{{
			Path: tc.path, Status: "added", OldPath: tc.oldPath,
			NewHash: str(BlobHash([]byte("x"))), NewMode: str("100644"),
		}}
		manifest, _ := manifestFor(changes, map[string][]byte{tc.path: []byte("x")})
		_, err := ApplyDelta(work, previous, manifest)
		if err == nil || err.Error() != tc.want {
			t.Errorf("ApplyDelta(%s) = %v, want %q", tc.path, err, tc.want)
		}
	}
}

func TestApplyDeltaRejectsMismatchedContent(t *testing.T) {
	work := t.TempDir()
	previous := recordDir(t, work)

	want := BlobHash([]byte("expected\n"))
	served := []byte("something else\n")
	changes := []DeltaChange{{
		Path: "a.txt", Status: "added",
		NewHash: str(want), NewMode: str("100644"),
	}}
	manifest, _ := manifestFor(changes, map[string][]byte{"a.txt": served})
	_, err := ApplyDelta(work, previous, manifest)
	wantErr := `delta content for "a.txt" hashed ` + BlobHash(served) + `, expected ` + want
	if err == nil || err.Error() != wantErr {
		t.Fatalf("ApplyDelta = %v, want %q", err, wantErr)
	}
}

func TestScanTreeRejectsVanishedAndOddEntries(t *testing.T) {
	work := t.TempDir()
	if _, err := scanTree(work, []string{"missing.txt"}); err == nil || err.Error() != "recorded file vanished: missing.txt" {
		t.Errorf("scanTree = %v, want the vanished-file error", err)
	}
	if err := os.MkdirAll(filepath.Join(work, "dir"), 0o777); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if _, err := scanTree(work, []string{"dir"}); err == nil || err.Error() != "recorded path is not a file or symlink: dir" {
		t.Errorf("scanTree = %v, want the not-a-file error", err)
	}
}
