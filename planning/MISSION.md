# MISSION.md — Forge mission-mode readiness

**Status: prototype validated, mission-ready.** This document is the complete
brief for mission mode: what we're building, what is already proven, how we
differentiate, the execution plan with acceptance gates, and the pivot
triggers that keep us from sinking time into an approach that isn't working.

---

## 1. Mission

Build **Forge** — the fastest git platform on Cloudflare Artifacts, designed
for the agentic era, and ship it for the Cloudflare "next Git platform"
competition (deadline **Oct 14, 2026**; submission = 5-10 min video,
permissively licensed source, run instructions).

Two claims to make real and provable:

1. **Speed is the product.** Every surface renders at the edge in O(viewport)
   or O(changed paths), never O(repo). A 1M-line change set must open fast,
   scroll smoothly, and never hang a request.
2. **Built for AI, not just humans.** Machines get first-class auth (PATs),
   first-class transport (MCP), first-class isolation (per-agent workspaces),
   and first-class provenance (attribution notes on every commit).

## 2. Prototype validation log (evidence, not claims)

Everything below ran against **production** Cloudflare (account
`<account-id>`, worker `forge-platform.<subdomain>.workers.dev`, deployed
2026-10-07):

| Capability | Evidence |
| --- | --- |
| Worker deploy with full binding set | 4 DOs, 4 Workflows, queue producer+consumer, D1, Artifacts namespace `default` |
| Git push (write path) | `git push` via PAT through smart-HTTP proxy into Artifacts — accepted `main -> main` |
| Git clone (read path) | Fresh clone byte-identical to source (`diff -r` clean) |
| Web SSR of pushed content | Tree, blob, raw, commits, branches pages all 200 with correct content |
| Edge caching | `cf-cache-status: HIT`, `x-forge-cache: hit` on second anonymous fetch of a public tree page |
| Registry + auth gates | Remote D1 lookups 404 unknown repos; anonymous redirect to sign-in; unconfigured WorkOS returns graceful 503 |
| Object engines | gitops verified against real git hash vectors; diffcore fuzz-verified vs `git diff` (250 cases: minimal + replay-valid); treediff prune behavior asserted (2 reads for a one-file change) |
| Test suite | 27/27 green; typecheck clean (root DOM lib + platform workers-types configs) |

Infra provisioned: D1 `forge` (`<database-id>`, migrations applied remote+local),
queues `forge-events`/`forge-events-dlq`, Artifacts namespace `default`,
first repo `<owner>/forge-e2e` seeded with a bootstrap PAT (`/tmp/forge-e2e.token`).

## 3. Architecture (as validated)

```
git client ──smart-HTTP──> Worker git gate ──PAT auth + rate limit──> Artifacts (git storage)
browser   ──GET─────────> SSR pages ──readTree/readBlob via binding──> Artifacts
                            │  anonymous public pages -> Cache API (edge)
                            │  README/diff HTML content-addressed by SHA -> Cache API
agents    ──MCP/REST──────> JSON APIs ── D1 registry (repos/users/PATs/events)
push      ──(M4)─────────> Artifacts event -> queue -> snapshot Workflow -> R2
```

Principles locked in by the prototype:

- **Artifacts is the storage layer.** We never reimplement git object storage
  or the wire protocol; the binding + smart-HTTP proxy cover it.
- **D1 is the registry, never the content.** Metadata in SQL, bytes in
  Artifacts, snapshots in R2, rendered HTML in the Cache API.
- **Content-addressed caching at every layer.** Every artifact of a render or
  diff is keyed by immutable SHAs, so cache entries never need invalidation —
  only branch-moving pages get short TTLs, and push events purge those (M4).
- **Zero client runtime.** One static stylesheet, inline critical CSS,
  hand-written vanilla JS (copy button, virtualized diff). No framework,
  no hydration, matching the GitHub CSS-modules lesson.
- **Structure-first rendering.** Tree views are O(entries); tree diffs are
  O(changed paths) with pruning; line diffs are lazy per-file and
  budget-bounded so no request can hang (the huge-PR blueprint).

## 4. Differentiation — the agent-era bet

1. **1M-LOC change sets that feel instant.** Compare = tree diff first
   (pruned walk, content-addressed by tree hashes), per-file line diffs
   fetched lazily and cached forever by blob-hash pair, virtualized
   fixed-height rows so the DOM stays O(viewport). GitHub's own engineering
   post is our spec; we ship it at the edge.
2. **Machines are first-class citizens.** PATs for git/REST, an MCP server
   exposing the same APIs agents already use, stable JSON everywhere, and
   snapshot tarballs (ArtifactFS-style) so agents skip `git clone` entirely.
