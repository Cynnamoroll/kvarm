-- Outbound webhooks (architecture §11.5). Additive only.
--
-- Platform events are CloudEvents 1.0 envelopes in the `events` ledger with
-- a `kvarm.` type, `processed_at` NULL and `source` `/repos/<owner>/<name>`
-- (the shape `kvarm.task.created` already has). The fan-out trigger below
-- turns each such row into one `webhook_deliveries` row per active hook of
-- that repository subscribed to the type, in the writer's own statement, so
-- an event is recorded for delivery exactly when the state change commits
-- and no service on a request or merge path makes a network call. Delivery
-- itself runs on the `kvarm-events` queue (services/webhooks.ts).
--
-- Merges, merge-queue ejections, completed check runs and opened escalations
-- are written on several paths (explicit merge, auto merge, the integration
-- train, the CI runner report, the checks API, reviews). Triggers on those
-- state transitions emit the envelope into the ledger so every path is
-- covered without touching the services. They write nothing unless an
-- active hook of the repository subscribes to the type.

CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  url TEXT NOT NULL,
  -- JSON array of subscribed event types.
  events TEXT NOT NULL,
  -- AES-GCM ciphertext of the signing secret under a key derived from the
  -- WEBHOOK_SECRET_KEY Worker secret; signing needs the plaintext, so a hash
  -- (as for tokens) cannot serve. Never returned after creation or rotation.
  secret_ciphertext TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  disabled_at INTEGER,
  disabled_reason TEXT,
  last_delivery_at INTEGER,
  last_status INTEGER,
  created_by TEXT,
  created_by_login TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  secret_rotated_at INTEGER
);
CREATE INDEX idx_webhooks_repo ON webhooks(repo_id, active);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  -- The CloudEvents id; also the receiver's idempotency key.
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  -- When a queue message for the next attempt was last sent (NULL: never).
  enqueued_at INTEGER,
  -- An attempt in flight holds the row until this time.
  lease_until INTEGER,
  response_status INTEGER,
  latency_ms INTEGER,
  error TEXT,
  response_excerpt TEXT,
  -- JSON array with one bounded entry per attempt.
  attempt_log TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (webhook_id, event_id)
);
CREATE INDEX idx_whd_hook ON webhook_deliveries(webhook_id, created_at DESC, id DESC);
CREATE INDEX idx_whd_due ON webhook_deliveries(next_attempt_at) WHERE state = 'pending';
CREATE INDEX idx_whd_done ON webhook_deliveries(created_at) WHERE state != 'pending';
CREATE INDEX idx_whd_repo ON webhook_deliveries(repo_id);

-- Fan-out. Audit rows (types without the `kvarm.` prefix, `processed_at`
-- set) never match; a payload that is not JSON is skipped, never an error,
-- so the trigger cannot fail a ledger writer.
CREATE TRIGGER webhook_fanout AFTER INSERT ON events
WHEN NEW.processed_at IS NULL AND NEW.type LIKE 'kvarm.%'
BEGIN
  INSERT OR IGNORE INTO webhook_deliveries (id, webhook_id, repo_id, event_id, event_type, state, attempts, next_attempt_at, created_at, updated_at)
  SELECT lower(hex(randomblob(16))), h.id, h.repo_id, NEW.id, NEW.type, 'pending', 0, NEW.created_at, NEW.created_at, NEW.created_at
    FROM (SELECT substr(x.src, 8) AS p
            FROM (SELECT CASE WHEN json_valid(NEW.payload) THEN json_extract(NEW.payload, '$.source') END AS src) x
           WHERE x.src LIKE '/repos/%/%') s
    JOIN repos r ON r.owner_login = substr(s.p, 1, instr(s.p, '/') - 1) AND r.name = substr(s.p, instr(s.p, '/') + 1)
    JOIN webhooks h ON h.repo_id = r.id AND h.active = 1
   WHERE EXISTS (SELECT 1 FROM json_each(h.events) j WHERE j.value = NEW.type);
END;

-- Change merged: every path that publishes a change sets state 'merged' once.
CREATE TRIGGER webhook_change_merged AFTER UPDATE OF state ON change_sets
WHEN NEW.state = 'merged' AND OLD.state != 'merged'
 AND EXISTS (SELECT 1 FROM webhooks h WHERE h.repo_id = NEW.repo_id AND h.active = 1
                AND EXISTS (SELECT 1 FROM json_each(h.events) j WHERE j.value = 'kvarm.change.merged'))
BEGIN
  INSERT OR IGNORE INTO events (id, type, payload, processed_at, created_at)
  SELECT 'change-merged-' || NEW.id, 'kvarm.change.merged',
         json_object('specversion', '1.0', 'id', 'change-merged-' || NEW.id, 'type', 'kvarm.change.merged',
                     'source', '/repos/' || r.owner_login || '/' || r.name, 'subject', CAST(NEW.number AS TEXT),
                     'time', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'datacontenttype', 'application/json',
                     'data', json_object('repo', r.owner_login || '/' || r.name, 'change', NEW.number, 'title', NEW.title, 'base', NEW.base_ref, 'head', NEW.head_ref,
                                         'headSha', NEW.head_sha, 'mergeCommit', NEW.merge_commit)),
         NULL, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    FROM repos r WHERE r.id = NEW.repo_id;
END;

