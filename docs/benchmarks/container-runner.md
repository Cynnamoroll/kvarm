# Container CI runner: cold vs snapshot-warm

Measured by `node scripts/demo-harness.mjs --container-only` (`scripts/lib/container-runner-demo.mjs`) against the deployed worker (version `da2007dc`) on Oct 12, 2026. Each sample is one private scratch repository with one required `typecheck` job (`tsc --noEmit -p .`). Phases are measured inside the `CiRunnerSandbox` Durable Object; "wall" is the harness's round trip for `POST …/ci/container-runs`.

- Run 1 (cold): `ctx.container.start({image: "cloudflare/debian-trixie", instance: "standard-2"})`, write the `kvarm runner` modules, `npm install --global typescript@5.9.3`, then the runner claims change #1's job and snapshot-checks-out its workspace. The runner then stops before the command, and the controller saves the prepared container with `snapshotContainer`. The runner then runs the command and reports.
- Run 2 (warm): a second change, opened on another branch at the same head, queues its own ordinary `typecheck` run. `ctx.container.start({containerSnapshot})` restores the prepared container with no setup; the runner claims that job, and its warm delta sync finds the workspace already at the head (`workdir: warm`, no checkout). It runs and reports.

Check runs are idempotent per change, head and check name, so the second run at the same head belongs to a second change. Both runs report through the standard CI endpoints. The two check runs have distinct ids, the same head sha, name, command and summary fields, status `success` (source `snapshot` for the cold run, `delta` for the warm one), and each change's checks-gate answer counts its `typecheck` as `success`.

The snapshot is taken after the workspace is prepared, so the warm run does no repeated checkout. The workspace phase covers the claim plus the checkout (cold) or the warm sync (warm). The job phase covers the `tsc` run and the report.

| Phase | Sample A cold | Sample A warm | Sample B cold | Sample B warm |
|---|---:|---:|---:|---:|
| boot (start → first exec returns) | 770 ms | 719 ms | 551 ms | 902 ms |
| setup (runner + toolchain) | 3.5 s | – | 4.8 s | – |
| workspace (claim + checkout or warm sync) | 2.1 s | 856 ms | 1.4 s | 986 ms |
| `snapshotContainer` (13.0 MiB) | 4.8 s | – | 5.4 s | – |
| job (run, report) | 4.0 s | 4.5 s | 6.5 s | 5.2 s |
| stop (`destroy`) | 173 ms | 229 ms | 175 ms | 168 ms |
| ready to run the job (boot + setup) | 4.3 s | 719 ms | 5.4 s | 902 ms |
| total in the Durable Object | 15.3 s | 6.4 s | 18.8 s | 7.3 s |
| harness wall | 15.9 s | 6.4 s | 19.5 s | 7.3 s |

Container reuse makes the container ready to run the job 5.9x (A) and 6.0x (B) faster. End to end, excluding the one-time snapshot save, the warm run is 1.7x (A) and 1.8x (B) faster. Two samples only; the toolchain install in this fixture is small, so a heavier setup widens the gap. These are our own measurements of our runs, not Cloudflare platform latency figures.

The cost sweep's container phase ran the same showcase once more on the same worker (sample C): boot 635 / 881 ms, setup 3.1 s, workspace 2.1 s / 872 ms, snapshot 4.5 s, job 3.7 / 6.3 s, ready to run 3.7 s / 881 ms (4.2x), total 14.3 / 8.2 s (1.2x end to end; the warm `tsc` run was slower in that sample).

The route's `x-kvarm-cost` was `d1=1;rr=4;do=1` for every run.

Earlier samples (Oct 11, worker `2dacea9f` and `0604f51d`) took the snapshot before the runner claimed a job, so both runs checked out a fresh workdir; they are superseded by the table above.
