# Mission Validation-Readiness — Forge (live deployed surface)

Verification run: 2026-10-07 21:21 UTC, against the live worker
`https://forge-platform.<subdomain>.workers.dev`. Companion to
`planning/readiness/dependency-readiness.md` (which verified D1 / R2 / Queues /
Artifacts / MCP SDK / test pool — not repeated here). This run was strictly
read-only: no deploy, no migration, no push, no source modification, no commit.
All timings from `curl -w` (first uncached hit includes DNS+TLS unless noted).

## Surface inventory

### Route map (read from source: `apps/platform/src/index.ts`, `routes/*.ts`)

| Surface | Exact path | Auth |
|---|---|---|
| Health | `GET /healthz` | none |
| Home | `GET /` | none (landing); dashboard needs session |
| WorkOS auth | `GET /auth/sign-in`, `/auth/callback`, `/auth/sign-out` | — (**503 on live**, secrets unset) |
| API | `GET /api/v1/user`, `GET/POST /api/v1/user/tokens`, `DELETE /api/v1/user/tokens/:id`, `GET/POST /api/v1/repos`, `POST /api/v1/import`, `GET/PATCH/DELETE /api/v1/repos/:owner/:repo`, `POST /api/v1/repos/:owner/:repo/forks` | Bearer PAT (scope `api`) or session |
| Repo pages | `GET /:owner/:repo` (tree), `/tree/:ref{.+}`, `/blob/:ref{.+}`, `/raw/:ref{.+}`, `/commits`, `/commit/:sha`, `/branches` | public repo: anonymous OK |
| Repo admin | `GET/POST /:owner/:repo/settings`, `POST /:owner/:repo/delete` | owner **session** only → **404 for anon** (deliberate, no session possible on live) |
| Web forms | `POST /new-repo`, `POST /import-repo`, `GET/POST /settings/tokens`, `POST /settings/tokens/:id/delete` | session only → unusable on live |
| Git smart-HTTP | `/{owner}/{repo}(.git)/{info/refs\|git-upload-pack\|git-receive-pack\|HEAD\|objects/...}` | public repo: anonymous read; PAT (basic) for private read + all write; rate limit 600 reads/min, 120 writes/min per identity |

Edge cache (`cache/edge.ts`): anonymous public tree/blob/raw pages cached via
`caches.default` — 60 s TTL on branch refs, 1-year immutable on commit-SHA refs;
`info/refs` for public repos cached 30 s (`routes/git.ts:121`). Client-visible
signals: `x-forge-cache: hit` on app-cache hits (misses return **no**
`x-forge-cache` header to the client), plus `cf-cache-status`/`age`.

### Live probe results (all against the deployed worker)

