-- Conflict resolution and agent tasks (architecture §3 resolve.ts, §4
-- services/tasks.ts, §6). Additive only.

-- While a change is `conflicted`: JSON {headSha, conflicts:[{path, kind,
-- needsRegeneration?}], truncated?} for the head the conflicts were found
-- at; NULL otherwise.
ALTER TABLE change_sets ADD COLUMN conflicts TEXT;

-- Work for agents, created by Kvarm (a conflict the deterministic rules could
-- not resolve dispatches a `resolve-conflict` task). Claims are fenced
-- through fenced_claims (kind 'task', subject = id); status mirrors the
-- task's lifecycle: open -> claimed -> completed, or obsolete when what it
-- was for went away (the conflict cleared, the change closed or merged).
CREATE TABLE agent_tasks (
  id TEXT NOT NULL PRIMARY KEY,
  repo_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  change_set_id TEXT,
  workspace_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  claimed_by TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  -- The change head and base tip the task was (last) dispatched for.
  head_sha TEXT,
  base_sha TEXT,
  -- JSON details for the kind (resolve-conflict: {conflicts, truncated?}).
  payload TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
-- One live task of a kind per change: re-detecting a conflict refreshes it.
CREATE UNIQUE INDEX idx_tasks_live_change ON agent_tasks(change_set_id, kind) WHERE status IN ('open', 'claimed');
-- GET tasks?status= and GET tasks (all statuses), newest first.
CREATE INDEX idx_tasks_repo_status ON agent_tasks(repo_id, status, created_at DESC, id DESC);
CREATE INDEX idx_tasks_repo_created ON agent_tasks(repo_id, created_at DESC, id DESC);
