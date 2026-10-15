package workdir

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// DeltaChange is one changed path on the compare wire, as the platform reports
// it. A nil field is a JSON null, meaning an absent side of the change.
type DeltaChange struct {
	Path    string
	Status  string // added|removed|modified|renamed|typechange
	OldHash *string
	NewHash *string
	OldMode *string
	NewMode *string
	OldPath *string // set on a rename, absent otherwise
}

// DeltaManifest is the fetched difference between the recorded commit and the
// new head, with a lazy byte reader for every path the new tree holds.
type DeltaManifest struct {
	SHA     string
	Source  string // "delta", or the checkout source when the delta came from one
	Changes []DeltaChange
	Read    func(path string) ([]byte, error)
}

// deltaEntry is one path's content identity in the new tree.
type deltaEntry struct {
	hash string
	mode string
}

// ApplyDelta applies the fetched manifest to the work directory and returns
// the exact tracked tree the new commit holds. The recorded hashes prove which
// files a previous job dirtied; those are restored even when the delta does
// not mention them, so the result stays byte-equal to a fresh snapshot
// checkout.
func ApplyDelta(work string, previous RecordedState, manifest DeltaManifest) (Tree, error) {
	keep := make(map[string]deltaEntry, len(previous.Files))
	for _, path := range previous.Files {
		keep[path] = deltaEntry{hash: previous.Blobs[path], mode: previous.Modes[path]}
	}
	remove := make(map[string]bool)
	writes := make(map[string]deltaEntry)

	for _, change := range manifest.Changes {
		if err := assertSafePath(change.Path); err != nil {
			return Tree{}, err
		}
		if change.OldPath != nil {
			if err := assertSafePath(*change.OldPath); err != nil {
				return Tree{}, err
			}
		}
		if isTreeMode(change.OldMode) || isTreeMode(change.NewMode) {
			return Tree{}, fmt.Errorf("delta change for %s still carries a tree side", jsonQuote(change.Path))
		}
		// A gitlink (submodule) never appears in a snapshot checkout: the new
		// side is not materialized and the old side never existed on disk.
		oldBlob := change.OldHash != nil && !isGitlink(change.OldMode)
		newBlob := change.NewHash != nil && !isGitlink(change.NewMode)
		if change.OldPath != nil {
			recorded, ok := keep[*change.OldPath]
			if ok && oldBlob && recorded.hash != *change.OldHash {
				return Tree{}, fmt.Errorf("recorded %s does not match the delta base tree", jsonQuote(*change.OldPath))
			}
			delete(keep, *change.OldPath)
			if oldBlob {
				remove[*change.OldPath] = true
			}
		} else if oldBlob {
			recorded, ok := keep[change.Path]
			if !ok || recorded.hash != *change.OldHash {
				return Tree{}, fmt.Errorf("recorded %s does not match the delta base tree", jsonQuote(change.Path))
			}
		}
		if newBlob {
			entry := deltaEntry{hash: *change.NewHash, mode: NormalizedMode(stringOr(change.NewMode))}
			keep[change.Path] = entry
			writes[change.Path] = entry
		} else if change.OldPath == nil {
			delete(keep, change.Path)
			if oldBlob {
				remove[change.Path] = true
			}
		}
	}

	// A clone fallback checked out `.git`; a snapshot tree never has it.
	for _, path := range previous.Files {
		if path == ".git" || strings.HasPrefix(path, ".git/") {
			delete(keep, path)
			remove[path] = true
		}
	}

	// The ancestor directories of the new tree decide which empty directories
	// may go.
	dirs := make(map[string]bool)
	for path := range keep {
		parts := splitPath(path)
		for i := 1; i < len(parts); i++ {
			dirs[strings.Join(parts[:i], "/")] = true
		}
	}

	for _, path := range sortedKeys(remove) {
		if _, tracked := keep[path]; tracked {
			continue
		}
		parts := splitPath(path)
		real, err := realParents(work, parts)
		if err != nil {
			return Tree{}, err
		}
		if !real {
			continue
		}
		if err := os.RemoveAll(underPath(work, path)); err != nil {
			return Tree{}, err
		}
		for i := len(parts) - 1; i > 0; i-- {
			if dirs[strings.Join(parts[:i], "/")] {
				break
			}
			if err := os.Remove(underPath(work, strings.Join(parts[:i], "/"))); err != nil {
				break // not empty, or already gone: the new tree still needs it
			}
		}
	}

	if err := prune(work, "", keep, dirs); err != nil {
		return Tree{}, err
	}
	// Files the delta did not mention are restored first: the recorded hash
	// says a job dirtied them, and their bytes come from the new head like any
	// other write.
	for _, path := range sortedKeys(keep) {
		if _, written := writes[path]; written {
			continue
		}
		if err := materializeEntry(work, path, keep[path], manifest.Read); err != nil {
			return Tree{}, err
		}
	}
	for _, path := range sortedKeys(writes) {
		if err := materializeEntry(work, path, writes[path], manifest.Read); err != nil {
			return Tree{}, err
		}
	}

	files := sortedKeys(keep)
	blobs := make(map[string]string, len(files))
	modes := make(map[string]string, len(files))
	for _, path := range files {
		blobs[path] = keep[path].hash
		modes[path] = keep[path].mode
	}
	return Tree{Files: files, Blobs: blobs, Modes: modes}, nil
}

