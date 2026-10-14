-- Push events recorded at the git gate (architecture §11.5). Additive only.
--
-- The gate ingests a protocol-confirmed push right away (source 'kvarm-gate')
-- instead of waiting for the Artifacts event. When the Artifacts event for the
-- same transition arrives later (or earlier, if the gate's write lagged), its
-- identity is recorded here as an alias of the row already ingested, so both
-- deliveries are one push: one audit row, one set of effects, and the second
-- delivery replays only the effects still missing.
CREATE TABLE push_event_aliases (
  alias_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- "Is this event already paired?" during ingest.
CREATE INDEX idx_push_event_aliases_event ON push_event_aliases(event_id);
