-- Issue #14: signed inbound incident webhooks that open revert change sets
-- (services/incidents.ts, services/reverts.ts). Revert change sets themselves
-- need no schema: change_sets.kind already allows 'revert' (0008).
--
-- One webhook secret per repository. The secret is never stored: it is
-- derived from the Worker secret INCIDENT_WEBHOOK_KEY, the repository id and
-- key_nonce, shown once, and re-derived to verify a delivery. key_hash
-- (SHA-256 of the secret) is a fingerprint for display and detects a changed
-- Worker secret; neither column lets a reader of D1 sign a delivery.
-- Rotation writes a new nonce, which invalidates the previous secret.
CREATE TABLE incident_webhooks (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  key_nonce TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  generation INTEGER NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  rotated_at INTEGER NOT NULL
);

-- Idempotency by CloudEvents source + id (unique together by the spec): the
-- first verified delivery of an event claims the row ('pending') before any
-- ref is written, records the revert change it opened ('opened'), and every
-- later delivery of the event answers with that change. A claim whose
-- delivery failed is removed so a retry recomputes; a pending claim older
-- than the takeover window may be taken over. The revert branch name is
-- derived from the event as well, so a taken-over delivery cannot open a
-- second change for it.
CREATE TABLE incident_events (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  event_source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  subject_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'opened')),
  claim TEXT NOT NULL,
  change_set_id TEXT REFERENCES change_sets(id) ON DELETE SET NULL,
  change_number INTEGER,
  claimed_at INTEGER NOT NULL,
  opened_at INTEGER,
  PRIMARY KEY (repo_id, event_source, event_id)
);

-- One change set per revert branch. A revert branch is written once by the
-- platform and opened once; two deliveries of one incident event that race
-- (one taking over the other's claim) cannot both open a change on it.
CREATE UNIQUE INDEX idx_change_sets_revert_head ON change_sets(repo_id, head_ref) WHERE kind = 'revert';
