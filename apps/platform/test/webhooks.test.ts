/**
 * Outbound webhooks (services/webhooks.ts, services/webhookSafety.ts,
 * migration 0033). Management goes through the Worker's routes; delivery
 * attempts run with an injected fetch and clock, so no test touches the
 * network and retries need no real waiting.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader } from '../src/cost/meter';
import worker from '../src/index';
import { markConflictedStatements } from '../src/services/conflicts';
import { WEBHOOK_URL_MAX, checkWebhookUrl, signWebhook } from '../src/services/webhookSafety';
import {
  WEBHOOK_DELIVERY_MESSAGE,
  WEBHOOK_LIMITS,
  deliverWebhook,
  pruneWebhookDeliveries,
  pumpWebhookDeliveries,
  webhookRetryDelaySeconds,
  type DeliveryDeps,
} from '../src/services/webhooks';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const FULL: Scope[] = ['read', 'write', 'api', 'ci'];
const SHA = 'a'.repeat(40);
const HOOK_URL = 'https://hooks.example.com/kvarm';

/** Queue sends recorded instead of delivered. */
const sent: Array<{ body: any; delaySeconds?: number }> = [];
const fakeEvents = {
  async send(body: unknown, opts?: { delaySeconds?: number }) {
    sent.push({ body, ...(opts?.delaySeconds !== undefined ? { delaySeconds: opts.delaySeconds } : {}) });
  },
  async sendBatch(msgs: Array<{ body: unknown }>) {
    for (const m of msgs) sent.push({ body: m.body });
  },
};
const env = { ...baseEnv, EVENTS: fakeEvents as unknown as Env['EVENTS'] } as Env;

type Who = 'owner' | 'writer' | 'reader' | 'outsider';
const logins: Record<Who, string> = { owner: 'wh-owner', writer: 'wh-writer', reader: 'wh-reader', outsider: 'wh-outsider' };
const pat = {} as Record<Who, string>;
const repoIds: Record<string, string> = {};

interface Reply {
  status: number;
  json: Record<string, any>;
  headers: Headers;
}

async function call(method: string, path: string, who?: Who | string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply> {
  const token = who === undefined ? undefined : who in pat ? pat[who as Who] : who;
  const headers: Record<string, string> = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const ctx = createExecutionContext();
  const res = await worker.fetch!(
    new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }) as Request<unknown, IncomingRequestCfProperties>,
    env,
    ctx,
  );
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    // non-JSON
  }
  return { status: res.status, json, headers: res.headers };
}

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  return id;
}

async function seedRepo(name: string, visibility: 'public' | 'private' = 'private'): Promise<string> {
  const id = crypto.randomUUID();
  repoIds[name] = id;
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'main', ?)`,
  )
    .bind(id, logins.owner, name, `${logins.owner}--${name}`, `https://artifacts.invalid/git/default/${logins.owner}--${name}.git`, visibility, Date.now())
    .run();
  return id;
}

async function seedChange(repo: string, number: number, state = 'open'): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO change_sets (id, repo_id, number, title, base_ref, head_ref, head_sha, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'main', ?, ?, ?, ?, ?)`,
  )
    .bind(id, repoIds[repo], number, `Change ${number}`, `b${number}`, SHA, state, Date.now(), Date.now())
    .run();
  return id;
}

const hooksPath = (repo: string, rest = '') => `/api/v1/repos/${logins.owner}/${repo}/webhooks${rest}`;

async function createHook(repo: string, events: string[], url = HOOK_URL): Promise<{ id: string; secret: string }> {
  const r = await call('POST', hooksPath(repo), 'owner', { url, events });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return { id: r.json.webhook.id, secret: r.json.secret };
}

async function deliveries(hookId: string): Promise<Array<{ id: string; event_type: string; state: string; attempts: number; next_attempt_at: number; event_id: string }>> {
  return (
    (
      await env.DB.prepare('SELECT id, event_type, state, attempts, next_attempt_at, event_id FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at, id')
        .bind(hookId)
        .all<{ id: string; event_type: string; state: string; attempts: number; next_attempt_at: number; event_id: string }>()
    ).results ?? []
  );
}

interface Captured {
  url: string;
  init: RequestInit;
  headers: Headers;
  body: string;
}

/** A fake endpoint: answers each call from `script` (the last entry repeats). */
function endpoint(script: Array<number | Error | (() => Response)>): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {}, headers: new Headers(init?.headers), body: String(init?.body ?? '') });
    const step = script[Math.min(calls.length - 1, script.length - 1)]!;
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step();
    const redirect = step >= 300 && step < 400;
    return new Response(redirect || step === 204 ? null : `answer ${step}`, { status: step, headers: redirect ? { location: 'https://169.254.169.254/' } : {} });
  }) as typeof fetch;
  return { fetch: f, calls };
}

/** HMAC-SHA256 hex computed here, the way a receiver would, without the service's signing code. */
async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function clock(start = Date.now()): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

beforeAll(async () => {
  for (const who of Object.keys(logins) as Who[]) pat[who] = (await mintPAT(env, await seedUser(logins[who]), 'full', FULL)).token;
  await seedRepo('hooks');
  await seedRepo('public-hooks', 'public');
  for (const [who, role] of [
    ['writer', 'write'],
    ['reader', 'read'],
  ] as const) {
    for (const repo of ['hooks', 'public-hooks']) {
      expect((await call('PUT', `/api/v1/repos/${logins.owner}/${repo}/grants/${logins[who]}`, 'owner', { role })).status).toBe(200);
    }
  }
});

afterEach(() => {
  sent.length = 0;
});

// ---------------------------------------------------------------------------

describe('webhook URL policy (SSRF)', () => {
  const refused: Array<[string, string]> = [
    ['http://hooks.example.com/x', 'https'],
    ['ftp://hooks.example.com/x', 'https'],
    ['https://user:pw@hooks.example.com/', 'credentials'],
    ['https://localhost/x', 'local'],
    ['https://LOCALHOST./x', 'local'],
    ['https://api.localhost/x', 'local'],
    ['https://printer.local/x', 'local'],
    ['https://metadata.google.internal/computeMetadata/v1/', 'local'],
    ['https://svc.corp.internal/', 'local'],
    ['https://router.home.arpa/', 'local'],
    ['https://intranet/', 'fully qualified'],
    ['https://127.0.0.1/', 'private'],
    ['https://127.1.2.3:8443/', 'private'],
    ['https://2130706433/', 'private'], // decimal 127.0.0.1
    ['https://0x7f.0.0.1/', 'private'], // hex
    ['https://0177.0.0.1/', 'private'], // octal
    ['https://0.0.0.0/', 'private'],
    ['https://10.1.2.3/', 'private'],
    ['https://172.16.0.1/', 'private'],
    ['https://172.31.255.255/', 'private'],
    ['https://192.168.1.10/', 'private'],
    ['https://169.254.169.254/latest/meta-data/', 'private'],
    ['https://100.64.0.1/', 'private'],
    ['https://224.0.0.1/', 'private'],
    ['https://255.255.255.255/', 'private'],
    ['https://[::1]/', 'private'],
    ['https://[::]/', 'private'],
    ['https://[fe80::1]/', 'private'],
    ['https://[fd00::1]/', 'private'],
    ['https://[fc00::abcd]/', 'private'],
    ['https://[::ffff:127.0.0.1]/', 'private'],
    ['https://[::ffff:10.0.0.1]/', 'private'],
    ['https://[::ffff:a9fe:a9fe]/', 'private'], // 169.254.169.254 mapped
    ['https://[64:ff9b::7f00:1]/', 'private'],
    ['https://[ff02::1]/', 'private'],
    ['https://[::ffff:0:7f00:1]/', 'private'], // IPv4-translated 127.0.0.1
    ['https://[64:ff9b:1::a00:1]/', 'private'], // local-use NAT64
    ['https://[100::1]/', 'private'], // discard-only
    ['https://kvarm.test/api/v1/user', 'this Kvarm deployment'],
    ['not a url', 'valid absolute URL'],
    ['', 'non-empty'],
  ];
  it.each(refused)('refuses %s', (url, reason) => {
    const v = checkWebhookUrl(url, 'kvarm.test');
    expect(v.ok, url).toBe(false);
    if (!v.ok) expect(v.reason).toContain(reason);
  });

  const accepted: Array<[string, string]> = [
    ['https://hooks.example.com/kvarm', 'https://hooks.example.com/kvarm'],
    ['https://HOOKS.example.com:8443/a?b=c', 'https://hooks.example.com:8443/a?b=c'],
    ['https://8.8.8.8/hook', 'https://8.8.8.8/hook'],
    ['https://172.32.0.1/', 'https://172.32.0.1/'],
    ['https://[2606:4700:4700::1111]/x', 'https://[2606:4700:4700::1111]/x'],
  ];
  it.each(accepted)('accepts %s', (url, normalized) => {
    expect(checkWebhookUrl(url, 'kvarm.test')).toEqual({ ok: true, url: normalized });
  });

  it('rejects a non-string and an overlong url', () => {
    expect(checkWebhookUrl(42).ok).toBe(false);
    expect(checkWebhookUrl(`https://hooks.example.com/${'x'.repeat(WEBHOOK_URL_MAX)}`)).toEqual({ ok: false, reason: `url must be at most ${WEBHOOK_URL_MAX} characters` });
  });
});

