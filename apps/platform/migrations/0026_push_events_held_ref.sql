-- Succession evidence for push ordering (architecture §11.5). Additive only.
--
-- A recorded successor of an event counts as evidence that the ref came back
-- to the event's commit only if that successor once held the ref position.
-- Ingest inserts 0 and sets 1 when the row moves the position; rows recorded
-- before this column existed keep the evidence they already gave (default 1).
ALTER TABLE push_events ADD COLUMN held_ref INTEGER NOT NULL DEFAULT 1;
