-- Push event ledger and per-effect completion (architecture §11.5). Additive only.
--
-- push_events: one row per genuine push transition. `id` is the event identity:
-- the source's own delivery identity when it carries one, otherwise a hash of
-- (repo, ref, before, after, source event time). Redeliveries of the same event
-- collapse onto one row (deliveries counts them); a genuine repeat of the same
-- transition later (A->B, B->A, A->B) is a new row with the same
-- transition_key. Rows are audit history: there is no repo foreign key, so
-- deleting a repo never deletes them.
CREATE TABLE push_events (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  before_sha TEXT NOT NULL,
  after_sha TEXT NOT NULL,
  -- repo_id:ref:before:after, the immutable work identity (not the audit identity).
  transition_key TEXT NOT NULL,
  source TEXT NOT NULL,
  first_delivery_id TEXT,
  last_delivery_id TEXT,
  deliveries INTEGER NOT NULL DEFAULT 0,
  -- Source event time (ms) orders transitions of one ref.
  event_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  -- Set once every applicable effect is done or skipped.
  completed_at INTEGER
);
-- (event_at, id) is the events API page order and cursor.
CREATE INDEX idx_push_events_repo ON push_events(repo_id, event_at, id);
CREATE INDEX idx_push_events_transition ON push_events(transition_key);

-- Each downstream effect of an event completes independently. A redelivered or
-- replayed event runs only the effects without a row here.
CREATE TABLE push_event_effects (
  event_id TEXT NOT NULL,
  effect TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('done', 'skipped')),
  detail TEXT,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, effect)
);

-- Latest known position of each ref, advanced only by a newer event, so an
-- out-of-order (older) delivery never moves state backwards.
CREATE TABLE repo_refs (
  repo_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  sha TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, ref)
);

-- Push events name the repo by its Artifacts name; the dispatcher resolves it
-- inside its single ingest batch.
CREATE INDEX idx_repos_artifacts_name ON repos(artifacts_name);
