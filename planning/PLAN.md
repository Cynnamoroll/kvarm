# The fastest git platform on Cloudflare Artifacts

> **Historical document.** This is the original design plan of October 7,
> 2026, kept as a record of the starting point. It is superseded by
> [`docs/architecture.md`](../docs/architecture.md), which describes the system
> as built. The working names below (`slipstream`, `.slipstream/ci.yaml`) were
> never shipped: the platform is Kvarm, its CLI is `kvarm` and CI reads
> `.kvarm/ci.json`. Section numbers here are internal to this plan; source
> comments that cite "architecture §N" refer to `docs/architecture.md`.
>
> Status at the time (2026-10-07): the prototype was validated (git push and a
> byte-identical clone through the platform, SSR repository pages with edge
> cache hits, remote D1 and queues provisioned, 27/27 tests green).

Working name: **TBD** (name deferred; the codebase uses a single `SITE_NAME` config constant so renaming is trivial). A git platform for the agentic era, built for the Cloudflare "next Git platform" competition. Deadline: **October 14, 2026** (one week). Submission: 5-10 min video, permissively licensed source, run instructions.

Mission: take the proven learnings from GitHub, Cursor Continuity, and Namespace, apply them on top of Cloudflare Artifacts, and ship the fastest, most agent-native git forge possible.

---

## 1. What Artifacts gives us vs. what we build

Artifacts (open beta, Workers Paid plan) is the storage and git-serving layer. We do not reimplement any of it.

**Artifacts provides:**
- A git server (smart HTTP v0/v2, shallow clones, have/want negotiation, git-notes, delta-aware fetch) implemented as Zig-to-WASM inside Durable Objects, with R2 snapshots and KV tokens internally.
- Workers binding: `create`, `get`, `import`, `fork`, `delete`, `list`; repo capability: `info`, `log`, `readCommit`, `readTree`, `readBlob`, `readFile`, `createToken`, `revokeToken`, `listTokens`.
- REST API mirroring the binding (repo lifecycle, content reads, token lifecycle).
- Repo-scoped git tokens with TTL (`createToken(scope, ttl)`), revocable.
- Event subscriptions via Queues: `repo.created/deleted/forked/imported`, `repo.pushed` (with commit metadata), `cloned`, `fetched`, `token.created/revoked`.
- Workers Builds integration: build + deploy Workers straight from an Artifacts repo, branch previews included.
- Data jurisdiction, metrics API, import from any HTTPS git remote.

**Artifacts does NOT provide (so we build it):**
- Users, logins, sessions, personal access tokens.
- Public/private visibility (every Artifacts repo is token-gated).
- Web UI, code rendering, diff rendering.
- Pull requests, reviews, merges, ref writes, or object writes (verified: the REST/binding surface is read + repo lifecycle only, no commit creation).
- CI beyond Workers Builds, snapshot downloads, merge, code search.

---

## 2. Blog learnings mapped to decisions

