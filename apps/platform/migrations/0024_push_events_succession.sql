-- Succession lookups for push ordering (architecture §11.5). Additive only.
--
-- An event whose `before` is the ledger's current position is timed after that
-- position unless a successor of the event (a row of the same ref leaving its
-- `after`) is already recorded at or after the position. This index answers
-- that question without scanning the repo's whole event history.
CREATE INDEX idx_push_events_ref_before ON push_events(repo_id, ref, before_sha, event_at);
