package help

import (
	"fmt"
	"strings"

	"kvarm/cli/internal/executor"
	"kvarm/cli/internal/ui"
)

// The special commands' help screens: the same content the JS CLI carried,
// organized into sections. The words are the contract; sections and color
// are presentation.

// Checkout renders `kvarm checkout --help`.
func Checkout(out *ui.Output) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s\n\n", out.Bold("kvarm checkout — materialize a ref into a directory"))
	b.WriteString(out.Bold("Usage:") + "\n  kvarm checkout <owner/repo> <ref> <dir>\n\n")

	b.WriteString(out.Bold("What it does") + "\n")
	b.WriteString(strings.TrimPrefix(`
Materializes <ref> (branch, tag or commit SHA) into <dir>, which must be
missing or empty.

With KVARM_PAT set, checkout demands the snapshot (POST .../snapshots/<ref>),
which starts a build for a ref that has none (non-default branches and
workspace refs build lazily, only on demand). If the snapshot is ready it is
downloaded and extracted and checkout prints "source: snapshot". Otherwise,
including while the demanded build is still running, it falls back to
"git clone" + "git checkout" and prints "source: clone"; a later checkout of
the same ref uses the snapshot once it is ready. Without KVARM_PAT checkout
only reads snapshot metadata and never starts a build.
`, "\n") + "\n")

	b.WriteString(out.Bold("Output") + "\n")
	b.WriteString(strings.TrimPrefix(`
stdout starts with "source: snapshot|clone" and "sha: <commit>" (plus
"files:", "bytes:", "transfer:" and "encoding:" for a snapshot). The reason
for a fallback goes to stderr. Exit status is 0 on success, 1 on failure and
2 on usage errors.
`, "\n") + "\n")

	b.WriteString(out.Bold("Snapshots have no git history") + "\n")
	b.WriteString(strings.TrimPrefix(`
A snapshot holds the tree only: there is no .git directory and no history.
To commit and push from a snapshot directory, attach it to the repository
first, for example:

  cd <dir>
  git init -q
  git remote add origin "$KVARM_BASE_URL/<owner>/<repo>.git"
  git fetch -q origin <sha>          # the sha printed by checkout
  git reset -q <sha>                 # index and HEAD at <sha>, files untouched
  git switch -q -c <new-branch>      # then commit and push as usual

"git status" is clean right after the reset because the snapshot tree equals
the commit tree.
`, "\n"))
	return b.String()
}

