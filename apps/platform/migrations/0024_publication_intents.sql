-- Durable merge-queue publication intents (architecture §11.4). Additive only.
--
-- A train publisher writes one row in the batch that claims an entry for
-- publication (`ready` -> `publishing`), before anything is sent, naming
-- exactly the ref move it may attempt. The row lives in D1, next to the registry
-- it guards, so the batch that records the outcome (entry published, change
-- merged, pins satisfied) is the same batch that resolves the intent, and the
-- entry's generation fences both. Reconciliation reads the actual ref and
-- resolves a pending row: the ref at new_sha completes the record exactly
-- once, at old_sha the push did not happen (the entry retries), anywhere else
-- the ref was moved by someone else (the entry recomposes; nothing is
-- overwritten). Rows are history: they are never deleted by the platform.
CREATE TABLE merge_publication_intents (
  repo_id TEXT NOT NULL,
  queue_id TEXT NOT NULL,
  -- The entry generation the publisher claimed; the entry is `publishing` at exactly this generation while the row is pending.
  generation INTEGER NOT NULL,
  target_ref TEXT NOT NULL,
  old_sha TEXT NOT NULL,
  new_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  tree_sha TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fast-forward', 'merge')),
  -- The entry's publication attempts before this one.
  attempt INTEGER NOT NULL,
  -- The MergeLock lease generation the publisher held.
  lease_generation INTEGER NOT NULL,
  -- 1 when a temporary CI ref retains new_sha (removed once the publication is recorded).
  ci_prepared INTEGER NOT NULL DEFAULT 0,
  -- pending: sent or about to be sent, outcome unknown to the registry.
  -- published: recorded by its publisher. reconciled: recorded by reconciliation from the actual ref.
  -- not_applied: the update did not apply (the ref still held old_sha, or the store rejected it).
  -- moved: the ref held something else. withdrawn: the publisher refused before sending anything.
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'published', 'reconciled', 'not_applied', 'moved', 'withdrawn')),
  -- The ref value reconciliation observed (null when unread or deleted).
  observed_sha TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  PRIMARY KEY (repo_id, queue_id, generation)
) WITHOUT ROWID;
