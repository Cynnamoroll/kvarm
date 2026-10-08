-- Organizations, direct membership and explicit per-repo grants (architecture §11.1).
-- Additive only: existing tables and rows are untouched apart from the
-- account_names backfill, which copies existing user logins into a new table.

-- One case-insensitive namespace for user and organization logins. Repo owner
-- paths and Artifacts repo names derive from these logins, so an org may
-- never shadow a user (or vice versa) in any letter case.
CREATE TABLE account_names (
  login TEXT PRIMARY KEY COLLATE NOCASE,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'org')),
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO account_names (login, kind, account_id, created_at)
  SELECT login, 'user', id, created_at FROM users;

-- Every user insert path (ops scripts, sign-in) claims its login here; a clash
-- with an existing org login aborts the user insert.
CREATE TRIGGER users_claim_account_name AFTER INSERT ON users
BEGIN
  INSERT INTO account_names (login, kind, account_id, created_at)
    VALUES (NEW.login, 'user', NEW.id, NEW.created_at);
END;

CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  login TEXT UNIQUE NOT NULL COLLATE NOCASE,
  name TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE org_members (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'maintainer', 'member')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_org_members_user ON org_members(user_id);
CREATE INDEX idx_org_members_role ON org_members(org_id, role);

CREATE TABLE repo_grants (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('read', 'write', 'admin')),
  granted_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, user_id)
);
CREATE INDEX idx_repo_grants_user ON repo_grants(user_id);
