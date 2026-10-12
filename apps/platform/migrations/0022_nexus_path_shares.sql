-- Nexus overlap and forecast reads that follow shared paths, not every indexed
-- row (services/intents/forecast.ts). Additive.

-- How many observed index rows each (repo, base, path) has. Triggers on
-- workspace_paths keep it in the same transaction as the index rows
-- themselves (push-consumer completion batch, abandon, merge, repo delete),
-- so overlap reads only the paths at least two workspaces share.
-- workspaces.base_ref never changes after creation.
CREATE TABLE workspace_path_shares (
  repo_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  path TEXT NOT NULL,
  members INTEGER NOT NULL,
  PRIMARY KEY (repo_id, base_ref, path)
) WITHOUT ROWID;
CREATE INDEX idx_wps_shared ON workspace_path_shares(repo_id, base_ref, path) WHERE members > 1;

CREATE TRIGGER trg_wsp_share_insert AFTER INSERT ON workspace_paths
WHEN NEW.kind = 'observed'
BEGIN
  INSERT INTO workspace_path_shares (repo_id, base_ref, path, members)
  SELECT NEW.repo_id, w.base_ref, NEW.path, 1 FROM workspaces w
   WHERE w.id = NEW.workspace_id AND w.repo_id = NEW.repo_id AND w.base_ref IS NOT NULL
  ON CONFLICT (repo_id, base_ref, path) DO UPDATE SET members = members + 1;
END;

CREATE TRIGGER trg_wsp_share_delete AFTER DELETE ON workspace_paths
WHEN OLD.kind = 'observed'
BEGIN
  UPDATE workspace_path_shares SET members = members - 1
   WHERE repo_id = OLD.repo_id AND path = OLD.path
     AND base_ref = (SELECT w.base_ref FROM workspaces w WHERE w.id = OLD.workspace_id AND w.repo_id = OLD.repo_id);
  DELETE FROM workspace_path_shares WHERE repo_id = OLD.repo_id AND path = OLD.path AND members <= 0;
END;

INSERT INTO workspace_path_shares (repo_id, base_ref, path, members)
SELECT p.repo_id, w.base_ref, p.path, COUNT(*) FROM workspace_paths p
  JOIN workspaces w ON w.id = p.workspace_id AND w.repo_id = p.repo_id
 WHERE p.kind = 'observed' AND w.base_ref IS NOT NULL
 GROUP BY p.repo_id, w.base_ref, p.path;

-- Active workspaces whose observed index omits changed paths, under the
-- exact predicate forecast and overlap disclose them by (INDEX_INCOMPLETE),
-- so that disclosure reads only those workspaces.
CREATE INDEX idx_ws_index_incomplete ON workspaces(repo_id, id)
  WHERE status = 'active' AND (observed_omitted IS NOT NULL OR (observed_truncated IS NOT NULL AND observed_truncated NOT GLOB '[0-9]*'));

-- Active workspaces with collapsed directory prefixes: the only ones that
-- start overlap's prefix probe.
CREATE INDEX idx_ws_observed_prefixes ON workspaces(repo_id, base_ref, id) WHERE status = 'active' AND observed_prefixes > 0;
