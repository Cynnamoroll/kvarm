-- Check runs carry the identity the checks-gate answers for (architecture
-- §3/§6): the tree they ran on, the attempt, whether they are required and
-- whether they are quarantined, plus a JSON summary (guard findings, job
-- results). Existing rows keep NULL tree/summary and count as required.
ALTER TABLE check_runs ADD COLUMN tree_sha TEXT;
ALTER TABLE check_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE check_runs ADD COLUMN required INTEGER NOT NULL DEFAULT 1;
ALTER TABLE check_runs ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0;
ALTER TABLE check_runs ADD COLUMN summary TEXT;

-- The gate's lookups, each a bounded newest-first index range: the counted
-- runs on an exact tree, and one named run of a commit (the guard verdict of
-- a head). The commit status reads a commit's runs newest first.
CREATE INDEX IF NOT EXISTS idx_checks_tree_gate ON check_runs(repo_id, tree_sha, required, quarantined, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_checks_sha_name_newest ON check_runs(repo_id, head_sha, name, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_checks_sha_newest ON check_runs(repo_id, head_sha, created_at DESC, id DESC);
