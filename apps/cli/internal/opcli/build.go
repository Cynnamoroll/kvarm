package opcli

import (
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"kvarm/cli/internal/errs"
	"kvarm/cli/internal/registry"
)

// APIPrefix is the REST prefix every operation lives under.
const APIPrefix = "/api/v1"

var repoFormatRe = regexp.MustCompile(`^[^/\s]+/[^/\s]+$`)

// Built is one operation's REST request.
type Built struct {
	Method  string
	Path    string // absolute, including /api/v1
	Query   string // without the leading '?', '' when none
	HasBody bool
	Body    map[string]any
}

// Target returns path plus query, the request target.
func (b Built) Target() string {
	if b.Query == "" {
		return b.Path
	}
	return b.Path + "?" + b.Query
}

// BuildRequest maps validated arguments onto the operation's REST request,
// mirroring the shared registry's buildRequest: unknown arguments are
// refused, required ones must be present, path parameters are percent-encoded
// (a repo expands to two encoded segments), literal lists repeat the query
// parameter and everything else goes into the JSON body.
func BuildRequest(op *registry.Operation, args map[string]any) (Built, error) {
	known := map[string]bool{}
	for i := range op.Params {
		known[op.Params[i].Name] = true
	}
	for key := range args {
		if !known[key] {
			return Built{}, errs.NewUsage("unknown argument %q for %s", key, op.Name)
		}
	}
	path := op.Path
	query := url.Values{}
	body := map[string]any{}
	hasBody := false
	for i := range op.Params {
		p := &op.Params[i]
		raw, has := args[p.Name]
		if !has || raw == nil {
			if p.Required {
				return Built{}, errs.NewUsage("argument %q is required (%s)", p.Name, p.Description)
			}
			continue
		}
		if err := checkValue(p, raw); err != nil {
			return Built{}, err
		}
		switch p.In {
		case "path":
			s := valueString(raw)
			var segment string
			if p.Format == "repo" {
				slash := strings.IndexByte(s, '/')
				segment = EncodeURIComponent(s[:slash]) + "/" + EncodeURIComponent(s[slash+1:])
			} else {
				segment = EncodeURIComponent(s)
			}
			path = strings.Replace(path, "{"+p.Name+"}", segment, 1)
		case "query":
			if list, ok := raw.([]string); ok {
				if p.Literal {
					for _, item := range list {
						query.Add(p.Name, item)
					}
				} else {
					query.Set(p.Name, strings.Join(list, ","))
				}
			} else {
				query.Set(p.Name, valueString(raw))
			}
		default:
			body[p.Name] = raw
			hasBody = true
		}
	}
	return Built{
		Method:  op.Method,
		Path:    APIPrefix + path,
		Query:   query.Encode(),
		HasBody: hasBody,
		Body:    body,
	}, nil
}

// checkValue is the registry's validation: the types and constraints a
// parameter may carry, naming the offending argument.
func checkValue(p *registry.Param, v any) error {
	fail := func(format string, args ...any) error {
		return errs.NewUsage("argument %q must be "+format, append([]any{p.Name}, args...)...)
	}
	switch p.Type {
	case registry.TypeString:
		s, ok := v.(string)
		if !ok {
			return fail("a string")
		}
		if p.Required && s == "" {
			return fail("a non-empty string")
		}
		if len(p.Enum) > 0 && !contains(p.Enum, s) {
			return fail("one of %s", strings.Join(p.Enum, ", "))
		}
		if p.Format == "repo" && !repoFormatRe.MatchString(s) {
			return fail("a repository as owner/name")
		}
	case registry.TypeInteger:
		if _, ok := v.(int64); !ok {
			return fail("an integer")
		}
	case registry.TypeBoolean:
		if _, ok := v.(bool); !ok {
			return fail("a boolean")
		}
	case registry.TypeStrings:
		if _, ok := v.([]string); !ok {
			return fail("a list of strings")
		}
	}
	return nil
}

func contains(list []string, s string) bool {
	for _, item := range list {
		if item == s {
			return true
		}
	}
	return false
}

// valueString renders a validated argument the way the JS String(v) did.
func valueString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case int64:
		return strconv.FormatInt(t, 10)
	case bool:
		if t {
			return "true"
		}
		return "false"
	default:
		return fmt.Sprintf("%v", v)
	}
}

// EncodeURIComponent matches JavaScript's encodeURIComponent byte for byte
// for ASCII and encodes UTF-8 runs the standard way (the JS variant encoded
// surrogate halves, which strict UTF-8 decoders reject).
func EncodeURIComponent(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9':
			b.WriteByte(c)
		default:
			switch c {
			case '-', '_', '.', '!', '~', '*', '\'', '(', ')':
				b.WriteByte(c)
			default:
				const hex = "0123456789ABCDEF"
				b.WriteByte('%')
				b.WriteByte(hex[c>>4])
				b.WriteByte(hex[c&0xf])
			}
		}
	}
	return b.String()
}
