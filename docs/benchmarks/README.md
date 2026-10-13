# Benchmarks

Measured against the deployed worker by `node scripts/bench.mjs` (see "Reproduce" below). Every timing is a client-side `Date.now()` span around the request or process; every counter is the `x-kvarm-cost` header the worker returns. The counters are work counts (D1 round trips, Artifacts RPCs, Durable Object calls, R2 reads, subrequests), not a bill.

Generated 2026-10-12T00:49:31.086Z from commit `40a5207`; client darwin 27.0.0/arm64 (6 CPUs), Node v26.8.2.

Detailed reports: [clone vs snapshot](clone-vs-snapshot.md), [compare](compare.md), [100-workspace fleet](fleet-100.md), [runner warm workdir](runner-warm-workdir.md), [container runner](container-runner.md).

## Clone vs snapshot

Wall time to materialize a ref into an empty directory, median of 3 runs per variant (measured 2026-10-12T00:49:27.570Z).

| target | files | tree bytes | `git clone` + checkout | `git clone --depth=1` | `kvarm checkout` (snapshot) |
| --- | ---: | ---: | ---: | ---: | ---: |
| fixture (`<owner>/fixture-1m`@`bench-head`) | 502 | 31.5 MiB | 12.3 s | 894 ms | 893 ms |
| small (61-file scratch repo) | 61 | 262.2 KiB | 535 ms | 462 ms | 328 ms |

## Compare timings

Fixture: `<owner>/fixture-1m` `bench-base...bench-head` (502 changed files). Cold runs use the instance-admin `?nocache=1` bypass, which reads and writes no compare cache entry; warm runs repeat the same URL after the tree-pair body is cached.

| state | n | min | p50 | max | `x-kvarm-cost` (last run) |
| --- | ---: | ---: | ---: | ---: | --- |
| cold (bypass) | 10 | 327 ms | 364 ms | 780 ms | `d1=1;rr=4;rw=0;art=56;do=0;sub=1;cache=bypass` |
| warm (cache hit) | 10 | 69 ms | 75 ms | 102 ms | `d1=1;rr=4;rw=0;art=0;do=0;sub=0;cache=hit` |

## Edge cache hit rates

Share of repeated requests answered from the Cache API (`cache=hit` in `x-kvarm-cost`). The first request of each URL fills the entry and counts as a miss. The authority lookup still runs on every hit.

| surface | requests | hits | hit rate |
| --- | ---: | ---: | ---: |
| warm compare (fixture, 502 changed files) | 11 | 11 | 100% |
| per-file diff | 6 | 6 | 100% |
| repo page `GET /:o/:r` (anonymous) | 6 | 5 | 83% |
| git gate `info/refs` (anonymous) | 6 | 5 | 83% |
| snapshot download (by SHA, edge cached) | 6 | 5 | 83% |
| change detail (open) | 6 | 6 | 100% |
| candidates (2 workspaces) | 6 | 6 | 100% |
| MCP `read_file` | 6 | 6 | 100% |

## Per-endpoint cost medians

Median of each counter over n requests of the same endpoint in the same state, compared with its budget (the `budget` column; `scripts/lib/cost-catalog.mjs` holds every budget spec and `scripts/cost-sweep.mjs` checks them).

| endpoint | n | d1 | art | do | r2b | sub | cache | budget | verdict |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| warm compare (fixture, 502 changed files) | 10 | 1 | 0 | 0 | 0 | 0 | hit | `d1<=1;art=0;do=0;sub=0;cache=hit` | within |
| per-file diff | 5 | 1 | 0 | 0 | 0 | 0 | hit | `d1<=1;art=0;do=0;sub=0;cache=hit` | within |
| repo page `GET /:o/:r` (anonymous) | 5 | 1 | 0 | 0 | 0 | 0 | hit | `d1<=1;art=0;do=0;cache=hit` | within |
| git gate `info/refs` (anonymous) | 5 | 1 | 0 | 0 | 0 | 0 | hit | `d1<=1;art=0;do=0;sub=0;cache=hit` | within |
| snapshot metadata (warm ref) | 5 | 2 | 0 | 0 | 0 | 0 | none | `d1<=2;art=0;r2a=0;r2b=0;do=0;sub=0` | within |
| snapshot download (by SHA, edge cached) | 5 | 1 | 0 | 0 | 0 | 0 | hit | `d1<=1;r2b=0;art=0;cache=hit` | within |
| change detail (open) | 5 | 3 | 0 | 0 | 0 | 0 | hit | `d1=3;art=0;sub=0;do=0` | within |
| workspace list | 5 | 2 | 0 | 0 | 0 | 0 | none | `d1=2;do=0;art=0;sub=0` | within |
| candidates (2 workspaces) | 5 | 3 | 0 | 0 | 0 | 0 | hit | `d1=3;art=0;do=0;sub=0` | within |
| MCP `read_file` | 5 | 1 | 0 | 0 | 0 | 0 | hit | `d1=1;art=0;do=0;r2b=0;sub=0 (= the REST contents read)` | within |

Agent fleet lifecycle rows are currently `workerd-only`: the local workerd pool
does not provide Cloudflare Containers or snapshot storage. The budget
specifications and required authorization/coalescing checks are in
`scripts/lib/cost-catalog.mjs`; a deployed-container run will add measured
`x-kvarm-cost` rows without changing these API contracts.

## Overlap forecast and composition

