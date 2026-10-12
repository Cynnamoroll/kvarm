# Forge

A git platform for the agentic era, built on [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) for the Cloudflare [next Git platform](https://blog.cloudflare.com/next-git-platform-on-cloudflare/) competition.

> Early scaffold. Architecture and milestones live in [`planning/PLAN.md`](planning/PLAN.md). This README becomes the submission-facing document before the deadline.

## Status

- [ ] M0 scaffold (monorepo, wrangler, D1 schema, tooling)
- [ ] M1 auth (WorkOS) + repo registry + git proxy
- [ ] M2 web SSR
- [ ] M3 diff engine + virtualized diff client
- [ ] M4 events + snapshots
- [ ] M5 CI + merges
- [ ] M6 agent layer + parity finish
- [ ] M7 hardening + submission package

## Demo

One command drives four scripted agent principals (two authors, two reviewers) and one human through MCP against a deployed worker, on a fresh private repository. No hosted model is called.

```sh
set -a; . apps/platform/.dev.vars.validation; set +a   # FORGE_BASE_URL, FORGE_PAT
node scripts/demo-harness.mjs              # the seven agent-coordination steps
node scripts/demo-harness.mjs --container  # plus the Container CI runner (cold vs snapshot-warm)
```

The seven steps: workspaces and declared intents, the overlap forecast, pushes and change sets, agent reviews with one escalation answered by the human, a composed outcome published through the merge queue, a textual conflict dispatched as a task and resolved by an agent, and a decision record read back with `get_context`. Each step prints its tool calls with timings. The script exits non-zero when any step fails and deletes its repository, agents and tokens at exit (`--keep` keeps the repository).

`--container` adds the Container CI runner showcase (Cloudflare Containers, public beta): an instance-admin route runs one `forge runner --once` job inside a `cloudflare/debian-trixie` container through the native `ctx.container` API. Run 1 prepares the container and saves it with `snapshotContainer`; run 2 starts from that snapshot and skips setup. Both check runs record through the standard CI endpoints. The user-owned `forge runner` CLI remains the primary runner.

## Benchmarks and work budgets

[`docs/benchmarks/README.md`](docs/benchmarks/README.md) holds the measured numbers (clone versus snapshot checkout, compare cold and warm, edge-cache hit rates, per-endpoint `x-forge-cost` medians, overlap forecast and composition timings, the 100-workspace fleet run and the dev-loop turnarounds), each with its method and sample count. Speed statements in this repository refer to those measurements. `node scripts/bench.mjs --write` re-measures against a deployed worker and rewrites the table.

`node scripts/cost-sweep.mjs --cost-md <path to cost.md>` checks every row of the work-budget document against the live worker (or names why a row cannot be triggered live) and exits non-zero on any violation. The counters are work counters (D1 round trips and rows, Artifacts and Durable Object calls, queue sends, subrequests), not a bill.

## License

MIT
