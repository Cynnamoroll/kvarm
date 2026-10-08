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

Result on 2026-10-08 (worker version `c6972ad1`): 17/17 checks pass.
Since this version an admin `?nocache=1` reads and writes no compare cache
entry at all (body, risk, ref, ref generation, commit or line counts), so
every one of the 10 runs is a truly cold computation. Only the colo's git
token cache is still used (a credential, not compare data).

| check | result |
| --- | --- |
| 10 cold `compare/bench-base...bench-head?nocache=1` (admin PAT) | all 200 + `x-forge-cache: bypass`; **p50 494 ms** (min 406, max 1,490) |
| cold body | 502 files, `truncated: false`, `totalsComplete: true`, `statsOmitted: true`, 109 KB |
| cold cost | `art=56` = 54 tree reads + 2 (ls-refs and the head log; commits are no longer served from cache), `d1=1` |
| anonymous / bot `?nocache=1` | served normally, never `bypass` (anonymous `miss`, bot `hit`) |
| ordering | path-ascending; `?order=path` identical |
| wide pair | 4,575 of 25,000 files, `truncated: true`, reason `tree read budget exhausted (2000 reads)`, `totalsComplete: false`, `totals.files` 4,575 (the listed subset), 1.0 MB, 8.4 s |
| interleaved file diff | `approximate: true`, 559 KB, 173 ms warm |
| largest file diff | +1 / -1, 759 B, 117 ms warm |
| warm repeat | cache hit, identical body, `d1=1 art=0 sub=0` |
| sweep (18 fixture requests) | no non-2xx, no request over 30 s |
| edge: first-ever compare, diverged base, write token warmed by the push | `art=5` <= tree reads 2 + blob reads 0 + 3, `d1=1` |

A second truly cold run straight after (`--skip-edge`) gave p50 471 ms
(min 381, max 650). The margin to 500 ms is thinner than before because the
bypass now also skips the commit cache: the refs stage takes ~85-150 ms
instead of ~70-90 ms.

Earlier results, when the bypass still read the immutable commit and
line-count entries (worker `a107390b`): cold p50 401 ms (min 361, max 796),
`art=55`; other runs gave 402 ms and 396 ms. Those runs were not fully cold.

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
- **Approved budget exception.** A first-ever cold compare whose base is not
  on the head's first-parent chain (a diverged base, or an ancestor beyond
  the 50-entry head log), in a colo with no cached read or write token, costs
  `treeReads + blobReads + 4`: token mint, repo handle, head log, and one
  readCommit for the base. Covering it would need a token mint that also
  opens the handle or a log call that walks two tips; neither exists in the
  Artifacts binding. This exact path is the documented, user-approved
  exception (VAL-COST-005). Every other compare, including the same one once
  a token is cached, stays within `+3`; workerd tests pin both cases.

## Alternatives if the gate regresses

None of these were needed. With the truly cold bypass the most direct
saving would be to overlap the head log with ls-refs (the log needs the
resolved head sha today), worth roughly one upstream round trip (~30-60 ms).

- **Pivot P1:** per-commit path-to-hash manifests written on push, so a
  compare reads two manifests instead of walking trees. This removes the
  tree-read cost and the wide-pair truncation, at the price of push-time work
  and storage.
- **Lower `maxFiles` or `maxTreeReads`** to cap worst-case time, with more
  truncation on wide diffs.
- **Warm compares on push** for the default branch against pushed branches.
