# AGENTS.md

Guidance for coding agents (and the people driving them) working in the Kvarm repository. Human contributors should read [CONTRIBUTING.md](CONTRIBUTING.md) as well; it holds the commit and pull-request guide this file refers to.

Kvarm is a git platform for teams of people and coding agents, built as one Cloudflare Worker on Cloudflare Artifacts. [`docs/architecture.md`](docs/architecture.md) explains the design; source comments cite its numbered sections ("architecture §11.4").

## Repository map

| path | what lives there |
| --- | --- |
| `apps/platform/src/routes` | thin HTTP adapters: the git gate (`git.ts`), the REST API (`api.ts`, `api/`), pages and auth |
| `apps/platform/src/mcp` | the MCP server (`server.ts`); tools come from the operation registry |
| `apps/platform/src/services` | all platform behavior: access, changes, merge, queue, checks, CI, workspaces, Nexus intents, candidates, reviews, tasks |
| `apps/platform/src/do`, `workflows`, `containers` | Durable Objects, Workflows and the Container CI runner (opt-in hosted drain and the single-run showcase) |
| `apps/platform/migrations` | D1 schema as numbered SQL migrations |
| `apps/platform/test` | workerd tests (real D1, in-memory Artifacts fakes) |
| `apps/cli` | the `kvarm` CLI: snapshot checkout, user-owned CI runner, every registry operation |
| `packages/gitops` | packfile writer, receive-pack client, merge base, three-way merge, tar writer, notes |
| `packages/diffcore` | tree and line diffs with work budgets |
| `packages/review` | risk classification, change rating and the `kvarm/guard` rules |
| `packages/issues` | issue references in change text and branch names, issue fingerprints |
| `packages/ops` | the operation registry: each entry is a REST endpoint, an MCP tool and a CLI command |
| `packages/ui` | server-side rendering helpers for the existing pages |
| `scripts` | ops scripts (`bootstrap.mjs`, `mint-pat.mjs`, `wrangler-target.mjs`), live drivers (`*-e2e.mjs`, `dogfood-ci.mjs`), benchmarks; pure helpers in `scripts/lib`, Node tests in `scripts/test` |
| `.kvarm/ci.json` | this repository's own CI jobs, run by Kvarm CI |
| `docs` | architecture, benchmarks, license inventory |

## The gate

These are the root `package.json` scripts. Run all three before you commit; all must exit 0.

```sh
npm run typecheck                  # tsc over packages and scripts, the Worker, and the CLI
npm run lint                       # oxlint
npm run test -- --maxWorkers=3     # vitest: `packages` (Node) and `platform` (workerd) projects
```

Narrower loops while you work: `npx vitest run --project packages`, `npx vitest run --project platform`, or a single file (`npx vitest run scripts/test/ciConfig.test.ts`). No Cloudflare account or token is needed for any of them.

The same three commands are the jobs of [`.kvarm/ci.json`](.kvarm/ci.json). The repository's only automated gate is Kvarm's own CI: a change pushed to a Kvarm deployment gets those jobs as check runs, a `kvarm runner` claims and reports them, and the change's checks and mergeability show the result (`node scripts/dogfood-ci.mjs`, see CONTRIBUTING.md). There is no GitHub Actions workflow or any other third-party CI here, and none should be added.

## Conventions

