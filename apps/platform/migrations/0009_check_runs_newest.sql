-- A change's newest check runs (ORDER BY created_at DESC, id DESC LIMIT n)
-- read straight off this index, so the rows read stay at n however long the
-- check history grows. idx_checks_cs alone makes SQLite read and sort every
-- run of the change.
CREATE INDEX IF NOT EXISTS idx_checks_cs_newest ON check_runs(change_set_id, created_at DESC, id DESC);
