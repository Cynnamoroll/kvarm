-- Push ordering across clocks and identities (architecture §11.5). Additive only.
--
-- clock: whose clock event_at was read from, 'worker' (git gate pushes, and
-- Artifacts events without a source timestamp, timed on receipt) or
-- 'artifacts'. Only rows of one clock are compared. NULL on rows recorded
-- before this column: their clock follows from `source`.
--
-- artifacts_at: the Artifacts source timestamp of the push, when known (also
-- on a gate row once its Artifacts delivery paired with it). A delivery of
-- the same transition with the same source timestamp is the same push under
-- another identity, never a new one.
ALTER TABLE push_events ADD COLUMN clock TEXT;
ALTER TABLE push_events ADD COLUMN artifacts_at INTEGER;
CREATE INDEX idx_push_events_artifacts_at ON push_events(transition_key, artifacts_at);