- **TypeScript, strict**, with `noUncheckedIndexedAccess`. The CLI and scripts are plain ESM JavaScript with JSDoc or `.d.mts` declarations; keep a script's declaration file in step with it.
- **Thin adapters.** Routes and MCP tools only adapt requests. Behavior goes in `apps/platform/src/services/*`; pure algorithms go in `packages/*` and are tested in Node. New operations are added once, in `packages/ops/src/index.js`.
- **Service results.** Service functions return `ServiceResult<T>` (`{ok: true, value}` or `{ok: false, status, error, code}`). API errors are `{"error": "...", "code": "..."}` JSON. JSON is camelCase; timestamps are ISO 8601 UTC.
- **Storage rules.** Artifacts is the only git store: read through the binding, write only through the receive-pack client in `packages/gitops`. D1 holds the registry and state, never file content. Schema changes are new numbered migrations (`apps/platform/migrations/00NN_*.sql`) that only add; never edit an applied migration.
- **Budgets.** Every walk has read, size and time budgets and returns `truncated` rather than failing. Every response carries an `x-kvarm-cost` work counter; keep new endpoints within the budget model of architecture §10 and state their measured `x-kvarm-cost` in the change request.
- **Tests.** Node tests in `packages/*/test`, `apps/cli/test` and `scripts/test`; workerd tests in `apps/platform/test`, with fakes for Artifacts (the real binding is exercised by the live drivers). Write the failing test first for new behavior.
- **Comments** explain a reason the code cannot show: a constraint, an invariant, a workaround. Do not narrate the code.
- **Formatting.** There is no formatter config. Do not run a formatter over whole files; match the surrounding style.
- **Secrets.** Never commit tokens or `.env*`/`.dev.vars*` files (only the `*.example` templates are tracked). Live drivers read tokens from the environment, pass them to git through a secret-free `GIT_ASKPASS` with `-c credential.helper=`, and never print them.
- **Git identity.** Scripts and test fixtures never override the git author or committer (`-c user.name`, `GIT_AUTHOR_*` and the like).
- **No personal data.** No owner URLs, account IDs, emails, machine paths or live resource IDs in tracked files; deployment targets come from `apps/platform/.env.deploy` or the environment.

## Names: Kvarm, and what never changes

The project, its packages and every brand-bearing identifier are Kvarm. Use exactly these names and add no other brand or alias:

- packages `@kvarm/*`; the `kvarm` CLI and its `KVARM_*` environment variables; tokens `kvarm_pat_…` and `kvarm_agt_…`
- platform check names `kvarm/guard`, `kvarm/ci-config`, `kvarm/checks-window` (CI job names may not start with `kvarm/`); CI configuration `.kvarm/ci.json`
- response headers `x-kvarm-*`; attribution notes `refs/notes/kvarm-attribution`; the platform-reserved CI staging namespace `refs/heads/kvarm-ci/**`
- Cloudflare resources as named in `apps/platform/wrangler.jsonc`: worker `kvarm-platform`, D1 `kvarm`, R2 `kvarm-snapshots`, queues `kvarm-events` and `kvarm-events-dlq`, and the Artifacts subscription `kvarm-artifacts-pushed`

These identifiers are stable interfaces and carry no brand. Never rename them:

- the REST prefix `/api/v1` and the MCP endpoint `/mcp`
- every MCP tool name (`list_repos`, `merge_change`, `enqueue_change`, …; the registry in `packages/ops/src/index.js`)
- agent workspace refs `refs/heads/agents/<workspaceId>/<slug>` (platform-reserved, like `refs/heads/kvarm-ci/**`; human pushes to both are rejected)
- the Artifacts namespace `default`

"Nexus" is the name of the coordination subsystem (intents and the overlap forecast), not a brand.

## Working in parallel

Several agents may work on this repository at once. Split the work like this:

- **Parallel is fine for read-only work:** exploring the code, reading docs, reviewing a diff, planning, and running read-only analysis (`rg`, `git log`, `npx tsc --noEmit` on an unchanged tree).
- **Single-threaded, one at a time:** anything that mutates the repository or shared state. That means editing files in one working tree, committing, running the full gate, applying migrations, deploying, and running the live drivers against a shared deployment. Two agents editing the same checkout or running the gate over each other's half-written changes produce failures neither can explain.
- **Parallel writers use separate worktrees.** If several agents must write at once, give each a linked worktree (`git worktree add ../kvarm-<task> -b <task>`) on its own short-lived branch, with disjoint files. One owner integrates the branches and runs the full gate over the result before anything lands. Lanes never deploy.
- **Live drivers create their own repositories** on the deployment they target and delete them afterwards. The shared transport in `scripts/lib/live.mjs` keeps at most 5 HTTP requests and 3 git processes in flight and honors `429 Retry-After`; do not raise those limits to go faster, and do not run two load-heavy drivers at once.

## Commits and pull requests

Follow the guide in [CONTRIBUTING.md](CONTRIBUTING.md#commits-and-pull-requests): one coherent change per commit, a `<scope>: <summary>` subject, the gate green before you push, and a change request that passes Kvarm CI. Do not rewrite published history.