| URL | Status | Total time | Notes |
|---|---|---|---|
| `https://forge-platform.<subdomain>.workers.dev/healthz` | 200 | 0.406 s | body `ok`; DNS 0.11 s + TLS 0.32 s included |
| `https://forge-platform.<subdomain>.workers.dev/` | 200 | 0.378 s | anonymous landing HTML renders (`<title>Home · Forge</title>`) |
| `https://forge-platform.<subdomain>.workers.dev/<owner>/forge-e2e` | 200 | 1.415 s (miss) → 0.38 s-class (hit) | tree page; `x-forge-cache: hit`, `cf-cache-status: HIT`, `cache-control: public, max-age=60`, `age: 2–3` on repeat |
| `https://forge-platform.<subdomain>.workers.dev/<owner>/forge-e2e/branches` | 200 | 1.920 s | uncached |
| `https://forge-platform.<subdomain>.workers.dev/<owner>/forge-e2e/commits` | 200 | 0.537 s | |
| `https://forge-platform.<subdomain>.workers.dev/<owner>/forge-e2e/commit/1da064aec583141a5e2836affe43c7af285e6c6b` | 200 | 0.501 s | commit-SHA ref → immutable-cached class |
| `https://forge-platform.<subdomain>.workers.dev/<owner>/forge-e2e/tree/main/src` | 200 | 0.656 s | subdir tree |
| `https://forge-platform.<subdomain>.workers.dev/<owner>/forge-e2e/blob/main/README.md` | 200 | 0.552 s | |
| `https://forge-platform.<subdomain>.workers.dev/<owner>/forge-e2e/raw/main/README.md` | 200 | 0.870 s (miss) → 0.460 s (hit) | hit 2: `x-forge-cache: hit`, `cf-cache-status: HIT`, `max-age=60` |
| `https://forge-platform.<subdomain>.workers.dev/<owner>/forge-e2e/raw/main/src/hello.ts` | 200 | 0.580 s | content verified (TS source served) |
| `https://forge-platform.<subdomain>.workers.dev/<owner>/forge-e2e/raw/1da064aec583141a5e2836affe43c7af285e6c6b/README.md` | 200 | 0.535 s | `cache-control: public, max-age=31536000, immutable` |
| `https://forge-platform.<subdomain>.workers.dev/<owner>/does-not-exist` | 404 | — | correct not-found for unknown repo |
| `https://forge-platform.<subdomain>.workers.dev/definitely/not/a/route` | 404 | — | |
| `https://forge-platform.<subdomain>.workers.dev/auth/sign-in` | **503** | — | body: `auth is not configured: set WORKOS_CLIENT_ID, WORKOS_API_KEY and WORKOS_COOKIE_PASSWORD (see apps/platform/.dev.vars.example)` |
| `https://forge-platform.<subdomain>.workers.dev/<owner>/forge-e2e/settings` (anon) | 404 | — | deliberate owner-only 404 (`repoPages.ts:566-568`), not a redirect |
| `https://forge-platform.<subdomain>.workers.dev/api/v1/user` + `Authorization: Bearer <PAT>` | 200 | 0.267 s | `{"user":{"login":"<owner>","name":"<Owner>","isAdmin":1},"via":"pat"}` |
| `https://forge-platform.<subdomain>.workers.dev/api/v1/user` (anon) | 401 | — | correct |
| `https://forge-platform.<subdomain>.workers.dev/api/v1/repos` + Bearer PAT | 200 | 0.288 s | lists `<owner>/forge-e2e`, `cloneUrl` = `https://forge-platform.<subdomain>.workers.dev/<owner>/forge-e2e.git` |
| `https://forge-platform.<subdomain>.workers.dev/api/v1/repos/<owner>/forge-e2e` + Bearer PAT | 200 | 0.283 s | |
| `https://forge-platform.<subdomain>.workers.dev/<owner>/forge-e2e.git/info/refs?service=git-upload-pack` | 200 | 0.409 s / 0.442 s | `cf-cache-status: HIT`, `cache-control: public, max-age=30`, `age: 25` — clone bootstrap edge-cached as designed |

Evidence snippet (tree page, second hit):

```
HTTP/2 200
cf-cache-status: HIT
age: 2
cache-control: public, max-age=60
x-forge-cache: hit
```

### Auth model on live (important for validation design)

- **Session cookie auth is unavailable on the live worker** (no WorkOS secrets).
  Every session-only surface — sign-in, dashboard, `/new-repo`, `/import-repo`,
  `/settings/tokens`, repo settings/delete pages — cannot be driven in a browser
  or with a PAT. `wrangler.jsonc:72,74` also bake `APP_ORIGIN` /
  `WORKOS_REDIRECT_URI` as `http://localhost:8787`, so even with secrets the
  live callback would be wrong until those vars are productionized.
- **Everything authenticated is drivable via the PAT** (`/tmp/forge-e2e.token`):
  git basic auth (`<owner>` + token) and API bearer auth both verified 200.
- Anonymous public pages are fully drivable (curl + browser).

### Rendering observations (validators will hit these)

- Markdown rendering does not rebase repo-relative links: the fixture README
  (`see [src/hello.ts](src/hello.ts)`) renders as
  `https://forge-platform.<subdomain>.workers.dev/<owner>/src/hello.ts` → 404
  on the blob page. GitHub-style rebasing to `/<owner>/forge-e2e/blob/main/src/hello.ts`
  is absent. Not a readiness blocker; a real product gap and a good first
  validation target.
- `x-forge-cache` is only visible on hits (by design — `cache/edge.ts` sets
  `miss` only on the stored copy). Validators should assert on presence of
  `hit` on the second request, not on `miss` on the first.

## Git checks

Clone URL scheme: `https://forge-platform.<subdomain>.workers.dev/<owner>/forge-e2e.git`
(served by the git gate on `/{owner}/{repo}(.git)/...`; plain `/.git`-less form
also matches — `GIT_PATH_RE` in `routes/git.ts`).

