CREATE TABLE change_review_requests (
  change_set_id TEXT NOT NULL REFERENCES change_sets(id),
  principal TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  PRIMARY KEY (change_set_id, principal)
);
CREATE INDEX idx_crr_principal ON change_review_requests(principal, requested_at);