// prune removes everything under work that the new tree does not hold. An
// untracked directory loses its contents recursively, an untracked file is
// unlinked, and a directory the new tree needs is walked into. rel is the
// '/'-separated path of work itself for the top call.
func prune(work, rel string, keep map[string]deltaEntry, dirs map[string]bool) error {
	dir := work
	if rel != "" {
		dir = filepath.Join(work, filepath.FromSlash(rel))
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if CacheDirs[entry.Name()] {
			continue
		}
		path := entry.Name()
		if rel != "" {
			path = rel + "/" + entry.Name()
		}
		full := filepath.Join(dir, entry.Name())
		if entry.IsDir() {
			if dirs[path] {
				if err := prune(work, path, keep, dirs); err != nil {
					return err
				}
				continue
			}
			if _, err := pruneUntracked(full); err != nil {
				return err
			}
			continue
		}
		if _, tracked := keep[path]; !tracked {
			if err := os.Remove(full); err != nil {
				return err
			}
		}
	}
	return nil
}

// pruneUntracked empties an untracked directory except for dependency caches
// nested at any depth below it, and removes the directory when nothing was
// kept. It reports whether a cache was kept below dir. Entries come from
// ReadDir, which reports a symlink as a symlink, so a link is unlinked and
// never followed.
func pruneUntracked(dir string) (bool, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false, err
	}
	kept := false
	for _, entry := range entries {
		full := filepath.Join(dir, entry.Name())
		switch {
		case CacheDirs[entry.Name()]:
			kept = true
		case entry.IsDir():
			nested, err := pruneUntracked(full)
			if err != nil {
				return false, err
			}
			kept = nested || kept
		default:
			if err := os.Remove(full); err != nil {
				return false, err
			}
		}
	}
	if !kept {
		// Everything below is gone — a nested cache would have set kept — so
		// the directory itself goes too.
		if err := os.Remove(dir); err != nil {
			return false, err
		}
	}
	return kept, nil
}

// prepareParents creates every parent directory of parts below work, refusing
// non-directories: a file or symlink in the way is removed first, so an entry
// is never written through a link out of the workdir.
func prepareParents(work string, parts []string) error {
	ready := make(map[string]bool)
	dir := work
	for i := 0; i < len(parts)-1; i++ {
		dir = filepath.Join(dir, parts[i])
		rel := strings.Join(parts[:i+1], "/")
		if ready[rel] {
			continue
		}
		info, err := lstatOrNull(dir)
		if err != nil {
			return err
		}
		if info != nil && !info.IsDir() {
			if err := os.Remove(dir); err != nil {
				return err
			}
		}
		if info == nil || !info.IsDir() {
			if err := os.Mkdir(dir, 0o777); err != nil {
				return err
			}
		}
		ready[rel] = true
	}
	return nil
}

// realParents reports whether every ancestor of parts below root is a real
// directory, never a symlink, so acting on the leaf cannot reach outside the
// workdir.
func realParents(root string, parts []string) (bool, error) {
	dir := root
	for _, part := range parts[:len(parts)-1] {
		dir = filepath.Join(dir, part)
		info, err := lstatOrNull(dir)
		if err != nil {
			return false, err
		}
		if info == nil || !info.IsDir() {
			return false, nil
		}
	}
	return true, nil
}