| Source | Learning | What we do on Artifacts |
|---|---|---|
| Cloudflare Artifacts posts | Artifacts is a programmable primitive: create/fork repos per agent, mint tokens, react to events; ArtifactFS shows blobless clone + background hydration | Build the platform layer entirely on the binding + events. Fork-per-task workspaces with one API call. Our checkout CLI does snapshot-first clone with background `git fetch` hydration (ArtifactFS pattern). |
| Cursor "Git at any scale" (Continuity) | Don't distribute git; object store is the source of truth; replicas are warm caches; linearizable pushes; consistent reads; batch to absorb bursts | Artifacts already embodies the storage-side lesson (one DO per repo = strong consistency, R2-backed). Our layer applies the rest: the git proxy streams and never buffers packs; UI caches are purged by push events so reads-after-write are always consistent; event consumers batch (Queues); CI reads immutable snapshots from R2 instead of hammering the repo DO; merges run in async Workflows, never in the request path. |
| Namespace git snapshots | Prepare the repo + working tree once, ship the snapshot to runners; up to 6.5x faster checkouts | Artifacts does not expose its internal snapshots, so we build the equivalent: on push events, a Workflow materializes the working tree as a content-addressed tar in R2, plus a delta overlay for PR heads. CI and agent sandboxes check out via snapshot + overlay, zero git protocol involved. Benchmarked against `git clone`. |
| GitHub "shipping more CSS" | Zero-runtime CSS (CSS Modules, no CSS-in-JS) cut SSR time 55% | Hand-written static stylesheet shipped with the HTML, critical CSS inlined, no CSS-in-JS, no Tailwind runtime, no client framework. SSR is template literals + streaming; target single-digit-ms render CPU. |
| GitHub "rendering huge PRs" | Structure-first streaming, virtualized fixed-height rows, imperative recycled renderer, two geometries (deterministic code + dynamic comment blocks), scroll anchoring by identity, off-thread highlighting, perf probes asserted in tests | This is the blueprint for our diff surface, implemented to the letter: initial response is the file list from a tree-level diff (O(changed files), no blob reads); per-file content diffs fetched lazily and cached content-addressed by blob pair; virtualized client with typed-array geometry; a synthetic 1M-line PR fixture with asserted perf budgets in CI. |
| Cloudflare contest post | Not "GitHub with agents on top"; minimum bar is multiple agents working concurrently; get creative with coordination, comparison of simultaneous changes, and "why" context | Agent workspaces (fork + token per task), auto-opened change sets, a multi-candidate comparison view (N agent branches for the same task, diffed against base and each other), merge queue with batched merges, git-notes-based agent attribution showing the prompt/task behind each commit, and an MCP server so agents drive the platform programmatically. |

---

## 3. Architecture

One Worker application (single deployable, multiple entrypoints), plus a Node CLI.

```
                    ┌────────────────────────── Cloudflare edge ──────────────────────────┐
                    │                                                                    │
 git clone/push ───▶│  Git proxy route  ──stream──▶  Artifacts (DO + Zig WASM git server) │
 (PAT or anon)       │       │ auth, visibility, rate limit, token injection                │
                    │       ▼                                                             │
 browsers ─────────▶│  Web SSR (Hono, streaming HTML, static assets, edge cache)           │
                    │       │                                                             │
 agents/CLIs ──────▶│  REST API + MCP endpoint                                            │
                    │       │                                                             │
                    │  Queues ◀── Artifacts event subscriptions (pushed/cloned/forked/…)  │
                    │       │                                                             │
                    │  Workflows: snapshot-builder, ci-pipeline, merge, repo-import       │
                    │       │                                                             │
                    │  D1 (users, repos, change sets, checks, workspaces)                  │
                    │  R2 (working-tree snapshots, delta overlays, bundles, diff cache)    │
                    │  DOs (token cache, realtime hub, rate limiter, merge lock)           │
                    └────────────────────────────────────────────────────────────────────┘
                                          │
                     Node CLI: `slipstream checkout` (snapshot-first clone for agents/CI)
                              `slipstream agent` (pipeline runner, long-poll)
```

### 3.1 Git proxy (fast clones, never strains hardware)

- Route: `https://<host>/{owner}/{repo}.git/*` (same domain as the web app, GitHub-style; web paths simply lack `.git`).
- Smart HTTP v0/v2 passthrough: `info/refs`, `git-upload-pack`, `git-receive-pack`.
- Auth: PAT via basic auth for push and private reads. Anonymous reads for public repos use a cached read-only Artifacts token (minted via binding, TTL 1h, cached in a DO + Cache API, refreshed at ~50min; one mint per repo per hour).
- The proxy **streams both directions and buffers nothing**; all pack generation stays inside Artifacts' engine. Same-network Worker-to-Worker hops add ~1-3ms. Memory and CPU stay flat no matter how large the clone.
- `info/refs` for public repos is edge-cached (short TTL) and purged by push events, so clone bootstrapping skips a backend hop.
- Per-token DO rate limiting protects against abuse.

### 3.2 Snapshots (Namespace's trick, on R2)

- On `repo.pushed` events, the `snapshot-builder` Workflow walks the tree via the binding and writes:
  - `snapshots/{owner}/{repo}/{commit}.tar` - full working tree, content-addressed, immutable, edge-cacheable forever.
  - `manifest.json` - sha, size, file count, built-at.
  - Delta overlays for PR heads: only files changed vs base (from the tree diff), tiny.
  - Bundle snapshots for default-branch heads: full-history git bundles in R2, for cold-clone bootstrap.