```
$ git -c http.extraHeader="Authorization: Basic <<owner>:PAT>" ls-remote \
    https://forge-platform.<subdomain>.workers.dev/<owner>/forge-e2e.git
1da064aec583141a5e2836affe43c7af285e6c6b	HEAD
1da064aec583141a5e2836affe43c7af285e6c6b	refs/heads/main
real	1.012s
```

- PAT ls-remote: **1.01 s** wall. Anonymous ls-remote (public repo): **0.92 s** — same refs, so anonymous public reads work.
- Timed fresh clone via PAT into `/tmp/forge-e2e-clone`: **1.59 s wall**
  (`user 0.028s sys 0.075s` — network-bound, trivial local CPU).
  Clone contents: commit `1da064a` "initial forge e2e fixture", branch `main`,
  files `.gitignore`, `README.md`, `src/deep/nested.txt`, `src/hello.ts`.
- `info/refs` advertisement edge-cached (30 s TTL, `cf-cache-status: HIT`) —
  bursty clone storms will hit cache as designed.
- **No push was performed.** Clone dir retained at `/tmp/forge-e2e-clone` for reference.

## Deploy checks (read-only)

- `npx wrangler whoami` (from `apps/platform`): wrangler 4.148.0, OAuth as
  `<owner-email>`, account `<account-id>` (matches
  expected). Token scopes include workers/d1/queues/artifacts (write).
- `npx wrangler deploy --dry-run --outdir /tmp/forge-dryrun`: **PASS in 1.18 s real**.
  Config parses; bundle 897.72 KiB (gzip 200.02 KiB); all 16 bindings resolved:
  4 DOs (TOKENS, RATE_LIMIT, REALTIME, MERGE_LOCK), 4 Workflows (SNAPSHOT_BUILDER,
  CI_PIPELINE, MERGE_WORKFLOW, REPO_IMPORT), Queue EVENTS, D1 DB (forge), R2
  SNAPSHOTS, ARTIFACTS (default), ASSETS, and vars.
- One known warning (already flagged in dependency-readiness):
  `Unexpected fields found in top-level field: "smart_placement"` (`wrangler.jsonc:79`;
  modern key is `placement`). Harmless to deploys.
- Var caveat for browser-auth validation: `APP_ORIGIN=http://localhost:8787` and
  `WORKOS_REDIRECT_URI=http://localhost:8787/auth/callback` are baked as vars
  (`wrangler.jsonc:72,74`).

## Browser check

`agent-browser` is available and drives the **Factory desktop embedded browser
pane** via CDP (`FACTORY_DESKTOP_CDP_PORT` set). Against the live repo page:

- `agent-browser --cdp "$AGENT_BROWSER_CDP" open https://forge-platform.<subdomain>.workers.dev/<owner>/forge-e2e`
  — works; page title `<owner>/forge-e2e · Forge`.
- `snapshot -i -u -d 3` — works; interactive refs resolve (evidence excerpt):

```
- heading "<owner> / forge-e2e public" [level=1, ref=e3]
- link "code" [ref=e11, url=.../<owner>/forge-e2e/tree/main]
- link "commits" [ref=e12, url=.../commits?ref=main]
- link "branches" [ref=e13, url=.../branches]
- link "▸ src" [ref=e5, url=.../tree/main/src]
- link "≡ README.md" [ref=e7, url=.../blob/main/README.md]
- button "Copy" [ref=e4]
```

- `agent-browser doctor --offline --quick`: **8 pass, 0 warn, 0 fail**.
- **Screenshot-to-file is BLOCKED on this desktop CDP daemon**: repeated
  failures/hangs with `Failed to read: Resource temporarily unavailable (os error 35)
  (after 5 retries - daemon may be busy or unresponsive)` and one 90 s hang;
  `/tmp/readiness-shot.png` could not be produced. Navigation, DOM reads,
  snapshots and (by extension) click/fill all work, so browser-driven
  validation is drivable — validators should base evidence on accessibility
  snapshots and curl, not screenshots, unless the daemon issue clears.
  Per the skill's guidance, no `doctor --fix` was attempted (shared host) and
  browsers were not relaunched repeatedly.

## Resources (this machine)

| Resource | Value |
|---|---|
| CPU | 6 cores, Apple A18 Pro (`hw.ncpu=6`) |
| RAM | 8 GiB (`hw.memsize=8589934592`) |
| Uptime / load | up 4 days 21:49; load avg **3.93 / 3.41 / 3.20** (machine already ~65% busy — other agents/workers active) |
| Disk (`<repo-root>`) | 460 GiB volume, 123 GiB used, **306 GiB available (29%)** |

