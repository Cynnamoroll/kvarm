// Package help renders the CLI's help screens. The hierarchy never dumps
// every command at once: the root screen lists only the parent commands
// (the special commands plus one line per API group), a group screen lists
// only that group's commands, and a command screen shows one operation's
// usage, arguments, endpoint and MCP tool.
package help

import (
	"fmt"
	"strings"

	"kvarm/cli/internal/registry"
	"kvarm/cli/internal/ui"
)

// Version is the CLI's version, printed by --version and shown in help.
const Version = "0.1.0"

// Root renders the screen for bare `kvarm` / `kvarm help`: the parent
// commands only, never the full operation list.
func Root(reg *registry.Registry, out *ui.Output, env map[string]string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s — a git platform for teams of people and coding agents\n\n", out.Bold("kvarm "+Version))

	b.WriteString(out.Bold("Usage:") + "\n")
	b.WriteString("  kvarm <command> [flags]\n")
	b.WriteString("  kvarm <group> <command> [flags]\n\n")

	b.WriteString(out.Bold("Commands:") + "\n")
	core := [][2]string{
		{"checkout", "materialize a ref into a directory (snapshot first, clone fallback)"},
		{"runner", "claim and run CI jobs on this machine"},
		{"status", "one read-only view of a repository's live state"},
		{"help", "show help for any command"},
	}
	for _, row := range core {
		fmt.Fprintf(&b, "  %s  %s\n", ui.Pad(row[0], 10), out.Dim(row[1]))
	}
	b.WriteString("\n")

	b.WriteString(out.Bold("API command groups") + out.Dim(" (\"kvarm <group>\" lists a group's commands)") + ":\n")
	width := 12
	for _, name := range reg.GroupNames() {
		if len(name) > width {
			width = len(name)
		}
	}
	width += 2
	for _, name := range reg.GroupNames() {
		fmt.Fprintf(&b, "  %s  %s\n", ui.Pad(name, width), out.Dim(reg.GroupBlurb(name)))
	}
	b.WriteString("\n")

	b.WriteString(out.Bold("Configuration:") + "\n")
	b.WriteString(configLine(env, "KVARM_BASE_URL", "platform origin, e.g. https://kvarm.example.com (required)", out))
	b.WriteString(configLine(env, "KVARM_PAT", "personal access or agent token; needed for private repos and writes", out))
	b.WriteString("\n")

	b.WriteString(out.Dim("Run \"kvarm <command> --help\" for details on any command.") + "\n")
	return b.String()
}

func configLine(env map[string]string, name, description string, out *ui.Output) string {
	state := out.Dim("not set")
	if v := env[name]; v != "" {
		state = out.Green("set") + out.Dim(" → "+v)
	}
	return fmt.Sprintf("  %s  %s  %s\n", ui.Pad(name, 14), state, out.Dim(description))
}

// Group renders the screen for `kvarm <group>` and `kvarm help <group>`:
// only that group's commands.
func Group(reg *registry.Registry, group string, out *ui.Output) string {
	ops := reg.GroupCommandsSorted(group)
	width := 0
	for _, op := range ops {
		if n := len(op.Command[1]) + len(op.Command[0]) + 1; n > width {
			width = n
		}
	}
	width += 2
	var b strings.Builder
	header := group
	if blurb := reg.GroupBlurb(group); blurb != "" {
		header += " — " + blurb
	}
	fmt.Fprintf(&b, "%s\n\n", out.Bold(header))
	b.WriteString(out.Bold("Commands:") + "\n")
	for _, op := range ops {
		fmt.Fprintf(&b, "  %s  %s\n", ui.Pad(strings.Join(op.Command, " "), width), out.Dim(ui.FirstSentence(op.Description)))
	}
	fmt.Fprintf(&b, "\n%s\n", out.Dim("Run \"kvarm "+group+" <command> --help\" for details on a command."))
	return b.String()
}

