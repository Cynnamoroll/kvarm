package tarx

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type entry struct {
	name, prefix, link string
	kind               byte
	mode               int64
	data               []byte
	size               *int64
}

func checksum(h []byte) {
	for i := 148; i < 156; i++ {
		h[i] = ' '
	}
	sum := 0
	for _, b := range h {
		sum += int(b)
	}
	copy(h[148:156], fmt.Sprintf("%06o\x00 ", sum))
}

func tarEntry(e entry) []byte {
	h := make([]byte, block)
	copy(h[:100], e.name)
	copy(h[100:108], fmt.Sprintf("%07o", e.mode))
	size := int64(len(e.data))
	if e.size != nil {
		size = *e.size
	}
	copy(h[124:136], fmt.Sprintf("%011o", size))
	h[156] = e.kind
	copy(h[157:257], e.link)
	copy(h[257:263], "ustar\x00")
	copy(h[345:500], e.prefix)
	checksum(h)
	h = append(h, e.data...)
	return append(h, make([]byte, (block-len(e.data)%block)%block)...)
}

func archive(entries ...entry) []byte {
	var out []byte
	for _, e := range entries {
		out = append(out, tarEntry(e)...)
	}
	return append(out, make([]byte, 2*block)...)
}

func file(name, data string) entry {
	return entry{name: name, kind: '0', mode: 0644, data: []byte(data)}
}

func paxRecord(key, value string) []byte {
	body := " " + key + "=" + value + "\n"
	n := len(body) + 1
	for {
		text := fmt.Sprint(n) + body
		if len(text) == n {
			return []byte(text)
		}
		n = len(text)
	}
}

func wantError(t *testing.T, err error, contains string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), contains) {
		t.Fatalf("error = %v, want %q", err, contains)
	}
}

func TestParsePax(t *testing.T) {
	data := append(paxRecord("path", "dir/日本.txt"), paxRecord("size", "513")...)
	data = append(data, paxRecord("path", "last")...)
	got, err := ParsePax(data)
	if err != nil || got["path"] != "last" || got["size"] != "513" {
		t.Fatalf("ParsePax = %v, %v", got, err)
	}
	for _, bad := range []string{"n path=x\n", "99 path=x\n", "0 path=x\n", "-1 x=y\n", "2 x=y\n", "7 x=y!", "123", "1"} {
		t.Run(bad, func(t *testing.T) {
			_, err := ParsePax([]byte(bad))
			wantError(t, err, "bad pax record")
		})
	}
	got, err = ParsePax(paxRecord("", "ignored"))
	if err != nil || len(got) != 0 {
		t.Fatalf("empty key = %v, %v", got, err)
	}
}

