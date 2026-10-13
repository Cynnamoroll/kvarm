-- Provenance evidence levels and the audit export (architecture §9
-- provenance, §11.1 principals). Additive only.

-- The evidence Kvarm can prove for each attribution note it wrote, computed
-- server-side at write time and never taken from the request. One row per
-- (repo, commit): the latest write through Kvarm.
CREATE TABLE attribution_evidence (
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  -- SHA-256 (hex) of the note blob Kvarm wrote. A note on the ref with other
  -- bytes was written around Kvarm (a direct push of the notes ref) and reads
  -- as declared.
  note_digest TEXT NOT NULL,
  notes_commit TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('api', 'merge', 'task')),
  agent TEXT NOT NULL,
  session TEXT NOT NULL,
  prompt_hash TEXT,
  model TEXT,
  actor TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('declared', 'authenticated', 'verified')),
  -- JSON array of reason codes explaining the level (why it is not higher).
  reasons TEXT NOT NULL,
  -- 'user:<users.id>' or 'agent:<agents.id>' of the submitting credential.
  principal TEXT,
  token_kind TEXT CHECK (token_kind IN ('session', 'pat', 'agent')),
  -- The credential's public prefix only; full tokens are never stored here.
  token_prefix TEXT,
  run_id TEXT,
  key_id TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, commit_sha)
) WITHOUT ROWID;

-- Ref moves the audit export joins per commit: confirmed git pushes through
-- the gate, direct merges and merge-train publications. Audit history: no
-- repo foreign key, so deleting a repo keeps it.
CREATE TABLE ref_updates (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  old_sha TEXT NOT NULL,
  new_sha TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('push', 'merge', 'queue')),
  change_number INTEGER,
  principal TEXT,
  actor_login TEXT,
  agent_name TEXT,
  token_kind TEXT CHECK (token_kind IN ('session', 'pat', 'agent')),
  token_prefix TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX idx_ref_updates_commit ON ref_updates(repo_id, new_sha, at, id);

-- One row per commit the audit knows about, ordered by when Kvarm first saw
-- it; the export pages this index with (first_at, commit_sha) cursors.
CREATE TABLE audit_commits (
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, commit_sha)
) WITHOUT ROWID;
CREATE INDEX idx_audit_commits_time ON audit_commits(repo_id, first_at, commit_sha);

CREATE TRIGGER audit_commit_attributed AFTER INSERT ON attribution_evidence
BEGIN
  INSERT OR IGNORE INTO audit_commits (repo_id, commit_sha, first_at) VALUES (NEW.repo_id, NEW.commit_sha, NEW.at);
END;

-- Ref deletions name no commit.
CREATE TRIGGER audit_commit_ref_update AFTER INSERT ON ref_updates
WHEN NEW.new_sha != '0000000000000000000000000000000000000000'
BEGIN
  INSERT OR IGNORE INTO audit_commits (repo_id, commit_sha, first_at) VALUES (NEW.repo_id, NEW.new_sha, NEW.at);
END;

-- A train publication is recorded from the queue's own published transition,
-- with the enqueuing principal the train published for (merge_queue keeps the
-- agent token id, so an agent's token prefix is joined; a human enqueuer's
-- PAT id is not recorded by the queue).
CREATE TRIGGER audit_queue_published AFTER UPDATE OF state ON merge_queue
WHEN NEW.state = 'published' AND OLD.state != 'published' AND NEW.merge_commit IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO ref_updates (id, repo_id, ref, old_sha, new_sha, via, change_number, principal, actor_login, agent_name,
                                     token_kind, token_prefix, at)
  VALUES (
    'queue:' || NEW.repo_id || ':' || NEW.id || ':' || NEW.generation,
    NEW.repo_id,
    NEW.target_ref,
    COALESCE(NEW.previous_sha, ''),
    NEW.merge_commit,
    'queue',
    NEW.change_number,
    CASE
      WHEN json_extract(NEW.agent_meta, '$.agentId') IS NOT NULL THEN 'agent:' || json_extract(NEW.agent_meta, '$.agentId')
      WHEN NEW.enqueued_by IS NOT NULL THEN 'user:' || NEW.enqueued_by
    END,
    NEW.enqueuer_login,
    json_extract(NEW.agent_meta, '$.agentName'),
    CASE WHEN json_extract(NEW.agent_meta, '$.tokenId') IS NOT NULL THEN 'agent' END,
    (SELECT t.prefix FROM agent_tokens t WHERE t.id = json_extract(NEW.agent_meta, '$.tokenId')),
    NEW.updated_at
  );
END;

-- Trusted execution-service keys for verified provenance, per repository
-- (instance-wide keys come from the KVARM_PROVENANCE_KEYS variable). Public
-- keys only: raw Ed25519, base64url. Revoked, never deleted.
CREATE TABLE provenance_keys (
  id TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (repo_id, id)
) WITHOUT ROWID;
