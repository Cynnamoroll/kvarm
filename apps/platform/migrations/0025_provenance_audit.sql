-- Provenance evidence levels and the audit export (architecture §9
-- provenance, §11.1 principals). Additive only.

-- The evidence Kvarm can prove for each attribution note it wrote, computed
-- server-side at write time and never taken from the request. Keyed by the
-- SHA-256 (hex) of the note bytes Kvarm wrote, so a reader finds the row for
-- exactly the note on the ref even when concurrent writers replaced each
-- other's notes; a note with no matching row was written around Kvarm (a
-- direct push of the notes ref) and reads as declared.
CREATE TABLE attribution_evidence (
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
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
  -- The record's own time (`at` in the note).
  at INTEGER NOT NULL,
  -- When this row was stored; the export reports a commit's newest row.
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, commit_sha, note_digest)
) WITHOUT ROWID;
CREATE INDEX idx_attribution_evidence_newest ON attribution_evidence(repo_id, commit_sha, recorded_at);

-- Ref moves the audit export joins per commit: confirmed git pushes through
-- the gate, explicit merges and merge-train publications. Audit history: no
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

-- One row per commit the audit knows about. `seq` is the per-repo insertion
-- order (D1 serializes writes, so MAX + 1 inside the inserting statement is
-- strictly increasing): the export pages by it, so a commit recorded after a
-- page was read always sorts after that page. `first_at` is the database
-- clock at insertion, which `since`/`until` filter on.
CREATE TABLE audit_commits (
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  seq INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, commit_sha)
) WITHOUT ROWID;
CREATE UNIQUE INDEX idx_audit_commits_seq ON audit_commits(repo_id, seq);
CREATE INDEX idx_audit_commits_time ON audit_commits(repo_id, first_at, seq);

CREATE TRIGGER audit_commit_attributed AFTER INSERT ON attribution_evidence
BEGIN
  INSERT OR IGNORE INTO audit_commits (repo_id, commit_sha, seq, first_at)
  VALUES (NEW.repo_id, NEW.commit_sha,
          (SELECT COALESCE(MAX(seq), 0) + 1 FROM audit_commits WHERE repo_id = NEW.repo_id),
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

-- Ref deletions name no commit.
CREATE TRIGGER audit_commit_ref_update AFTER INSERT ON ref_updates
WHEN NEW.new_sha != '0000000000000000000000000000000000000000'
BEGIN
  INSERT OR IGNORE INTO audit_commits (repo_id, commit_sha, seq, first_at)
  VALUES (NEW.repo_id, NEW.new_sha,
          (SELECT COALESCE(MAX(seq), 0) + 1 FROM audit_commits WHERE repo_id = NEW.repo_id),
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

-- A train publication is recorded from the queue's own published transition,
-- with the enqueuing principal the train published for (merge_queue keeps the
-- agent token id, so an agent's token prefix is joined; a human enqueuer's
-- PAT id is not recorded by the queue). The trigger runs inside the queue's
-- publication batch, so it must never fail it: OR IGNORE absorbs constraint
-- conflicts and agent_meta is read only when it is valid JSON.
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
    COALESCE(NEW.principal, CASE WHEN NEW.enqueued_by IS NOT NULL THEN 'user:' || NEW.enqueued_by END),
    NEW.enqueuer_login,
    CASE WHEN json_valid(NEW.agent_meta) THEN json_extract(NEW.agent_meta, '$.agentName') END,
    CASE WHEN json_valid(NEW.agent_meta) AND json_extract(NEW.agent_meta, '$.tokenId') IS NOT NULL THEN 'agent' END,
    CASE WHEN json_valid(NEW.agent_meta) THEN (SELECT t.prefix FROM agent_tokens t WHERE t.id = json_extract(NEW.agent_meta, '$.tokenId')) END,
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
