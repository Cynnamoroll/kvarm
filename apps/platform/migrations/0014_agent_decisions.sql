-- Agent decision records (services/decisions.ts): which candidate an agent
-- chose for a task and/or paths, what it rejected and why, so later agents
-- inherit the reasoning through get_context. Additive.

CREATE TABLE agent_decisions (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  task_id TEXT,
  -- JSON array of the normalized paths, as recorded.
  paths TEXT NOT NULL,
  chosen_candidate TEXT NOT NULL,
  -- JSON array of rejected candidates, each an id or {id, reason}, as recorded.
  rejected_candidates TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  agent_id TEXT,
  agent_name TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX idx_decisions_task ON agent_decisions(repo_id, task_id, at DESC, id DESC) WHERE task_id IS NOT NULL;
CREATE INDEX idx_decisions_repo_at ON agent_decisions(repo_id, at DESC, id DESC);

-- One row per (decision, path), so a decision is found by any of its paths.
CREATE TABLE agent_decision_paths (
  decision_id TEXT NOT NULL REFERENCES agent_decisions(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL,
  path TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (decision_id, path)
);
CREATE INDEX idx_decision_paths ON agent_decision_paths(repo_id, path, at DESC, decision_id DESC);
