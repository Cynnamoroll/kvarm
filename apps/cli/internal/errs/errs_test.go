package errs

import (
	"errors"
	"testing"
)

func TestExitCodes(t *testing.T) {
	tests := []struct {
		name string
		err  *CliError
		code int
	}{
		{"usage errors exit 2", NewUsage("expected <owner/repo>"), 2},
		{"failure errors exit 1", NewFailure("could not reach http://x"), 1},
		{"formatting is applied", NewUsage("unknown option %q", "--nope"), 2},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.err.ExitCode; got != tt.code {
				t.Errorf("ExitCode = %d, want %d", got, tt.code)
			}
		})
	}
}

func TestMessageFormatting(t *testing.T) {
	// fmt.Sprintf formatting: the message the user sees is built here once.
	if got, want := NewUsage("unknown option %q for kvarm %s", "--nope", "change list").Message,
		`unknown option "--nope" for kvarm change list`; got != want {
		t.Errorf("Message = %q, want %q", got, want)
	}
	if got, want := NewFailure("could not reach %s: %s", "http://x", "ECONNREFUSED").Message,
		"could not reach http://x: ECONNREFUSED"; got != want {
		t.Errorf("Message = %q, want %q", got, want)
	}
}

func TestErrorMethod(t *testing.T) {
	// CliError is an error whose text is only the message, never the code.
	err := NewUsage("expected <owner/repo>")
	if got, want := err.Error(), "expected <owner/repo>"; got != want {
		t.Errorf("Error() = %q, want %q", got, want)
	}
}

func TestFromKeepsCliError(t *testing.T) {
	usage := NewUsage("expected <owner/repo>")
	// From must keep the original exit code, not flatten it to a failure.
	if got := From(usage); got != usage {
		t.Errorf("From(CliError) = %p, want the same error %p", got, usage)
	}
}

func TestFromWrapsUnknownErrors(t *testing.T) {
	// Anything the command tree did not classify is a failure (exit 1), the
	// way the JS CLI treated a thrown non-CliError.
	got := From(errors.New("boom"))
	if got.ExitCode != 1 {
		t.Errorf("ExitCode = %d, want 1", got.ExitCode)
	}
	if got.Message != "boom" {
		t.Errorf("Message = %q, want %q", got.Message, "boom")
	}
}
