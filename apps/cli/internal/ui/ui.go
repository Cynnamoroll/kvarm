// Package ui is the CLI's presentation layer: TTY-aware styling so output
// is colorful for a person and plain for a pipe (scripts, tests, CI logs),
// command suggestions, a terminal progress line and a JSON colorizer.
// The words of a line never change with color — only the ANSI wrappers.
package ui

import (
	"fmt"
	"io"
	"os"
	"strings"
)

// ANSI SGR codes, applied only when color is on.
const (
	ansiReset  = "\x1b[0m"
	ansiBold   = "\x1b[1m"
	ansiDim    = "\x1b[2m"
	ansiRed    = "\x1b[31m"
	ansiGreen  = "\x1b[32m"
	ansiYellow = "\x1b[33m"
	ansiCyan   = "\x1b[36m"
	ansiMag    = "\x1b[35m"
)

// Output writes to one stream, styling only when that stream is an
// interactive terminal and the environment allows color.
type Output struct {
	w     io.Writer
	color bool
}

// New wraps a writer. A nil or non-terminal writer never gets color, so
// captured output stays plain and machine-readable.
func New(w io.Writer) *Output {
	color := false
	if f, ok := w.(*os.File); ok && isTerminal(f) {
		color = colorEnabled()
	}
	return &Output{w: w, color: color}
}

func isTerminal(f *os.File) bool {
	fi, err := f.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

// NO_COLOR (any value) and TERM=dumb turn color off everywhere;
// CLICOLOR_FORCE turns it on even through a pipe.
func colorEnabled() bool {
	if os.Getenv("NO_COLOR") != "" {
		return false
	}
	if os.Getenv("CLICOLOR_FORCE") != "" && os.Getenv("CLICOLOR_FORCE") != "0" {
		return true
	}
	return os.Getenv("TERM") != "" && os.Getenv("TERM") != "dumb"
}

// Color reports whether styling is active on this output.
func (o *Output) Color() bool { return o.color }

// Write emits raw bytes; used for JSON payloads that must never be styled.
func (o *Output) Write(p []byte) (int, error) { return o.w.Write(p) }

// Line prints one line, newline included, when the text is non-empty.
func (o *Output) Line(s string) {
	if s == "" {
		return
	}
	fmt.Fprintln(o.w, s)
}

// Plain prints s without styling; format arguments behave like fmt.Sprintln's.
func (o *Output) Plain(format string, args ...any) {
	o.Line(fmt.Sprintf(format, args...))
}

func (o *Output) wrap(code, s string) string {
	if !o.color || s == "" {
		return s
	}
	return code + s + ansiReset
}

// Bold text.
func (o *Output) Bold(s string) string { return o.wrap(ansiBold, s) }

// Dim text: secondary detail that must not compete with the content.
func (o *Output) Dim(s string) string { return o.wrap(ansiDim, s) }

// Red: errors and refusals.
func (o *Output) Red(s string) string { return o.wrap(ansiRed, s) }

// Green: success.
func (o *Output) Green(s string) string { return o.wrap(ansiGreen, s) }

// Yellow: warnings.
func (o *Output) Yellow(s string) string { return o.wrap(ansiYellow, s) }

// Cyan: hints, headers, keys.
func (o *Output) Cyan(s string) string { return o.wrap(ansiCyan, s) }

// Magenta: numbers.
func (o *Output) Magenta(s string) string { return o.wrap(ansiMag, s) }

// ErrorLine prints "kvarm: <message>" in the error style.
func (o *Output) ErrorLine(message string) {
	o.Line(o.Red("kvarm: ") + message)
}

// Pad right-pads s with spaces to at least width columns, counting runes
// (help columns hold ASCII plus the occasional unicode word).
func Pad(s string, width int) string {
	n := len([]rune(s))
	if n >= width {
		return s
	}
	return s + strings.Repeat(" ", width-n)
}

// Indent prefixes every line of s with pad.
func Indent(s, pad string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		if l != "" {
			lines[i] = pad + l
		}
	}
	return strings.Join(lines, "\n")
}

// FirstSentence cuts a description at the first sentence boundary, the
// length the group listings show.
func FirstSentence(s string) string {
	if i := strings.IndexByte(s, '.'); i >= 0 {
		return s[:i+1]
	}
	return s
}