// Command renders one registry operation's help: usage, description,
// arguments, endpoint and MCP tool.
func Command(op *registry.Operation, out *ui.Output) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s — %s\n\n", out.Bold(strings.Join(op.Command, " ")), op.Description)

	b.WriteString(out.Bold("Usage:") + "\n")
	fmt.Fprintf(&b, "  %s\n\n", usageLine(op))

	var positionals, flags []*registry.Param
	for i := range op.Params {
		p := &op.Params[i]
		if p.Positional {
			positionals = append(positionals, p)
		} else {
			flags = append(flags, p)
		}
	}
	if len(positionals) > 0 {
		b.WriteString(out.Bold("Arguments:") + "\n")
		width := 0
		type row struct{ left, right string }
		var rows []row
		for _, p := range positionals {
			left := "<" + p.Name + ">"
			if !p.Required {
				left = "[<" + p.Name + ">]"
			}
			rows = append(rows, row{left, p.Description})
			if len(left)+2 > width {
				width = len(left) + 2
			}
		}
		for _, r := range rows {
			fmt.Fprintf(&b, "  %s  %s\n", ui.Pad(r.left, width), r.right)
		}
		b.WriteString("\n")
	}
	if len(flags) > 0 {
		b.WriteString(out.Bold("Options:") + "\n")
		width := 0
		type row struct{ left, right string }
		var rows []row
		for _, p := range flags {
			left := "--" + flagName(p)
			if p.Type != registry.TypeBoolean {
				left += " " + placeholder(p)
			}
			if !p.Required {
				left = "[" + left + "]"
			}
			right := p.Description
			if p.Required {
				right += " (required)"
			}
			if p.Type == registry.TypeStrings {
				if p.Literal {
					right += " (repeat the flag once per path; commas are part of the path)"
				} else {
					right += " (repeat the flag or separate with commas)"
				}
			}
			rows = append(rows, row{left, right})
			if len(left)+2 > width {
				width = len(left) + 2
			}
		}
		rows = append(rows, row{"--json", "print the reply as one line of JSON (default: indented JSON)"})
		if len("--json")+2 > width {
			width = len("--json") + 2
		}
		for _, r := range rows {
			fmt.Fprintf(&b, "  %s  %s\n", ui.Pad(r.left, width), r.right)
		}
		b.WriteString("\n")
	} else {
		b.WriteString(out.Bold("Options:") + "\n")
		b.WriteString("  --json  print the reply as one line of JSON (default: indented JSON)\n\n")
	}

	fmt.Fprintf(&b, "%s %s /api/v1%s · %s %s\n", out.Bold("REST:"), op.Method, op.Path, out.Bold("MCP tool:"), op.Name)
	fmt.Fprintf(&b, "%s 0 success · 1 API or network failure · 2 usage error\n", out.Dim("Exit codes:"))
	return b.String()
}

// usageLine is the one-line form: positionals in declaration order, then
// flags, then --json.
func usageLine(op *registry.Operation) string {
	parts := []string{"kvarm " + strings.Join(op.Command, " ")}
	for i := range op.Params {
		p := &op.Params[i]
		if p.Positional {
			if p.Required {
				parts = append(parts, "<"+p.Name+">")
			} else {
				parts = append(parts, "[<"+p.Name+">]")
			}
		}
	}
	for i := range op.Params {
		p := &op.Params[i]
		if p.Positional {
			continue
		}
		flag := "--" + flagName(p)
		if p.Type != registry.TypeBoolean {
			flag += " " + placeholder(p)
		}
		if !p.Required {
			flag = "[" + flag + "]"
		}
		parts = append(parts, flag)
	}
	parts = append(parts, "[--json]")
	return strings.Join(parts, " ")
}

// flagName is a parameter's kebab-case flag.
func flagName(p *registry.Param) string {
	var b strings.Builder
	for i := 0; i < len(p.Name); i++ {
		c := p.Name[i]
		if c >= 'A' && c <= 'Z' {
			b.WriteByte('-')
			c += 'a' - 'A'
		}
		b.WriteByte(c)
	}
	return b.String()
}

// placeholder is the value hint a typed flag shows.
func placeholder(p *registry.Param) string {
	if len(p.Enum) > 0 {
		return "<" + strings.Join(p.Enum, "|") + ">"
	}
	switch p.Type {
	case registry.TypeString:
		return "<string>"
	case registry.TypeInteger:
		return "<integer>"
	case registry.TypeStrings:
		return "<list>"
	case registry.TypeJSON:
		return "<json>"
	default:
		return ""
	}
}