// Runner renders `kvarm runner --help`.
func Runner(out *ui.Output) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s\n\n", out.Bold("kvarm runner — claim and run CI jobs on this machine"))
	fmt.Fprintf(&b, "%s\n  kvarm runner --repo <owner/repo> [--once] [--drain] [--fresh] [--workdir <dir>]\n", out.Bold("Usage:"))
	b.WriteString("                    [--trust humans|all|none] [--executor auto|host|container]\n")
	b.WriteString("                    [--container-runtime docker|podman] [--image <image>] [--network <name>]\n")
	b.WriteString("                    [--cpus <n>] [--memory <size>] [--pids-limit <n>]\n")
	b.WriteString("                    [--container-user <uid:gid>|image]\n\n")

	b.WriteString(out.Bold("What it does") + "\n")
	b.WriteString(strings.TrimPrefix(`
Claims CI jobs for the repository, materializes each job's exact immutable
commit through snapshot checkout (with clone fallback), runs the configured
command, heartbeats the 120-second lease, and reports a bounded summary.
The command runs only because the user explicitly started this runner.
--once exits after one job, or immediately when none is queued; --drain keeps
claiming until the queue is empty and then exits, for batch runners that
should stop on their own. The token must have the ci scope.
`, "\n") + "\n")

	b.WriteString(out.Bold("Execution trust") + "\n")
	b.WriteString(strings.TrimPrefix(`
Repository commands are code from whoever pushed the commit, often an agent.
Before running a job the runner decides from the claim's provenance whether
it may run on this host:

  --trust humans   (default) the exact head of a change a human opened, on a
                    ref no agent token may push, runs on the host;
                    agent-authored changes, agent-writable refs,
                    platform-prepared merge commits and anything unknown are
                    untrusted
  --trust none     no job is trusted
  --trust all      every job runs on the host, with a warning per job

Untrusted jobs run in a container (--executor auto, the default) or are
refused when no container runtime answers; --executor host refuses them,
--executor container isolates every job. A refused job is reported as a
failure whose summary says why; it is never skipped or left claimed. On the
host the command sees only PATH, HOME, LANG, LC_*, TZ and TMPDIR, but keeps
this user's files and network: environment filtering is not a sandbox.
`, "\n") + "\n")

	b.WriteString(out.Bold("Container executor") + "\n")
	b.WriteString(fmt.Sprintf(strings.TrimPrefix(`
docker, else podman, or --container-runtime: a fresh container per job (--rm)
from --image (default %s; pin a patch tag or digest for reproducible jobs),
the job's working directory bind-mounted at %s as the only writable host
mount, a read-only root with a private /tmp, all capabilities dropped, no
privilege escalation, this user's uid:gid (--container-user image keeps the
image's user), --cpus %s, --memory %s and --pids-limit %s by default, and the
runtime's default network unless --network is set (--network none cuts it
off; installs then need a warm workdir). host and container:<name> networks
are refused. A timeout kills the container. Container jobs use their own
working directories (<workdir>-container), so they never share files with
host jobs.
`, "\n"), executor.DefaultImage, executor.ContainerWorkdir, executor.DefaultCPUS, executor.DefaultMemory, executor.DefaultPidsLimit) + "\n")

	b.WriteString(out.Bold("Working directories") + "\n")
	b.WriteString(strings.TrimPrefix(`
Jobs run in a persistent working directory per repository, locked to this
runner process (a concurrent runner uses another one), under --workdir
(default $XDG_CACHE_HOME/kvarm/runner, else ~/.cache/kvarm/runner). The
first job checks out fully; later jobs sync the directory to the new commit:
tracked files are rewritten exactly, files the new commit lacks are deleted,
and other untracked paths are removed except dependency caches (node_modules,
.venv, venv, target, .cache, .gradle, .turbo, __pycache__, .pytest_cache,
.mypy_cache, .tox), so installs do not repeat. Any sync error falls back to
a full checkout. --fresh rematerializes every job from an empty directory.
`, "\n"))
	return b.String()
}

// Status renders `kvarm status --help`.
func Status(out *ui.Output, limits StatusLimits) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s\n\n", out.Bold("kvarm status — one read-only view of a repository's live state"))
	b.WriteString(out.Bold("Usage:") + "\n  kvarm status <owner/repo> [--json]\n\n")
	b.WriteString(strings.TrimPrefix(`
Read-only status of a repository: its active workspaces with their pinned
dependencies (state active, stale, broken or satisfied), the integration
train (entries per target branch, positions, and the waiting reason of an
entry held back by a pin) and the open agent tasks.

arguments:
  <repo>                       Repository as owner/name
  --json                       print the status as one line of JSON (default: indented JSON)

Reads only: GET workspaces?status=active, GET workspaces/:id/dependencies
(for up to `, "\n"))
	fmt.Fprintf(&b, "%d active workspaces), GET train, GET tasks?status=open.\n", limits.DependencyReads)
	b.WriteString(strings.TrimPrefix(`
For the full lists use "kvarm workspace list", "kvarm deps list",
"kvarm train status" and "kvarm task list".

Exit status: 0 success; 1 API or network failure (with --json the error body
{status, error, code, ...} is printed on stdout); 2 usage error.
`, "\n"))
	return b.String()
}

// StatusLimits is the read budget the status screen reports.
type StatusLimits struct {
	DependencyReads int
}