| call | n | min | p50 | max | methodology |
| --- | ---: | ---: | ---: | ---: | --- |
| overlap forecast (`GET …/forecast`) | 10 | 66 ms | 82 ms | 96 ms | 10 identical calls (`paths=src/util.js,docs/guide.md`, excluding the caller's workspace) over 2 active agent workspaces with declared and observed paths overlapping on `src/util.js`, in a 6-file repo; the forecast has no response cache (`cache=none`), so every call reads the Nexus index (`d1=2`) |
| composition (`POST …/candidates/compose`) | 10 | 1088 ms | 1197 ms | 1578 ms | 10 compositions of the same 2 workspaces (one clean merge3 hunk each in `src/util.js` plus one file each); every call folds both pieces, writes and pushes a new composed commit and records a workspace and a draft change set, so no run is served from a cache |

## 100-workspace fleet run

From the committed [fleet-100](fleet-100.md) run (finished 2026-10-11T16:07:34.375Z).

| measure | value |
| --- | --- |
| active workspaces | 100 |
| changes published through the train | 99 (96 in the initial burst + 3 after conflict resolution) |
| initial burst window (first enqueue -> last of the 96 initial-burst publications) | 361.9 s |
| throughput (the 96 initial-burst publications per minute over that window) | 15.91 |
| enqueue -> published latency of the 96 initial-burst publications, server clock (p50 / p90) | 94.0 s / 219.1 s |
| enqueue `x-kvarm-cost`, median per counter (all published) | `d1=2;rr=12;rw=4;art=0;do=0;r2a=0;r2b=0;q=1;sub=0;cache=none` |
| stored publication cost, median per counter (all published) | `d1=3;rr=10;rw=3;art=0;do=2;q=0;sub=2` |
| longest interval with no queue entry reaching a terminal state | 79.7 s |
| driver checks | 34/34 passed |

## Dev-loop and CI turnaround

Wall-clock turnaround of the developer and CI loop, from the client side.

| metric | n | min | p50 | max | methodology |
| --- | ---: | ---: | ---: | ---: | --- |
| explicit merge (`POST …/merge` -> 200) | 10 | 531 ms | 1108 ms | 1310 ms | `POST …/changes/:n/merge` until its 200 (publication happens inside the request); 10 changes adding one file each: 1 fast-forward, 9 three-way (main moved by the previous merge) |
| mergeability, cold | 10 | 298 ms | 366 ms | 466 ms | first `GET …/mergeability` of a change right after main moved: new (target, head) pair, merge plan computed (`art` 6-7) |
| mergeability, warm | 10 | 117 ms | 136 ms | 238 ms | the same read repeated: plan served from the content-addressed cache (`art=0`), gate asked fresh |
| push -> kvarm/guard verdict recorded | 10 | 6394 ms | 6589 ms | 7308 ms | Date.now() before `git push` to the server-recorded `finishedAt` of the guard run at the pushed head (host clock NTP-synchronized); 10 pushes of a one-file change to an open change's head branch; `git push` itself took p50 603 ms |
| push -> kvarm/guard verdict visible to the client | 10 | 6637 ms | 6825 ms | 7566 ms | the same pushes, ending at the first `GET …/changes/:n/checks` (polled every 250 ms) that shows the verdict |
| push -> CI job created (claimable) | 10 | 6861 ms | 7032 ms | 7764 ms | the same pushes, ending at the server-recorded `createdAt` of the queued CI check run (the job is claimable from then) |
| push -> CI job claimed by a polling client | 10 | 7458 ms | 7751 ms | 8580 ms | the same pushes, ending at the first `POST …/ci/jobs/claim` (polled every 250 ms) that returns the job for the pushed head |
| runner claim -> report, cold install (`--fresh`) | 5 | 2593 ms | 2669 ms | 2804 ms | `scripts/runner-warm-bench.mjs --samples 5` (measured 2026-10-12): the runner's own claim response -> report response span for `npm install && npm test` on a TypeScript + vitest fixture; empty workdir, full install from the machine npm cache, checkout by clone fallback |
| runner claim -> report, warm workdir | 5 | 1536 ms | 1573 ms | 1704 ms | `scripts/runner-warm-bench.mjs --samples 5` (measured 2026-10-12): the runner's own claim response -> report response span for `npm install && npm test` on a TypeScript + vitest fixture; next commit delta-synced into the same workdir, node_modules reused |

## Container CI: cold vs snapshot-warm

Container CI runner (Cloudflare Containers, public beta): run 1 starts from the image, prepares the workspace and saves it with `snapshotContainer`; run 2 starts from that snapshot and skips setup. "total" is measured inside the controlling Durable Object, "wall" is the client round trip of `POST …/ci/container-runs`, "ready to run" is boot plus setup. One sample per run; container start times in the beta vary.

| run | total | wall | ready to run |
| --- | ---: | ---: | ---: |
| run 1 cold | 18.9 s | 19.4 s | 5.1 s |
| run 2 snapshot-warm | 8.7 s | 8.9 s | 0.6 s |

## Reproduce

```sh
set -a; . ./.env.local; set +a   # KVARM_BASE_URL, KVARM_PAT (instance admin, api + ci scopes)
node scripts/bench.mjs --write                         # rewrites this file
node scripts/cost-sweep.mjs --cost-md <path to cost.md> # every budget row, non-zero exit on a violation
```
