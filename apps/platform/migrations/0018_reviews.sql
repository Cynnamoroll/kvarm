-- Reviews, the per-repo review policy and human escalations (architecture
-- §0.4 agent review policy, §9). Additive only.

-- The model family of an agent principal (e.g. "claude", "gpt"); reviewers of
-- a different family than the change author are preferred.
ALTER TABLE agents ADD COLUMN model_family TEXT;

-- Required approving reviews per change, from distinct principals other than
-- the author. No row: no review requirement (the ordinary review policy).
CREATE TABLE review_policies (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  required_reviews INTEGER NOT NULL CHECK (required_reviews BETWEEN 0 AND 10),
  updated_by TEXT REFERENCES users(id),
  updated_at INTEGER NOT NULL
);

-- One verdict per principal per exact head: a later review by the same
-- principal of the same head replaces the earlier one, and a review of an
-- older head never counts for a newer one.
CREATE TABLE change_reviews (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  change_set_id TEXT NOT NULL REFERENCES change_sets(id),
  head_sha TEXT NOT NULL,
  -- 'user:<users.id>' or 'agent:<agents.id>'.
  principal TEXT NOT NULL,
  -- The human, or the minting human of the agent token.
  user_id TEXT NOT NULL REFERENCES users(id),
  user_login TEXT NOT NULL,
  agent_id TEXT,
  agent_name TEXT,
  token_id TEXT,
  -- 'human' for human principals; the agent's model family (or NULL) otherwise.
  model_family TEXT,
  verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'request-changes')),
  body TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (change_set_id, head_sha, principal)
);
CREATE INDEX idx_reviews_change ON change_reviews(change_set_id, created_at);
CREATE INDEX idx_reviews_repo ON change_reviews(repo_id);

-- Open escalations block publication until a human approves or resolves them.
CREATE TABLE change_escalations (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  change_set_id TEXT NOT NULL REFERENCES change_sets(id),
  change_number INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('reviewer-disagreement', 'review-blocked', 'protected-path', 'final-selection')),
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
  head_sha TEXT,
  detail TEXT,
  opened_by TEXT,
  opened_at INTEGER NOT NULL,
  resolved_by TEXT REFERENCES users(id),
  resolved_by_login TEXT,
  resolution TEXT CHECK (resolution IN ('approve', 'acknowledge', 'resolve')),
  note TEXT,
  resolved_at INTEGER
);
CREATE UNIQUE INDEX idx_escalations_open ON change_escalations(change_set_id, reason) WHERE state = 'open';
CREATE INDEX idx_escalations_change ON change_escalations(change_set_id, opened_at);
CREATE INDEX idx_escalations_repo ON change_escalations(repo_id, state);

-- Review assignment lists the agents holding a live token for one repo.
CREATE INDEX idx_agent_tokens_repo ON agent_tokens(repo_id, agent_id);
