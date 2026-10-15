package opcli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"kvarm/cli/internal/errs"
	"kvarm/cli/internal/help"
	"kvarm/cli/internal/httpx"
	"kvarm/cli/internal/registry"
	"kvarm/cli/internal/ui"
)

// IO is what a command runs against: the environment (KVARM_BASE_URL,
// KVARM_PAT), the two outputs and the HTTP client. Tests inject their own.
type IO struct {
	Env    map[string]string
	Stdout *ui.Output
	Stderr *ui.Output
	Client *httpx.Client
}

// BaseURL returns the configured platform origin.
func (io IO) BaseURL() string { return io.Env["KVARM_BASE_URL"] }

// PAT returns the token, "" when none.
func (io IO) PAT() string { return io.Env["KVARM_PAT"] }

// Reply is one registry operation's HTTP reply.
type Reply struct {
	OK         bool
	Status     int
	Data       any // parsed JSON, or the raw text of a non-JSON reply
	Text       string
	RetryAfter string
}

var httpSchemeRe = regexp.MustCompile(`^https?://`)

// CallOperation sends one registry operation and reads its reply. Input
// problems and configuration problems are usage errors; an unreachable
// platform is a failure. The reply itself — success or API error — is
// returned, not thrown.
func CallOperation(ctx context.Context, op *registry.Operation, args map[string]any, io IO) (*Reply, error) {
	built, err := BuildRequest(op, args)
	if err != nil {
		return nil, err
	}
	baseURL := io.BaseURL()
	if baseURL == "" {
		return nil, errs.NewUsage("KVARM_BASE_URL is not set (e.g. https://kvarm.example.com)")
	}
	if !httpSchemeRe.MatchString(baseURL) {
		return nil, errs.NewUsage("KVARM_BASE_URL must be an http(s) URL, got %q", baseURL)
	}
	headers := map[string]string{"accept": "application/json"}
	if io.PAT() != "" {
		headers["authorization"] = "Bearer " + io.PAT()
	}
	var body string
	if built.HasBody {
		headers["content-type"] = "application/json"
		body, err = marshalJSON(built.Body)
		if err != nil {
			return nil, errs.NewFailure("serializing the request body: %v", err)
		}
	}
	target, err := resolveTarget(built.Target(), baseURL)
	if err != nil {
		return nil, err
	}
	res, err := io.Client.DoText(ctx, built.Method, target, headers, []byte(body), httpx.MaxResponseBytes)
	if err != nil {
		return nil, errs.NewFailure("could not reach %s: %v", origin(baseURL), unwrapCause(err))
	}
	data, parseErr := res.JSONValue()
	if parseErr != nil {
		data = res.Text // non-JSON reply: shown as the raw text
	}
	return &Reply{OK: res.OK(), Status: res.Status, Data: data, Text: res.Text, RetryAfter: res.RetryAfter()}, nil
}

// RunOperation parses argv, prints help or the reply, and returns the exit
// code the same way the JS CLI did: 0 on success, 1 on an API failure with
// the failure report printed.
func RunOperation(ctx context.Context, op *registry.Operation, argv []string, io IO) (int, error) {
	parsed, err := ParseArgs(op, argv)
	if err != nil {
		return 2, err
	}
	if parsed.Help {
		io.Stdout.Line(help.Command(op, io.Stdout))
		return 0, nil
	}
	reply, err := CallOperation(ctx, op, parsed.Args, io)
	if err != nil {
		return 1, err
	}
	if reply.OK {
		PrintJSON(reply.Data, parsed.JSONOutput, io.Stdout)
		return 0, nil
	}
	return ReportFailure(op, parsed.Args, reply, parsed.JSONOutput, io, "kvarm "+commandWords(op)), nil
}

// PrintJSON writes a reply as indented JSON, or as one line with --json,
// colored only on a terminal.
func PrintJSON(data any, oneLine bool, out *ui.Output) {
	text, err := marshalJSON(data)
	if err != nil {
		text = "null"
	}
	if oneLine {
		out.Write([]byte(text + "\n"))
		return
	}
	var buf bytes.Buffer
	if err := json.Indent(&buf, []byte(text), "", "  "); err != nil {
		out.Write([]byte(text + "\n"))
		return
	}
	out.Line(ui.JSONColorize(out, buf.String()))
}

// marshalJSON without HTML escaping, so replies with < > & stay readable.
func marshalJSON(v any) (string, error) {
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buf.String(), "\n"), nil
}

// ReportFailure prints a failed reply (label, code, error, details, hint)
// and returns exit code 1.
func ReportFailure(op *registry.Operation, args map[string]any, res *Reply, jsonOut bool, io IO, label string) int {
	body, _ := res.Data.(map[string]any)
	if body == nil {
		// A non-object error body: the first 200 characters of the text.
		text := res.Text
		if len(text) > 200 {
			text = text[:200]
		}
		body = map[string]any{"error": text}
	}
	if jsonOut {
		// The same shape the JS CLI printed: {status, ...body} on one line.
		out := map[string]any{"status": json.Number(strconv.Itoa(res.Status))}
		for k, v := range body {
			out[k] = v
		}
		PrintJSON(out, true, io.Stdout)
	}
	errText := "request failed"
	if e, ok := body["error"].(string); ok {
		errText = e
	}
	details := map[string]any{}
	for k, v := range body {
		if k != "error" && k != "code" {
			details[k] = v
		}
	}
	code, _ := body["code"].(string)
	codePart := ""
	if code != "" {
		codePart = code + " "
	}
	io.Stderr.Line(io.Stderr.Red(fmt.Sprintf("%s: %s(HTTP %d): %s", label, codePart, res.Status, errText)))
	if len(details) > 0 {
		d, _ := marshalJSON(details)
		io.Stderr.Line(io.Stderr.Dim("details: ") + d)
	}
	io.Stderr.Line(io.Stderr.Cyan("hint: ") + Hint(op, res.Status, body, args, res.RetryAfter))
	return 1
}

