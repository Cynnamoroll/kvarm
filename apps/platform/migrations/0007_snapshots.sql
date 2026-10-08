-- Working-tree snapshots (architecture §11.5). Additive only; the unused 0001
-- `snapshots` table stays as it was.
--
-- snapshot_trees: one immutable tarball per (repo, root tree) in R2. Commits
-- that share a tree share its bytes. `builder` is the SnapshotBuilder
-- instance that holds the build; a failed or long-stale build can be taken
-- over by another instance.
--
-- No repo foreign key on either table: deleting a repo removes its rows
-- explicitly (repos/service.ts) and must never be blocked by them.
CREATE TABLE snapshot_trees (
  repo_id TEXT NOT NULL,
  tree TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('building', 'ready', 'failed')),
  builder TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size INTEGER,
  files INTEGER,
  build_cost TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  built_at INTEGER,
  PRIMARY KEY (repo_id, tree)
);

-- snapshot_commits: the commit-addressed metadata the API serves. `tree` is
-- null until the builder has read the commit. `trigger` records why the
-- build exists: an eager default-branch push or an explicit demand.
CREATE TABLE snapshot_commits (
  repo_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  tree TEXT,
  state TEXT NOT NULL CHECK (state IN ('building', 'ready', 'failed')),
  trigger TEXT NOT NULL CHECK (trigger IN ('push', 'demand')),
  instance_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  reused INTEGER NOT NULL DEFAULT 0,
  build_cost TEXT,
  error TEXT,
  requested_at INTEGER NOT NULL,
  built_at INTEGER,
  PRIMARY KEY (repo_id, sha)
);
-- A finished tree build marks every commit waiting on the same tree ready.
CREATE INDEX idx_snapshot_commits_tree ON snapshot_commits(repo_id, tree, state);
