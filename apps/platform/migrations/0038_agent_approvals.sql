ALTER TABLE branch_rules ADD COLUMN agent_approvals TEXT NOT NULL DEFAULT 'never';

CREATE TABLE change_head_tiers (
  change_set_id TEXT NOT NULL REFERENCES change_sets(id),
  head_sha TEXT NOT NULL,
  max_tier TEXT NOT NULL CHECK (max_tier IN ('scrutinize','read','receipt')),
  truncated INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (change_set_id, head_sha)
);