-- Change ejected from the merge queue (the entry leaves the train for good).
CREATE TRIGGER webhook_change_ejected AFTER UPDATE OF state ON merge_queue
WHEN NEW.state = 'ejected' AND OLD.state != 'ejected'
 AND EXISTS (SELECT 1 FROM webhooks h WHERE h.repo_id = NEW.repo_id AND h.active = 1
                AND EXISTS (SELECT 1 FROM json_each(h.events) j WHERE j.value = 'kvarm.change.ejected'))
BEGIN
  INSERT OR IGNORE INTO events (id, type, payload, processed_at, created_at)
  SELECT 'change-ejected-' || NEW.id, 'kvarm.change.ejected',
         json_object('specversion', '1.0', 'id', 'change-ejected-' || NEW.id, 'type', 'kvarm.change.ejected',
                     'source', '/repos/' || r.owner_login || '/' || r.name, 'subject', CAST(NEW.change_number AS TEXT),
                     'time', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'datacontenttype', 'application/json',
                     'data', json_object('repo', r.owner_login || '/' || r.name, 'change', NEW.change_number, 'target', NEW.target_ref, 'headSha', NEW.head_sha,
                                         'code', NEW.reason_code, 'reason', substr(NEW.reason, 1, 500))),
         NULL, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    FROM repos r WHERE r.id = NEW.repo_id;
END;

-- Check run completed: recorded already finished, or moved from queued or
-- running to a terminal status.
CREATE TRIGGER webhook_check_run_completed_insert AFTER INSERT ON check_runs
WHEN NEW.status IN ('success', 'failure', 'skipped')
 AND EXISTS (SELECT 1 FROM webhooks h WHERE h.repo_id = NEW.repo_id AND h.active = 1
                AND EXISTS (SELECT 1 FROM json_each(h.events) j WHERE j.value = 'kvarm.check_run.completed'))
BEGIN
  INSERT OR IGNORE INTO events (id, type, payload, processed_at, created_at)
  SELECT 'check-run-completed-' || NEW.id || '-' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 'kvarm.check_run.completed',
         json_object('specversion', '1.0', 'id', 'check-run-completed-' || NEW.id || '-' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 'type', 'kvarm.check_run.completed',
                     'source', '/repos/' || r.owner_login || '/' || r.name, 'subject', NEW.name,
                     'time', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'datacontenttype', 'application/json',
                     'data', json_object('repo', r.owner_login || '/' || r.name, 'checkRun', NEW.id, 'name', NEW.name, 'headSha', NEW.head_sha, 'treeSha', NEW.tree_sha,
                                         'status', NEW.status, 'conclusion', NEW.conclusion, 'attempt', NEW.attempt,
                                         'required', json(CASE WHEN NEW.required THEN 'true' ELSE 'false' END),
                                         'change', (SELECT c.number FROM change_sets c WHERE c.id = NEW.change_set_id))),
         NULL, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    FROM repos r WHERE r.id = NEW.repo_id;
END;

CREATE TRIGGER webhook_check_run_completed_update AFTER UPDATE OF status ON check_runs
WHEN NEW.status IN ('success', 'failure', 'skipped') AND OLD.status IN ('queued', 'running')
 AND EXISTS (SELECT 1 FROM webhooks h WHERE h.repo_id = NEW.repo_id AND h.active = 1
                AND EXISTS (SELECT 1 FROM json_each(h.events) j WHERE j.value = 'kvarm.check_run.completed'))
BEGIN
  INSERT OR IGNORE INTO events (id, type, payload, processed_at, created_at)
  SELECT 'check-run-completed-' || NEW.id || '-' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 'kvarm.check_run.completed',
         json_object('specversion', '1.0', 'id', 'check-run-completed-' || NEW.id || '-' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 'type', 'kvarm.check_run.completed',
                     'source', '/repos/' || r.owner_login || '/' || r.name, 'subject', NEW.name,
                     'time', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'datacontenttype', 'application/json',
                     'data', json_object('repo', r.owner_login || '/' || r.name, 'checkRun', NEW.id, 'name', NEW.name, 'headSha', NEW.head_sha, 'treeSha', NEW.tree_sha,
                                         'status', NEW.status, 'conclusion', NEW.conclusion, 'attempt', NEW.attempt,
                                         'required', json(CASE WHEN NEW.required THEN 'true' ELSE 'false' END),
                                         'change', (SELECT c.number FROM change_sets c WHERE c.id = NEW.change_set_id))),
         NULL, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    FROM repos r WHERE r.id = NEW.repo_id;
END;

-- Escalation opened (reviews, the review gate and final arena selections).
CREATE TRIGGER webhook_escalation_opened AFTER INSERT ON change_escalations
WHEN NEW.state = 'open'
 AND EXISTS (SELECT 1 FROM webhooks h WHERE h.repo_id = NEW.repo_id AND h.active = 1
                AND EXISTS (SELECT 1 FROM json_each(h.events) j WHERE j.value = 'kvarm.escalation.opened'))
BEGIN
  INSERT OR IGNORE INTO events (id, type, payload, processed_at, created_at)
  SELECT 'escalation-opened-' || NEW.id, 'kvarm.escalation.opened',
         json_object('specversion', '1.0', 'id', 'escalation-opened-' || NEW.id, 'type', 'kvarm.escalation.opened',
                     'source', '/repos/' || r.owner_login || '/' || r.name, 'subject', CAST(NEW.change_number AS TEXT),
                     'time', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'datacontenttype', 'application/json',
                     'data', json_object('repo', r.owner_login || '/' || r.name, 'escalation', NEW.id, 'change', NEW.change_number, 'reason', NEW.reason, 'headSha', NEW.head_sha)),
         NULL, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    FROM repos r WHERE r.id = NEW.repo_id;
END;