// Hint is the next-step line printed after a failure: the explicit recovery
// for a pinned-dependency refusal, or the standing advice per status.
func Hint(op *registry.Operation, status int, body map[string]any, args map[string]any, retryAfter string) string {
	code, _ := body["code"].(string)
	cmd := "kvarm " + commandWords(op)
	if recovery := dependencyRecovery(code, body, args); recovery != "" {
		return recovery
	}
	repo, hasRepo := args["repo"].(string)
	switch {
	case status == 401:
		return "set KVARM_PAT to a valid personal access token with the api scope (or an unexpired agent token)"
	case status == 403 && code == "INSUFFICIENT_SCOPE":
		return "the token lacks the api scope or role this needs; use a token minted with the api scope"
	case status == 403:
		if hasRepo {
			return "your account or token lacks the role this needs on " + repo + "; ask an admin for a grant"
		}
		return "your account or token lacks the role this needs; ask an admin for a grant"
	case status == 404 && code == "NOT_FOUND" && hasRepo:
		return repo + " does not exist or is private to you; check owner/name and that KVARM_PAT can read it"
	case status == 404:
		return "check the identifiers you passed to " + cmd
	case status == 409:
		return "the current state conflicts with this request; read the current state (details above) and retry"
	case status == 400 || status == 422:
		return "fix the argument named in the error; run \"" + cmd + " --help\""
	case status == 429:
		if retryAfter == "" {
			retryAfter = "60"
		}
		return "rate limited; retry after " + retryAfter + " seconds"
	case status >= 500:
		return "platform or storage error; retry shortly"
	default:
		return "run \"" + cmd + " --help\""
	}
}

// dependencyRecovery builds the explicit recovery commands for a refusal
// caused by a pinned dependency.
func dependencyRecovery(code string, body map[string]any, args map[string]any) string {
	if code == "REVISION_NOT_CURRENT" {
		if current, ok := body["currentRevision"].(string); ok {
			return "the source's current revision is " + current + "; retry with --revision " + current
		}
	}
	switch code {
	case "DEPENDENCY_BROKEN", "DEPENDENCY_STALE", "DEPENDENCY_PENDING":
	default:
		return ""
	}
	deps, ok := body["dependencies"].([]any)
	if !ok || len(deps) == 0 {
		return ""
	}
	dep, ok := deps[0].(map[string]any)
	if !ok {
		return ""
	}
	id, _ := dep["id"].(string)
	workspaceID, _ := dep["workspaceId"].(string)
	if id == "" || workspaceID == "" {
		return ""
	}
	repo, hasRepo := args["repo"].(string)
	if !hasRepo {
		repo = "<owner/repo>"
	}
	at := repo + " " + workspaceID + " " + id
	list := "inspect with \"kvarm deps list " + repo + " " + workspaceID + "\""
	detach := "\"kvarm deps detach " + at + "\""
	if code == "DEPENDENCY_PENDING" {
		onWorkspace, ok := dep["onWorkspace"].(string)
		if !ok {
			onWorkspace = "undefined"
		}
		return list + "; land workspace " + onWorkspace + "'s change first, or " + detach
	}
	var repin string
	if code == "DEPENDENCY_STALE" {
		if sourceHead, ok := dep["sourceHead"].(string); ok {
			repin = "kvarm deps repin " + at + " --revision " + sourceHead
		}
	}
	if repin == "" {
		repin = "kvarm deps repin " + at + " --on-workspace <live-workspace> --revision <its-head>"
	}
	return list + ", then recover explicitly: \"" + repin + "\" or " + detach
}

// resolveTarget puts the request target on the platform origin; the base
// URL's own path, if any, is dropped exactly like `new URL(target, base)`.
func resolveTarget(target, baseURL string) (string, error) {
	base, err := url.Parse(baseURL)
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", errs.NewUsage("KVARM_BASE_URL must be an http(s) URL, got %q", baseURL)
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", errs.NewUsage("KVARM_BASE_URL must be an http(s) URL, got %q", baseURL)
	}
	return base.Scheme + "://" + base.Host + target, nil
}

func origin(baseURL string) string {
	base, err := url.Parse(baseURL)
	if err != nil || base.Host == "" {
		return baseURL
	}
	return base.Scheme + "://" + base.Host
}

// unwrapCause renders transport failures like Node's cause.code did, with
// the host's own wording when Go does not name the errno.
func unwrapCause(err error) error {
	msg := err.Error()
	if strings.Contains(msg, "connection refused") {
		return fmt.Errorf("%s", "ECONNREFUSED")
	}
	if strings.Contains(msg, "no such host") || strings.Contains(msg, "lookup ") {
		return fmt.Errorf("%s", "ENOTFOUND")
	}
	return err
}
