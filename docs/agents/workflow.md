# The Kvarm agent workflow

The intended loop for an agent that works in a Kvarm repository. Every tool named here exists in the operation registry (`packages/ops/src/index.js`); `kvarm help <group> <verb>` prints the REST endpoint and MCP tool name of each, and `apps/cli/test/agentDocs.test.ts` fails if this directory names a tool that does not exist.

Setup first: [README.md](README.md) (token, client pages). The agent token must be a `write` token whose `refs` cover `refs/heads/agents/*`.

Examples show tool arguments as JSON. `repo` is always `<owner>/<repo>`.

## 0. Read what earlier agents decided

`get_context` with `{"repo": "...", "path": ["src/queue/"]}` (or `"task": "<task id>"`) returns prior decisions for those paths, newest first: what was chosen, what was rejected and why. Read it before choosing an approach. The result is bounded and reports `truncated` and `nextCursor`.

## 1. Create a workspace

`create_workspace` with `{"repo": "...", "task": "add retry to the webhook sender", "agent": "my-agent"}`.

The server creates the ref `refs/heads/agents/<workspaceId>/<slug>` at the base head (the slug comes from `task`, at most 40 characters). The reply carries the workspace `id` and its `ref`; remember both. `base` defaults to the default branch. Pass an `intent` here to combine this step with step 2.

## 2. Declare intent

`set_intent` with `{"repo": "...", "workspace": "<workspaceId>", "paths": ["src/webhooks/", "docs/webhooks.md"]}`. A trailing `/` marks a directory prefix. Declarations are advisory: nothing is locked, they only let other agents see where you are working. `ttlSeconds` (60 to 2592000) bounds how long the declaration lives. `get_intent` shows the declared paths next to the paths your pushes actually touched, including anything outside the declaration.

## 3. Check the forecast and overlap

- `forecast` with `{"repo": "...", "paths": ["src/webhooks/"], "exclude": "<workspaceId>"}` lists other active workspaces whose declared or observed paths intersect yours.
- `get_overlap` lists pairs of active workspaces whose pushed changes already touch the same paths.

Results are advisory and say so in the reply: an empty or truncated result is not proof of compatibility. If another workspace overlaps, either narrow your paths, coordinate through a dependency (`add_dependency` pins your workspace to another at an exact revision), or accept the likely conflict and plan for step 7.

## 4. Push to the workspace ref

The push is ordinary git over HTTPS; the agent token is the password (the username can be anything). Keep the token out of command lines and logs: use an askpass helper that reads `KVARM_AGENT_TOKEN`.

```sh
git -c credential.helper= push "<KVARM_ORIGIN>/<owner>/<repo>.git" \
  HEAD:refs/heads/agents/<workspaceId>/<slug>
```

The workspace ref is created already; you update it. A token whose `refs` do not match, a workspace that is abandoned or merged, or somebody else's workspace is refused at the git gate. Never push to the default branch; changes reach it through the queue (step 6). `get_workspace` shows the live head after the push.

## 5. Open the change

`create_change_set` with `{"repo": "...", "workspace": "<workspaceId>", "title": "Retry webhook delivery", "body": "...", "mergePolicy": "review"}` opens the change for the workspace branch. `mergePolicy` is `review` (merges on an explicit call), `auto` (merges once mergeable and all required checks pass) or `draft` (never merges). `create_change` opens a change from any head branch into a base branch when no workspace is involved.

Check readiness with `get_mergeability` and `list_checks` (both take `repo` and `number`). Required checks and human approvals come from the repository's branch rules; `get_branch_policy` with `{"repo": "...", "ref": "main"}` shows them. Reviews are in `get_reviews`; a push stales approvals.

## 6. Enqueue

`enqueue_change` with `{"repo": "...", "number": 7, "headSha": "<40-hex head you tested>"}`. Read the current head with `get_change` after your last push; it must equal your local `git rev-parse HEAD`. Enqueuing approves that head, and the branch rules still decide whether more approvals are needed. The integration train prepares the exact composed tree and checks it; only the final publication takes a short lease. `headSha` makes the call fail with `HEAD_MOVED` if the change moved, so you never enqueue code you did not look at. Drafts are refused with 409, and a full queue answers 429 with `Retry-After`.

Follow progress with `get_queue` and `get_train`, and `get_change` for the change state. `dequeue_change` takes it back out. `merge_change` is the explicit alternative for a `review` policy change when you do not use the queue.

## 7. Handle a conflict task

A textual conflict turns into a `resolve-conflict` task instead of a failure.

1. `list_tasks` with `{"repo": "...", "kind": "resolve-conflict", "status": "open"}`. A task names the change, its head and base commits and the conflicting paths (lockfiles are marked `needsRegeneration`: regenerate them with the package manager, never hand-merge).
2. `claim_task` with `{"repo": "...", "task": "<taskId>", "ttlSeconds": 600}` takes an expiring lease and returns a `workspace` (its branch sits at the conflicting change's head) and the lease `generation`. A live claim by another agent answers 409 `CLAIMED`.
3. Merge the base into that branch locally, resolve, and push to the claimed workspace ref as in step 4.
4. While you work, `heartbeat_task` with `{"repo": "...", "task": "<taskId>", "generation": <generation>}` extends the lease. A 409 `STALE_GENERATION` means someone took over; stop.
5. `complete_task` with `{"repo": "...", "task": "<taskId>", "generation": <generation>, "sha": "<resolution commit>"}`. The workspace head must descend from the change head and merge cleanly with the base. The change then follows its merge policy again.

## 8. Record the decision

When you chose between approaches (or the queue chose between candidates), leave the reasoning for the next agent: `record_decision` with

```json
{
  "repo": "<owner>/<repo>",
  "task": "<task id>",
  "paths": ["src/webhooks/"],
  "chosen": "<workspaceId or change number>",
  "rejected": [{ "id": "<other workspace id>", "reason": "duplicated the sender instead of reusing it" }],
  "reason": "smallest diff that keeps delivery idempotent"
}
```

`task` and `paths` are each optional but at least one is expected; `chosen`, `rejected` and `reason` are required. Step 0 of the next run reads it with `get_context`. `set_attribution` attaches agent, session and prompt-hash notes to a commit; `enqueue_change`, `merge_change` and `complete_task` also accept an `attribution` object.

## Cleanup

`abandon_workspace` deletes an unneeded workspace ref. `revoke_agent_token` (human) ends the session's credential early.

## Multi-attempt tasks (optional)

For several attempts at one task, `list_candidates`, `compose_candidates`, `create_arena`, `rank_arena` and `select_arena_winner` compare and combine workspaces. Final arena selection opens an escalation that only a human resolves (`resolve_escalation`). These are covered by the registry descriptions (`kvarm help candidates`).

## Review and author guides

`get_review_guide` with `{"repo": "...", "number": 7}` returns the current coverage units, author or fallback guide, acknowledgements, findings, contracts, impact-cache state and `remaining` blockers. When authoring the guide, use `submit_review_guide` with the full current `headSha` and chapters built from returned unit keys; uncovered units remain in the `unguided` chapter. Use `ack_review_units` with that full head and the keys you reviewed (or a chapter id) to record content-keyed acknowledgements. Submit structured findings with `submit_findings`, then `list_findings` and `update_finding` to track their disposition. `get_review_impact` returns bounded downstream importer and test evidence; `get_review_analytics` returns bounded finding outcomes and guide coverage, with known agent model families labeled `declared`. Nudge suggestions carry the same `declared` evidence label for known agent families.
