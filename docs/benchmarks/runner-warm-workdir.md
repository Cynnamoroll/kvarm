# CLI runner: claim → report, cold install vs warm workdir

Measured by `node scripts/runner-warm-bench.mjs --samples 5 [--isolated-npm-cache] [--snapshot-ready]` against the deployed worker on Oct 11, 2026 (macOS host, Node 26, npm 11). The span is the runner's own: claim response to report response. Fixture: a TypeScript + vitest project (typescript 5.9.3, vitest 4.1.11, 46 packages, committed lockfile) whose job runs `npm install --no-audit --no-fund --prefer-offline && npm test` (`tsc --noEmit` + `vitest run`). Each sample pushes a new head (one file modified, one added, one deleted).

- Cold: `--fresh`, an empty workdir and a full `npm install`.
- Warm: the next commit synced into the same workdir with `node_modules` reused (npm reports `up to date`). The warm sync fetches only the changed paths (`compare` + `contents`) and downloads no snapshot tarball.

Five alternating samples per variant. After every job the workdir's tracked files matched `git archive` of that commit and `node_modules` survived; two concurrent runners held different workdir slots. Every run passed all 12 driver checks.

| Variant | Cold source | Cold median | Warm median | Warm median before the delta sync |
|---|---|---:|---:|---:|
| machine npm cache (`~/.npm`) | clone fallback | 2,567 ms | 1,532 ms | 1,921 ms |
| job-local npm cache (`--isolated-npm-cache`) | clone fallback | 2,937 ms | 1,538 ms | 1,876 ms |
| job-local npm cache, snapshot ready (`--snapshot-ready`) | snapshot | 2,599 ms | 1,568 ms | 1,390 ms |

Samples (ms), cold / warm:

- machine npm cache: 2896, 2537, 2785, 2567, 2436 / 1587, 1456, 1669, 1449, 1532
- `--isolated-npm-cache`: 2898, 3118, 2937, 2896, 2938 / 1496, 1621, 1694, 1487, 1538
- `--isolated-npm-cache --snapshot-ready`: 2754, 2498, 2599, 2521, 2660 / 1740, 1767, 1568, 1404, 1457

A job claimed right after its push usually finds the snapshot still building; the warm path no longer depends on it, which is where the warm median dropped by 338-389 ms. When the snapshot of this ten-file tree is already built, one tarball request is cheaper than one compare plus a contents request per changed file, so that warm median is 178 ms slower than before. The delta transfers data in proportion to the changed paths rather than the whole tree; this fixture is too small to show where that crossover lies. The "before" column comes from the same driver on Oct 10, 2026, and the cold snapshot-ready median moved by about 250 ms between the two days with no change to the cold path, so differences of that size are within day-to-day variance. These are our own measurements of our runs.
