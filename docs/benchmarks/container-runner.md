# Container CI runner: cold vs snapshot-warm

Measured by `node scripts/demo-harness.mjs --container` (`scripts/lib/container-runner-demo.mjs`) against the deployed worker on Oct 11, 2026. Each sample is one private scratch repository with one required `typecheck` job (`tsc --noEmit -p .`). Phases are measured inside the `CiRunnerSandbox` Durable Object; "wall" is the harness's round trip for `POST …/ci/container-runs`.

- Run 1 (cold): `ctx.container.start({image: "cloudflare/debian-trixie", instance: "standard-2"})`, write the `forge runner` modules, `npm install --global typescript@5.9.3`, `snapshotContainer`, then one claim → snapshot checkout → run → report job.
- Run 2 (warm): `ctx.container.start({containerSnapshot})` after a head push, no setup, then the same job loop at the new head.

The job phase includes the platform snapshot download and the `tsc` run; both runs check out a fresh workdir because the container snapshot is taken before the first job.

| Phase | Sample A cold | Sample A warm | Sample B cold | Sample B warm |
|---|---:|---:|---:|---:|
| boot (start → first exec returns) | 481 ms | 511 ms | 556 ms | 666 ms |
| setup (runner + toolchain) | 3.6 s | – | 4.8 s | – |
| `snapshotContainer` (13.0 MiB) | 6.5 s | – | 5.9 s | – |
| job (claim, checkout, run, report) | 6.8 s | 6.5 s | 7.5 s | 8.6 s |
| stop (`destroy`) | 211 ms | 133 ms | 188 ms | 190 ms |
| ready to run the job (boot + setup) | 4.1 s | 511 ms | 5.4 s | 666 ms |
| total in the Durable Object | 17.5 s | 7.1 s | 18.9 s | 9.5 s |
| harness wall | 18.2 s | 7.2 s | 20.8 s | 9.6 s |

Container reuse makes the container ready to run the job 7.9x (A) and 8.1x (B) faster. End to end, excluding the one-time snapshot save, the warm run is 1.6x (A) and 1.4x (B) faster. Two samples only; the toolchain install in this fixture is small, so a heavier setup widens the gap. These are our own measurements of our runs, not Cloudflare platform latency figures.

Both check runs of each sample were listed by `GET …/changes/1/checks` with distinct ids, status `success`, `source: snapshot` and the same summary fields. The route's `x-forge-cost` was `d1=1;rr=4;do=1` for every run.