- Workflow steps batch ~500 blobs each (subrequest limits), multipart upload to R2, retryable steps. Build once per push, reused by every CI job and sandbox start.
- Consumers:
  - CI runner checks out base snapshot + delta overlay (no `git clone`, no `git checkout`).
  - `slipstream checkout owner/repo --ref sha` for agents and sandboxes: download + extract snapshot, then hydrate real git metadata with a background `git fetch` (ArtifactFS pattern).
  - If the manifest is not ready yet, consumers fall back to a proxy clone (graceful degradation).

### 3.3 Diff engine (1M-LOC PRs)

Server:
- **Tree diff**: recursive comparison of tree entries by name + SHA. O(changed paths), zero blob reads. Returns the file list with statuses, modes, blob SHAs, and sizes. This is what the PR page's first paint uses, so a 1M-line PR with 2,000 files renders its structure as fast as a 20-line PR.
- **Blob diffs**: per-file, on demand, computed from the two blobs, cached in Cache API/R2 keyed by `(old_sha, new_sha)` (immutable, so cache hits are free forever). Myers diff with common prefix/suffix stripping; beyond a line budget, degrade to a structural summary plus line-range views (the same way GitHub degrades). Hunks stream as JSON: offsets and counts first, content behind them.
- Commit pages diff against `parents[0]`.

Client (implements the GitHub Copilot app contract):
- Virtualized rows, fixed line height, imperative recycled DOM, no per-row React, typed-array prefix-sum offsets.
- Two geometries: deterministic code rows + dynamic comment blocks with estimated-then-measured heights, idle/scroll-gated measurement passes, scroll anchoring by identity.
- Syntax highlighting off the main thread (Worker), text renders instantly plain.
- Per-file diff content fetched lazily as files approach the viewport.
- Permanent perf probes (mounted row count, frame time, correction distances, observer leaks) asserted headlessly against a synthetic 1M-line PR fixture.

### 3.4 Auth (WorkOS AuthKit, zero self-rolled auth)

All human authentication is delegated to WorkOS AuthKit: hosted sign-in/sign-up UI, email+password, Google/Microsoft social, magic auth, MFA, email verification, SSO if ever needed. We build no auth UI or credential storage.

