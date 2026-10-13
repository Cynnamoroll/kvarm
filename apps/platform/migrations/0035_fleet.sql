-- Reusable Linux build environments and isolated agent sandboxes.
-- Credentials are stored only as token hashes in D1; sandbox plaintext
-- credentials are held by the corresponding Durable Object, never a snapshot.

CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (
    length(name) BETWEEN 1 AND 63 AND
    name GLOB '[a-z]*' AND
    name NOT GLOB '*[^a-z0-9-]*'
  ),
  os TEXT NOT NULL DEFAULT 'linux' CHECK (os IN ('linux')),
  base_ref TEXT NOT NULL DEFAULT 'main',
  instance TEXT NOT NULL DEFAULT 'standard-1'
    CHECK (instance IN ('basic', 'standard-1', 'standard-2', 'standard-3', 'standard-4')),
  setup_script TEXT NOT NULL DEFAULT '' CHECK (length(setup_script) <= 10000),
  validate_script TEXT NOT NULL DEFAULT '' CHECK (length(validate_script) <= 10000),
  env_vars TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(env_vars) AND json_type(env_vars) = 'object'
  ),
  allowed_hosts TEXT NOT NULL DEFAULT '["registry.npmjs.org","pypi.org","files.pythonhosted.org","crates.io","static.crates.io","proxy.golang.org","sum.golang.org"]'
    CHECK (json_valid(allowed_hosts) AND json_type(allowed_hosts) = 'array'),
  command_policy TEXT NOT NULL DEFAULT '{"deny":[],"approve":[]}' CHECK (
    json_valid(command_policy) AND json_type(command_policy) = 'object'
    AND json_type(command_policy, '$.deny') = 'array'
    AND json_type(command_policy, '$.approve') = 'array'
  ),
  rebuild_paths TEXT NOT NULL DEFAULT '["package-lock.json","pnpm-lock.yaml","yarn.lock","bun.lockb","Cargo.lock","go.sum","poetry.lock","uv.lock","requirements*.txt","Gemfile.lock",".kvarm/**"]'
    CHECK (json_valid(rebuild_paths) AND json_type(rebuild_paths) = 'array'),
  max_build_age_hours INTEGER NOT NULL DEFAULT 72 CHECK (max_build_age_hours BETWEEN 1 AND 600),
  idle_minutes INTEGER NOT NULL DEFAULT 30 CHECK (idle_minutes BETWEEN 1 AND 360),
  config_hash TEXT NOT NULL,
  ready_build_id TEXT,
  pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1)),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  UNIQUE(repo_id, name)
);
CREATE INDEX idx_environments_repo ON environments(repo_id, archived_at, name);

CREATE TABLE environment_builds (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'building', 'validating', 'ready', 'failed', 'superseded')),
  reason TEXT NOT NULL CHECK (reason IN ('create', 'config', 'push', 'age', 'manual', 'retry')),
  base_sha TEXT,
  config_hash TEXT NOT NULL,
  snapshot_id TEXT,
  snapshot_size INTEGER,
  phases TEXT NOT NULL DEFAULT '{}',
  output_tail TEXT NOT NULL DEFAULT '' CHECK (length(output_tail) <= 65536),
  error TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE(environment_id, seq)
);
CREATE INDEX idx_environment_builds_env_seq ON environment_builds(environment_id, seq DESC);
CREATE INDEX idx_environment_builds_repo_status ON environment_builds(repo_id, status);
CREATE UNIQUE INDEX idx_environment_builds_one_live
  ON environment_builds(environment_id)
  WHERE status IN ('queued', 'building', 'validating');

CREATE TABLE sandboxes (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id),
  build_id TEXT NOT NULL REFERENCES environment_builds(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  agent_id TEXT REFERENCES agents(id),
  token_id TEXT REFERENCES agent_tokens(id),
  status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'sleeping', 'stopped', 'failed')),
  task TEXT,
  last_active_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  run_expires_at INTEGER NOT NULL,
  sleep_snapshot_id TEXT,
  created_at INTEGER NOT NULL,
  stopped_at INTEGER,
  error TEXT
);
CREATE INDEX idx_sandboxes_owner_status ON sandboxes(owner_user_id, status, created_at DESC);
CREATE INDEX idx_sandboxes_repo_status ON sandboxes(repo_id, status, created_at DESC);
CREATE INDEX idx_sandboxes_environment_status ON sandboxes(environment_id, status);

CREATE TABLE sandbox_commands (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT,
  exit_code INTEGER,
  duration_ms INTEGER NOT NULL,
  stdout_tail TEXT NOT NULL DEFAULT '' CHECK (length(stdout_tail) <= 16384),
  stderr_tail TEXT NOT NULL DEFAULT '' CHECK (length(stderr_tail) <= 16384),
  policy TEXT NOT NULL CHECK (policy IN ('allowed', 'denied', 'approved')),
  approval_id TEXT REFERENCES sandbox_approvals(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sandbox_commands_sandbox_created ON sandbox_commands(sandbox_id, created_at DESC);

CREATE TABLE sandbox_approvals (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'used')),
  decided_by TEXT REFERENCES users(id),
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sandbox_approvals_repo_status ON sandbox_approvals(repo_id, status, created_at DESC);
CREATE INDEX idx_sandbox_approvals_sandbox ON sandbox_approvals(sandbox_id, created_at DESC);
