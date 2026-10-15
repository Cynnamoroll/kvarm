CREATE TABLE repo_purges (
  repo_id TEXT PRIMARY KEY,
  artifacts_name TEXT NOT NULL,
  snapshot_keys TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  done_at INTEGER,
  last_error TEXT
);

CREATE INDEX idx_repo_purges_due ON repo_purges(done_at, next_attempt_at);
