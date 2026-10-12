-- Nexus intents and forecasts (services/intents/forecast.ts). Additive.

-- Declared intent: the normalized declaration (JSON array; a trailing `/`
-- marks a prefix), when it was last replaced and when it stops counting as an
-- active signal (NULL: while the workspace is active).
ALTER TABLE workspaces ADD COLUMN intent_paths TEXT;
ALTER TABLE workspaces ADD COLUMN intent_updated_at INTEGER;
ALTER TABLE workspaces ADD COLUMN intent_expires_at INTEGER;
-- Observed paths: the cumulative base→head changed-path set (JSON array,
-- bounded; wide edits collapse to prefixes), the commit pair it was computed
-- from, the push event time that produced it (orders reconciliations) and why
-- it is incomplete, if it is.
ALTER TABLE workspaces ADD COLUMN observed_paths TEXT;
ALTER TABLE workspaces ADD COLUMN observed_base_sha TEXT;
ALTER TABLE workspaces ADD COLUMN observed_head_sha TEXT;
ALTER TABLE workspaces ADD COLUMN observed_event_at INTEGER;
ALTER TABLE workspaces ADD COLUMN observed_at INTEGER;
ALTER TABLE workspaces ADD COLUMN observed_truncated TEXT;
-- Number of observed entries that are collapsed directory prefixes.
ALTER TABLE workspaces ADD COLUMN observed_prefixes INTEGER NOT NULL DEFAULT 0;

-- The active index: one row per declared or observed path/prefix of an
-- active workspace. Abandon and merge remove a workspace's rows (the
-- workspace row keeps its declaration and observed set as history).
CREATE TABLE workspace_paths (
  repo_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('declared', 'observed')),
  path TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  PRIMARY KEY (repo_id, kind, path, workspace_id)
) WITHOUT ROWID;
CREATE INDEX idx_wsp_workspace ON workspace_paths(repo_id, workspace_id, kind, path);
