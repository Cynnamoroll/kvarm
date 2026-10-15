ALTER TABLE review_policies ADD COLUMN nudge_after_minutes INTEGER
  CHECK (nudge_after_minutes IS NULL OR nudge_after_minutes BETWEEN 15 AND 10080);

CREATE TABLE review_nudges (
  change_set_id TEXT NOT NULL REFERENCES change_sets(id) ON DELETE CASCADE,
  head_sha TEXT NOT NULL,
  waiting_on TEXT NOT NULL CHECK (waiting_on IN ('reviewers', 'human')),
  seq INTEGER NOT NULL CHECK (seq IN (1, 2)),
  sent_at INTEGER NOT NULL,
  reasons TEXT NOT NULL,
  suggested_principal TEXT,
  PRIMARY KEY (change_set_id, head_sha, waiting_on, seq)
);
CREATE INDEX idx_review_nudges_change ON review_nudges(change_set_id, head_sha, sent_at DESC);
