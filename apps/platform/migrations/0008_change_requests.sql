-- Change requests (architecture §4 services/changes.ts, §6, invariant 5).
-- Additive columns on change_sets; existing rows keep their values.

ALTER TABLE change_sets ADD COLUMN merge_policy TEXT NOT NULL DEFAULT 'review' CHECK (merge_policy IN ('auto', 'draft', 'review'));
ALTER TABLE change_sets ADD COLUMN base_sha TEXT;
ALTER TABLE change_sets ADD COLUMN risk_score INTEGER;
ALTER TABLE change_sets ADD COLUMN risk_level TEXT;
ALTER TABLE change_sets ADD COLUMN risk_reasons TEXT;
ALTER TABLE change_sets ADD COLUMN kind TEXT NOT NULL DEFAULT 'change' CHECK (kind IN ('change', 'revert', 'conflict-resolution'));
ALTER TABLE change_sets ADD COLUMN source_change_id TEXT;
ALTER TABLE change_sets ADD COLUMN queue_state TEXT;
ALTER TABLE change_sets ADD COLUMN updated_at INTEGER;
-- Event time of the push that last set head_sha (creation time at first): a
-- push event moves the head only when it is newer, so late deliveries of
-- older pushes never roll the head back.
ALTER TABLE change_sets ADD COLUMN head_event_at INTEGER;

-- Head refresh on push looks up the open changes of one head branch.
CREATE INDEX idx_cs_head ON change_sets(repo_id, head_ref, state);
-- List pages: one repo, one state, newest first.
CREATE INDEX idx_cs_repo_state_number ON change_sets(repo_id, state, number);
