-- Per-path history of the default branch (architecture §11.9). Additive only.
--
-- Derived data, built lazily by GET history from the default branch's
-- first-parent chain in bounded steps: forward from the newest indexed commit
-- and backward toward the root. `seq` orders commits along the chain (newer is
-- larger; backward fill goes below zero). When the indexed head is no longer on
-- the chain (a rewritten or renamed default branch), the index restarts in a
-- new epoch; rows of older epochs are never served and are deleted in bounded
-- batches by later requests. Every write is one compare-and-swap on the state
-- row (writer token), and the rows of a step are inserted only when that swap
-- applied, in the same batch.
CREATE TABLE path_history_state (
  repo_id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  ref TEXT NOT NULL,
  -- Newest indexed commit and its seq (NULL head: nothing indexed yet).
  head_sha TEXT,
  head_seq INTEGER NOT NULL,
  -- Next commit to index backward (the first parent of the oldest indexed
  -- commit); NULL once the root commit is indexed.
  tail_next TEXT,
  tail_seq INTEGER NOT NULL,
  -- Commits whose changes exceeded the per-commit budget (listed nowhere).
  gaps INTEGER NOT NULL DEFAULT 0,
  writer TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE path_history_commits (
  repo_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  sha TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_email TEXT NOT NULL,
  committed_at INTEGER NOT NULL,
  summary TEXT NOT NULL,
  gap INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, epoch, seq)
);

CREATE TABLE path_history (
  repo_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  path TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (repo_id, epoch, path, seq)
);
