-- Merge queue / bounded integration train (architecture §4 services/queue.ts,
-- §11.4, STEER v2 §0.1). Additive only.

-- Admission per repository: `active` counts the repository's entries still
-- in a train, so admission never counts rows. Keyed by the repository alone
-- so the merge_queue_admit trigger bumps it without another lookup.
CREATE TABLE merge_admission (
  repo_id TEXT NOT NULL PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- One row per repository + target ref partition, created by the first train
-- run: `runner`/`runner_gen`/`runner_until` is the D1 claim of the one run
-- working the partition (a fenced, expiring claim), and `dirty` asks the
-- holder for another pass when a kick arrived while it ran.
CREATE TABLE merge_trains (
  repo_id TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  runner TEXT,
  runner_gen INTEGER NOT NULL DEFAULT 0,
  runner_until INTEGER,
  dirty INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, target_ref)
) WITHOUT ROWID;

-- One immutable candidate per enqueue. `active` = still in the train
-- (queued/preparing/checking/ready/publishing); published, ejected, stale and
-- dequeued rows stay as history. `generation` fences every state transition:
-- a writer must name the generation it read.
CREATE TABLE merge_queue (
  id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  -- FIFO order within the partition: enqueue time in ms × 1000 plus a random tie-breaker.
  seq INTEGER NOT NULL,
  change_set_id TEXT NOT NULL,
  change_number INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'preparing', 'checking', 'ready', 'publishing', 'published', 'ejected', 'stale', 'dequeued')),
  active INTEGER NOT NULL DEFAULT 1,
  -- The head the enqueue approved; publication requires the change to still be at it.
  head_sha TEXT NOT NULL,
  merge_policy TEXT NOT NULL,
  enqueued_by TEXT,
  enqueuer_login TEXT,
  -- JSON {agentId, agentName, tokenId} when an agent token enqueued.
  agent_meta TEXT,
  -- JSON attribution input for a two-parent merge commit.
  attribution TEXT,
  enqueued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Exact composition identity of the last preparation.
  base_sha TEXT,
  tree_sha TEXT,
  config_id TEXT,
  checks_state TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,
  lease_generation INTEGER,
  merge_commit TEXT,
  previous_sha TEXT,
  reason_code TEXT,
  reason TEXT,
  -- JSON per-step work counters of the publication.
  cost TEXT,
  -- The admission capacity the enqueue was checked against (merge_queue_admit).
  admission_capacity INTEGER NOT NULL DEFAULT 64,
  -- Keyed under the repository so a repository delete is one key range.
  PRIMARY KEY (repo_id, id)
) WITHOUT ROWID;
-- At most one active entry per change; the queue read and the partition's
-- window are one index range over active entries each, so history never
-- adds work to either.
CREATE UNIQUE INDEX idx_mq_active_change ON merge_queue(change_set_id) WHERE active = 1;
CREATE INDEX idx_mq_live ON merge_queue(repo_id, target_ref, seq) WHERE active = 1;

-- Admission happens in the inserting statement itself: the repository's
-- slot count goes up, and an insert beyond the entry's admission capacity
-- aborts the statement (the enqueue answers 429).
CREATE TRIGGER merge_queue_admit AFTER INSERT ON merge_queue WHEN NEW.active = 1
BEGIN
  INSERT INTO merge_admission (repo_id, active, updated_at) VALUES (NEW.repo_id, 1, NEW.updated_at)
  ON CONFLICT (repo_id) DO UPDATE
    SET active = IIF(active < NEW.admission_capacity, active + 1, RAISE(ABORT, 'KVARM_QUEUE_FULL')), updated_at = excluded.updated_at;
END;

-- Every way out of the train (published, ejected, stale, dequeued) frees
-- its admission slot in the same statement.
CREATE TRIGGER merge_queue_leave AFTER UPDATE OF active ON merge_queue WHEN OLD.active = 1 AND NEW.active = 0
BEGIN
  UPDATE merge_admission SET active = MAX(0, active - 1), updated_at = NEW.updated_at WHERE repo_id = NEW.repo_id;
END;

-- A PAT hash names one token: a unique index lets the per-request token
-- lookup stop at its match instead of also reading the next index entry.
CREATE UNIQUE INDEX idx_pat_hash_unique ON pat(hash);
DROP INDEX idx_pat_hash;

-- Generation/owner-fenced expiring claims (check runs, agent tasks): a claim
-- may be taken over only after it expired or its subject moved to a new
-- identity, which bumps the generation; reports and releases must name the
-- current generation and owner.
CREATE TABLE fenced_claims (
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  owner TEXT,
  identity TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'claimed', 'done')),
  expires_at INTEGER,
  result TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, subject)
) WITHOUT ROWID;
