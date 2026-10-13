-- Nexus semantic dependency signal (services/intents/semantic.ts,
-- architecture §11.2). Additive. Advisory only: nothing that decides a push,
-- merge, queue entry or check reads these rows.

-- One row per signal of an active workspace, computed from its changed files
-- at the head it was reconciled at. Paths and names only, never content:
--  - import:   key = a repo path (or Go package directory, trailing `/`) the
--              workspace's changed files import within the depth limit;
--              detail = {"depth":n,"chain":[changed file, ..., key],"names":[...]}
--  - export:   key = a changed module whose export surface changed;
--              detail = {"added":[...],"removed":[...]}
--  - contract: key = a contract-file API family (`proto:api/v1/`);
--              detail = {"paths":[...]} (the workspace's changed files in it)
CREATE TABLE workspace_semantic (
  repo_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('import', 'export', 'contract')),
  key TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  detail TEXT NOT NULL,
  PRIMARY KEY (repo_id, kind, key, workspace_id)
) WITHOUT ROWID;
CREATE INDEX idx_wss_workspace ON workspace_semantic(repo_id, workspace_id, kind, key);

-- The head the semantic rows were read at, when, and why they are incomplete
-- (a spent budget or a failed analysis); NULL when complete.
ALTER TABLE workspaces ADD COLUMN semantic_head_sha TEXT;
ALTER TABLE workspaces ADD COLUMN semantic_at INTEGER;
ALTER TABLE workspaces ADD COLUMN semantic_truncated TEXT;
CREATE INDEX idx_ws_semantic_incomplete ON workspaces(repo_id, id) WHERE status = 'active' AND semantic_truncated IS NOT NULL;

-- Active workspaces with observed changes from before this migration have no
-- semantic rows yet; say so until their next push analyzes them, so forecasts
-- disclose them instead of reporting an empty layer as complete.
UPDATE workspaces SET semantic_truncated = 'not analyzed yet: observed before the semantic signal existed; the next push analyzes it'
 WHERE status = 'active' AND observed_paths IS NOT NULL AND observed_paths != '[]';

-- A workspace that leaves active (abandon, merge, expiry) or is deleted with
-- its repo drops its semantic rows in the same transaction, so every reader
-- sees only active workspaces' signal without new cleanup calls.
CREATE TRIGGER trg_ws_semantic_inactive AFTER UPDATE OF status ON workspaces
WHEN OLD.status = 'active' AND NEW.status != 'active'
BEGIN
  DELETE FROM workspace_semantic WHERE repo_id = NEW.repo_id AND workspace_id = NEW.id;
END;

CREATE TRIGGER trg_ws_semantic_delete AFTER DELETE ON workspaces
BEGIN
  DELETE FROM workspace_semantic WHERE repo_id = OLD.repo_id AND workspace_id = OLD.id;
END;
