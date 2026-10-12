-- User-owned CI runner jobs. A job and its check run share one immutable
-- head/tree identity. Claims use generation + owner fencing; an expired
-- lease may be taken over, and a late report cannot overwrite its successor.
CREATE TABLE ci_jobs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  change_set_id TEXT REFERENCES change_sets(id) ON DELETE CASCADE,
  check_run_id TEXT NOT NULL UNIQUE REFERENCES check_runs(id) ON DELETE CASCADE,
  head_sha TEXT NOT NULL,
  tree_sha TEXT NOT NULL,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'success', 'failure')),
  generation INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  claim_id TEXT,
  lease_until INTEGER,
  timeout_seconds INTEGER NOT NULL DEFAULT 900,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  summary TEXT
);

CREATE UNIQUE INDEX idx_ci_jobs_change_head_name ON ci_jobs(change_set_id, head_sha, name);
CREATE INDEX idx_ci_jobs_claim ON ci_jobs(repo_id, status, lease_until, created_at, id);
CREATE INDEX idx_ci_jobs_tree ON ci_jobs(repo_id, tree_sha, required, created_at DESC);