- Integration via `@workos/authkit-session` (WorkOS' framework-agnostic toolkit: PKCE authorization flow, JWKS-verified JWTs, AES-256-CBC+HMAC sealed session cookie via iron-webcrypto, token refresh). We write only a thin Workers storage adapter over `Request`/`Response` cookie headers.
- Flow: unauthenticated request → `authService.createSignIn()` redirect to AuthKit → `/auth/callback` → `handleCallback()` seals the session cookie. Every request: `withAuth()` verifies. Sign out: `signOut()` redirect.
- First sign-in lazily provisions a D1 `users` row keyed by WorkOS user id (login derived from email, collision-suffixed).
- **Platform PATs** (`<prefix>_...`) remain ours by necessity (WorkOS does not issue git-over-HTTPS basic-auth tokens): minted in account settings, SHA-256-hashed in D1, scoped (repo read/write, api, ci). Used for git proxy basic auth, REST API, and MCP.
- Public repos: anonymous web reads (edge-cached), anonymous clone via the cached public-read Artifacts token.
- Required secrets: `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_REDIRECT_URI`, `WORKOS_COOKIE_PASSWORD`.

### 3.9 Deployment prerequisites (live build against user's account)

- Cloudflare: Workers Paid plan (Artifacts requirement), `wrangler login` by the user or a `CLOUDFLARE_API_TOKEN` with account scopes covering Workers Scripts, D1, R2, Queues, Workflows, KV, and Artifacts Read/Edit.
- WorkOS: an application in the WorkOS dashboard; redirect URI `https://<domain>/auth/callback`; client ID + API key provided as secrets.
- Bootstrap script provisions: Artifacts namespace, D1 database + migrations, R2 bucket, queues + Artifacts event subscription, first admin user.

### 3.5 Change sets (PRs), review, merge

- A change set = base ref + head ref + state + conversation. Opened from the web, REST, MCP, or auto-opened when an agent workspace pushes to its branch.
- Review comments anchor to (path, line, side); rendered inside the diff surface as dynamic blocks.
- Merges run in the `merge` Workflow (never in the request path):
  - Fast-forward: hand-rolled `git-receive-pack` ref update with an empty pack (tiny, ~30 lines of protocol code).
  - Three-way: merge-base via commit DAG walk (binding `readCommit`), recursive 3-way tree merge in TS, then construct new trees + merge commit and push a small pack. Git object construction is native in Workers: SHA-1 via `crypto.subtle`, deflate via `CompressionStream`. Conflicts mark the change set conflicted with a conflict list.
  - Merge queue: batch candidate merges, re-run required checks, land in order.
- Agent attribution: commits carry git-notes (task, prompt, session); the UI shows "why" next to each commit.

### 3.6 CI/CD

- **Workers Builds**: Workers-deployable repos connect to Workers Builds (Artifacts integration) for build + deploy + branch previews. The platform UI links the flow and shows build status; docs make this the zero-config CI/CD path for Worker projects.
- **General pipelines**: `.slipstream/ci.yaml` in the repo defines steps. On push, the `ci-pipeline` Workflow creates check runs; a `slipstream agent` runner (Node CLI, runs anywhere: laptop, VM, container) long-polls for jobs, checks out via **snapshot + overlay**, runs steps, streams logs back through the API. This demonstrates snapshot-accelerated CI end-to-end and generalizes to arbitrary stacks.
- Cloudflare Containers are noted as the managed-runner roadmap item (availability on the account unverified).
- Checks gate merges (required-checks policy), displayed on change sets and commits.

### 3.7 Agent coordination (the differentiator)

- **Workspaces**: `POST /api/v1/repos/{owner}/{repo}/workspaces` forks the Artifacts repo, mints a write token, returns `{remote, token, workspace_id}`. One call = one isolated agent task.
- **Multi-candidate view**: a task with N agent branches shows all candidates side by side, each diffed against base and each other, with checks and merge queue entries; pick a winner in one click.
- **MCP server** at `/mcp`: tools for `create_workspace`, `open_change`, `comment`, `get_diff` (structure-first, token-efficient), `list_candidates`, `merge`, `check_status`. Agents operate the platform programmatically.
- **Auto change sets**: pushes to `agent/*` branches auto-open draft change sets with attribution.

### 3.8 Web performance

- SSR everything, stream responses, zero client framework, one static stylesheet with critical CSS inlined, ~0 JS on content pages, small hand-rolled ES modules on the diff page.
- Public repo pages edge-cached (stale-while-revalidate) and purged by push events (read-after-write consistency).
- Blob view paginates huge files server-side; markdown (README) rendered server-side with a worker-safe renderer.

---

## 4. Data model (D1)

```
users(id, login, email, name, password_hash, created_at)
sessions(id, user_id, created_at, expires_at)
tokens(id, user_id, prefix, hash, scopes, name, created_at, last_used_at)
repos(id, owner_login, name, artifacts_name, visibility, default_branch,
      description, fork_parent_id, stars, created_at, pushed_at)
change_sets(id, repo_id, number, title, body, base_ref, head_ref, state,
      author_id, agent_meta, created_at, merged_at, merge_commit, checks_summary)
comments(id, change_set_id, user_id, path, line, side, body, created_at, resolved)
check_runs(id, repo_id, change_set_id, head_sha, name, status, conclusion,
      details_url, started_at, finished_at)
workspaces(id, repo_id, artifacts_name, task, agent, status, change_set_id, created_at)
snapshots(repo_id, sha, kind, r2_key, size, files, base_sha, state, built_at)
events(id, type, payload, processed_at)
settings(key, value)
```

---

## 5. Repo layout

```
README.md              submission-facing: quickstart, architecture, benchmarks
LICENSE                MIT
planning/              this plan, ADRs, video script
apps/platform/         the Worker: web SSR, REST API, MCP, git proxy, queue consumer,
                       scheduled, Workflows (snapshot-builder, ci-pipeline, merge), DOs
apps/cli/              slipstream: checkout (snapshot clone) + agent (CI runner)
packages/gitops/       smart-HTTP client ops: ref update push, object construction,
                       pack writer, tree diff, merge, tar builder
packages/diffcore/     Myers/histogram diff, hunk model, line budgeting
packages/ui/           SSR component helpers + the CSS system + diff client modules
scripts/              bootstrap (namespace/D1/R2/queue/event-sub setup), fixtures
                       (1M-LOC generator), benchmarks (clone vs snapshot, diff perf)
```

Tooling: npm workspaces, TypeScript strict, wrangler (deploy + local dev with `remote = true` Artifacts binding), vitest + `@cloudflare/vitest-pool-workers` for tests, tsc for typecheck.

---

## 6. Performance budgets (asserted, not vibes)

| Metric | Budget |
|---|---|
| Public page TTFB (edge cache hit) | < 50 ms |
| Public page TTFB (cold SSR) | < 300 ms |
| PR page initial render (2,000-file PR) | O(files), first paint < 1 s; independent of total LOC |
| Diff scroll on 1M-line PR | 60 fps, ~100 mounted rows, no scroll jumps |
| Clone overhead added by proxy | < 5 ms p99 vs direct Artifacts remote |
| Snapshot CI checkout (1M LOC) | target ~5x faster than git clone+checkout (measured) |
| Worker CPU per web request | < 10 ms |

Benchmarks live in `scripts/bench` and run in CI where feasible; the diff perf budgets run headlessly against the synthetic fixture (the GitHub post's probe discipline).

---

## 7. Milestones (today Oct 7, deadline Oct 14)

- **M0 (Oct 7-8)** Scaffold: monorepo, wrangler config, D1 migrations, types, CI lint/test script, LICENSE.
- **M1 (Oct 8)** Auth + registry + git proxy: signup/login/PATs, repo create/import (Artifacts binding), clone/push through the proxy with PATs, anonymous public clone, private enforcement. Acceptance: real `git clone`/`push` through our domain.
- **M2 (Oct 9)** Web SSR: tree/blob/log/commit pages, README rendering, CSS system, streaming, edge cache + push-event purge. Parity breadth starts here: profiles, repo list/search, stars.
- **M3 (Oct 10)** Diff: tree-diff API, per-file cached diffs, virtualized diff client with probes, 1M-LOC fixture + headless perf test.
- **M4 (Oct 11)** Events + snapshots: event subscription wiring, snapshot-builder Workflow, R2 layout, `checkout` CLI, clone-vs-snapshot benchmark.
- **M5 (Oct 12)** CI + merges: pipeline engine + `agent` runner, checks UI, Workers Builds flow, FF + 3-way merge + merge queue.
- **M6 (Oct 13)** Agent layer + parity finish: workspaces, auto change sets, candidate compare UI, MCP server, notes attribution; issues, forks network UI, GitHub import UI, PAT settings page.
- **M7 (Oct 13-14)** Hardening, benchmarks, README, video script + demo storyboard, submission package.

---

## 8. Risks and mitigations

- **No write API in Artifacts** (verified): merges and ref updates go through hand-rolled smart-HTTP ops in `packages/gitops`. Small, fully unit-testable; isomorphic-git kept as a cross-check reference, not a runtime dependency.
- **Snapshot builds for giant trees** hit subrequest limits: Workflow steps batch blob reads; consumers degrade to proxy clone when the manifest is not ready.
- **Artifacts beta limits** (ops/sec, blob sizes, event lag): Workflows with retries + exponential backoff; token caches; rate limits at the proxy.
- **Workers Builds programmatic connection** may be dashboard-only: bootstrap script documents the manual connect step; our own checks still run on every push.
- **Event subscription setup** needs a one-time account-level configuration: `scripts/bootstrap.sh` automates it via the REST API.
- **Week deadline**: blame, code search, releases, and orgs remain out of scope for v1 and are listed as roadmap; issues, profiles, forks UI, and import are in scope (parity breadth is a chosen must-have) and scheduled into M2/M6.

---

## 9. Resolved decisions (user sign-off, Oct 7)

1. **Deployment**: build live against the user's Cloudflare account; they authenticate wrangler (or provide an API token). Local unit tests run on Miniflare in the meantime.
2. **Scope**: all four showcase areas are must-haves: agent concurrency, raw speed, agent APIs, and GitHub-parity breadth.
3. **Auth**: WorkOS AuthKit for everything human (no self-rolled sign-in); platform PATs only for git/API/MCP machine access.
4. **Name**: deferred; single `SITE_NAME` config constant, decided before submission.
