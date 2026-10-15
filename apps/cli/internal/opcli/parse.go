// Package opcli adapts the operation registry to the command line: it parses
// a command's arguments (positionals in declaration order, kebab-case flags,
// lists that repeat or take commas, JSON flags, strict booleans) and builds
// each operation's REST request, then runs it and reports the reply.
package opcli

import (
	"encoding/json"
	"regexp"
	"strconv"

	"kvarm/cli/internal/errs"
	"kvarm/cli/internal/registry"
)

// Parsed is one command line for an operation.
type Parsed struct {
	Help       bool
	JSONOutput bool
	Args       map[string]any
}

var intRe = regexp.MustCompile(`^-?\d+$`)

// Kebab converts a camelCase parameter name to its --kebab-case flag.
func Kebab(name string) string {
	out := make([]byte, 0, len(name)+4)
	for i := 0; i < len(name); i++ {
		c := name[i]
		if c >= 'A' && c <= 'Z' {
			out = append(out, '-')
			c += 'a' - 'A'
		}
		out = append(out, c)
	}
	return string(out)
}

// ParseArgs mirrors the JS CLI's parseOperationArgs: positionals in
// declaration order, --kebab=value or --kebab value flags, repeatable or
// comma-separated lists (literal lists never split, because Git paths may
// contain commas), JSON flags parsed strictly, booleans only as true/false.
func ParseArgs(op *registry.Operation, argv []string) (Parsed, error) {
	usage := func(format string, args ...any) error {
		return errs.NewUsage(format, args...)
	}
	var positionals []*registry.Param
	flags := map[string]*registry.Param{}
	for i := range op.Params {
		p := &op.Params[i]
		if p.Positional {
			positionals = append(positionals, p)
		} else {
			flags[Kebab(p.Name)] = p
		}
	}
	parsed := Parsed{Args: map[string]any{}}
	assign := func(p *registry.Param, raw string) error {
		switch p.Type {
		case registry.TypeInteger:
			if !intRe.MatchString(raw) {
				return usage("argument %q must be an integer, got %q", p.Name, raw)
			}
			n, err := strconv.ParseInt(raw, 10, 64)
			if err != nil {
				return usage("argument %q must be an integer, got %q", p.Name, raw)
			}
			parsed.Args[p.Name] = n
		case registry.TypeStrings:
			list, _ := parsed.Args[p.Name].([]string)
			if p.Literal {
				list = append(list, raw)
			} else {
				for _, part := range splitComma(raw) {
					list = append(list, part)
				}
			}
			parsed.Args[p.Name] = list
		case registry.TypeJSON:
			var v any
			if err := json.Unmarshal([]byte(raw), &v); err != nil {
				quoted, _ := json.Marshal(raw)
				return usage("argument %q must be JSON, got %s", p.Name, quoted)
			}
			parsed.Args[p.Name] = v
		case registry.TypeBoolean:
			// Only the two spellings mean anything; "0", "no" or any other
			// value is a usage error, not a truthy coercion that flips a flag.
			switch raw {
			case "true":
				parsed.Args[p.Name] = true
			case "false":
				parsed.Args[p.Name] = false
			default:
				return usage("argument %q must be true or false, got %q", p.Name, raw)
			}
		default:
			parsed.Args[p.Name] = raw
		}
		return nil
	}

	next := 0
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		if a == "--help" || a == "-h" {
			parsed.Help = true
			return parsed, nil
		}
		if a == "--json" {
			parsed.JSONOutput = true
			continue
		}
		if len(a) >= 2 && a[:2] == "--" {
			name := a[2:]
			var value string
			hasValue := false
			for j := 0; j < len(name); j++ {
				if name[j] == '=' {
					value = name[j+1:]
					name = name[:j]
					hasValue = true
					break
				}
			}
			p, ok := flags[name]
			if !ok {
				return parsed, usage("unknown option %q for kvarm %s", "--"+name, commandWords(op))
			}
			if p.Type == registry.TypeBoolean && !hasValue {
				parsed.Args[p.Name] = true
				continue
			}
			if !hasValue {
				i++
				if i >= len(argv) {
					return parsed, usage("option %q needs a value", "--"+name)
				}
				value = argv[i]
			}
			if err := assign(p, value); err != nil {
				return parsed, err
			}
			continue
		}
		if next >= len(positionals) {
			return parsed, usage("unexpected argument %q", a)
		}
		if err := assign(positionals[next], a); err != nil {
			return parsed, err
		}
		next++
	}
	return parsed, nil
}

func commandWords(op *registry.Operation) string {
	words := ""
	for i, w := range op.Command {
		if i > 0 {
			words += " "
		}
		words += w
	}
	return words
}

// splitComma keeps the JS CLI's `split(',').filter(s => s.length > 0)`.
func splitComma(raw string) []string {
	var out []string
	start := 0
	for i := 0; i <= len(raw); i++ {
		if i == len(raw) || raw[i] == ',' {
			if i > start {
				out = append(out, raw[start:i])
			}
			start = i + 1
		}
	}
	return out
}
