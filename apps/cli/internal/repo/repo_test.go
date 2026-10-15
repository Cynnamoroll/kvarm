package repo

import (
	"testing"

	"kvarm/cli/internal/errs"
)

func TestParseValid(t *testing.T) {
	tests := []struct {
		raw   string
		owner string
		name  string
	}{
		{"acme/app", "acme", "app"},
		{"Acme/App", "Acme", "App"},
		// A .git suffix is stripped the way a clone URL would be.
		{"acme/app.git", "acme", "app"},
		{"a-1.b_c/x.y-z_9", "a-1.b_c", "x.y-z_9"},
	}
	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			got, err := Parse(tt.raw)
			if err != nil {
				t.Fatalf("Parse(%q) error: %v", tt.raw, err)
			}
			if got.Owner != tt.owner || got.Name != tt.name {
				t.Errorf("Parse(%q) = %s/%s, want %s/%s", tt.raw, got.Owner, got.Name, tt.owner, tt.name)
			}
		})
	}
}

func TestParseRefused(t *testing.T) {
	tests := []string{
		"",
		"acme",           // no slash
		"/app",           // owner must start alphanumeric
		"-acme/app",      // owner must start alphanumeric
		"acme/",          // empty name
		"acme/app/extra", // extra segment
		"acme/app/",      // trailing slash
		"acme /app",      // whitespace
		"acme/app ",      // whitespace
		"acme/ap p",
		// "." and ".." resolve outside the repo under the host's path
		// rules, so they are refused like every other bad shape.
		"acme/.",
		"acme/..",
		"acme/...git",
	}
	for _, raw := range tests {
		t.Run(raw, func(t *testing.T) {
			got, err := Parse(raw)
			if err == nil {
				t.Fatalf("Parse(%q) = %s/%s, want an error", raw, got.Owner, got.Name)
			}
			if want := `invalid repository "` + raw + `", expected <owner>/<repo>`; err.Error() != want {
				t.Errorf("error = %q, want %q", err.Error(), want)
			}
			if code := errs.From(err).ExitCode; code != 2 {
				t.Errorf("ExitCode = %d, want 2 (a usage error)", code)
			}
		})
	}
}
