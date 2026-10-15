// Package app is the kvarm CLI's dispatch: one place decides which command
// runs, renders the hierarchical help screens, suggests corrections for
// unknown or incomplete commands, and turns every command's outcome into an
// exit code. Nothing here knows how any command works.
package app

import (
	"context"
	"fmt"
	"io"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"kvarm/cli/internal/checkout"
	"kvarm/cli/internal/errs"
	"kvarm/cli/internal/executor"
	"kvarm/cli/internal/help"
	"kvarm/cli/internal/httpx"
	"kvarm/cli/internal/opcli"
	"kvarm/cli/internal/registry"
	"kvarm/cli/internal/runner"
	"kvarm/cli/internal/statuscmd"
	"kvarm/cli/internal/ui"
)

// coreCommands are the commands outside the operation registry.
var coreCommands = []string{"checkout", "runner", "status", "help"}

// repoSlugRe is the owner/name shape the special commands take.
var repoSlugRe = regexp.MustCompile(`^[^/\s]+/[^/\s]+$`)

// showHelp prints one rendered help screen: the renderers end in a newline
// and Line adds its own, so one trailing blank line is trimmed here.
func showHelp(out *ui.Output, screen string) {
	out.Line(strings.TrimRight(screen, "\n"))
}

// Main runs one command-line invocation and returns the process exit code.
// Errors are printed here, never returned unwrapped: a command either prints
// its own failure report or yields an error with an exit code, and this
// function is the single place both become stderr text.
func Main(argv []string, env map[string]string, stdout, stderr io.Writer) int {
	ctx := context.Background()
	reg := registry.Load()
	out, errOut := ui.New(stdout), ui.New(stderr)
	opIO := opcli.IO{Env: env, Stdout: out, Stderr: errOut, Client: httpx.New()}

	command, rest := "", argv
	if len(argv) > 0 {
		command, rest = argv[0], argv[1:]
	}
	switch {
	case command == "":
		showHelp(out, help.Root(reg, out, env))
		return 2
	case command == "help" || command == "--help" || command == "-h":
		return helpCommand(reg, rest, out, errOut, env)
	case command == "--version" || command == "-v" || command == "version":
		out.Line("kvarm " + help.Version)
		return 0
	case command == "checkout":
		return runCheckout(ctx, rest, env, out, errOut)
	case command == "runner":
		return runRunnerCmd(rest, env, out, errOut)
	case command == "status":
		code, err := statuscmd.Run(ctx, rest, opIO)
		return finish("status", code, err, errOut)
	}

	// Everything else is a registry group: `kvarm <group> <verb>`.
	ops := reg.GroupCommands(command)
	if len(ops) == 0 {
		errOut.Line(errOut.Red(fmt.Sprintf("kvarm: unknown command %q", command)))
		candidates := append(append([]string{}, coreCommands...), reg.GroupNames()...)
		if suggestions := ui.Suggest(command, candidates); len(suggestions) > 0 {
			errOut.Line("did you mean " + englishList(suggestions) + "?")
		}
		errOut.Line(errOut.Dim("Run \"kvarm\" to list every command group."))
		return 2
	}
	if len(rest) == 0 || rest[0] == "--help" || rest[0] == "-h" {
		// An incomplete command lists only the relevant subcommands.
		showHelp(out, help.Group(reg, command, out))
		if len(rest) == 0 {
			return 2
		}
		return 0
	}
	verb, args := rest[0], rest[1:]
	op := reg.FindCommand([]string{command, verb})
	if op == nil {
		errOut.Line(errOut.Red(fmt.Sprintf("kvarm: unknown command %q", command+" "+verb)))
		verbs := make([]string, 0, len(ops))
		for _, candidate := range reg.GroupCommandsSorted(command) {
			verbs = append(verbs, candidate.Command[1])
		}
		if suggestions := ui.Suggest(verb, verbs); len(suggestions) > 0 {
			errOut.Line(fmt.Sprintf("did you mean %s? Try \"kvarm %s\" to list the group's commands.", englishList(pairs(command, suggestions)), command))
		} else {
			errOut.Line(errOut.Dim(fmt.Sprintf("Try \"kvarm %s\" to list the group's commands.", command)))
		}
		return 2
	}
	code, err := opcli.RunOperation(ctx, op, args, opIO)
	return finish(strings.Join(op.Command, " "), code, err, errOut)
}