## Recommended validator concurrency + isolation notes

Classification by cost, with measured numbers:

- **(a) curl-cheap (page/API hits)** — 0.27–0.5 s cached/light hits, up to ~2 s
  for uncached first renders (tree/branches). Effectively free locally.
  Recommend up to **~20 concurrent curl validators**; beyond that, timings
  skew and the git-proxy rate limit (600 reads/min per identity, per IP for
  anonymous) becomes the real ceiling for git-path probes.
- **(b) browser (page loads + interactions)** — each CDP/Chromium session
  costs ~300–500 MB and meaningful CPU; the host is 6-core/8 GiB with a
  background load already ~4. Recommend **max 2 concurrent browser-driven
  validators (3 absolute ceiling when the machine is otherwise idle)**, each
  in its own named `agent-browser --session`. Use accessibility snapshots
  (`snapshot -i`) for assertions — screenshots are currently blocked.
- **(c) git clone/push** — clone of this fixture repo measured **1.59 s wall,
  ~0.1 s local CPU** (network-bound); **4–6 concurrent clones** are fine
  (isolate each in its own `/tmp` dir). Pushes: rate-limited 120 writes/min per
  PAT and **must never run concurrently against the shared `forge-e2e` repo**
  (mutates shared validation state) — if push validation is needed, create
  dedicated throwaway repos via `POST /api/v1/repos` (Bearer PAT) and delete
  them after (`DELETE /api/v1/repos/:owner/:repo`), or serialize push tests.
- **(d) deploy-per-feature** — `wrangler deploy` must be **strictly serialized
  (1 at a time)**: it replaces the live surface every other validator is
  probing. Measured dry-run build = **1.18 s**; a real deploy adds upload of
  897.72 KiB (200 KiB gzipped) + edge propagation. No prior live-deploy timing
  is recorded in dependency-readiness.md, so estimate **5–15 s per deploy**;
  budget ~20 s including one post-deploy smoke curl (`/healthz` + one repo
  page) before handing the surface back to other validators.

Isolation notes:

1. **There is no per-validator data isolation**: the live D1 has exactly one
   user (`<owner>`, admin) and one repo (`<owner>/forge-e2e`). Any validator
   creating repos/tokens/PATs via the API mutates shared state — coordinate,
   namespace names (e.g. `e2e-<validator>-<ts>`), and clean up.
2. **Edge-cache TTLs can make read-after-write probes flaky**: branch-ref
   pages cache 60 s, `info/refs` 30 s (no push-purge until M4). Cache-bust
   with a unique query string or wait out the TTL; commit-SHA URLs are
   immutable-safe (1-year cache).
3. **Auth on live is PAT-only** (WorkOS 503). Plan all authenticated flows as
   git-basic or API-bearer; do not write validators that need the sign-in
   button until WorkOS secrets + production `APP_ORIGIN`/`WORKOS_REDIRECT_URI`
   are configured.
4. Clone/push scratch state must live under `/tmp` per validator; the
   PAT lives at `/tmp/forge-e2e.token` (74 bytes, no trailing newline —
   `$(cat ...)` is safe, as used in this run).

## Blockers

1. **Screenshot capture through the desktop CDP daemon is blocked**
   (`os error 35`, daemon busy/unresponsive, repeated hangs). Browser
   validation is otherwise fully drivable (open/snapshot/refs/doctor all
   pass). Workaround: evidence via accessibility snapshots + curl.
2. **WorkOS session auth is not configured on the live worker**
   (`/auth/sign-in` → 503 with explicit setup message; `APP_ORIGIN` /
   `WORKOS_REDIRECT_URI` baked at `http://localhost:8787` in
   `wrangler.jsonc:72,74`). All session-only surfaces (dashboard, new/import
   repo forms, token management UI, repo settings/delete pages) are
   unreachable on live. Not a blocker for PAT/API/git validation, which is
   the recommended path; becomes a blocker only if a feature requires
   browser-driven signed-in UI flows.

No other blockers. The live validation surface is drivable end-to-end today:
every page, API, and git operation probed in this run returned the expected
status, and the deploy path (dry-run) parses cleanly with all bindings intact.
