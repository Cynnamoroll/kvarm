import { env as cfEnv, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { pktLine, readPktLines, ZERO_OID } from '@forge/gitops';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader } from '../src/cost/meter';
import {
  directPushDenial,
  directHumanPushDenial,
  effectivePolicy,
  normalizeRulePattern,
  RESERVED_REF_REASON,
  PROTECTED_REF_REASON,
  type BranchRule,
} from '../src/services/branchRules';

const env = cfEnv as unknown as Env;
const ORIGIN = 'https://forge.test';
const FULL: Scope[] = ['read', 'write', 'api'];
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

type Who = 'owner' | 'writer' | 'reader' | 'outsider' | 'admin';
const logins: Record<Who, string> = {
  owner: 'br-owner',
  writer: 'br-writer',
  reader: 'br-reader',
  outsider: 'br-outsider',
  admin: 'br-instance-admin',
};
const pat = {} as Record<Who, string>;
const REPO = `${logins.owner}/protected`;
const PLAIN = `${logins.owner}/plain`;

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, init));
}

function as(who: Who, init: RequestInit & { json?: unknown } = {}): RequestInit {
  const headers: Record<string, string> = { Authorization: `Bearer ${pat[who]}` };
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  const { json, ...rest } = init;
  return { ...rest, headers, body: json === undefined ? undefined : JSON.stringify(json) };
}

async function status(path: string, init: RequestInit = {}): Promise<number> {
  const res = await call(path, init);
  await res.body?.cancel();
  return res.status;
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function basic(token: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`x:${token}`)}` };
}

function pushBody(cmds: string[], caps = 'report-status agent=git/2.47'): Uint8Array {
  const parts = cmds.map((c, i) => pktLine(i === 0 ? `${c}\0${caps}\n` : `${c}\n`));
  parts.push(new TextEncoder().encode('0000PACK\0\0\0\x02\0\0\0\0'));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function push(token: string, repo: string, body: Uint8Array): Promise<Response> {
  return call(`/${repo}.git/git-receive-pack`, {
    method: 'POST',
    headers: { ...basic(token), 'content-type': 'application/x-git-receive-pack-request' },
    body,
  });
}

async function reportStatus(res: Response): Promise<string[]> {
  const buf = new Uint8Array(await res.arrayBuffer());
  let pkts = readPktLines(buf).filter((p) => !p.flush);
  if (pkts.length > 0 && pkts.every((p) => p.data[0] === 1)) {
    const inner = pkts.map((p) => p.data.subarray(1));
    const joined = new Uint8Array(inner.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of inner) {
      joined.set(p, off);
      off += p.length;
    }
    pkts = readPktLines(joined).filter((p) => !p.flush);
  }
  return pkts.map((p) => new TextDecoder().decode(p.data).trim());
}

async function seedUser(login: string, admin = false): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, `test:${login}`, login, `${login}@forge.invalid`, login, admin ? 1 : 0, Date.now())
    .run();
  return id;
}

async function seedRepo(owner: string, name: string, visibility: 'public' | 'private'): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'main', ?7)`,
  )
    .bind(
      crypto.randomUUID(),
      owner,
      name,
      `${owner}--${name}`,
      `https://artifacts.invalid/git/default/${owner}--${name}.git`,
      visibility,
      Date.now(),
    )
    .run();
}

