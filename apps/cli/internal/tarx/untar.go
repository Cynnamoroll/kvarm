// Package tarx extracts snapshot ustar/pax streams without following archive links.
package tarx

import (
	"bytes"
	"fmt"
	"io"
	"math"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

const (
	DefaultMaxTarBytes    int64 = 1 << 30
	DefaultMaxEntries     int64 = 250000
	DefaultMaxHeaderBytes int64 = 1 << 20
	block                       = 512
	maxSafe               int64 = 1<<53 - 1
)

type TarError struct{ Message string }

func (e *TarError) Error() string { return e.Message }

func fail(format string, args ...any) error {
	return &TarError{Message: fmt.Sprintf(format, args...)}
}

// Budgets uses zero fields for defaults. To impose an explicit zero limit,
// set the corresponding Zero field; Go values cannot distinguish omitted zeros.
type Budgets struct {
	MaxBytes, MaxEntries, MaxHeaderBytes    int64
	ZeroBytes, ZeroEntries, ZeroHeaderBytes bool
}

type Counts struct {
	Files, Dirs, Symlinks int64
	Bytes                 int64
}

type byteReader struct {
	source     io.Reader
	max, total int64
}

func (r *byteReader) Read(p []byte) (int, error) {
	if r.total > r.max {
		return 0, fail("archive exceeds the %d-byte byte budget", r.max)
	}
	if len(p) == 0 {
		return 0, nil
	}
	// Probe at most one byte past the limit, including when draining.
	if int64(len(p)) > r.max-r.total+1 {
		p = p[:r.max-r.total+1]
	}
	n, err := r.source.Read(p)
	r.total += int64(n)
	if r.total > r.max {
		// Do not let ReadFull discard a budget error on a full final read.
		return n - 1, fail("archive exceeds the %d-byte byte budget", r.max)
	}
	return n, err
}

func (r *byteReader) take(w io.Writer, n int64) error {
	_, err := io.CopyN(w, r, n)
	if err == io.EOF || err == io.ErrUnexpectedEOF {
		return fail("unexpected end of archive")
	}
	return err
}

func (r *byteReader) read(n int64) ([]byte, error) {
	// Extended headers are budgeted before allocation.
	if n > r.max-r.total {
		return nil, fail("archive exceeds the %d-byte byte budget", r.max)
	}
	if n > int64(int(^uint(0)>>1)) {
		return nil, fail("bad entry size")
	}
	data := make([]byte, int(n))
	_, err := io.ReadFull(r, data)
	if err == io.EOF || err == io.ErrUnexpectedEOF {
		err = fail("unexpected end of archive")
	}
	return data, err
}

func (r *byteReader) drain() (int64, error) {
	_, err := io.Copy(io.Discard, r)
	return r.total, err
}

func cstr(data []byte) string {
	if i := bytes.IndexByte(data, 0); i >= 0 {
		data = data[:i]
	}
	return strings.ToValidUTF8(string(data), "\ufffd")
}

func octal(data []byte) (int64, error) {
	text := strings.TrimSpace(cstr(data))
	if text == "" {
		return 0, nil
	}
	for _, c := range text {
		if c < '0' || c > '7' {
			return 0, fail("bad numeric header field %q", text)
		}
	}
	n, err := strconv.ParseInt(text, 8, 64)
	if err != nil {
		return 0, fail("bad numeric header field %q", text)
	}
	return n, nil
}

// ParsePax parses byte-length-prefixed extended header records.
func ParsePax(data []byte) (map[string]string, error) {
	out := make(map[string]string)
	for len(data) > 0 {
		sp := bytes.IndexByte(data, ' ')
		if sp <= 0 {
			return nil, fail("bad pax record")
		}
		n, err := strconv.ParseInt(string(data[:sp]), 10, 64)
		if err != nil || n <= int64(sp+1) || n > int64(len(data)) || data[n-1] != '\n' {
			return nil, fail("bad pax record")
		}
		record := strings.ToValidUTF8(string(data[sp+1:n-1]), "\ufffd")
		if eq := strings.IndexByte(record, '='); eq > 0 {
			out[record[:eq]] = record[eq+1:]
		}
		data = data[n:]
	}
	return out, nil
}

// Platform makes Windows path validation testable on POSIX hosts.
type Platform struct {
	Separator byte
	IsAbs     func(string) bool
}

func Host() Platform {
	if runtime.GOOS == "windows" {
		return Windows()
	}
	return Platform{Separator: '/', IsAbs: path.IsAbs}
}

func Windows() Platform {
	return Platform{Separator: '\\', IsAbs: func(s string) bool {
		return strings.HasPrefix(s, "/") || strings.HasPrefix(s, "\\") ||
			(len(s) >= 3 && s[1] == ':' && (s[2] == '\\' || s[2] == '/'))
	}}
}

func clean(s string, p Platform) string {
	volume := ""
	unc := false
	if p.Separator == '\\' {
		s = strings.ReplaceAll(s, "\\", "/")
		if len(s) >= 2 && s[1] == ':' {
			volume, s = s[:2], s[2:]
		}
		unc = strings.HasPrefix(s, "//")
	}
	s = path.Clean(s)
	if p.Separator == '\\' {
		if unc {
			s = "/" + s
		}
		s = volume + s
		s = strings.ReplaceAll(s, "/", "\\")
	}
	return s
}

func inside(root, target string, sep byte) bool {
	return target == root || strings.HasPrefix(target, strings.TrimRight(root, string(sep))+string(sep))
}

// ArchiveTarget defaults to host rules; POSIX backslashes remain filename bytes.
func ArchiveTarget(raw, root string, platforms ...Platform) (string, error) {
	p := Host()
	if len(platforms) > 0 {
		p = platforms[0]
	}
	if strings.ContainsRune(raw, 0) {
		return "", fail("archive path contains NUL")
	}
	windows := p.Separator == '\\'
	drive := len(raw) >= 2 && raw[1] == ':' &&
		((raw[0] >= 'A' && raw[0] <= 'Z') || (raw[0] >= 'a' && raw[0] <= 'z'))
	if p.IsAbs(raw) || (windows && drive) {
		return "", fail("archive path is absolute: %s", raw)
	}
	split := raw
	if windows {
		split = strings.ReplaceAll(split, "\\", "/")
	}
	parts := strings.Split(split, "/")
	for len(parts) > 0 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	for len(parts) > 0 && parts[0] == "." {
		parts = parts[1:]
	}
	for _, part := range parts {
		if part == "" || part == ".." ||
			(windows && (strings.Contains(part, ":") ||
				(part != "." && strings.Trim(part, ". ") == ""))) {
			return "", fail("unsafe archive path: %s", raw)
		}
	}
	root = clean(root, p)
	target := root
	if len(parts) > 0 {
		target = clean(root+string(p.Separator)+strings.Join(parts, string(p.Separator)), p)
	}
	if !inside(root, target, p.Separator) {
		return "", fail("archive path escapes the destination: %s", raw)
	}
	return target, nil
}

type extraction struct {
	root  string
	dirs  map[string]bool
	files map[fileID]bool
}

func (x *extraction) ensureDir(dir string) error {
	if x.dirs[dir] {
		return nil
	}
	if !inside(x.root, dir, filepath.Separator) {
		return fail("directory escapes the destination: %s", dir)
	}
	if err := x.ensureDir(filepath.Dir(dir)); err != nil {
		return err
	}
	st, err := os.Lstat(dir)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err == nil && !st.IsDir() {
		rel, _ := filepath.Rel(x.root, dir)
		return fail("archive path is not a directory: %s", rel)
	}
	if os.IsNotExist(err) {
		if err := os.Mkdir(dir, 0755); err != nil {
			return err
		}
	}
	x.dirs[dir] = true
	return nil
}

func (x *extraction) openFile(target string, mode os.FileMode) (*os.File, error) {
	if target == x.root || !inside(x.root, target, filepath.Separator) {
		return nil, fail("file escapes the destination: %s", target)
	}
	f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if os.IsExist(err) {
		st, statErr := os.Lstat(target)
		if statErr != nil {
			return nil, statErr
		}
		if !st.Mode().IsRegular() || !x.files[identity(target, st)] {
			rel, _ := filepath.Rel(x.root, target)
			return nil, fail("archive path already exists: %s", rel)
		}
		f, err = os.OpenFile(target, os.O_WRONLY|os.O_TRUNC|noFollow, 0)
	}
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	x.files[identity(target, st)] = true
	return f, nil
}

// Extract creates symlinks last so archive entries cannot write through them.
func Extract(source io.Reader, dest string, budgets Budgets) (Counts, error) {
	var counts Counts
	limits := []struct {
		name  string
		value *int64
		def   int64
		zero  bool
	}{
		{"maxBytes", &budgets.MaxBytes, DefaultMaxTarBytes, budgets.ZeroBytes},
		{"maxEntries", &budgets.MaxEntries, DefaultMaxEntries, budgets.ZeroEntries},
		{"maxHeaderBytes", &budgets.MaxHeaderBytes, DefaultMaxHeaderBytes, budgets.ZeroHeaderBytes},
	}
	for _, limit := range limits {
		if *limit.value < 0 || *limit.value > maxSafe {
			return counts, fail("%s must be a non-negative safe integer", limit.name)
		}
		if *limit.value == 0 && !limit.zero {
			*limit.value = limit.def
		}
	}
	if err := os.MkdirAll(dest, 0755); err != nil {
		return counts, err
	}
	root, err := filepath.EvalSymlinks(dest)
	if err != nil {
		return counts, err
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return counts, err
	}
	x := extraction{root: root, dirs: map[string]bool{root: true}, files: make(map[fileID]bool)}
	reader := byteReader{source: source, max: budgets.MaxBytes}
	type link struct{ path, target string }
	var links []link
	var pax map[string]string
	var longName *string
	var entries, headerBytes int64
	for {
		h, err := reader.read(block)
		if err != nil {
			return counts, err
		}
		if bytes.Equal(h, make([]byte, block)) {
			break
		}
		entries++
		if entries > budgets.MaxEntries {
			return counts, fail("archive exceeds the %d-entry entry budget", budgets.MaxEntries)
		}
		want, err := octal(h[148:156])
		if err != nil {
			return counts, err
		}
		var sum int64
		for i, b := range h {
			if i >= 148 && i < 156 {
				b = ' '
			}
			sum += int64(b)
		}
		if sum != want {
			return counts, fail("bad header checksum")
		}
		kind := h[156]
		size, err := octal(h[124:136])
		if err != nil {
			return counts, err
		}
		if value, ok := pax["size"]; ok {
			n, parseErr := strconv.ParseFloat(strings.TrimSpace(value), 64)
			if parseErr != nil || math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n > float64(maxSafe) || math.Trunc(n) != n {
				return counts, fail("bad entry size")
			}
			size = int64(n)
		}
		if size < 0 || size > maxSafe {
			return counts, fail("bad entry size")
		}
		padded := size + (block-size%block)%block
		if padded > maxSafe {
			return counts, fail("bad entry size")
		}
		if kind == 'x' || kind == 'g' || kind == 'L' {
			headerBytes += padded
			if headerBytes > budgets.MaxHeaderBytes {
				return counts, fail("archive exceeds the %d-byte extended-header budget", budgets.MaxHeaderBytes)
			}
			data, err := reader.read(padded)
			if err != nil {
				return counts, err
			}
			if kind == 'x' {
				pax, err = ParsePax(data[:size])
				if err != nil {
					return counts, err
				}
			}
			if kind == 'L' {
				name := cstr(data[:size])
				longName = &name
			}
			continue
		}
		raw := cstr(h[:100])
		if cstr(h[257:263]) == "ustar" {
			if prefix := cstr(h[345:500]); prefix != "" {
				raw = prefix + "/" + raw
			}
		}
		if longName != nil {
			raw = *longName
		}
		if value, ok := pax["path"]; ok {
			raw = value
		}
		linkname := cstr(h[157:257])
		if value, ok := pax["linkpath"]; ok {
			linkname = value
		}
		mode, err := octal(h[100:108])
		if err != nil {
			return counts, err
		}
		pax, longName = nil, nil
		target, err := ArchiveTarget(raw, root)
		if err != nil {
			return counts, err
		}
		switch kind {
		case '0', 0, '7':
			if target == root {
				return counts, fail("file entry without a name")
			}
			if err := x.ensureDir(filepath.Dir(target)); err != nil {
				return counts, err
			}
			mode &= 0777
			if mode == 0 {
				mode = 0644
			}
			f, err := x.openFile(target, os.FileMode(mode))
			if err != nil {
				return counts, err
			}
			writeErr := reader.take(f, size)
			// The non-Unix identity surrogate includes the completed file size.
			st, statErr := f.Stat()
			if statErr == nil {
				x.files[identity(target, st)] = true
			}
			closeErr := f.Close()
			if writeErr != nil {
				return counts, writeErr
			}
			if statErr != nil {
				return counts, statErr
			}
			if closeErr != nil {
				return counts, closeErr
			}
			if err := reader.take(io.Discard, padded-size); err != nil {
				return counts, err
			}
			counts.Files++
		case '5':
			if err := x.ensureDir(target); err != nil {
				return counts, err
			}
			if err := reader.take(io.Discard, padded); err != nil {
				return counts, err
			}
			counts.Dirs++
		case '2':
			if target == root {
				return counts, fail("symlink entry without a name")
			}
			links = append(links, link{target, linkname})
			if err := reader.take(io.Discard, padded); err != nil {
				return counts, err
			}
		default:
			return counts, fail("unsupported tar entry type %q for %s", string(kind), raw)
		}
	}
	for _, link := range links {
		parent := filepath.Dir(link.path)
		if err := x.ensureDir(parent); err != nil {
			return counts, err
		}
		real, err := filepath.EvalSymlinks(parent)
		if err != nil {
			return counts, err
		}
		if !inside(root, real, filepath.Separator) {
			return counts, fail("symlink escapes the destination: %s", link.path)
		}
		if _, err := os.Lstat(link.path); err == nil {
			rel, _ := filepath.Rel(root, link.path)
			return counts, fail("symlink path already exists: %s", rel)
		} else if !os.IsNotExist(err) {
			return counts, err
		}
		if err := os.Symlink(link.target, link.path); err != nil {
			return counts, err
		}
		counts.Symlinks++
	}
	counts.Bytes, err = reader.drain()
	return counts, err
}
