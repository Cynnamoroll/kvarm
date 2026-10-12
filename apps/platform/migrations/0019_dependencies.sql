-- Nexus pinned draft dependencies (services/dependencies.ts, architecture
-- §11.3). Additive only.
--
-- One explicit edge per (dependent workspace, source workspace) in one
-- repository: `workspace_id` depends on `on_workspace` at exactly `revision`.
-- The edge state is derived on read from the source workspace (active at
-- the revision: active; moved: stale; abandoned: broken; merged: satisfied
-- only once `satisfied_commit` recorded that the landed commit contains the
-- revision, or broken when `broken_code` recorded that it does not). The
-- platform never rewrites `revision`: only an explicit repin does.
CREATE TABLE workspace_dependencies (
  repo_id TEXT NOT NULL,
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  on_workspace TEXT NOT NULL,
  revision TEXT NOT NULL,
  created_by TEXT,
  created_login TEXT,
  agent_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  repinned_at INTEGER,
  satisfied_commit TEXT,
  satisfied_at INTEGER,
  broken_code TEXT,
  broken_reason TEXT,
  PRIMARY KEY (repo_id, id)
) WITHOUT ROWID;
-- A workspace's own edges (list, the publication gate, the downward chain walk).
CREATE UNIQUE INDEX idx_dep_edge ON workspace_dependencies(repo_id, workspace_id, on_workspace);
-- The dependents of a source (the upward walk, satisfaction when the source
-- lands); covering for the walk.
CREATE INDEX idx_dep_source ON workspace_dependencies(repo_id, on_workspace, workspace_id);

-- Per-principal fairness of the integration train (services/queue.ts): the
-- enqueuing principal (`agent:<id>` or `user:<id>`). `seq` stays the arrival
-- order; each train pass orders its bounded read-ahead fairly across
-- principals (fairOrder), so the column adds no read or index to enqueue.
ALTER TABLE merge_queue ADD COLUMN principal TEXT;
