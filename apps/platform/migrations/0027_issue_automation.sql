-- Issue automation (services/issues.ts). Additive only.
--
-- Issues are filed by people, by agents (create_issue) and by platform
-- signals (a failing default-branch check, a flake, a quarantine). A signal
-- names a fingerprint; while an issue with that fingerprint is open, the same
-- signal counts another occurrence on it instead of filing a duplicate.

-- human | agent | ci | flake | guard
ALTER TABLE issues ADD COLUMN source TEXT NOT NULL DEFAULT 'human';
ALTER TABLE issues ADD COLUMN fingerprint TEXT;
-- JSON array of repository-relative paths the issue is about.
ALTER TABLE issues ADD COLUMN paths TEXT;
-- JSON {agentId, agentName} when an agent token filed it.
ALTER TABLE issues ADD COLUMN agent_meta TEXT;
-- JSON evidence of the latest occurrence: {sha?, check?, runId?, workspace?, url?}.
ALTER TABLE issues ADD COLUMN evidence TEXT;
ALTER TABLE issues ADD COLUMN occurrences INTEGER NOT NULL DEFAULT 1;
ALTER TABLE issues ADD COLUMN last_seen_at INTEGER;
ALTER TABLE issues ADD COLUMN updated_at INTEGER;
-- completed (a linked change merged) | verified (its signal passed again) | not_planned | duplicate
ALTER TABLE issues ADD COLUMN closed_reason TEXT;
ALTER TABLE issues ADD COLUMN closed_by_change_id TEXT;
ALTER TABLE issues ADD COLUMN closed_by_commit TEXT;

-- One open issue per fingerprint; a closed one leaves room for a recurrence.
CREATE UNIQUE INDEX idx_issues_open_fingerprint ON issues(repo_id, fingerprint) WHERE state = 'open' AND fingerprint IS NOT NULL;
-- List pages: one repo, one state, newest number first.
CREATE INDEX idx_issues_repo_state_number ON issues(repo_id, state, number);

-- A link between an issue and the change or workspace that addresses it.
-- `closes` links that are `confirmed` close the issue in the same batch that
-- records the change merged into the default branch. Sources: text (a
-- closing keyword in the change title or body), branch (an issue number in
-- the head branch; proposed only), workspace (the workspace was created for
-- the issue), manual (link_issue). Text and branch rows are recomputed from
-- the change; manual rows, confirmations and rejections alike, are kept.
CREATE TABLE issue_links (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  change_set_id TEXT,
  workspace_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('closes', 'refs')),
  source TEXT NOT NULL CHECK (source IN ('text', 'branch', 'workspace', 'manual')),
  state TEXT NOT NULL CHECK (state IN ('confirmed', 'proposed', 'rejected')),
  actor TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((change_set_id IS NULL) != (workspace_id IS NULL))
);
CREATE UNIQUE INDEX idx_issue_links_change ON issue_links(change_set_id, issue_id) WHERE change_set_id IS NOT NULL;
CREATE UNIQUE INDEX idx_issue_links_workspace ON issue_links(workspace_id, issue_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX idx_issue_links_issue ON issue_links(issue_id, created_at);
