-- Guided review state and deterministic findings. Migration 0024 is already
-- used by publication intents, so this additive migration takes the next slot.

CREATE TABLE review_guides (
  id TEXT PRIMARY KEY,
  change_set_id TEXT NOT NULL REFERENCES change_sets(id) ON DELETE CASCADE,
  head_sha TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('author', 'reviewer')),
  user_id TEXT REFERENCES users(id),
  agent_id TEXT,
  token_id TEXT,
  body TEXT NOT NULL,
  gaps INTEGER NOT NULL,
  undeclared INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (change_set_id, head_sha, source)
);
CREATE INDEX idx_review_guides_change ON review_guides(change_set_id, head_sha, source);

CREATE TABLE review_acks (
  change_set_id TEXT NOT NULL REFERENCES change_sets(id) ON DELETE CASCADE,
  unit_key TEXT NOT NULL,
  principal TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  agent_id TEXT,
  head_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (change_set_id, principal, unit_key)
);
CREATE INDEX idx_review_acks_unit ON review_acks(change_set_id, unit_key);

CREATE TABLE review_findings (
  id TEXT PRIMARY KEY,
  change_set_id TEXT NOT NULL REFERENCES change_sets(id) ON DELETE CASCADE,
  opened_head TEXT NOT NULL,
  last_seen_head TEXT NOT NULL,
  path TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('head', 'base')),
  start_line INTEGER NOT NULL,
  end_line INTEGER,
  unit_key TEXT,
  category TEXT NOT NULL CHECK (category IN ('bug', 'risk', 'security', 'breaking', 'maintainability', 'question')),
  severity TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
  confidence TEXT NOT NULL CHECK (confidence IN ('confirmed', 'investigate')),
  title TEXT NOT NULL,
  scenario TEXT,
  verify TEXT,
  body TEXT,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'irrelevant', 'wont-fix')),
  principal TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  agent_id TEXT,
  resolved_principal TEXT,
  resolved_note TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_review_findings_change_status ON review_findings(change_set_id, status);
CREATE INDEX idx_review_findings_fingerprint ON review_findings(change_set_id, fingerprint);

ALTER TABLE review_policies ADD COLUMN guide_required INTEGER NOT NULL DEFAULT 0 CHECK (guide_required IN (0, 1));
ALTER TABLE review_policies ADD COLUMN blocking_findings TEXT NOT NULL DEFAULT 'high-confirmed' CHECK (blocking_findings IN ('none', 'high-confirmed'));
ALTER TABLE change_reviews ADD COLUMN coverage TEXT;