// helpCommand handles `kvarm help [target...]`: root, group, registry
// command or special command screens.
func helpCommand(reg *registry.Registry, rest []string, out, errOut *ui.Output, env map[string]string) int {
	if len(rest) == 0 {
		showHelp(out, help.Root(reg, out, env))
		return 0
	}
	switch rest[0] {
	case "checkout":
		showHelp(out, help.Checkout(out))
		return 0
	case "runner":
		showHelp(out, help.Runner(out))
		return 0
	case "status":
		showHelp(out, help.Status(out, help.StatusLimits{DependencyReads: statuscmd.DependencyReads}))
		return 0
	}
	if op := reg.FindCommand(rest); op != nil {
		showHelp(out, help.Command(op, out))
		return 0
	}
	if reg.HasGroup(rest[0]) {
		showHelp(out, help.Group(reg, rest[0], out))
		return 0
	}
	errOut.Line(errOut.Red(fmt.Sprintf("kvarm: nothing to help about %q", strings.Join(rest, " "))))
	candidates := append(append([]string{}, coreCommands...), reg.GroupNames()...)
	if len(rest) >= 2 {
		candidates = nil
		for _, candidate := range reg.GroupCommandsSorted(rest[0]) {
			candidates = append(candidates, candidate.Command[1])
		}
	}
	if suggestions := ui.Suggest(rest[len(rest)-1], candidates); len(suggestions) > 0 {
		// Unprefixed: rest[0] is never a real group here (groups return
		// their screen above), so prefixing it would suggest "chckout
		// checkout" for a typo instead of "checkout".
		errOut.Line("did you mean " + englishList(suggestions) + "?")
	}
	return 2
}

// runCheckout parses and runs `kvarm checkout <owner/repo> <ref> <dir>`.
func runCheckout(ctx context.Context, args []string, env map[string]string, out, errOut *ui.Output) int {
	var wantsHelp bool
	var positionals []string
	for _, a := range args {
		switch a {
		case "--help", "-h":
			wantsHelp = true
		default:
			if strings.HasPrefix(a, "-") {
				return finish("checkout", 2, errs.NewUsage("unknown option %q", a), errOut)
			}
			positionals = append(positionals, a)
		}
	}
	if wantsHelp {
		showHelp(out, help.Checkout(out))
		return 0
	}
	if len(positionals) != 3 {
		return finish("checkout", 2, errs.NewUsage("expected <owner/repo> <ref> <dir>"), errOut)
	}
	repoArg, ref, dir := positionals[0], positionals[1], positionals[2]
	baseURL := env["KVARM_BASE_URL"]
	if baseURL == "" {
		return finish("checkout", 2, errs.NewUsage("KVARM_BASE_URL is not set (e.g. https://kvarm.example.com)"), errOut)
	}
	_, err := checkout.Checkout(ctx, checkout.Options{
		BaseURL: baseURL,
		PAT:     env["KVARM_PAT"],
		Repo:    repoArg,
		Ref:     ref,
		Dir:     dir,
		Stdout:  out,
		Stderr:  errOut,
		Client:  httpx.New(),
	})
	if err != nil {
		return finish("checkout", 0, err, errOut)
	}
	return 0
}

