-- Candidate sets, arenas and compositions (services/candidates.ts). Additive.

-- An arena is an explicit candidate set: 2-8 workspaces created together
-- from one brief at one base head. The caller's selection is a recorded
-- choice only; merging still goes through the winner's change set.
CREATE TABLE arenas (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  brief TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  candidates INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'selected')),
  created_by TEXT,
  agent_id TEXT,
  created_at INTEGER NOT NULL,
  selected_workspace TEXT,
  selected_by TEXT,
  selected_at INTEGER
);
CREATE INDEX idx_arenas_repo_created ON arenas(repo_id, created_at);

-- The arena a workspace was created for (NULL for ordinary workspaces).
ALTER TABLE workspaces ADD COLUMN arena_id TEXT;
CREATE INDEX idx_ws_arena ON workspaces(repo_id, arena_id) WHERE arena_id IS NOT NULL;

-- A composed candidate: selected pieces of several workspaces folded onto
-- the base head, published as its own workspace (ref + change set). The
-- required checks the checks-gate reported for the exact composed tree are
-- recorded with it; `conflict_kind` is 'semantic' when that tree merged
-- cleanly but a required check failed.
CREATE TABLE compositions (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  tree_sha TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  -- JSON [{workspace, headSha, mergeBase, paths|null}] in fold order.
  sources TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  checks TEXT NOT NULL,
  conflict_kind TEXT CHECK (conflict_kind IS NULL OR conflict_kind = 'semantic'),
  created_by TEXT,
  agent_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_compositions_repo_created ON compositions(repo_id, created_at);
