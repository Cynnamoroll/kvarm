-- Durable agent principals owned by a user or organization account, and
-- owner-minted expiring tokens scoped to one repository and, for writes, an
-- explicit list of ref patterns (architecture §11.1). Additive only.

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user', 'org')),
  -- users.id or orgs.id, depending on owner_kind.
  owner_id TEXT NOT NULL,
  owner_login TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  -- Agents are revoked, never deleted, so audit history keeps resolving.
  revoked_at INTEGER,
  revoked_by TEXT REFERENCES users(id),
  UNIQUE (owner_id, name)
);
CREATE INDEX idx_agents_owner_name ON agents(owner_id, name);

CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  name TEXT,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('read', 'write')),
  -- JSON array of ref patterns the token may update; empty for read tokens.
  refs TEXT NOT NULL DEFAULT '[]',
  -- The minting human: the token's authority is also capped by this user's
  -- current role on the repo.
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT REFERENCES users(id),
  last_used_at INTEGER
);
CREATE INDEX idx_agent_tokens_agent ON agent_tokens(agent_id, created_at);
