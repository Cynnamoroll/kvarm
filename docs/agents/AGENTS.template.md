<!--
Drop-in AGENTS.md for a repository hosted on Kvarm. Replace every <placeholder>
(<KVARM_ORIGIN>, <owner>/<repo>, the check commands) and delete this comment.
Keep real tokens out of this file: the agent's token comes from its environment.
-->

# AGENTS.md

This repository is hosted on Kvarm (`<KVARM_ORIGIN>`, repository `<owner>/<repo>`). You work in your own workspace branch and land changes through Kvarm's change and merge queue. Do not push to `main`.

## Setup

- The `kvarm` MCP server is configured for you (`<KVARM_ORIGIN>/mcp`). Your credential is an agent token in `KVARM_AGENT_TOKEN`. Never print it, write it to a file or put it in a commit.
- Your token is limited to this repository and to the refs `refs/heads/agents/*`. Account-level tools (`get_user`, `list_repos`, token and agent management) are not available to you; use `get_repo` to check connectivity.
- Build and test commands: `<install command>`, `<test command>`, `<lint command>`. Run them before every push.

## The flow

1. **Read prior decisions.** Call `get_context` for the paths you expect to touch. Follow decisions that fit; if you disagree, say why in step 8.
2. **Create a workspace.** Call `create_workspace` with a one-line `task`. It returns the workspace `id` and its ref `refs/heads/agents/<workspaceId>/<slug>`. Work only on that branch.
3. **Declare intent.** Call `set_intent` with the paths and directories you will change (a trailing `/` marks a directory). Keep it honest and narrow; update it if the scope grows.
4. **Check for collisions.** Call `forecast` for those paths with `exclude` set to your workspace id. If another workspace overlaps, prefer narrowing your scope or building on theirs (`add_dependency`) over duplicating the work. The forecast is advisory: an empty result does not prove compatibility.
5. **Push.** Commit small, coherent changes with the repository's commit style and push to the workspace ref only:
   `git -c credential.helper= push <KVARM_ORIGIN>/<owner>/<repo>.git HEAD:refs/heads/agents/<workspaceId>/<slug>`
   Supply the token through a `GIT_ASKPASS` helper that prints `$KVARM_AGENT_TOKEN` (the username can be anything), never in the URL or a stored credential.
6. **Open the change.** Call `create_change_set` with a clear title and body (what, why, how you verified it). Use merge policy `review` unless told otherwise. Check `get_mergeability` and `list_checks`; fix failing required checks by pushing to the same ref.
7. **Enqueue.** When required checks pass, call `enqueue_change` with the change `number` and the `headSha` you tested (read the head with `get_change` after your last push; it must equal your local `git rev-parse HEAD`). Enqueuing approves that head, and the repository's branch rules still decide whether more approvals are needed; if the call is refused, report why instead of working around it. If it answers `HEAD_MOVED`, re-read the change and re-test. Watch `get_queue` or `get_change` until it merges.
8. **Record the decision.** If you chose between approaches, call `record_decision` with `chosen`, `rejected` (each with a reason) and `reason`, and the `task` or `paths` it covers.

## Conflicts

If a change conflicts with its base, Kvarm opens a `resolve-conflict` task instead of failing. Call `list_tasks` with `kind` `resolve-conflict`, then `claim_task`, resolve in the workspace the claim returns (regenerate lockfiles with the package manager instead of merging them by hand), push, and finish with `complete_task` using the `generation` and `sha`. Call `heartbeat_task` if the work takes longer than the lease. A `STALE_GENERATION` error means another agent took over: stop and do not push.

## Rules

- Never push to `main` or to another agent's workspace. Never force-push over a ref you did not create.
- Do not weaken tests, add `|| true` to CI commands or disable checks to get a change through; Kvarm's `kvarm/guard` check flags these and a human decides.
- Do not commit secrets, tokens (`kvarm_pat_...`, `kvarm_agt_...`) or `.env` files.
- Escalations (reviewer disagreement, protected paths, final selection between candidates) are resolved by a human. Stop and report instead of working around them.
- If a tool returns `isError`, read `status`, `error` and `code`; do not retry blindly on 403 or 404.
- Keep changes scoped to the task. Mention anything unrelated you noticed in the change body instead of fixing it.

Full guide: the Kvarm repository's `docs/agents/workflow.md`.
