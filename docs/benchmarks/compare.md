# Compare benchmark (M3 gate)

The M3 gate (planning/MISSION.md §6) requires the cold compare file-list
endpoint on a ~1M-changed-line diff to answer with p50 < 500 ms over 10 runs.
The gate is met on the live worker without pivot P1.

## Fixture

`scripts/fixture-1m.mjs` builds the repo deterministically with
`git fast-import` (fixed identity and timestamps), creates
`cynthia/fixture-1m` through `POST /api/v1/repos`, and pushes one ref at a
time through the live proxy with retry on 429/503 (the 120/min write limit).
Re-running it produces the same SHAs. The generated record is
`docs/benchmarks/fixture-1m.json`.

| ref | sha | role |
| --- | --- | --- |
| `bench-base`, `main` | `cc72e4a02c8f` | base of the 1M-line pair |
| `bench-head` | `08333c79998f` | head of the 1M-line pair |
| `wide-base` | `a08995ca00ff` | base of the wide pair |
| `wide-head` | `d6e8b0d42867` | head of the wide pair |

- `bench-base...bench-head`: 502 files in 25 directories,
  +516,001 / -516,001 (1,032,002 changed lines).
  - `large/huge.txt`: the largest file, 120,000 lines (2.88 MB), one line
    edited (+1 / -1).
  - `large/interleaved.txt`: 60,000 lines with every 5th line rewritten and
    a 5,000-line block moved; git reports +16,000 / -16,000.
- `wide-base...wide-head`: 25,000 changed paths across 5,000 leaf
  directories (5,051 directories), which needs ~10,104 tree reads for a full
  diff.

## Gate

`scripts/gate-m3.mjs` runs against the live worker
(`set -a; . apps/platform/.dev.vars.validation; set +a; node scripts/gate-m3.mjs --json=out.json`).
The latest run is committed as `docs/benchmarks/gate-m3.json`.

Result on 2026-10-08 (worker version `a107390b`): 17/17 checks pass.

| check | result |
| --- | --- |
| 10 cold `compare/bench-base...bench-head?nocache=1` (admin PAT) | all 200 + `x-forge-cache: bypass`; **p50 401 ms** (min 361, max 796) |
| cold body | 502 files, `truncated: false`, `statsOmitted: true`, 109 KB |
| cold cost | `art=55` = 54 tree reads + 1 refs call, `d1=1` |
| anonymous / bot `?nocache=1` | served normally from cache, never `bypass` |
| ordering | path-ascending; `?order=path` identical |
| wide pair | 4,580 of 25,000 files, `truncated: true`, reason `tree read budget exhausted (2000 reads)`, 1.0 MB |
| interleaved file diff | `approximate: true`, 559 KB, 163 ms warm |
| largest file diff | +1 / -1, 759 B, 128 ms warm |
| warm repeat | cache hit, identical body, `d1=1 art=0 sub=0` |
| sweep (18 fixture requests) | no non-2xx, no request over 30 s |
| edge: first-ever compare, non-parent base, cold read token | `art=5` <= tree reads 2 + blob reads 0 + 3, `d1=1` |

Earlier runs gave cold p50 of 402 ms and 396 ms.

### Where the cold time goes

The route emits `server-timing: auth, refs, diff[, file]`. A typical cold
run spends ~25 ms in auth, ~70-90 ms resolving refs (ls-refs plus the commit
log) and ~120-230 ms in the tree diff. The first run of a batch is slower
(~400 ms in refs) because it opens the Artifacts handle and token in a new
isolate.

## What changed to get here

Baseline before this work: cold p50 ~455 ms, `art=56`.

1. **One global read limit in the tree diff.** The nested worker pools in
   `packages/gitops/src/treediff.ts` let in-flight reads reach 80-128 at a
   configured concurrency of 16. A single semaphore now bounds all reads, and
   `treeConcurrency` is 64.
2. **Earlier repo handle.** A bypass request opens the Artifacts repo handle
   while auth and refs resolve.
3. **Fewer upstream calls for commits.** `readCommitPair` reads up to 50
   commits of the head's first-parent chain with one `log` call and takes the
   base from it when present. Only a base off that chain costs one extra
   `readCommit`.
4. **Read-capable token reuse.** ls-refs takes any cached read or write token
   (`getReadCapableToken`). Write tokens serve upload-pack ls-refs (verified
   live), so a compare right after a push no longer mints a read token.

After these changes cold p50 is ~400 ms and `art=55`.

## Findings

- **Artifacts tree reads look serialized per repo.** Each `readTree` costs
  ~2.7 ms in sequence, and raising concurrency from 16 to 64 barely changes
  wall time on the wide pair. Concurrency mainly helps by hiding per-call
  latency on small diffs.
- **The wide pair stays truncated.** `COMPARE_BUDGETS.maxTreeReads` is still
  2000. That run takes ~6 s and returns a 1 MB body with a truncation reason.
  A full diff needs ~10,104 reads (~27 s at the measured rate), which is close
  to the 30 s client limit and above the default Workers cap of 10,000
  subrequests per request, so the budget was not raised.
- **Residual budget edge.** A first-ever cold compare whose base is not on
  the head's first-parent chain (a diverged branch), in a colo with no cached
  read or write token, still costs `treeReads + blobReads + 4`: token mint,
  ls-refs, log, and readCommit. Covering it would need a token mint that also
  returns refs or a log call that walks two tips; neither exists in the
  Artifacts binding. The common case (a base on the head's chain, or any
  compare after a push in the same colo) stays within `+3`.

## Alternatives if the gate regresses

None of these were needed.

- **Pivot P1:** per-commit path-to-hash manifests written on push, so a
  compare reads two manifests instead of walking trees. This removes the
  tree-read cost and the wide-pair truncation, at the price of push-time work
  and storage.
- **Lower `maxFiles` or `maxTreeReads`** to cap worst-case time, with more
  truncation on wide diffs.
- **Warm compares on push** for the default branch against pushed branches.
