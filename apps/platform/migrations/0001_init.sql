-- Forge platform schema v1
-- Metadata lives in D1; git objects live in Cloudflare Artifacts;
-- working-tree snapshots live in R2.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  workos_user_id TEXT UNIQUE NOT NULL,
  login TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE pat (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '["read"]',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX idx_pat_hash ON pat(hash);
CREATE INDEX idx_pat_user ON pat(user_id);

CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  owner_login TEXT NOT NULL,
  name TEXT NOT NULL,
  artifacts_name TEXT NOT NULL,
  artifacts_remote TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  default_branch TEXT NOT NULL DEFAULT 'main',
  description TEXT,
  fork_parent_id TEXT REFERENCES repos(id),
  stars INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  pushed_at INTEGER,
  UNIQUE(owner_login, name)
);
CREATE INDEX idx_repos_owner ON repos(owner_login);
CREATE INDEX idx_repos_pushed ON repos(pushed_at);

CREATE TABLE change_sets (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  base_ref TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  head_sha TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'merged', 'conflicted', 'closed')),
  author_id TEXT REFERENCES users(id),
  agent_meta TEXT,
  merge_commit TEXT,
  merged_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(repo_id, number)
);
CREATE INDEX idx_cs_repo ON change_sets(repo_id, state);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  change_set_id TEXT NOT NULL REFERENCES change_sets(id),
  user_id TEXT REFERENCES users(id),
  path TEXT,
  line INTEGER,
  side TEXT,
  body TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_comments_cs ON comments(change_set_id);

CREATE TABLE check_runs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  change_set_id TEXT REFERENCES change_sets(id),
  head_sha TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'success', 'failure', 'skipped')),
  conclusion TEXT,
  details_url TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_checks_cs ON check_runs(change_set_id);
CREATE INDEX idx_checks_sha ON check_runs(repo_id, head_sha);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  artifacts_name TEXT NOT NULL,
  task TEXT,
  agent TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged', 'abandoned')),
  change_set_id TEXT REFERENCES change_sets(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ws_repo ON workspaces(repo_id);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  sha TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tree', 'delta', 'bundle')),
  r2_key TEXT NOT NULL,
  size INTEGER,
  files INTEGER,
  base_sha TEXT,
  state TEXT NOT NULL DEFAULT 'building' CHECK (state IN ('building', 'ready', 'failed')),
  built_at INTEGER,
  UNIQUE(repo_id, sha, kind)
);

CREATE TABLE stars (
  user_id TEXT NOT NULL REFERENCES users(id),
  repo_id TEXT NOT NULL REFERENCES repos(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, repo_id)
);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  author_id TEXT REFERENCES users(id),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  UNIQUE(repo_id, number)
);
CREATE INDEX idx_issues_repo ON issues(repo_id, state);

CREATE TABLE issue_comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  user_id TEXT REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ic_issue ON issue_comments(issue_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  processed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
