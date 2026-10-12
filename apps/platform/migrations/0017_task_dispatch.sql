-- Agent dispatch of resolve-conflict tasks (services/tasks.ts): claim,
-- heartbeat, completion. Additive only.

-- The workspace the claimant works in, created at claim at the conflicting
-- change's head (refs/heads/agents/<id>/<slug>); a reclaim reuses it. The
-- existing workspace_id stays the change's own workspace, if any.
ALTER TABLE agent_tasks ADD COLUMN claim_workspace_id TEXT;
-- Mirror of the fenced claim's expiry (fenced_claims kind 'task'), so open
-- listings can include claims whose lease ran out without a join.
ALTER TABLE agent_tasks ADD COLUMN lease_expires_at INTEGER;
-- The commit completion moved the change's head to, and who completed it.
ALTER TABLE agent_tasks ADD COLUMN resolution_sha TEXT;
ALTER TABLE agent_tasks ADD COLUMN completed_by TEXT;