// runnerFlag is one --flag of the runner command.
// runRunnerCmd parses and runs `kvarm runner ...`.
func runRunnerCmd(args []string, env map[string]string, out, errOut *ui.Output) int {
	values := map[string]string{}
	set := map[string]bool{}
	var positionals []string
	i := 0
	for i < len(args) {
		a := args[i]
		i++
		if a == "--help" || a == "-h" {
			showHelp(out, help.Runner(out))
			return 0
		}
		if a == "--" {
			positionals = append(positionals, args[i:]...)
			break
		}
		if !strings.HasPrefix(a, "--") {
			positionals = append(positionals, a)
			continue
		}
		flag := strings.TrimPrefix(a, "--")
		value := ""
		hasValue := false
		if eq := strings.IndexByte(flag, '='); eq >= 0 {
			flag, value, hasValue = flag[:eq], flag[eq+1:], true
		}
		switch flag {
		case "once", "drain", "fresh":
			if hasValue {
				return finish("runner", 2, errs.NewUsage("option '--%s' does not take a value", flag), errOut)
			}
			set[flag] = true
		case "repo", "workdir", "trust", "executor", "container-runtime", "image", "network", "cpus", "memory", "pids-limit", "container-user":
			if !hasValue {
				if i >= len(args) {
					return finish("runner", 2, errs.NewUsage("option '--%s' requires a value", flag), errOut)
				}
				value, hasValue = args[i], true
				i++
			}
			values[flag], set[flag] = value, true
		default:
			return finish("runner", 2, errs.NewUsage("unknown option '--%s'", flag), errOut)
		}
	}
	if len(positionals) > 0 {
		return finish("runner", 2, errs.NewUsage("unexpected positional argument %q", positionals[0]), errOut)
	}
	repoArg := values["repo"]
	if !set["repo"] || !repoSlugRe.MatchString(repoArg) {
		return finish("runner", 2, errs.NewUsage("expected --repo <owner/repo>"), errOut)
	}
	baseURL := env["KVARM_BASE_URL"]
	if baseURL == "" {
		return finish("runner", 2, errs.NewUsage("KVARM_BASE_URL is not set"), errOut)
	}
	pat := env["KVARM_PAT"]
	if pat == "" {
		return finish("runner", 2, errs.NewUsage("KVARM_PAT is not set (the runner requires ci scope)"), errOut)
	}
	container := executor.ContainerConfig{}
	if v, ok := values["container-runtime"]; ok {
		container.Runtime = executor.ContainerRuntime(v)
	}
	if v, ok := values["image"]; ok {
		container.Image = v
	}
	if v, ok := values["network"]; ok {
		container.Network = v
	}
	if v, ok := values["cpus"]; ok {
		container.CPUS = v
	}
	if v, ok := values["memory"]; ok {
		container.Memory = v
	}
	if v, ok := values["pids-limit"]; ok {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 {
			// NaN in the JS CLI reached the same refusal through the config check.
			return finish("runner", 2, errs.NewUsage("invalid pids limit %q", v), errOut)
		}
		container.PidsLimit = &n
	}
	if v, ok := values["container-user"]; ok {
		container.User = v
	}
	workRoot, err := cacheRoot(env, values["workdir"])
	if err != nil {
		return finish("runner", 2, err, errOut)
	}
	trust := executor.TrustMode(values["trust"])
	if !set["trust"] {
		trust = executor.TrustHumans
	}
	executorMode := executor.ExecutorMode(values["executor"])
	if !set["executor"] {
		executorMode = executor.ExecutorAuto
	}
	_, runErr := runner.Run(context.Background(), runner.Options{
		BaseURL:         baseURL,
		PAT:             pat,
		Repo:            repoArg,
		Once:            set["once"],
		DrainUntilEmpty: set["drain"],
		Fresh:           set["fresh"],
		WorkRoot:        workRoot,
		Trust:           trust,
		Executor:        executorMode,
		Container:       container,
		Stdout:          out,
		Stderr:          errOut,
		Client:          httpx.New(),
	})
	return finish("runner", 0, runErr, errOut)
}

// cacheRoot resolves --workdir or the default runner workdir root
// ($XDG_CACHE_HOME/kvarm/runner, else ~/.cache/kvarm/runner), the way the
// JS CLI did.
func cacheRoot(env map[string]string, workdir string) (string, error) {
	if workdir != "" {
		if !filepath.IsAbs(workdir) {
			return "", errs.NewUsage("--workdir must be an absolute path")
		}
		return filepath.Clean(workdir), nil
	}
	base := env["XDG_CACHE_HOME"]
	if base == "" || !filepath.IsAbs(base) {
		home := env["HOME"]
		if home == "" {
			if u, err := user.Current(); err == nil {
				home = u.HomeDir
			}
		}
		if home == "" {
			return "", errs.NewUsage("neither --workdir nor $HOME is set; there is nowhere to keep runner working directories")
		}
		base = filepath.Join(home, ".cache")
	}
	return filepath.Join(base, "kvarm", "runner"), nil
}

// finish prints one command's terminal error the same way for every
// command: `kvarm <label>: <message>`, plus the pointer to help for usage
// errors. A nil error keeps the code the command returned; a CliError
// carries its own exit code.
func finish(label string, code int, err error, errOut *ui.Output) int {
	if err == nil {
		return code
	}
	if ce, ok := err.(*errs.CliError); ok {
		code = ce.ExitCode
	} else if code == 0 {
		code = 1
	}
	// Printed directly, not through ErrorLine: that prefixes "kvarm: ",
	// which doubled the prefix into "kvarm: kvarm <label>: ...".
	errOut.Line(errOut.Red(fmt.Sprintf("kvarm %s: ", label)) + err.Error())
	if code == 2 {
		errOut.Line(errOut.Dim(fmt.Sprintf("run \"kvarm help %s\" for usage", label)))
	}
	return code
}

// englishList joins suggestions like a sentence: "a", "a, b", "a or b",
// "a, b or c".
func englishList(items []string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return "\"" + items[0] + "\""
	default:
		return "\"" + strings.Join(items[:len(items)-1], "\", \"") + "\" or \"" + items[len(items)-1] + "\""
	}
}

// pairs prefixes each suggestion with its group, for suggestions that are
// subcommands.
func pairs(group string, suggestions []string) []string {
	out := make([]string, 0, len(suggestions))
	for _, s := range suggestions {
		out = append(out, group+" "+s)
	}
	return out
}