// scanTree records the exact tree work holds after a checkout, so the next
// warm sync can prove file-for-file whether a job dirtied it.
func scanTree(work string, files []string) (Tree, error) {
	blobs := make(map[string]string, len(files))
	modes := make(map[string]string, len(files))
	for _, path := range files {
		full := underPath(work, path)
		info, err := lstatOrNull(full)
		if err != nil {
			return Tree{}, err
		}
		switch {
		case info == nil:
			return Tree{}, fmt.Errorf("recorded file vanished: %s", path)
		case info.Mode()&os.ModeSymlink != 0:
			target, err := os.Readlink(full)
			if err != nil {
				return Tree{}, err
			}
			blobs[path] = BlobHash([]byte(target))
			modes[path] = "120000"
		case info.Mode().IsRegular():
			content, err := os.ReadFile(full)
			if err != nil {
				return Tree{}, err
			}
			blobs[path] = BlobHash(content)
			if info.Mode().Perm()&0o111 != 0 {
				modes[path] = "100755"
			} else {
				modes[path] = "100644"
			}
		default:
			return Tree{}, fmt.Errorf("recorded path is not a file or symlink: %s", path)
		}
	}
	return Tree{Files: files, Blobs: blobs, Modes: modes}, nil
}

// localEntry is what the work directory holds at one path right now.
type localEntry struct {
	kind       string // file | symlink | other
	hash       string // blob hash of the bytes, or of a symlink's target
	executable bool
}

// inspectLocal reports the entry at path, or nil when it is missing.
func inspectLocal(work, path string) (*localEntry, error) {
	full := underPath(work, path)
	info, err := lstatOrNull(full)
	if err != nil {
		return nil, err
	}
	switch {
	case info == nil:
		return nil, nil
	case info.Mode()&os.ModeSymlink != 0:
		target, err := os.Readlink(full)
		if err != nil {
			return nil, err
		}
		return &localEntry{kind: "symlink", hash: BlobHash([]byte(target))}, nil
	case info.Mode().IsRegular():
		content, err := os.ReadFile(full)
		if err != nil {
			return nil, err
		}
		return &localEntry{kind: "file", hash: BlobHash(content), executable: info.Mode().Perm()&0o111 != 0}, nil
	default:
		return &localEntry{kind: "other"}, nil
	}
}

// materializeEntry makes work hold exactly one entry: bytes are fetched through
// read only when they differ, and a drifted mode is fixed in place, restoring
// content, type and executable bit a job may have dirtied.
func materializeEntry(work, path string, want deltaEntry, read func(path string) ([]byte, error)) error {
	parts := splitPath(path)
	// Parents are repaired before the leaf is inspected, chmodded or removed:
	// through a symlinked parent those calls would act outside the workdir.
	if err := prepareParents(work, parts); err != nil {
		return err
	}
	local, err := inspectLocal(work, path)
	if err != nil {
		return err
	}
	wantSymlink := want.mode == "120000"
	sameKind := local != nil && local.kind == entryKind(wantSymlink)
	sameBytes := sameKind && local.hash == want.hash
	if sameBytes && (wantSymlink || (want.mode == "100755") == local.executable) {
		return nil
	}
	dest := underPath(work, path)
	if sameBytes {
		return os.Chmod(dest, modePerm(want.mode))
	}
	data, err := read(path)
	if err != nil {
		return err
	}
	if got := BlobHash(data); got != want.hash {
		return fmt.Errorf("delta content for %s hashed %s, expected %s", jsonQuote(path), got, want.hash)
	}
	if local != nil {
		// Recursive, so both directions of a file ↔ directory transition land.
		if err := os.RemoveAll(dest); err != nil {
			return err
		}
	}
	if wantSymlink {
		return os.Symlink(string(data), dest)
	}
	if err := os.WriteFile(dest, data, 0o666); err != nil {
		return err
	}
	return os.Chmod(dest, modePerm(want.mode))
}

// entryKind is the local entry kind one recorded mode materializes as.
func entryKind(symlink bool) string {
	if symlink {
		return "symlink"
	}
	return "file"
}

// modePerm is the permission bits a recorded mode materializes as.
func modePerm(mode string) os.FileMode {
	if mode == "100755" {
		return 0o755
	}
	return 0o644
}

// splitPath splits a recorded '/'-separated path into its safe segments.
func splitPath(path string) []string {
	return strings.Split(path, "/")
}

// underPath is the filesystem path of a recorded '/'-separated path below
// root. The segments are joined here because filepath.Join takes only its own
// variadic elements, not a slice beside a first argument.
func underPath(root, path string) string {
	return filepath.Join(root, filepath.FromSlash(path))
}

// stringOr is a wire field's value, with "" for a JSON null; NormalizedMode
// then reads the null like the JS did.
func stringOr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// sortedKeys returns a map's keys in lexical order: Go map iteration is
// random, and the removal walk and the materialize order are easier to reason
// about, and to reproduce from a bug report, when they are fixed.
func sortedKeys[T any](m map[string]T) []string {
	out := make([]string, 0, len(m))
	for key := range m {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}
