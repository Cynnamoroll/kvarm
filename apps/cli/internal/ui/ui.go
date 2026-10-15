// Package ui is the CLI's presentation layer: TTY-aware styling so output
// is colorful for a person and plain for a pipe (scripts, tests, CI logs),
// command suggestions, a terminal progress line, a JSON colorizer and
// secret redaction. The words of a line never change with color — only the
// ANSI wrappers.
package ui

import (
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"regexp"
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

// Redacted replaces a secret in output: no part of the value survives, so
// a masked line never discloses its length or prefix.
const Redacted = "[redacted]"

// tokenShape matches the token formats the platform mints (`kvarm_pat_…`
// and `kvarm_agt_…`, AGENTS.md), so a token this process never saw — one a
// platform error body echoed back, say — is still masked.
var tokenShape = regexp.MustCompile(`kvarm_(?:pat|agt)_[A-Za-z0-9_-]+`)

// Output writes to one stream, styling only when that stream is an
// interactive terminal and the environment allows color. Every write is
// passed through redact, so no call site has to remember to mask a secret.
type Output struct {
	w       io.Writer
	color   bool
	secrets []string
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

// AddSecret registers a value that must never appear in this output. The
// token itself is registered, plus the two base64 forms git carries it in
// (basic auth hides it from a literal match), so a leak through any of them
// is masked. An empty value registers nothing.
func (o *Output) AddSecret(secret string) {
	if secret == "" {
		return
	}
	o.secrets = append(o.secrets,
		secret,
		base64.StdEncoding.EncodeToString([]byte(secret)),
		base64.StdEncoding.EncodeToString([]byte("kvarm:"+secret)),
	)
}

// redact masks every registered secret and any token-shaped value.
func (o *Output) redact(s string) string {
	if s == "" {
		return s
	}
	for _, secret := range o.secrets {
		s = strings.ReplaceAll(s, secret, Redacted)
	}
	if strings.Contains(s, "kvarm_pat_") || strings.Contains(s, "kvarm_agt_") {
		s = tokenShape.ReplaceAllString(s, Redacted)
	}
	return s
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
// Secrets are still masked: a reply body is no place for a credential.
func (o *Output) Write(p []byte) (int, error) {
	_, err := io.WriteString(o.w, o.redact(string(p)))
	return len(p), err
}

// Line prints one line, newline included, when the text is non-empty.
func (o *Output) Line(s string) {
	if s == "" {
		return
	}
	fmt.Fprintln(o.w, o.redact(s))
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