3. **Concurrent agent workspaces.** Isolated workspaces per agent on the
   same repo, change sets as first-class objects, candidate comparison UI
   (diff two agents' attempts), and a merge queue with real locking. Code
   review for an AI team, which GitHub does not have.
4. **Provenance by default.** Every commit can carry git-notes attribution
   (which agent, which session, which prompt hash) rendered in the UI.
5. **We are the demo of the platform.** Forge runs entirely on Artifacts +
   Workers primitives — the submission doubles as proof of Cloudflare's
   thesis. CI runs on Workflows, storage on Artifacts, snapshots on R2.

## 5. Execution plan with acceptance gates

> **Scope update (2026-10-07): implementation first, UI deferred.** The
> autonomous mission builds engines, APIs, workflows, and the MCP surface
> only. All new UI (compare page, virtualized diff client, workspace /
> candidate-compare views, merge-queue and attribution display, visual
> polish) is **out of mission scope**. When the mission reaches the UI, it
> **stops** so the user and Droid can design it together on paper first.
> Reference material: `planning/aesthetic/INSPIRATION.md`. UI-flavored gates
> below (60fps scroll, "through the UI") are re-stated as API/JSON gates for
> the mission and re-applied during the UI pass. The submission video comes
> after the UI pass.

Each milestone has a measurable gate. **Two consecutive gate failures trigger
the documented pivot** (section 6). Budgets from PLAN.md still apply.

- **M3 — Diff surface** (engine done, `28cdadb`)
  Artifacts-backed adapters, content-addressed Cache API layer, compare +
  diff JSON APIs, `/compare/base...head` page with virtualized client.
  *Gate:* 1M-LOC fixture repo; compare file list < 500 ms p50 from cold
  cache; expanded file renders at 60fps scroll; no request exceeds 30 s CPU.
- **M4 — Events, snapshots, purges**
  Queue consumer for Artifacts push events; snapshot-builder Workflow
  (R2 tarballs per push); edge-cache purge on push; snapshot checkout CLI.
  *Gate:* push -> purged tree page < 2 s; snapshot of the fixture
  downloadable + byte-complete; clone vs snapshot benchmark written down.
  *Blocked on:* R2 activation (user dashboard action).
- **M5 — CI + merges**
  CI pipeline Workflow (test runs from snapshot checkout, check runs in D1,
  commit status in UI), fast-forward + three-way merge over gitops builders,
  merge queue behind MergeLock DO.
  *Gate:* a PR with a failing check cannot merge; a passing PR merges via
  the queue with correct commit graph; 3-way merge matches git's result on
  a scripted conflict corpus.
- **M6 — Agent layer**
  Workspaces (per-agent isolated refs), change sets, candidate compare UI,
  MCP server, git-notes attribution. Issues/fork/import UI polish.
  *Gate:* two simulated agents produce competing change sets on one repo,
  compared + merged through the UI with attribution visible end-to-end.
- **M7 — Hardening + submission**
  Perf probes rerun and published, README run instructions, 5-10 min video,
  MIT license audit, final benchmark table for the blog-post claims.
  *Gate:* a fresh clone of the repo deploys from zero with only the README.

## 6. Pivot points (decided in advance)

| # | If this fails | Symptom | Pivot |
| --- | --- | --- | --- |
| P1 | Artifacts `readTree` latency on huge repos | M3 gate misses on cold compare | Precompute path->hash manifests per commit on push (queue consumer) and diff manifests in-memory; worst case restrict deep walks to snapshot-derived manifests |
| P2 | Cache API limits (entry size/eviction) hurt diff caching | cache hit rate < 80% on fixture | Move diff cache to R2 objects keyed by the same SHAs (DO for single-flight) |
| P3 | Virtualized DOM can't keep 60fps at 1M lines | dropped frames in probe | Canvas-rendered diff rows (measure first; DOM stays default) |
| P4 | 3-way merge too brittle (conflict corpus failures) | M5 gate fails twice | Ship FF-only + conflict detection (no auto-resolution) and document; merge queue still works |
| P5 | Workflows CI can't run repo test suites | M5 gate fails | CI = snapshot checkout + user-provided runner script executed in a dedicated Worker with hard timeouts (document limits honestly) |
| P6 | MCP integration stalls | M6 slips > 1 day | Ship the REST surface (agents consume it fine) and note MCP as post-deadline; do not block M7 |
| P7 | R2 activation or WorkOS credentials delayed | M4/human-auth blocked | R2: keep queue consumer + purges, snapshots land on activation. WorkOS: bootstrap admin + PATs already cover all machine flows; human login is the only gap |

Pivot discipline: gates are measured, not vibes. A pivot is chosen at the
second consecutive failure; pivots P1/P2/P3 are reversible (cache/manifest
layers are internal), P4/P5 scope the claim instead of breaking the demo.

## 7. Inputs needed from the user

- **WorkOS** (human sign-in): `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`,
  `WORKOS_COOKIE_PASSWORD` as worker secrets + redirect URI
  `https://forge-platform.<subdomain>.workers.dev/auth/callback`. Until
  then the seed admin (`<owner>`, `bootstrap-<owner>` workos id — UPDATE
  the row when the real AuthKit user id is known) and PATs cover everything.
- **R2 activation** (one dashboard click) for M4 snapshots; then
  `wrangler r2 bucket create forge-snapshots` + uncomment the binding.
- Optional: custom domain (workers.dev URL is fine for submission).

## 8. Definition of done (submission checklist)

- [ ] Video (5-10 min): live demo of clone/push speed, 1M-LOC compare, agent
      workspaces + candidate compare, merge queue, snapshots vs clone.
- [ ] MIT source published with run instructions that work from a clean clone.
- [ ] Benchmark table: clone vs snapshot, compare timings, edge-cache hit
      rates, budget-bound guarantees.
- [ ] All acceptance gates green or honestly scoped per section 6.
