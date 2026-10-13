-- Train exit history for the train view (architecture §11.4). Additive only.
--
-- The train view lists each target branch's active entries (trainStatus,
-- covered by idx_mq_live) and the entries that recently left the train with
-- the reason they left. The exits read is one indexed range scan per
-- repository, newest first, bounded by its LIMIT; history never adds work to
-- the live reads.

CREATE INDEX idx_mq_exits ON merge_queue(repo_id, updated_at DESC) WHERE active = 0;
