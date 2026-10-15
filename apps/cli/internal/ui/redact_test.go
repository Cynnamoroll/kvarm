package ui

import (
	"encoding/base64"
	"strings"
	"testing"
)

// A registered secret must not survive in any of the forms the CLI can
// carry it in: the raw token, and the two base64 encodings git basic auth
// uses (the header value alone, and its `kvarm:<token>` payload). The value
// is deliberately not token-shaped, so this proves the registration path
// rather than the token-shape regex.
func TestAddSecretMasksEveryForm(t *testing.T) {
	const token = "opaque-token-1234567890"
	var buf strings.Builder
	out := New(&buf)
	out.AddSecret(token)
	out.Line("raw " + token)
	out.Line("header " + base64.StdEncoding.EncodeToString([]byte("kvarm:"+token)))
	out.Line("bare " + base64.StdEncoding.EncodeToString([]byte(token)))

	got := buf.String()
	if strings.Contains(got, token) {
		t.Errorf("the token survived:\n%s", got)
	}
	if strings.Contains(got, base64.StdEncoding.EncodeToString([]byte("kvarm:"+token))) {
		t.Errorf("the basic-auth form survived:\n%s", got)
	}
	if n := strings.Count(got, Redacted); n != 3 {
		t.Errorf("masked %d values, want 3:\n%s", n, got)
	}
}

// A token the process never registered is still masked, so a platform that
// echoes one back in an error body cannot make the CLI print it.
func TestTokenShapedValuesAreMaskedWithoutRegistration(t *testing.T) {
	for _, secret := range []string{
		"kvarm_pat_0123456789abcdef",
		"kvarm_agt_0123456789abcdef",
	} {
		var buf strings.Builder
		out := New(&buf)
		out.Line("server said: unauthorized for " + secret)
		if got := buf.String(); strings.Contains(got, secret) {
			t.Errorf("unregistered token survived:\n%s", got)
		}
	}
}

// Redaction covers Write too: a JSON reply body is no place for a credential.
func TestWriteRedacts(t *testing.T) {
	const token = "opaque-in-json"
	var buf strings.Builder
	out := New(&buf)
	out.AddSecret(token)
	if _, err := out.Write([]byte(`{"error":"bad token ` + token + `"}`)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if got := buf.String(); strings.Contains(got, token) {
		t.Errorf("Write leaked the token: %s", got)
	}
}

// An empty secret registers nothing, so an unset KVARM_PAT cannot make every
// empty substring match and swallow the output.
func TestAddSecretIgnoresEmpty(t *testing.T) {
	var buf strings.Builder
	out := New(&buf)
	out.AddSecret("")
	out.Line("nothing to mask")
	if got, want := buf.String(), "nothing to mask\n"; got != want {
		t.Errorf("output = %q, want %q", got, want)
	}
}

// Styled text still redacts: color wraps the words, it never hides them.
func TestRedactionSurvivesStyling(t *testing.T) {
	const token = "opaque-styled"
	var buf strings.Builder
	out := New(&buf)
	out.AddSecret(token)
	out.Line(out.Red("failed for " + token))
	if got := buf.String(); strings.Contains(got, token) {
		t.Errorf("styled output leaked the token: %s", got)
	}
}