describe('webhook management', () => {
  it('creates a hook for a repo admin, shows the secret once and stores it encrypted', async () => {
    const r = await call('POST', hooksPath('hooks'), 'owner', { url: HOOK_URL, events: ['kvarm.change.merged', 'kvarm.task.created', 'kvarm.change.merged'] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.headers.get('cache-control')).toContain('no-store');
    expect(r.json.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.json.webhook).toMatchObject({ url: HOOK_URL, events: ['kvarm.change.merged', 'kvarm.task.created'], active: true, consecutiveFailures: 0, createdBy: logins.owner });
    const id = r.json.webhook.id as string;
    const secret = r.json.secret as string;

    const list = await call('GET', hooksPath('hooks'), 'owner');
    expect(list.status).toBe(200);
    expect(list.json.webhooks.map((h: { id: string }) => h.id)).toContain(id);
    expect(list.json.eventTypes).toContain('kvarm.check_run.completed');
    const one = await call('GET', hooksPath('hooks', `/${id}`), 'owner');
    for (const res of [list, one]) {
      expect(JSON.stringify(res.json)).not.toContain(secret);
      expect(JSON.stringify(res.json)).not.toMatch(/secret"\s*:/);
    }
    const row = await env.DB.prepare('SELECT secret_ciphertext, secret_iv FROM webhooks WHERE id = ?').bind(id).first<{ secret_ciphertext: string; secret_iv: string }>();
    expect(row!.secret_ciphertext).not.toContain(secret);
    // The audit row names the hook and its host, never the secret or the path.
    const audit = await env.DB.prepare("SELECT payload FROM events WHERE type = 'webhook.created' AND payload LIKE ?").bind(`%${id}%`).first<{ payload: string }>();
    expect(audit!.payload).toContain('hooks.example.com');
    expect(audit!.payload).not.toContain(secret);
    expect(audit!.payload).not.toContain('/kvarm');

    const rotated = await call('POST', hooksPath('hooks', `/${id}/rotate-secret`), 'owner');
    expect(rotated.status).toBe(200);
    expect(rotated.headers.get('cache-control')).toContain('no-store');
    expect(rotated.json.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotated.json.secret).not.toBe(secret);
    expect(rotated.json.webhook.secretRotatedAt).not.toBeNull();

    const del = await call('DELETE', hooksPath('hooks', `/${id}`), 'owner');
    expect(del.status).toBe(200);
    expect(del.json).toMatchObject({ deleted: true, webhook: { id } });
    expect((await call('GET', hooksPath('hooks', `/${id}`), 'owner')).status).toBe(404);
    expect((await call('DELETE', hooksPath('hooks', `/${id}`), 'owner')).status).toBe(404);
  });

  it('admits repo admins only, conceals a private repo and refuses agent tokens', async () => {
    const { id } = await createHook('hooks', ['kvarm.change.merged']);
    const body = { url: HOOK_URL, events: ['kvarm.change.merged'] };
    for (const [who, expected] of [
      ['writer', 403],
      ['reader', 403],
      ['outsider', 404],
    ] as const) {
      expect((await call('GET', hooksPath('hooks'), who)).status, who).toBe(expected);
      expect((await call('POST', hooksPath('hooks'), who, body)).status, who).toBe(expected);
      expect((await call('DELETE', hooksPath('hooks', `/${id}`), who)).status, who).toBe(expected);
      expect((await call('POST', hooksPath('hooks', `/${id}/rotate-secret`), who)).status, who).toBe(expected);
      expect((await call('GET', hooksPath('hooks', `/${id}/deliveries`), who)).status, who).toBe(expected);
    }
    // A public repo is readable by anyone, but its hooks are still admin-only.
    expect((await call('GET', hooksPath('public-hooks'), 'outsider')).status).toBe(403);
    expect((await call('GET', hooksPath('hooks'))).status).toBe(401);
    // A hook id from another repository is not found here.
    expect((await call('GET', `/api/v1/repos/${logins.owner}/public-hooks/webhooks/${id}`, 'owner')).status).toBe(404);

    const agent = await call('POST', '/api/v1/agents', 'owner', { name: 'wh-bot' });
    expect(agent.status).toBe(201);
    const tok = await call('POST', `/api/v1/agents/${agent.json.agent.id}/tokens`, 'owner', {
      repo: `${logins.owner}/hooks`,
      role: 'write',
      refs: ['refs/heads/*'],
      expiresIn: 600,
    });
    expect(tok.status).toBe(201);
    for (const [method, rest, b] of [
      ['GET', '', undefined],
      ['POST', '', body],
      ['POST', `/${id}/rotate-secret`, undefined],
    ] as const) {
      const r = await call(method, hooksPath('hooks', rest), tok.json.token as string, b);
      expect(r.status, `${method} ${rest}`).toBe(403);
    }
  });

  it('validates the URL and events and caps hooks per repository', async () => {
    await seedRepo('capped');
    expect((await call('POST', hooksPath('capped'), 'owner', { url: 'https://10.0.0.1/', events: ['kvarm.change.merged'] })).json.code).toBe('INVALID_URL');
    expect((await call('POST', hooksPath('capped'), 'owner', { url: HOOK_URL, events: [] })).json.code).toBe('INVALID_EVENTS');
    expect((await call('POST', hooksPath('capped'), 'owner', { url: HOOK_URL, events: ['push'] })).json.code).toBe('INVALID_EVENTS');
    expect((await call('POST', hooksPath('capped'), 'owner', { url: HOOK_URL, events: ['kvarm.webhook.ping'] })).json.code).toBe('INVALID_EVENTS');
    for (let i = 0; i < WEBHOOK_LIMITS.hooksPerRepo; i++) await createHook('capped', ['kvarm.change.merged'], `${HOOK_URL}/${i}`);
    const over = await call('POST', hooksPath('capped'), 'owner', { url: HOOK_URL, events: ['kvarm.change.merged'] });
    expect(over.status).toBe(409);
    expect(over.json.code).toBe('WEBHOOK_LIMIT');
    expect((await call('GET', hooksPath('capped'), 'owner')).json.webhooks).toHaveLength(WEBHOOK_LIMITS.hooksPerRepo);
  });

  it('answers 503 when the deployment has no WEBHOOK_SECRET_KEY', async () => {
    const { createWebhook } = await import('../src/services/webhooks');
    const repo = { id: repoIds.hooks!, owner_login: logins.owner, name: 'hooks' } as never;
    const actor = { user: { id: 'u', login: logins.owner } } as never;
    const r = await createWebhook({ ...env, WEBHOOK_SECRET_KEY: undefined } as Env, repo, actor, { url: HOOK_URL, events: ['kvarm.change.merged'] });
    expect(r).toMatchObject({ ok: false, status: 503, code: 'WEBHOOKS_NOT_CONFIGURED' });
  });

  it('updates events and URL, and re-enabling clears the failure count', async () => {
    const { id } = await createHook('hooks', ['kvarm.change.merged']);
    const r = await call('PATCH', hooksPath('hooks', `/${id}`), 'owner', { events: ['kvarm.escalation.opened'], url: 'https://other.example.com/h' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.webhook).toMatchObject({ events: ['kvarm.escalation.opened'], url: 'https://other.example.com/h' });
    expect((await call('PATCH', hooksPath('hooks', `/${id}`), 'owner', { url: 'https://localhost/' })).json.code).toBe('INVALID_URL');
    expect((await call('PATCH', hooksPath('hooks', `/${id}`), 'owner', {})).json.code).toBe('INVALID_UPDATE');
    const off = await call('PATCH', hooksPath('hooks', `/${id}`), 'owner', { active: false });
    expect(off.json.webhook).toMatchObject({ active: false });
    expect(off.json.webhook.disabledAt).not.toBeNull();
    await env.DB.prepare('UPDATE webhooks SET consecutive_failures = 9 WHERE id = ?').bind(id).run();
    const on = await call('PATCH', hooksPath('hooks', `/${id}`), 'owner', { active: true });
    expect(on.json.webhook).toMatchObject({ active: true, consecutiveFailures: 0, disabledAt: null, disabledReason: null });
    expect((await call('PATCH', hooksPath('hooks', `/${crypto.randomUUID()}`), 'owner', { active: true })).status).toBe(404);
  });
});

describe('recording platform events', () => {
  it('fans each subscribed event type out to the active hooks of its repository only', async () => {
    const repo = await seedRepo('emit');
    await seedRepo('emit-other');
    const all = await createHook('emit', [
      'kvarm.change.merged',
      'kvarm.change.ejected',
      'kvarm.check_run.completed',
      'kvarm.escalation.opened',
      'kvarm.task.created',
      'kvarm.queue.publication_reconciled',
    ]);
    const merges = await createHook('emit', ['kvarm.change.merged'], `${HOOK_URL}/merges`);
    const other = await createHook('emit-other', ['kvarm.change.merged']);
    const off = await createHook('emit', ['kvarm.change.merged'], `${HOOK_URL}/off`);
    await call('PATCH', hooksPath('emit', `/${off.id}`), 'owner', { active: false });

    // Merged (any publication path sets the state once).
    const merged = await seedChange('emit', 1);
    await env.DB.prepare("UPDATE change_sets SET state = 'merged', merge_commit = ?, merged_at = ? WHERE id = ?").bind('b'.repeat(40), Date.now(), merged).run();
    // A later unrelated update of a merged change emits nothing again.
    await env.DB.prepare("UPDATE change_sets SET state = 'merged', title = 'x' WHERE id = ?").bind(merged).run();
    // Ejected from the queue.
    const ejected = await seedChange('emit', 2);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO merge_queue (id, repo_id, target_ref, seq, change_set_id, change_number, state, active, head_sha, merge_policy, enqueued_at, updated_at)
       VALUES ('mq-1', ?, 'refs/heads/main', 1, ?, 2, 'queued', 1, ?, 'review', ?, ?)`,
    ).bind(repo, ejected, SHA, now, now).run();
    await env.DB.prepare("UPDATE merge_queue SET state = 'ejected', active = 0, reason_code = 'CHECKS_FAILED', reason = 'ci/test failed' WHERE id = 'mq-1'").run();
    // Overtaken (stale) also leaves the train for good; a later write to the exited entry emits nothing more.
    const overtaken = await seedChange('emit', 4);
    await env.DB.prepare(
      `INSERT INTO merge_queue (id, repo_id, target_ref, seq, change_set_id, change_number, state, active, head_sha, merge_policy, enqueued_at, updated_at)
       VALUES ('mq-2', ?, 'refs/heads/main', 2, ?, 4, 'checking', 1, ?, 'review', ?, ?)`,
    ).bind(repo, overtaken, SHA, now, now).run();
    await env.DB.prepare("UPDATE merge_queue SET state = 'stale', active = 0, reason_code = 'HEAD_MOVED' WHERE id = 'mq-2'").run();
    await env.DB.prepare("UPDATE merge_queue SET state = 'ejected' WHERE id = 'mq-2'").run();
    // Check runs: completed at insert, and queued → running → success.
    await env.DB.prepare(
      `INSERT INTO check_runs (id, repo_id, change_set_id, head_sha, name, status, conclusion, created_at) VALUES ('cr-1', ?, ?, ?, 'ci/lint', 'failure', 'failure', ?)`,
    ).bind(repo, ejected, SHA, now).run();
    await env.DB.prepare(`INSERT INTO check_runs (id, repo_id, head_sha, name, status, created_at) VALUES ('cr-2', ?, ?, 'ci/test', 'queued', ?)`).bind(repo, SHA, now).run();
    await env.DB.prepare("UPDATE check_runs SET status = 'running' WHERE id = 'cr-2'").run();
    await env.DB.prepare("UPDATE check_runs SET status = 'success', conclusion = 'success' WHERE id = 'cr-2'").run();
    // A rewrite to the same status is no new completion; a correction to another terminal status is.
    await env.DB.prepare("UPDATE check_runs SET status = 'success', summary = '{}' WHERE id = 'cr-2'").run();
    await new Promise((r) => setTimeout(r, 2));
    await env.DB.prepare("UPDATE check_runs SET status = 'failure', conclusion = 'failure' WHERE id = 'cr-2'").run();
    // Escalation opened.
    await env.DB.prepare(
      `INSERT INTO change_escalations (id, repo_id, change_set_id, change_number, reason, state, head_sha, opened_at) VALUES ('esc-1', ?, ?, 2, 'review-blocked', 'open', ?, ?)`,
    ).bind(repo, ejected, SHA, now).run();
    // Task created: the existing conflicts path writes the envelope to the ledger.
    const conflicted = await seedChange('emit', 3);
    await env.DB.batch(markConflictedStatements(env.DB, conflicted, { headSha: SHA, baseSha: 'c'.repeat(40), conflicts: [{ path: 'a.txt', kind: 'content' }] }, now));
    // A type another service already writes to the ledger as an envelope is subscribable by listing it.
    await env.DB.prepare(
      `INSERT INTO events (id, type, payload, processed_at, created_at)
       VALUES ('reconciled-1', 'kvarm.queue.publication_reconciled',
               json_object('specversion', '1.0', 'id', 'reconciled-1', 'type', 'kvarm.queue.publication_reconciled',
                           'source', '/repos/' || ?1 || '/emit', 'time', '2026-01-01T00:00:00.000Z', 'datacontenttype', 'application/json',
                           'data', json_object('repo', ?1 || '/emit', 'change', 2, 'outcome', 'not_applied')), NULL, ?2)`,
    ).bind(logins.owner, now).run();

    const rows = await deliveries(all.id);
    expect(rows.map((r) => r.event_type).sort()).toEqual([
      'kvarm.change.ejected',
      'kvarm.change.ejected',
      'kvarm.change.merged',
      'kvarm.check_run.completed',
      'kvarm.check_run.completed',
      'kvarm.check_run.completed',
      'kvarm.escalation.opened',
      'kvarm.queue.publication_reconciled',
      'kvarm.task.created',
    ]);
    expect(rows.every((r) => r.state === 'pending' && r.attempts === 0)).toBe(true);
    expect((await deliveries(merges.id)).map((r) => r.event_type)).toEqual(['kvarm.change.merged']);
    // One event, one id, shared by every hook that receives it.
    expect((await deliveries(merges.id))[0]!.event_id).toBe(rows.find((r) => r.event_type === 'kvarm.change.merged')!.event_id);
    expect(await deliveries(other.id)).toEqual([]);
    expect(await deliveries(off.id)).toEqual([]);

    const payloads = await env.DB.prepare(
      `SELECT e.type, e.payload FROM events e JOIN webhook_deliveries d ON d.event_id = e.id WHERE d.webhook_id = ?`,
    ).bind(all.id).all<{ type: string; payload: string }>();
    const byType = new Map((payloads.results ?? []).map((p) => [p.type, JSON.parse(p.payload) as Record<string, any>]));
    for (const [type, env] of byType) {
      expect(env, type).toMatchObject({ specversion: '1.0', type, source: `/repos/${logins.owner}/emit`, datacontenttype: 'application/json' });
      expect(typeof env.id).toBe('string');
      expect(Date.parse(env.time)).not.toBeNaN();
      expect(env.data.repo).toBe(`${logins.owner}/emit`);
    }
    expect(byType.get('kvarm.change.merged')!.data).toMatchObject({ change: 1, mergeCommit: 'b'.repeat(40), headSha: SHA });
    const ejections = (payloads.results ?? []).filter((p) => p.type === 'kvarm.change.ejected').map((p) => JSON.parse(p.payload).data);
    expect(ejections.map((d: any) => [d.change, d.state, d.code]).sort()).toEqual([
      [2, 'ejected', 'CHECKS_FAILED'],
      [4, 'stale', 'HEAD_MOVED'],
    ]);
    expect(ejections[0].target).toBe('refs/heads/main');
    expect(byType.get('kvarm.escalation.opened')!.data).toMatchObject({ change: 2, reason: 'review-blocked', escalation: 'esc-1' });
    expect(byType.get('kvarm.task.created')!.data).toMatchObject({ change: 3, kind: 'resolve-conflict' });
    const checks = (payloads.results ?? []).filter((p) => p.type === 'kvarm.check_run.completed').map((p) => JSON.parse(p.payload).data);
    expect(checks.map((c: any) => [c.name, c.status, c.change]).sort()).toEqual([
      ['ci/lint', 'failure', 2],
      ['ci/test', 'failure', null],
      ['ci/test', 'success', null],
    ]);
  });

  it('writes no ledger row for a transition no hook subscribes to', async () => {
    await seedRepo('quiet');
    const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type LIKE 'kvarm.%'").first<{ n: number }>())!.n;
    const id = await seedChange('quiet', 1);
    await env.DB.prepare("UPDATE change_sets SET state = 'merged' WHERE id = ?").bind(id).run();
    const after = (await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type LIKE 'kvarm.%'").first<{ n: number }>())!.n;
    expect(after).toBe(before);
  });

  it('never fails a ledger writer: audit rows and malformed payloads are skipped', async () => {
    await createHook('hooks', ['kvarm.task.created']);
    const now = Date.now();
    await env.DB.prepare("INSERT INTO events (id, type, payload, processed_at, created_at) VALUES (?, 'kvarm.task.created', 'not json', NULL, ?)").bind(crypto.randomUUID(), now).run();
    await env.DB.prepare("INSERT INTO events (id, type, payload, processed_at, created_at) VALUES (?, 'kvarm.task.created', '{\"source\":\"/elsewhere\"}', NULL, ?)").bind(crypto.randomUUID(), now).run();
    await env.DB.prepare("INSERT INTO events (id, type, payload, processed_at, created_at) VALUES (?, 'review_policy.updated', '{}', ?, ?)").bind(crypto.randomUUID(), now, now).run();
  });
});

describe('delivering', () => {
  async function pendingDelivery(events = ['kvarm.change.merged']): Promise<{ hook: { id: string; secret: string }; delivery: string; envelope: string }> {
    const name = `deliver-${crypto.randomUUID().slice(0, 8)}`;
    await seedRepo(name);
    const hook = await createHook(name, events);
    const change = await seedChange(name, 1);
    await env.DB.prepare("UPDATE change_sets SET state = 'merged', merge_commit = ?, merged_at = ? WHERE id = ?").bind('b'.repeat(40), Date.now(), change).run();
    const [row] = await deliveries(hook.id);
    const envelope = (await env.DB.prepare('SELECT payload FROM events WHERE id = ?').bind(row!.event_id).first<{ payload: string }>())!.payload;
    return { hook, delivery: row!.id, envelope };
  }

  it('signs the raw CloudEvents body with the hook secret (verified by an independent HMAC)', async () => {
    const { hook, delivery, envelope } = await pendingDelivery();
    const ep = endpoint([204]);
    const c = clock();
    const r = await deliverWebhook(env, delivery, { fetch: ep.fetch, now: c.now });
    expect(r).toMatchObject({ outcome: 'delivered', attempt: 1, status: 204 });
    expect(ep.calls).toHaveLength(1);
    const [req] = ep.calls as [Captured];
    expect(req.url).toBe(HOOK_URL);
    expect(req.init.method).toBe('POST');
    expect(req.init.redirect).toBe('manual');
    expect(req.body).toBe(envelope);
    const event = JSON.parse(req.body) as Record<string, any>;
    expect(event).toMatchObject({ specversion: '1.0', type: 'kvarm.change.merged' });
    expect(req.headers.get('content-type')).toBe('application/cloudevents+json; charset=utf-8');
    expect(req.headers.get('x-kvarm-event')).toBe('kvarm.change.merged');
    expect(req.headers.get('x-kvarm-event-id')).toBe(event.id);
    expect(req.headers.get('idempotency-key')).toBe(event.id);
    expect(req.headers.get('x-kvarm-delivery')).toBe(delivery);
    expect(req.headers.get('x-kvarm-attempt')).toBe('1');
    const ts = req.headers.get('x-kvarm-timestamp')!;
    expect(Number(ts)).toBe(Math.floor(c.now() / 1000));
    const expected = `sha256=${await hmacHex(hook.secret, `${ts}.${req.body}`)}`;
    expect(req.headers.get('x-kvarm-signature')).toBe(expected);
    expect(await signWebhook(hook.secret, Number(ts), req.body)).toBe(expected);
    // A different secret or a tampered body does not verify.
    expect(await hmacHex('wrong', `${ts}.${req.body}`)).not.toBe(expected.slice(7));
    expect(await hmacHex(hook.secret, `${Number(ts) + 1}.${req.body}`)).not.toBe(expected.slice(7));

    const log = await call('GET', `/api/v1/repos/${logins.owner}/${(await repoOfHook(hook.id))}/webhooks/${hook.id}/deliveries`, 'owner');
    expect(log.status).toBe(200);
    expect(log.json.deliveries[0]).toMatchObject({ id: delivery, state: 'delivered', attempts: 1, responseStatus: 204, eventId: event.id, nextAttemptAt: null });
    expect(log.json.deliveries[0].attemptLog).toEqual([expect.objectContaining({ attempt: 1, status: 204, error: null })]);
    expect(JSON.stringify(log.json)).not.toContain(hook.secret);
  });

  it('signs with the rotated secret once rotated', async () => {
    const { hook, delivery } = await pendingDelivery();
    const rotated = await call('POST', `/api/v1/repos/${logins.owner}/${await repoOfHook(hook.id)}/webhooks/${hook.id}/rotate-secret`, 'owner');
    const ep = endpoint([200]);
    await deliverWebhook(env, delivery, { fetch: ep.fetch, now: () => Date.now() });
    const req = ep.calls[0]!;
    const ts = req.headers.get('x-kvarm-timestamp')!;
    expect(req.headers.get('x-kvarm-signature')).toBe(`sha256=${await hmacHex(rotated.json.secret, `${ts}.${req.body}`)}`);
  });

  it('retries a failing endpoint with exponential backoff, records every attempt and stops at the bound', async () => {
    const { hook, delivery } = await pendingDelivery();
    const ep = endpoint([500, new Error('connection reset'), 302, Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 503, 500]);
    const c = clock();
    const delays: number[] = [];
    for (let attempt = 1; attempt <= WEBHOOK_LIMITS.maxAttempts; attempt++) {
      sent.length = 0;
      // A message that arrives before the due time is not an attempt.
      if (attempt > 1) expect((await deliverWebhook(env, delivery, { fetch: ep.fetch, now: () => c.now() - 60_000 })).outcome).toBe('skipped');
      const r = await deliverWebhook(env, delivery, { fetch: ep.fetch, now: c.now });
      expect(r.attempt).toBe(attempt);
      if (attempt < WEBHOOK_LIMITS.maxAttempts) {
        expect(r.outcome).toBe('retry');
        expect(sent).toEqual([{ body: { type: WEBHOOK_DELIVERY_MESSAGE, deliveryId: delivery }, delaySeconds: webhookRetryDelaySeconds(attempt) }]);
        delays.push(sent[0]!.delaySeconds!);
        const [row] = await deliveries(hook.id);
        expect(row).toMatchObject({ state: 'pending', attempts: attempt });
        expect(row!.next_attempt_at).toBe(c.now() + webhookRetryDelaySeconds(attempt) * 1000);
        c.advance(webhookRetryDelaySeconds(attempt) * 1000);
      } else {
        expect(r.outcome).toBe('failed');
        expect(sent).toEqual([]);
      }
    }
    expect(delays).toEqual([30, 120, 480, 1920, 3600]);
    expect(ep.calls).toHaveLength(WEBHOOK_LIMITS.maxAttempts);
    expect(ep.calls.every((x) => x.init.redirect === 'manual')).toBe(true);
    const [row] = await deliveries(hook.id);
    expect(row).toMatchObject({ state: 'failed', attempts: WEBHOOK_LIMITS.maxAttempts });
    const log = await env.DB.prepare('SELECT attempt_log, error, response_status FROM webhook_deliveries WHERE id = ?').bind(delivery).first<{ attempt_log: string; error: string; response_status: number }>();
    const attempts = JSON.parse(log!.attempt_log) as Array<{ attempt: number; status: number | null; error: string }>;
    expect(attempts.map((a) => [a.attempt, a.status])).toEqual([
      [1, 500],
      [2, null],
      [3, 302],
      [4, null],
      [5, 503],
      [6, 500],
    ]);
    expect(attempts[1]!.error).toContain('network error');
    expect(attempts[2]!.error).toBe('redirect not followed');
    expect(attempts[3]!.error).toContain('timeout');
    // A terminal delivery is never attempted again.
    expect((await deliverWebhook(env, delivery, { fetch: ep.fetch, now: () => c.now() + 86_400_000 })).outcome).toBe('skipped');
    expect(ep.calls).toHaveLength(WEBHOOK_LIMITS.maxAttempts);
  });

  it('disables a hook after repeated consecutive failures and records kvarm.webhook.disabled for other hooks', async () => {
    const name = `disable-${crypto.randomUUID().slice(0, 8)}`;
    await seedRepo(name);
    const flaky = await createHook(name, ['kvarm.change.merged']);
    const watcher = await createHook(name, ['kvarm.webhook.disabled'], `${HOOK_URL}/watch`);
    const ep = endpoint([500]);
    const c = clock();
    let disabled = false;
    for (let n = 1; !disabled && n <= WEBHOOK_LIMITS.disableAfterFailures; n++) {
      const change = await seedChange(name, n);
      await env.DB.prepare("UPDATE change_sets SET state = 'merged' WHERE id = ?").bind(change).run();
      const pending = (await deliveries(flaky.id)).filter((d) => d.state === 'pending');
      for (const d of pending) {
        const r = await deliverWebhook(env, d.id, { fetch: ep.fetch, now: () => Math.max(c.now(), d.next_attempt_at) });
        if (r.detail === 'webhook disabled') disabled = true;
      }
    }
    expect(disabled).toBe(true);
    expect(ep.calls).toHaveLength(WEBHOOK_LIMITS.disableAfterFailures);
    const hook = await call('GET', hooksPath(name, `/${flaky.id}`), 'owner');
    expect(hook.json.webhook).toMatchObject({ active: false, consecutiveFailures: WEBHOOK_LIMITS.disableAfterFailures, disabledReason: 'consecutive delivery failures', lastStatus: 500 });
    // No pending delivery remains, and new events are no longer recorded for it.
    expect((await deliveries(flaky.id)).filter((d) => d.state === 'pending')).toEqual([]);
    const later = await seedChange(name, 99);
    const count = (await deliveries(flaky.id)).length;
    await env.DB.prepare("UPDATE change_sets SET state = 'merged' WHERE id = ?").bind(later).run();
    expect(await deliveries(flaky.id)).toHaveLength(count);
    const notice = await deliveries(watcher.id);
    expect(notice.map((d) => d.event_type)).toEqual(['kvarm.webhook.disabled']);
    const payload = JSON.parse((await env.DB.prepare('SELECT payload FROM events WHERE id = ?').bind(notice[0]!.event_id).first<{ payload: string }>())!.payload);
    expect(payload.data).toMatchObject({ webhook: flaky.id, host: 'hooks.example.com', consecutiveFailures: WEBHOOK_LIMITS.disableAfterFailures });
    // Re-enabled, it receives new events again.
    await call('PATCH', hooksPath(name, `/${flaky.id}`), 'owner', { active: true });
    const again = await seedChange(name, 100);
    await env.DB.prepare("UPDATE change_sets SET state = 'merged' WHERE id = ?").bind(again).run();
    expect((await deliveries(flaky.id)).filter((d) => d.state === 'pending')).toHaveLength(1);
  });

  it('delivers at least once: a duplicate message after success is a no-op, a lost one is re-enqueued by the pump', async () => {
    const { hook, delivery } = await pendingDelivery();
    const c = clock();
    // The pump enqueues a new delivery once and not again while its message is live.
    const first = await pumpWebhookDeliveries(env, c.now());
    expect(first.enqueued).toBeGreaterThanOrEqual(1);
    expect(sent.map((s) => s.body.deliveryId)).toContain(delivery);
    sent.length = 0;
    await pumpWebhookDeliveries(env, c.now() + 1000);
    expect(sent.map((s) => s.body.deliveryId)).not.toContain(delivery);
    // The message was lost: once stale, the pump sends it again.
    await pumpWebhookDeliveries(env, c.now() + WEBHOOK_LIMITS.staleMs + 1000);
    expect(sent.map((s) => s.body.deliveryId)).toContain(delivery);

    // Two copies of the message race: only one claims the attempt.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const slow = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      await gate;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const deps: DeliveryDeps = { fetch: slow, now: () => c.now() + WEBHOOK_LIMITS.staleMs + 2000 };
    const one = deliverWebhook(env, delivery, deps);
    await new Promise((r) => setTimeout(r, 20));
    const two = await deliverWebhook(env, delivery, deps);
    expect(two.outcome).toBe('skipped');
    release();
    expect((await one).outcome).toBe('delivered');
    expect(await deliverWebhook(env, delivery, deps)).toMatchObject({ outcome: 'skipped' });
    expect(calls).toHaveLength(1);
    expect((await deliveries(hook.id))[0]).toMatchObject({ state: 'delivered', attempts: 1 });
  });

  it('re-sends a stale delivery once per stale window, not on every pump of a backlog', async () => {
    const { delivery } = await pendingDelivery();
    const t0 = Date.now();
    await pumpWebhookDeliveries(env, t0);
    const sends = () => sent.filter((s) => s.body.deliveryId === delivery).length;
    expect(sends()).toBe(1);
    const late = t0 + WEBHOOK_LIMITS.staleMs + 1000;
    await pumpWebhookDeliveries(env, late);
    expect(sends()).toBe(2);
    // The queue is backlogged: the message has not run yet. Later pumps inside the window do not add copies.
    for (const dt of [1000, 60_000, WEBHOOK_LIMITS.staleMs - 1000]) await pumpWebhookDeliveries(env, late + dt);
    expect(sends()).toBe(2);
    await pumpWebhookDeliveries(env, late + WEBHOOK_LIMITS.staleMs + 1000);
    expect(sends()).toBe(3);
  });

  it('an attempt that lost its lease records nothing against the hook', async () => {
    const { hook, delivery } = await pendingDelivery();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const stalled = (async () => {
      await gate;
      return new Response('late failure', { status: 500 });
    }) as typeof fetch;
    const t0 = Date.now();
    const first = deliverWebhook(env, delivery, { fetch: stalled, now: () => t0 });
    await new Promise((r) => setTimeout(r, 20));
    // The lease ran out while the first attempt hung; another copy of the message succeeds.
    const takeover = t0 + WEBHOOK_LIMITS.leaseMs + 1000;
    expect((await deliverWebhook(env, delivery, { fetch: endpoint([200]).fetch, now: () => takeover })).outcome).toBe('delivered');
    release();
    expect((await first).outcome).toBe('skipped');
    const h = await env.DB.prepare('SELECT consecutive_failures, last_status FROM webhooks WHERE id = ?').bind(hook.id).first();
    expect(h).toEqual({ consecutive_failures: 0, last_status: 200 });
    expect((await deliveries(hook.id))[0]).toMatchObject({ state: 'delivered', attempts: 2 });
  });

  it('never sends past the attempt bound, even when the last attempt died holding its lease', async () => {
    const { hook, delivery } = await pendingDelivery();
    const t = Date.now();
    await env.DB.prepare('UPDATE webhook_deliveries SET attempts = ?, lease_until = ? WHERE id = ?').bind(WEBHOOK_LIMITS.maxAttempts, t - 1, delivery).run();
    const ep = endpoint([200]);
    expect((await deliverWebhook(env, delivery, { fetch: ep.fetch, now: () => t })).outcome).toBe('skipped');
    expect(ep.calls).toHaveLength(0);
    expect((await deliveries(hook.id))[0]).toMatchObject({ state: 'failed', attempts: WEBHOOK_LIMITS.maxAttempts });
  });

  it('a 2xx whose body stalls or breaks is still delivered', async () => {
    const { hook, delivery } = await pendingDelivery();
    const broken = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'));
            controller.error(new Error('connection reset mid-body'));
          },
        }),
        { status: 200 },
      );
    const r = await deliverWebhook(env, delivery, { fetch: endpoint([broken]).fetch, now: () => Date.now() });
    expect(r).toMatchObject({ outcome: 'delivered', status: 200 });
    expect((await deliveries(hook.id))[0]).toMatchObject({ state: 'delivered' });
  });

  it('a missing signing key fails the attempt without sending and never counts against the hook', async () => {
    const { hook, delivery } = await pendingDelivery();
    const ep = endpoint([200]);
    const noKey = { ...env, WEBHOOK_SECRET_KEY: undefined } as Env;
    const r = await deliverWebhook(noKey, delivery, { fetch: ep.fetch, now: () => Date.now() });
    expect(r.outcome).toBe('retry');
    expect(r.detail).toContain('signing secret unavailable');
    expect(ep.calls).toHaveLength(0);
    expect(await env.DB.prepare('SELECT consecutive_failures FROM webhooks WHERE id = ?').bind(hook.id).first('consecutive_failures')).toBe(0);
    const { pingWebhook } = await import('../src/services/webhooks');
    const repo = { id: repoIds[await repoOfHook(hook.id)]!, owner_login: logins.owner, name: await repoOfHook(hook.id) } as never;
    expect(await pingWebhook(noKey, repo, { user: { id: 'u', login: logins.owner } } as never, hook.id)).toMatchObject({ ok: false, status: 503 });
  });

  it('opens a secret only with the key version it was sealed under', async () => {
    const { sealWebhookSecret, openWebhookSecret } = await import('../src/services/webhookSafety');
    const sealed = await sealWebhookSecret(env, 'hook-a', 'the secret');
    expect(await openWebhookSecret(env, 'hook-a', { ...sealed, keyVersion: 1 })).toBe('the secret');
    await expect(openWebhookSecret(env, 'hook-a', { ...sealed, keyVersion: 2 })).rejects.toThrow();
    await expect(openWebhookSecret(env, 'hook-b', { ...sealed, keyVersion: 1 })).rejects.toThrow();
    await expect(openWebhookSecret({ ...env, WEBHOOK_SECRET_KEY: 'another-key-of-at-least-thirty-two-chars' } as Env, 'hook-a', { ...sealed, keyVersion: 1 })).rejects.toThrow();
  });

  it('bounds the stored response and cancels deliveries of deleted or disabled hooks', async () => {
    const { hook, delivery } = await pendingDelivery();
    const big = 'x'.repeat(100_000);
    const ep = endpoint([() => new Response(big, { status: 500 })]);
    await deliverWebhook(env, delivery, { fetch: ep.fetch, now: () => Date.now() });
    const row = await env.DB.prepare('SELECT response_excerpt, error FROM webhook_deliveries WHERE id = ?').bind(delivery).first<{ response_excerpt: string; error: string }>();
    expect(row!.response_excerpt.length).toBeLessThanOrEqual(WEBHOOK_LIMITS.responseExcerptChars + 1);
    expect(row!.error).toBe('HTTP 500');

    const name = await repoOfHook(hook.id);
    await call('DELETE', hooksPath(name, `/${hook.id}`), 'owner');
    const gone = await env.DB.prepare('SELECT state, error FROM webhook_deliveries WHERE id = ?').bind(delivery).first();
    expect(gone).toEqual({ state: 'cancelled', error: 'webhook deleted' });
    expect((await deliverWebhook(env, delivery, { fetch: ep.fetch, now: () => Date.now() + 3_600_000 })).outcome).toBe('skipped');

    // A hook deleted while its message is in flight: the attempt cancels instead of sending.
    const race = await pendingDelivery();
    await env.DB.prepare('DELETE FROM webhooks WHERE id = ?').bind(race.hook.id).run();
    expect(await deliverWebhook(env, race.delivery, { fetch: ep.fetch, now: () => Date.now() })).toMatchObject({ outcome: 'cancelled', detail: 'webhook deleted' });
    expect(ep.calls).toHaveLength(1);
  });

  it('refuses at delivery time a stored URL the policy no longer accepts', async () => {
    const { hook, delivery } = await pendingDelivery();
    await env.DB.prepare("UPDATE webhooks SET url = 'https://169.254.169.254/latest' WHERE id = ?").bind(hook.id).run();
    const ep = endpoint([200]);
    const r = await deliverWebhook(env, delivery, { fetch: ep.fetch, now: () => Date.now() });
    expect(r.outcome).toBe('failed');
    expect(ep.calls).toHaveLength(0);
    expect((await deliveries(hook.id))[0]!.state).toBe('failed');
  });

  it('pings one hook through the queue and pages the delivery log within its cost budget', async () => {
    const name = `ping-${crypto.randomUUID().slice(0, 8)}`;
    await seedRepo(name);
    const hook = await createHook(name, ['kvarm.change.merged']);
    const other = await createHook(name, ['kvarm.change.merged'], `${HOOK_URL}/other`);
    for (let i = 0; i < 3; i++) {
      const ping = await call('POST', hooksPath(name, `/${hook.id}/ping`), 'owner');
      expect(ping.status).toBe(202);
      expect(ping.json.delivery).toMatchObject({ eventType: 'kvarm.webhook.ping', state: 'pending', attempts: 0 });
    }
    expect(sent.filter((s) => s.body.type === WEBHOOK_DELIVERY_MESSAGE)).toHaveLength(3);
    expect(await deliveries(other.id)).toEqual([]);

    const page1 = await call('GET', hooksPath(name, `/${hook.id}/deliveries?limit=2`), 'owner');
    expect(page1.status).toBe(200);
    expect(page1.json.deliveries).toHaveLength(2);
    expect(page1.json.nextCursor).toEqual(expect.any(String));
    const cost = parseCostHeader(page1.headers.get(COST_HEADER))!;
    expect(cost.d1).toBeLessThanOrEqual(2);
    const page2 = await call('GET', hooksPath(name, `/${hook.id}/deliveries?limit=2&cursor=${page1.json.nextCursor}`), 'owner');
    expect(page2.json.deliveries).toHaveLength(1);
    expect(page2.json.nextCursor).toBeNull();
    const ids = [...page1.json.deliveries, ...page2.json.deliveries].map((d: { id: string }) => d.id);
    expect(new Set(ids).size).toBe(3);
    expect((await call('GET', hooksPath(name, `/${hook.id}/deliveries?limit=51`), 'owner')).json.code).toBe('INVALID_LIMIT');
    expect((await call('GET', hooksPath(name, `/${hook.id}/deliveries?cursor=zz`), 'owner')).json.code).toBe('INVALID_CURSOR');
    expect((await call('GET', hooksPath(name, `/${hook.id}/deliveries?state=pending`), 'owner')).json.deliveries).toHaveLength(3);

    for (const [method, rest, budget] of [
      ['GET', '', 2],
      ['POST', `/${hook.id}/rotate-secret`, 2],
      ['GET', `/${hook.id}`, 2],
    ] as const) {
      const r = await call(method, hooksPath(name, rest), 'owner');
      expect(parseCostHeader(r.headers.get(COST_HEADER))!.d1, `${method} ${rest}`).toBeLessThanOrEqual(budget);
    }

    await call('PATCH', hooksPath(name, `/${hook.id}`), 'owner', { active: false });
    expect((await call('POST', hooksPath(name, `/${hook.id}/ping`), 'owner')).json.code).toBe('WEBHOOK_DISABLED');
  });

  it('prunes terminal deliveries past retention in bounded batches, never pending ones', async () => {
    const { hook, delivery } = await pendingDelivery();
    const old = Date.now() - WEBHOOK_LIMITS.retentionMs - 1000;
    await env.DB.prepare('UPDATE webhook_deliveries SET created_at = ? WHERE id = ?').bind(old, delivery).run();
    await pruneWebhookDeliveries(env);
    expect(await deliveries(hook.id)).toHaveLength(1);
    await env.DB.prepare("UPDATE webhook_deliveries SET state = 'delivered' WHERE id = ?").bind(delivery).run();
    const r = await pruneWebhookDeliveries(env);
    expect(r.pruned).toBeGreaterThanOrEqual(1);
    expect(r.pruned).toBeLessThanOrEqual(WEBHOOK_LIMITS.pruneBatch);
    expect(await deliveries(hook.id)).toHaveLength(0);
  });
});

describe('the queue consumer and request paths', () => {
  it('handles a delivery message, acks it even when the endpoint fails, and pumps new deliveries', async () => {
    const name = `consumer-${crypto.randomUUID().slice(0, 8)}`;
    await seedRepo(name);
    const hook = await createHook(name, ['kvarm.change.merged']);
    const change = await seedChange(name, 1);
    await env.DB.prepare("UPDATE change_sets SET state = 'merged' WHERE id = ?").bind(change).run();
    const [d] = await deliveries(hook.id);

    const original = globalThis.fetch;
    const outbound: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      outbound.push(String(input));
      return new Response('down', { status: 503 });
    }) as typeof fetch;
    try {
      const batch = createMessageBatch('kvarm-events', [{ id: 'm1', timestamp: new Date(), attempts: 1, body: { type: WEBHOOK_DELIVERY_MESSAGE, deliveryId: d!.id } }]);
      const ctx = createExecutionContext();
      await worker.queue!(batch, env, ctx);
      const result = await getQueueResult(batch, ctx);
      await waitOnExecutionContext(ctx);
      expect(result.explicitAcks).toEqual(['m1']);
      expect(result.retryMessages).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
    expect(outbound).toEqual([HOOK_URL]);
    expect((await deliveries(hook.id))[0]).toMatchObject({ state: 'pending', attempts: 1 });
    // The retry went out as a delayed message of its own.
    expect(sent).toContainEqual({ body: { type: WEBHOOK_DELIVERY_MESSAGE, deliveryId: d!.id }, delaySeconds: 30 });
  });

  it('runs the attempts of one batch concurrently, beside the other messages', async () => {
    const name = `concurrent-${crypto.randomUUID().slice(0, 8)}`;
    await seedRepo(name);
    const hook = await createHook(name, ['kvarm.change.merged']);
    for (const n of [1, 2]) {
      const change = await seedChange(name, n);
      await env.DB.prepare("UPDATE change_sets SET state = 'merged' WHERE id = ?").bind(change).run();
    }
    const ids = (await deliveries(hook.id)).map((d) => d.id);
    // Each endpoint call waits until both have started: sequential attempts would never finish.
    let started = 0;
    let both!: () => void;
    const barrier = new Promise<void>((r) => (both = r));
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      if (++started === 2) both();
      await Promise.race([barrier, new Promise((_, reject) => setTimeout(() => reject(new Error('attempts ran one at a time')), 2000))]);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      const batch = createMessageBatch('kvarm-events', [
        { id: 'w1', timestamp: new Date(), attempts: 1, body: { type: WEBHOOK_DELIVERY_MESSAGE, deliveryId: ids[0]! } },
        { id: 'x1', timestamp: new Date(), attempts: 1, body: { type: 'not-a-known-message' } },
        { id: 'w2', timestamp: new Date(), attempts: 1, body: { type: WEBHOOK_DELIVERY_MESSAGE, deliveryId: ids[1]! } },
      ]);
      const ctx = createExecutionContext();
      await worker.queue!(batch, env, ctx);
      const result = await getQueueResult(batch, ctx);
      await waitOnExecutionContext(ctx);
      expect([...result.explicitAcks].sort()).toEqual(['w1', 'w2', 'x1']);
    } finally {
      globalThis.fetch = original;
    }
    expect((await deliveries(hook.id)).map((d) => d.state)).toEqual(['delivered', 'delivered']);
  });

  it('a request that records an event never calls the endpoint and answers as before', async () => {
    const name = `request-${crypto.randomUUID().slice(0, 8)}`;
    const repo = await seedRepo(name);
    const hook = await createHook(name, ['kvarm.check_run.completed']);
    await env.DB.prepare(`INSERT INTO check_runs (id, repo_id, head_sha, name, status, created_at) VALUES (?, ?, ?, 'ext/scan', 'running', ?)`)
      .bind(`cr-${name}`, repo, SHA, Date.now())
      .run();
    const original = globalThis.fetch;
    const outbound: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://hooks.example.com')) {
        outbound.push(url);
        throw new Error('endpoint down');
      }
      return original(input, init);
    }) as typeof fetch;
    let r: Reply;
    try {
      r = await call('PATCH', `/api/v1/repos/${logins.owner}/${name}/check-runs/cr-${name}`, 'owner', { conclusion: 'failure' });
    } finally {
      globalThis.fetch = original;
    }
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.run).toMatchObject({ status: 'failure' });
    expect(outbound).toEqual([]);
    expect(await deliveries(hook.id)).toEqual([expect.objectContaining({ event_type: 'kvarm.check_run.completed', state: 'pending' })]);
    expect(parseCostHeader(r.headers.get(COST_HEADER))!.sub).toBe(0);
  });
});

describe('MCP and repository lifecycle', () => {
  async function tool(name: string, args: Record<string, unknown>, who: Who = 'owner'): Promise<{ isError: boolean; data: any }> {
    const r = await call('POST', '/mcp', who, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, {
      accept: 'application/json, text/event-stream',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const result = r.json.result as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: result.isError === true, data: JSON.parse(result.content[0]!.text) };
  }

  it('creates, lists, pages and deletes hooks through the MCP tools with the REST authority', async () => {
    const name = `mcp-${crypto.randomUUID().slice(0, 8)}`;
    await seedRepo(name);
    const repo = `${logins.owner}/${name}`;
    const created = await tool('create_webhook', { repo, url: HOOK_URL, events: ['kvarm.task.created'] });
    expect(created.isError, JSON.stringify(created.data)).toBe(false);
    expect(created.data.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const id = created.data.webhook.id as string;
    const listed = await tool('list_webhooks', { repo });
    expect(listed.data.webhooks.map((h: { id: string }) => h.id)).toEqual([id]);
    expect(JSON.stringify(listed.data)).not.toContain(created.data.secret);
    expect((await tool('list_webhook_deliveries', { repo, id, limit: 5 })).data).toEqual({ deliveries: [], nextCursor: null });
    expect(await tool('list_webhooks', { repo }, 'outsider')).toMatchObject({ isError: true, data: { status: 404 } });
    expect(await tool('create_webhook', { repo, url: HOOK_URL, events: ['kvarm.task.created'] }, 'writer')).toMatchObject({ isError: true, data: { status: 404 } });
    expect((await tool('update_webhook', { repo, id, active: false })).data.webhook.active).toBe(false);
    expect((await tool('delete_webhook', { repo, id })).data).toMatchObject({ deleted: true });
  });

  it('deleting a repository removes its hooks and delivery log', async () => {
    const name = `doomed-${crypto.randomUUID().slice(0, 8)}`;
    const repoId = await seedRepo(name);
    const hook = await createHook(name, ['kvarm.change.merged']);
    const change = await seedChange(name, 1);
    await env.DB.prepare("UPDATE change_sets SET state = 'merged' WHERE id = ?").bind(change).run();
    expect(await deliveries(hook.id)).toHaveLength(1);
    const { changeCleanupStatements } = await import('../src/services/changes');
    await env.DB.batch(changeCleanupStatements(env.DB, repoId));
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM webhooks WHERE repo_id = ?').bind(repoId).first('n')).toBe(0);
    expect(await deliveries(hook.id)).toEqual([]);
  });
});

async function repoOfHook(hookId: string): Promise<string> {
  return (await env.DB.prepare('SELECT r.name FROM webhooks h JOIN repos r ON r.id = h.repo_id WHERE h.id = ?').bind(hookId).first<{ name: string }>())!.name;
}
