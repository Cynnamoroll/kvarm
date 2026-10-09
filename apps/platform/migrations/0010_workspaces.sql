-- Agent workspaces (services/workspaces.ts). Additive: the 0001 table gains
-- the workspace ref and its lifecycle; rows from before this migration keep
-- NULL in the new columns.

-- Full ref, refs/heads/agents/<id>/<slug>, created server-side at the base head.
ALTER TABLE workspaces ADD COLUMN ref TEXT;
-- Base branch name and the head it pointed at when the workspace was created.
ALTER TABLE workspaces ADD COLUMN base_ref TEXT;
ALTER TABLE workspaces ADD COLUMN base_sha TEXT;
-- Last head recorded when the workspace left `active` (its ref may be gone).
ALTER TABLE workspaces ADD COLUMN head_sha TEXT;
ALTER TABLE workspaces ADD COLUMN created_by TEXT REFERENCES users(id);
-- The agent principal that owns the workspace (agent-token creations);
-- NULL for workspaces a person created.
ALTER TABLE workspaces ADD COLUMN agent_id TEXT REFERENCES agents(id);
ALTER TABLE workspaces ADD COLUMN updated_at INTEGER;
ALTER TABLE workspaces ADD COLUMN abandoned_at INTEGER;
ALTER TABLE workspaces ADD COLUMN merged_at INTEGER;

-- Newest-first pages, with and without a status filter (rowid, implicit in
-- every index entry, breaks creation-time ties).
CREATE INDEX idx_ws_repo_created ON workspaces(repo_id, created_at);
CREATE INDEX idx_ws_repo_status_created ON workspaces(repo_id, status, created_at);
-- Merge hook: the workspace of a change set.
CREATE INDEX idx_ws_change ON workspaces(change_set_id);
CREATE UNIQUE INDEX idx_ws_repo_ref ON workspaces(repo_id, ref) WHERE ref IS NOT NULL;
