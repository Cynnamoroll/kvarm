-- Opt-in branch rules (architecture §11.1). A ref matching any rule of its
-- repo is protected: no principal (including the instance admin) may create,
-- update or delete it with a direct git push; it changes only through the
-- platform's publication path, which must satisfy the rule's required checks
-- and separate human approvals. Additive only.

CREATE TABLE branch_rules (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  -- Full ref name (refs/heads/main) or a prefix ending in /* (refs/heads/release/*).
  pattern TEXT NOT NULL,
  -- JSON array of check names that must succeed on the published composition.
  required_checks TEXT NOT NULL DEFAULT '[]',
  -- Distinct human approvals of the current head, excluding the change author.
  required_approvals INTEGER NOT NULL DEFAULT 0 CHECK (required_approvals BETWEEN 0 AND 10),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at INTEGER NOT NULL,
  UNIQUE (repo_id, pattern)
);