interface RuleJson {
  id: string;
  pattern: string;
  requiredChecks: string[];
  requiredApprovals: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

async function createRule(who: Who, repo: string, body: Record<string, unknown>): Promise<Response> {
  return call(`/api/v1/repos/${repo}/branch-rules`, as(who, { method: 'POST', json: body }));
}

async function createdRule(who: Who, repo: string, body: Record<string, unknown>): Promise<RuleJson> {
  const res = await createRule(who, repo, body);
  expect(res.status, JSON.stringify(body)).toBe(201);
  return (await json<{ rule: RuleJson }>(res)).rule;
}

let mainRule: RuleJson;

beforeAll(async () => {
  for (const who of Object.keys(logins) as Who[]) {
    const id = await seedUser(logins[who], who === 'admin');
    pat[who] = (await mintPAT(env, id, 'full', FULL)).token;
  }
  await seedRepo(logins.owner, 'protected', 'private');
  await seedRepo(logins.owner, 'plain', 'private');
  for (const [who, role] of [
    ['writer', 'write'],
    ['reader', 'read'],
  ] as const) {
    expect(
      await status(`/api/v1/repos/${REPO}/grants/${logins[who]}`, as('owner', { method: 'PUT', json: { role } })),
    ).toBe(200);
    expect(
      await status(`/api/v1/repos/${PLAIN}/grants/${logins[who]}`, as('owner', { method: 'PUT', json: { role } })),
    ).toBe(200);
  }
  mainRule = await createdRule('owner', REPO, { pattern: 'main', requiredChecks: ['ci/test'], requiredApprovals: 1 });
});

describe('branch rule evaluation', () => {
  const rule = (id: string, pattern: string, checks: string[] = [], approvals = 0): BranchRule => ({
    id,
    pattern,
    requiredChecks: checks,
    requiredApprovals: approvals,
    createdBy: null,
    createdAt: 0,
    updatedBy: null,
    updatedAt: 0,
  });

  it('normalizes branch names and validates patterns', () => {
    expect(normalizeRulePattern('main')).toBe('refs/heads/main');
    expect(normalizeRulePattern('release/*')).toBe('refs/heads/release/*');
    expect(normalizeRulePattern('refs/tags/*')).toBe('refs/tags/*');
    expect(normalizeRulePattern('refs/heads/*')).toBe('refs/heads/*');
    for (const bad of ['', 'refs/*', 'ma*in', 'a..b', 'x/*/y', 7, null]) {
      expect(normalizeRulePattern(bad), String(bad)).toBeNull();
    }
  });

  it('combines matching rules and denies direct pushes only on protected refs', () => {
    const rules = [rule('r1', 'refs/heads/main', ['ci'], 1), rule('r2', 'refs/heads/*', ['guard', 'ci'], 2)];
    expect(effectivePolicy(rules, 'refs/heads/main')).toEqual({
      ref: 'refs/heads/main',
      protected: true,
      directPush: 'denied',
      requiredChecks: ['ci', 'guard'],
      requiredApprovals: 2,
      rules: ['r1', 'r2'],
    });
    expect(effectivePolicy(rules, 'refs/tags/v1').protected).toBe(false);
    expect(directPushDenial(rules, 'refs/heads/feature')).toBe(PROTECTED_REF_REASON);
    expect(directPushDenial([rule('r', 'refs/heads/main')], 'refs/heads/main2')).toBeNull();
    expect(directPushDenial([rule('r', 'refs/heads/main')], 'refs/heads//main')).toBe('invalid ref name');
    expect(directPushDenial([], 'refs/heads//main')).toBeNull();
  });

  it('reserves platform branch namespaces from human pushes without branch rules', () => {
    for (const ref of ['refs/heads/forge-ci', 'refs/heads/forge-ci/x', 'refs/heads/agents', 'refs/heads/agents/x']) {
      expect(directHumanPushDenial([], ref)).toBe(RESERVED_REF_REASON);
    }
    expect(directHumanPushDenial([], 'refs/heads/feature/x')).toBeNull();
  });
});

describe('branch rule management', () => {
  it('lets repo admins create rules with normalized settings', () => {
    expect(mainRule).toMatchObject({
      pattern: 'refs/heads/main',
      requiredChecks: ['ci/test'],
      requiredApprovals: 1,
      createdBy: logins.owner,
      updatedBy: logins.owner,
    });
    expect(mainRule.createdAt).toMatch(/Z$/);
  });

  it('validates input and rejects duplicates', async () => {
    const cases: [Record<string, unknown>, number, string][] = [
      [{ pattern: 'refs/*' }, 400, 'INVALID_PATTERN'],
      [{}, 400, 'INVALID_PATTERN'],
      [{ pattern: 'dev', requiredChecks: 'ci' }, 400, 'INVALID_CHECKS'],
      [{ pattern: 'dev', requiredChecks: [''] }, 400, 'INVALID_CHECKS'],
      [{ pattern: 'dev', requiredApprovals: 11 }, 400, 'INVALID_APPROVALS'],
      [{ pattern: 'dev', requiredApprovals: 1.5 }, 400, 'INVALID_APPROVALS'],
      [{ pattern: 'refs/heads/main' }, 409, 'RULE_EXISTS'],
    ];
    for (const [body, code, errCode] of cases) {
      const res = await createRule('owner', REPO, body);
      expect(res.status, JSON.stringify(body)).toBe(code);
      expect((await json(res)).code).toBe(errCode);
    }
  });

  it('only repo admins manage rules; readers may list them; outsiders see nothing', async () => {
    for (const who of ['writer', 'reader'] as const) {
      const res = await createRule(who, REPO, { pattern: 'dev' });
      expect(res.status, who).toBe(403);
      expect((await json(res)).code).toBe('FORBIDDEN');
      expect(
        await status(`/api/v1/repos/${REPO}/branch-rules/${mainRule.id}`, as(who, { method: 'DELETE' })),
      ).toBe(403);
    }
    expect(await status(`/api/v1/repos/${REPO}/branch-rules`, as('outsider'))).toBe(404);
    expect(await status(`/api/v1/repos/${REPO}/branch-rules`, as('outsider', { method: 'POST', json: { pattern: 'x' } }))).toBe(404);
    expect(await status(`/api/v1/repos/${REPO}/branch-rules`)).toBe(404);
    const listed = await json<{ rules: RuleJson[] }>(await call(`/api/v1/repos/${REPO}/branch-rules`, as('reader')));
    expect(listed.rules.map((r) => r.pattern)).toContain('refs/heads/main');
    const one = await call(`/api/v1/repos/${REPO}/branch-rules/${mainRule.id}`, as('writer'));
    expect((await json<{ rule: RuleJson }>(one)).rule.id).toBe(mainRule.id);
  });

  it('updates and deletes rules, with audit events', async () => {
    const rule = await createdRule('owner', REPO, { pattern: 'release/*' });
    const patched = await call(
      `/api/v1/repos/${REPO}/branch-rules/${rule.id}`,
      as('owner', { method: 'PATCH', json: { requiredChecks: ['a', 'a', 'b'], requiredApprovals: 2 } }),
    );
    expect(patched.status).toBe(200);
    expect((await json<{ rule: RuleJson }>(patched)).rule).toMatchObject({
      pattern: 'refs/heads/release/*',
      requiredChecks: ['a', 'b'],
      requiredApprovals: 2,
    });
    expect(
      await status(`/api/v1/repos/${REPO}/branch-rules/${rule.id}`, as('owner', { method: 'PATCH', json: { pattern: 'x' } })),
    ).toBe(400);
    const del = await call(`/api/v1/repos/${REPO}/branch-rules/${rule.id}`, as('owner', { method: 'DELETE' }));
    expect(del.status).toBe(200);
    expect(await json(del)).toMatchObject({ deleted: true, rule: { id: rule.id } });
    expect(await status(`/api/v1/repos/${REPO}/branch-rules/${rule.id}`, as('owner', { method: 'DELETE' }))).toBe(404);
    expect(await status(`/api/v1/repos/${REPO}/branch-rules/${rule.id}`, as('owner'))).toBe(404);
    // Rules of another repo are not reachable through this one.
    expect(await status(`/api/v1/repos/${PLAIN}/branch-rules/${mainRule.id}`, as('owner'))).toBe(404);

    const { results } = await env.DB.prepare(
      "SELECT type, payload FROM events WHERE type LIKE 'branch_rule.%' AND payload LIKE ? ORDER BY created_at",
    )
      .bind(`%${rule.id}%`)
      .all<{ type: string; payload: string }>();
    expect(results.map((r) => r.type)).toEqual(['branch_rule.created', 'branch_rule.updated', 'branch_rule.deleted']);
    expect(JSON.parse(results[1]!.payload)).toMatchObject({
      repo: REPO,
      ruleId: rule.id,
      pattern: 'refs/heads/release/*',
      requiredChecks: ['a', 'b'],
      requiredApprovals: 2,
      actor: logins.owner,
    });
  });

  it('lets the instance admin manage rules as an explicit operations role', async () => {
    const rule = await createdRule('admin', REPO, { pattern: 'ops-test' });
    expect(rule.createdBy).toBe(logins.admin);
    expect(await status(`/api/v1/repos/${REPO}/branch-rules/${rule.id}`, as('admin', { method: 'DELETE' }))).toBe(200);
  });

  it('reports the effective policy of a ref', async () => {
    const res = await call(`/api/v1/repos/${REPO}/branch-policy?ref=main`, as('reader'));
    expect(await json(res)).toEqual({
      ref: 'refs/heads/main',
      protected: true,
      directPush: 'denied',
      requiredChecks: ['ci/test'],
      requiredApprovals: 1,
      rules: [mainRule.id],
    });
    const free = await json(await call(`/api/v1/repos/${REPO}/branch-policy?ref=refs/heads/scratch`, as('reader')));
    expect(free).toMatchObject({ protected: false, directPush: 'allowed', requiredChecks: [], requiredApprovals: 0 });
    expect(await status(`/api/v1/repos/${REPO}/branch-policy?ref=a..b`, as('reader'))).toBe(400);
  });
});

describe('protected direct pushes', () => {
  it('denies update, non-fast-forward, create and delete of a protected ref for every human', async () => {
    const cmds = [`${A} ${B} refs/heads/main`, `${A} ${C} refs/heads/main`, `${ZERO_OID} ${B} refs/heads/main`, `${A} ${ZERO_OID} refs/heads/main`];
    for (const who of ['owner', 'writer', 'admin'] as const) {
      for (const cmd of cmds) {
        const res = await push(pat[who], REPO, pushBody([cmd]));
        expect(res.status, `${who} ${cmd}`).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/x-git-receive-pack-result');
        expect(await reportStatus(res)).toEqual(['unpack ok', `ng refs/heads/main ${PROTECTED_REF_REASON}`]);
      }
    }
  });

  it('rejects every ref of a push that touches a protected ref', async () => {
    const res = await push(
      pat.owner,
      REPO,
      pushBody([`${A} ${B} refs/heads/scratch`, `${A} ${B} refs/heads/main`], 'report-status side-band-64k agent=git/2.47'),
    );
    expect(await reportStatus(res)).toEqual([
      'unpack ok',
      'ng refs/heads/scratch push rejected: another ref in this push was denied',
      `ng refs/heads/main ${PROTECTED_REF_REASON}`,
    ]);
  });

  it('costs one D1 batch and no upstream work when denied', async () => {
    const res = await push(pat.owner, REPO, pushBody([`${A} ${B} refs/heads/main`]));
    const cost = parseCostHeader(res.headers.get(COST_HEADER));
    await res.body?.cancel();
    expect(cost).toMatchObject({ d1: 1, art: 0, do: 0, sub: 0 });
  });

  it('passes unprotected refs on a protected repo through to storage', async () => {
    for (const cmd of [`${A} ${B} refs/heads/scratch`, `${ZERO_OID} ${B} refs/heads/feature/x`, `${A} ${ZERO_OID} refs/heads/old`]) {
      const res = await push(pat.writer, REPO, pushBody([cmd]));
      // Past the gate the upstream token mint fails hermetically (no Artifacts).
      expect(res.status, cmd).toBe(503);
      await res.body?.cancel();
    }
  });

  it('protects prefix patterns and stops protecting when the rule is removed', async () => {
    const rule = await createdRule('owner', REPO, { pattern: 'release/*' });
    const denied = await push(pat.owner, REPO, pushBody([`${ZERO_OID} ${B} refs/heads/release/1.0`]));
    expect(await reportStatus(denied)).toEqual(['unpack ok', `ng refs/heads/release/1.0 ${PROTECTED_REF_REASON}`]);
    expect(await status(`/api/v1/repos/${REPO}/branch-rules/${rule.id}`, as('owner', { method: 'DELETE' }))).toBe(200);
    const allowed = await push(pat.owner, REPO, pushBody([`${ZERO_OID} ${B} refs/heads/release/1.0`]));
    expect(allowed.status).toBe(503);
    await allowed.body?.cancel();
  });

  it('leaves ordinary branch pushes to repos without rules unchanged', async () => {
    const main = await push(pat.owner, PLAIN, pushBody([`${A} ${B} refs/heads/main`]));
    expect(main.status).toBe(503);
    await main.body?.cancel();
  });

  it('denies human create, update and delete in platform-reserved namespaces without rules', async () => {
    const commands = [
      `${ZERO_OID} ${B}`,
      `${A} ${B}`,
      `${A} ${ZERO_OID}`,
    ];
    for (const who of ['owner', 'writer', 'admin'] as const) {
      for (const ref of ['refs/heads/forge-ci', 'refs/heads/forge-ci/x', 'refs/heads/agents', 'refs/heads/agents/x']) {
        for (const command of commands) {
          const res = await push(pat[who], PLAIN, pushBody([`${command} ${ref}`]));
          expect(res.status, `${who} ${command} ${ref}`).toBe(200);
          expect(await reportStatus(res)).toEqual(['unpack ok', `ng ${ref} ${RESERVED_REF_REASON}`]);
        }
      }
    }
  });

  it('rejects reserved refs locally without extra upstream work', async () => {
    const res = await push(pat.owner, PLAIN, pushBody([`${ZERO_OID} ${B} refs/heads/forge-ci/x`]));
    const cost = parseCostHeader(res.headers.get(COST_HEADER));
    await res.body?.cancel();
    expect(cost).toMatchObject({ d1: 1, art: 0, do: 0, sub: 0 });
  });

  it('still requires write access before any rule is consulted', async () => {
    expect(await status(`/${REPO}.git/git-receive-pack`, { method: 'POST', headers: basic(pat.reader), body: pushBody([`${A} ${B} refs/heads/scratch`]) })).toBe(403);
    expect(await status(`/${REPO}.git/git-receive-pack`, { method: 'POST', headers: basic(pat.outsider), body: pushBody([`${A} ${B} refs/heads/main`]) })).toBe(404);
  });
});

describe('protected refs and agent tokens', () => {
  it('denies an agent whose grant covers the protected ref', async () => {
    const agentRes = await call('/api/v1/agents', as('owner', { method: 'POST', json: { name: 'br-bot' } }));
    expect(agentRes.status).toBe(201);
    const agentId = (await json<{ agent: { id: string } }>(agentRes)).agent.id;
    const tokRes = await call(
      `/api/v1/agents/${agentId}/tokens`,
      as('owner', { method: 'POST', json: { repo: REPO, role: 'write', refs: ['refs/heads/*'], expiresIn: 600 } }),
    );
    expect(tokRes.status).toBe(201);
    const token = (await json<{ token: string }>(tokRes)).token;
    const denied = await push(token, REPO, pushBody([`${A} ${B} refs/heads/main`]));
    expect(await reportStatus(denied)).toEqual(['unpack ok', `ng refs/heads/main ${PROTECTED_REF_REASON}`]);
    const outside = await push(token, REPO, pushBody([`${A} ${B} refs/tags/v1`]));
    expect(await reportStatus(outside)).toEqual(['unpack ok', 'ng refs/tags/v1 ref outside agent token grant']);
    const allowed = await push(token, REPO, pushBody([`${A} ${B} refs/heads/scratch`]));
    expect(allowed.status).toBe(503);
    await allowed.body?.cancel();
    // Agents cannot manage rules.
    const manage = await call(`/api/v1/repos/${REPO}/branch-rules`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pattern: 'x' }),
    });
    expect(manage.status).toBe(403);
    expect((await json(manage)).code).toBe('INSUFFICIENT_SCOPE');
  });
});