func TestArchiveTarget(t *testing.T) {
	posix := Platform{Separator: '/', IsAbs: func(s string) bool { return strings.HasPrefix(s, "/") }}
	for raw, want := range map[string]string{
		`a\b.txt`: `/root/a\b.txt`, `..\literal.txt`: `/root/..\literal.txt`,
		"./x": "/root/x", "日本/é": "/root/日本/é", "./": "/root", "a/./b/": "/root/a/b",
		"C:notes": "/root/C:notes", "": "/root",
	} {
		got, err := ArchiveTarget(raw, "/root", posix)
		if err != nil || got != want {
			t.Errorf("%q = %q, %v; want %q", raw, got, err, want)
		}
	}
	for _, raw := range []string{"/abs", "../x", "a/../b", "a//b", "a\x00b"} {
		if _, err := ArchiveTarget(raw, "/root", posix); err == nil {
			t.Errorf("accepted %q", raw)
		}
	}
	for raw, want := range map[string]string{
		`a\b`: `C:\root\a\b`, `a/b\c`: `C:\root\a\b\c`, `.\a\`: `C:\root\a`,
		`..foo\bar..txt`: `C:\root\..foo\bar..txt`,
	} {
		got, err := ArchiveTarget(raw, `C:\root`, Windows())
		if err != nil || got != want {
			t.Errorf("%q = %q, %v; want %q", raw, got, err, want)
		}
	}
	for _, raw := range []string{`C:\x`, `C:x`, `a:.txt`, `a\.. \x`, `...`, `\\server\share`, `\x`, `a\\b`, `a\..\x`, "a\x00b"} {
		if _, err := ArchiveTarget(raw, `C:\root`, Windows()); err == nil {
			t.Errorf("accepted Windows path %q", raw)
		}
	}
	for _, root := range []string{`C:\`, `\\server\share`} {
		got, err := ArchiveTarget(".", root, Windows())
		if err != nil || got != root {
			t.Errorf("Windows root = %q, %v; want %q", got, err, root)
		}
	}
}

type tinyReader struct {
	reader io.Reader
	step   int
}

func (r *tinyReader) Read(p []byte) (int, error) {
	r.step = r.step%7 + 1
	if len(p) > r.step {
		p = p[:r.step]
	}
	return r.reader.Read(p)
}

func TestRoundTrip(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture contains POSIX-only filenames and modes")
	}
	prefix := strings.Repeat("d", 60) + "/" + strings.Repeat("e", 60)
	longName := strings.Repeat("n", 140)
	expected := map[string]string{
		"nested/deep/a": "hello", "tool": "#!/bin/sh\n", "empty": "", "big": strings.Repeat("b", 1703),
		"one": "1", "511": strings.Repeat("q", 511), "513": strings.Repeat("r", 513),
		"日本/é": "unicode", prefix + "/file": "prefix", "pax/" + longName: "pax",
		"gnu/" + longName: "gnu", "sized": "abc", `a\b.txt`: "literal", `..\literal.txt`: "not traversal",
	}
	entries := []entry{
		{name: "nested/", kind: '5'}, {name: "nested/deep/", kind: '5'},
		{name: "global", kind: 'g', data: paxRecord("path", "../../ignored")},
	}
	for _, name := range []string{"nested/deep/a", "tool", "empty", "big", "one", "511", "513", "日本/é", `a\b.txt`, `..\literal.txt`} {
		e := file(name, expected[name])
		if name == "tool" {
			e.mode = 0755
		}
		if name == "empty" {
			e.mode = 0
		}
		entries = append(entries, e)
	}
	entries = append(entries,
		entry{name: "file", prefix: prefix, kind: '7', data: []byte("prefix")},
		entry{name: "pax", kind: 'x', data: paxRecord("path", "pax/"+longName)},
		file("ignored", "pax"),
		entry{name: "long", kind: 'L', data: []byte("gnu/" + longName + "\x00")},
		file("ignored", "gnu"),
		entry{name: "pax", kind: 'x', data: paxRecord("size", "3")},
	)
	zero := int64(0)
	entries = append(entries, entry{name: "sized", kind: 0, data: []byte("abc"), size: &zero},
		entry{name: "pax", kind: 'x', data: paxRecord("linkpath", "../tool")},
		entry{name: "nested/link", kind: '2', link: "ignored"},
	)
	data := archive(entries...)
	dest := filepath.Join(t.TempDir(), "out")
	got, err := Extract(&tinyReader{reader: bytes.NewReader(data)}, dest, Budgets{})
	if err != nil {
		t.Fatal(err)
	}
	want := Counts{Files: int64(len(expected)), Dirs: 2, Symlinks: 1, Bytes: int64(len(data))}
	if got != want {
		t.Fatalf("counts = %+v; want %+v", got, want)
	}
	for name, want := range expected {
		content, err := os.ReadFile(filepath.Join(dest, name))
		if err != nil || string(content) != want {
			t.Errorf("%s content = %q, %v; want %q", name, content, err, want)
		}
	}
	for name, mode := range map[string]os.FileMode{"tool": 0755, "nested/deep/a": 0644, "empty": 0644} {
		st, err := os.Stat(filepath.Join(dest, name))
		if err != nil || st.Mode().Perm() != mode {
			t.Errorf("%s mode: %v, %v", name, st, err)
		}
	}
	if target, err := os.Readlink(filepath.Join(dest, "nested/link")); err != nil || target != "../tool" {
		t.Fatalf("symlink = %q, %v", target, err)
	}
}

func TestDuplicateOwnedFile(t *testing.T) {
	dest := t.TempDir()
	data := archive(file("a", "first longer"), file("a", "last"))
	got, err := Extract(bytes.NewReader(data), dest, Budgets{})
	if err != nil || got.Files != 2 {
		t.Fatalf("duplicate = %+v, %v", got, err)
	}
	content, err := os.ReadFile(filepath.Join(dest, "a"))
	if err != nil || string(content) != "last" {
		t.Fatalf("duplicate content = %q, %v", content, err)
	}
}

func TestSecurity(t *testing.T) {
	for _, name := range []string{"../../escape", "/abs", "a/../../escape"} {
		t.Run(name, func(t *testing.T) {
			dest := filepath.Join(t.TempDir(), "inner")
			_, err := Extract(bytes.NewReader(archive(file(name, "bad"))), dest, Budgets{})
			if err == nil {
				t.Fatal("accepted traversal")
			}
			var tarErr *TarError
			if !errors.As(err, &tarErr) {
				t.Fatalf("expected TarError: %v", err)
			}
		})
	}
	t.Run("existing file", func(t *testing.T) {
		dest := t.TempDir()
		name := filepath.Join(dest, "a")
		if err := os.WriteFile(name, []byte("original"), 0644); err != nil {
			t.Fatal(err)
		}
		_, err := Extract(bytes.NewReader(archive(file("a", "bad"))), dest, Budgets{})
		wantError(t, err, "archive path already exists")
		data, _ := os.ReadFile(name)
		if string(data) != "original" {
			t.Fatal("existing file truncated")
		}
	})
	if runtime.GOOS == "windows" {
		return
	}
	t.Run("existing symlinks", func(t *testing.T) {
		outside, dest := t.TempDir(), t.TempDir()
		victim := filepath.Join(outside, "victim")
		if err := os.WriteFile(victim, []byte("original"), 0644); err != nil {
			t.Fatal(err)
		}
		for name, target := range map[string]string{"sym": outside, "file": victim} {
			if err := os.Symlink(target, filepath.Join(dest, name)); err != nil {
				t.Fatal(err)
			}
		}
		for _, e := range []entry{file("sym/x", "bad"), {name: "sym/dir", kind: '5'}, file("file", "bad")} {
			_, err := Extract(bytes.NewReader(archive(e)), dest, Budgets{})
			if err == nil {
				t.Fatalf("followed symlink for %s", e.name)
			}
		}
		data, _ := os.ReadFile(victim)
		if string(data) != "original" {
			t.Fatal("victim truncated")
		}
		names, _ := os.ReadDir(outside)
		if len(names) != 1 {
			t.Fatal("wrote outside destination")
		}
	})
	t.Run("deferred link collision", func(t *testing.T) {
		outside, dest := t.TempDir(), t.TempDir()
		data := archive(entry{name: "sym", kind: '2', link: outside}, file("sym/x", "bad"))
		_, err := Extract(bytes.NewReader(data), dest, Budgets{})
		wantError(t, err, "symlink path already exists")
		names, _ := os.ReadDir(outside)
		if len(names) != 0 {
			t.Fatal("wrote through archive link")
		}
	})
	t.Run("nested deferred links", func(t *testing.T) {
		outside := t.TempDir()
		data := archive(entry{name: "sym", kind: '2', link: outside}, entry{name: "sym/inner", kind: '2', link: "/etc/passwd"})
		_, err := Extract(bytes.NewReader(data), t.TempDir(), Budgets{})
		wantError(t, err, "not a directory")
		names, _ := os.ReadDir(outside)
		if len(names) != 0 {
			t.Fatal("created link outside")
		}
	})
}

func TestBudgetsAndMalformedArchives(t *testing.T) {
	basic := archive(file("a", "hello"))
	badChecksum := append([]byte(nil), basic...)
	badChecksum[0] = 'z'
	badNumeric := append([]byte(nil), basic...)
	badNumeric[100] = '9'
	checksum(badNumeric[:block])
	header := archive(entry{name: "pax", kind: 'x', data: paxRecord("path", "a")}, file("ignored", "x"))
	for _, tc := range []struct {
		name   string
		data   []byte
		budget Budgets
		want   string
	}{
		{"bytes", basic, Budgets{MaxBytes: int64(len(basic) - 1)}, "byte budget"},
		{"bytes during header", basic, Budgets{MaxBytes: 511}, "byte budget"},
		{"entries", archive(file("a", "a"), file("b", "b")), Budgets{MaxEntries: 1}, "entry budget"},
		{"zero entries", basic, Budgets{ZeroEntries: true}, "0-entry entry budget"},
		{"zero bytes", basic, Budgets{ZeroBytes: true}, "0-byte byte budget"},
		{"headers", header, Budgets{MaxHeaderBytes: 1}, "extended-header budget"},
		{"global headers", archive(entry{name: "global", kind: 'g', data: []byte("ignored")}), Budgets{ZeroHeaderBytes: true}, "extended-header budget"},
		{"truncated", basic[:block+2], Budgets{}, "unexpected end of archive"},
		{"short header", basic[:200], Budgets{}, "unexpected end of archive"},
		{"checksum", badChecksum, Budgets{}, "bad header checksum"},
		{"numeric", badNumeric, Budgets{}, "bad numeric header field"},
		{"unsupported", archive(entry{name: "device", kind: '3'}), Budgets{}, `unsupported tar entry type "3" for device`},
		{"no filename", archive(file(".", "x")), Budgets{}, "file entry without a name"},
		{"no link name", archive(entry{name: ".", kind: '2'}), Budgets{}, "symlink entry without a name"},
		{"negative budget", basic, Budgets{MaxEntries: -1}, "maxEntries must be a non-negative safe integer"},
		{"unsafe budget", basic, Budgets{MaxBytes: 1 << 53}, "maxBytes must be a non-negative safe integer"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Extract(&tinyReader{reader: bytes.NewReader(tc.data)}, t.TempDir(), tc.budget)
			wantError(t, err, tc.want)
		})
	}
	for _, value := range []string{"-1", "1.5", "NaN", "9007199254740992", "9007199254740991"} {
		t.Run("size "+value, func(t *testing.T) {
			data := archive(entry{name: "pax", kind: 'x', data: paxRecord("size", value)}, file("a", "x"))
			_, err := Extract(bytes.NewReader(data), t.TempDir(), Budgets{})
			wantError(t, err, "bad entry size")
		})
	}
}

func TestTerminationAndDrain(t *testing.T) {
	data := append(archive(file("a", "x")), []byte("trailing garbage")...)
	got, err := Extract(bytes.NewReader(data), t.TempDir(), Budgets{})
	if err != nil || got.Bytes != int64(len(data)) {
		t.Fatalf("drain = %+v, %v", got, err)
	}
	// A zero first byte is not sufficient to terminate an archive.
	h := make([]byte, block)
	h[499] = 1
	_, err = Extract(bytes.NewReader(h), t.TempDir(), Budgets{})
	wantError(t, err, "checksum")
	_, err = Extract(bytes.NewReader(data), t.TempDir(), Budgets{MaxBytes: int64(len(data) - 1)})
	wantError(t, err, "byte budget")
}

func TestByteReader(t *testing.T) {
	r := byteReader{source: &tinyReader{reader: strings.NewReader("abcdef")}, max: 6}
	got, err := r.read(2)
	if err != nil || string(got) != "ab" {
		t.Fatalf("read = %q, %v", got, err)
	}
	var out bytes.Buffer
	if err := r.take(&out, 2); err != nil || out.String() != "cd" {
		t.Fatalf("take = %q, %v", out.String(), err)
	}
	if n, err := r.drain(); n != 6 || err != nil {
		t.Fatalf("drain = %d, %v", n, err)
	}
}
