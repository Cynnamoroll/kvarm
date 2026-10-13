-- Issue #13: retry-then-classify flaky required checks. The retry itself lives
-- in ci_jobs (services/ci.ts reportJob): a failed required, non-quarantined
-- runner check gets exactly one automatic second attempt of the same head and
-- tree. A pass on attempt 2 records the flake here, with the first attempt's
-- failure summary as evidence. A check that fails twice is not registered and
-- blocks as before.
CREATE TABLE ci_flakes (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  tree_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  -- SET NULL: a flake is history and outlives the change that produced it.
  change_set_id TEXT REFERENCES change_sets(id) ON DELETE SET NULL,
  attempt INTEGER NOT NULL,
  summary TEXT,
  seen_at INTEGER NOT NULL
);
CREATE INDEX idx_ci_flakes_repo ON ci_flakes(repo_id, seen_at DESC, id DESC);

-- Quarantine is per repository and check name, and only ever set by an
-- explicit admin action (services/flakes.ts). A quarantined check still
-- queues and runs, but its check runs are marked quarantined and therefore
-- never satisfy or block a required-checks gate, and its failures never
-- retry. Restore clears the flag on the existing runs and returns the name
-- to normal handling.
CREATE TABLE ci_quarantine (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  quarantined_by TEXT REFERENCES users(id),
  quarantined_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, name)
);
