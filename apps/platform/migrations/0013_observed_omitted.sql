-- Nexus observed index completeness (services/intents/forecast.ts). Additive.

-- Why the observed set may omit changed paths (top-level entries dropped past
-- the cap, or a base→head diff that ran out of budget); NULL when every
-- changed path is covered by some entry. Collapsing into prefixes is not an
-- omission. Forecast and overlap disclose active workspaces that have one.
ALTER TABLE workspaces ADD COLUMN observed_omitted TEXT;
CREATE INDEX idx_ws_observed_omitted ON workspaces(repo_id, base_ref) WHERE status = 'active' AND observed_omitted IS NOT NULL;
