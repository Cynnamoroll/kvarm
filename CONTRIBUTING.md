# Contributing to Kvarm

Thanks for helping build Kvarm. This guide covers setting up a fresh clone without any credentials, the gate every change passes, how Kvarm's own CI runs that gate, and how to write commits and pull requests. Coding agents should also read [AGENTS.md](AGENTS.md); people and agents follow the same rules.

By contributing you agree that your work is released under the [MIT License](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

## Fresh clone, no credentials

Everything below runs against local state; only `npm ci` uses the network, to download dependencies. You need Node 20 or later, npm, and git with `user.name` and `user.email` set (several tests create commits in temporary repositories with your configured identity). You do not need a Cloudflare account, a login or anyone's token.

```sh
git clone https://github.com/kvarm-git/kvarm.git && cd kvarm
npm ci                                                 # npm may say it skipped workerd/esbuild install scripts; the binaries work
npm run db:migrate:local --workspace apps/platform     # every migration, applied to the local D1 under apps/platform/.wrangler
npm run typecheck && npm run lint && npm run test -- --maxWorkers=3
```

To run the Worker locally, use the offline configuration `apps/platform/wrangler.dev.jsonc`. It drops the Artifacts binding, which only exists remotely, so routing, authentication, the REST API over D1, the pages that need no repository content and the static assets all work, while anything that reads git content answers with an error.

```sh
cd apps/platform && npx wrangler dev -c wrangler.dev.jsonc --port 8787     # leave running
curl -s http://localhost:8787/healthz                                       # ok
```

Tokens are always ones you mint yourself. `scripts/mint-pat.mjs --local` creates a user and a personal access token in the local D1 and writes the token only to a gitignored env file (`.env.local` at the repository root); it prints the token prefix, never the token.

```sh
node scripts/mint-pat.mjs --local --login dev --scopes read,write,api,ci --name local --token-file .env.local --key KVARM_PAT
set -a; . ./.env.local; set +a
curl -s -H "Authorization: Bearer $KVARM_PAT" http://localhost:8787/api/v1/user     # {"login":"dev",...}
```

`node scripts/bootstrap.mjs --local` prints the Cloudflare resources a new account would get and applies the local migrations through the offline configuration; it contacts no account. Deploying your own instance is covered in the README under [Deploy from zero](README.md#deploy-from-zero).

## The gate

Three commands, all from the root `package.json`. Every one must exit 0 before you push.

| check | command |
| --- | --- |
| typecheck | `npm run typecheck` |
| lint | `npm run lint` |
| test | `npm run test -- --maxWorkers=3` |

The `packages` test project runs in Node; the `platform` project runs the Worker in workerd with a real local D1 and in-memory Artifacts fakes. Live behavior against real Artifacts is covered by the drivers in `scripts/*-e2e.mjs`, which need a deployment of your own (see the README).

## Kvarm CI: the gate runs on Kvarm

Kvarm hosts its own gate. There is no GitHub Actions workflow and no other third-party CI in this repository, by design: the project uses its own platform so gaps show up where its users would hit them.

[`.kvarm/ci.json`](.kvarm/ci.json) declares three required jobs, `typecheck`, `lint` and `test`, each running the gate command above after an `npm install` (fast once a warm runner working directory holds `node_modules`). A runner job works in a snapshot of the commit, which has no `.git` directory; the `test` job runs `git init -q` first because two tests read git metadata (`git ls-files` in the architecture citation audit, `git check-ignore` in the gitignore test). When a change request is opened or its head moves on a Kvarm deployment, the platform reads `.kvarm/ci.json` at the exact head commit and queues one check run per job. A user-owned `kvarm runner` claims each job, checks out that commit from a snapshot, runs the command and reports the result. The change's checks, its commit status and its mergeability then show the verdict, and a change whose required checks have not all succeeded cannot merge. `scripts/test/ciConfig.test.ts` validates the file against the platform's CI schema in the ordinary test run.

`scripts/dogfood-ci.mjs` drives the whole loop for one change of this repository against a Kvarm deployment you can push to:

```sh
set -a; . ./.env.local; set +a       # KVARM_BASE_URL, KVARM_USER, KVARM_PAT with read, write, api and ci scopes
node scripts/dogfood-ci.mjs --repo kvarm --create --base origin/main --head HEAD
```

It pushes `--base` to the Kvarm repository's `main` (fast-forward only) and `--head` to a `dogfood/<sha>` branch, opens a change request, waits for the platform to queue the jobs, runs `kvarm runner --once` until they finish, and prints the check runs, the commit status and the mergeability. It exits 0 only when every check succeeded and the change is mergeable. Pass `--workdir <dir>` to keep the runner's warm working directory between runs.

The runner keeps its default execution trust, `--trust humans`: the change is opened with your `KVARM_PAT`, so with a personal access token its head runs on your machine. A change opened by an agent token is untrusted and runs in a container, or is refused and reported as a failure when neither docker nor podman is running. `--trust` and `--executor` are passed through to the runner; `--executor container` runs the whole gate isolated in the `node:24-bookworm` image. See [SECURITY.md](SECURITY.md#ci-runner-threat-model) for what each mode protects.

Pull requests on GitHub do not trigger Kvarm CI automatically yet. Until they do, a maintainer runs each pull request's head through `scripts/dogfood-ci.mjs` and posts the result on the pull request.

## Commits and pull requests

### Commits

- **One coherent change per commit.** A commit builds, passes the gate and makes sense on its own. Keep mechanical changes (renames, generated output) apart from behavior changes.
- **Subject:** `<scope>: <summary>`, in the imperative or as a short noun phrase, without a trailing period, about 72 characters at most. The scope is the area you changed: a package or app (`gitops`, `review`, `ops`, `cli`, `platform`), a subsystem (`queue`, `ci`, `nexus`, `mcp`) or `docs`, `scripts`, `tests`. Examples: `queue: release the publication lease on stale generations`, `cli: warm workdir keeps nested node_modules`, `docs: contribution guide and Kvarm CI`.
- **Body:** say why the change is needed and what behavior changes, wrapped at about 72 characters. Name new budgets, migrations, configuration or breaking changes explicitly.
- **Attribution:** if an agent wrote part of the change, add a `Co-authored-by:` trailer for it. Do not override the git author or committer identity in scripts or tests.
- **History:** never force-push or rewrite a branch that others have fetched, including `main`.

### Pull requests

- **Scope:** one concern per pull request. A fix, a feature or a refactor, not all three. Split large work into a reviewable series.
- **Tests:** new behavior comes with tests, written to fail first; a bug fix comes with a test that reproduces it. Pure logic is tested in Node under `packages/*/test`, `apps/cli/test` or `scripts/test`; platform behavior in workerd under `apps/platform/test`.
- **The required gate:** the three gate commands pass locally, and the pull request's head passes Kvarm CI (`typecheck`, `lint` and `test` check runs succeeded and the change is mergeable). Put the `scripts/dogfood-ci.mjs` summary in the pull request.
- **Description:** what changed and why, how you verified it (commands and their results), and anything a reviewer should look at closely. For an endpoint you added or changed, give its measured `x-kvarm-cost` and how it fits the budget model in [architecture §10](docs/architecture.md#10-cost-metering-and-budgets).
- **Schema:** D1 changes are a new numbered migration that only adds. Applied migrations are never edited.
- **Docs:** update the README, `docs/architecture.md` or `apps/cli/README.md` when you change behavior they describe.
- **No secrets or personal data:** no tokens, `.env*` or `.dev.vars*` files, account IDs, personal URLs or emails.

### Naming boundaries

Kvarm is the project's only name. Brand-bearing identifiers use it exactly: `@kvarm/*` packages, the `kvarm` CLI and `KVARM_*` variables, `kvarm_pat_`/`kvarm_agt_` tokens, `kvarm/guard`, `kvarm/ci-config` and `kvarm/checks-window` checks, `.kvarm/ci.json`, `x-kvarm-*` headers, `refs/notes/kvarm-attribution`, `refs/heads/kvarm-ci/**`, and the `kvarm-*` Cloudflare resources in `apps/platform/wrangler.jsonc`. Do not introduce another brand or alias.

Some identifiers are stable interfaces and never change in a pull request: the REST prefix `/api/v1`, the MCP endpoint `/mcp`, every MCP tool name, the agent workspace refs `refs/heads/agents/**` and the Artifacts namespace `default`. [AGENTS.md](AGENTS.md#names-kvarm-and-what-never-changes) has the full list.

## Issues

Bugs and feature requests go in GitHub issues on [kvarm-git/kvarm](https://github.com/kvarm-git/kvarm/issues). For a bug, include what you ran, what you expected and what happened, plus the `x-kvarm-cost` header or the CLI's error line when there is one. Never paste tokens.
