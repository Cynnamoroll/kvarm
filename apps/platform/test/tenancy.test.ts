import { env as cfEnv, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import { authorizeGitRequest } from '../src/routes/git';

const env = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const ORG = 'acme-labs';
const FULL: Scope[] = ['read', 'write', 'api'];

type Who = 'owner' | 'maint' | 'member' | 'outsider' | 'coowner' | 'twinA' | 'twinB' | 'twinM';
const logins: Record<Who, string> = {
  owner: 'tn-owner',
  maint: 'tn-maint',
  member: 'tn-member',
  outsider: 'tn-outsider',
  coowner: 'tn-coowner',
  twinA: 'tn-twin-a',
  twinB: 'tn-twin-b',
  twinM: 'tn-twin-m',
};
const tok = {} as Record<Who, string>;

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, init));
}

function as(who: Who, init: RequestInit & { json?: unknown } = {}): RequestInit {
  const headers: Record<string, string> = { Authorization: `Bearer ${tok[who]}` };
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  const { json, ...rest } = init;
  return { ...rest, headers, body: json === undefined ? undefined : JSON.stringify(json) };
}

async function status(path: string, init: RequestInit = {}): Promise<number> {
  const res = await call(path, init);
  await res.body?.cancel();
  return res.status;
}

async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function costOf(res: Response): Promise<CostCounters> {
  const parsed = parseCostHeader(res.headers.get(COST_HEADER));
  expect(parsed).not.toBeNull();
  if (!res.bodyUsed) await res.body?.cancel();
  return parsed!;
}

/** Git gate decision only; allowed requests would otherwise proxy to Artifacts. */
async function git(who: Who | null, repo: string, op: 'read' | 'write'): Promise<number> {
  const path =
    op === 'read'
      ? `/${repo}.git/info/refs?service=git-upload-pack`
      : `/${repo}.git/info/refs?service=git-receive-pack`;
  const headers: Record<string, string> = who ? { Authorization: `Basic ${btoa(`x:${tok[who]}`)}` } : {};
  const [owner, name] = repo.split('/') as [string, string];
  const res = await authorizeGitRequest(env, new Request(`${ORIGIN}${path}`, { headers }), owner, name, 'info/refs');
  return res.ok ? 200 : res.response.status;
}

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  )
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  return id;
}

/** Repo rows are seeded directly: Artifacts is not available hermetically. */
async function seedRepo(owner: string, name: string, visibility: 'public' | 'private'): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility,
       default_branch, created_at, owner_org_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'main', ?7, (SELECT id FROM orgs WHERE login = ?2))`,
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

async function setRole(who: Who, role: string, by: Who = 'owner'): Promise<Response> {
  return call(`/api/v1/orgs/${ORG}/members/${logins[who]}`, as(by, { method: 'PUT', json: { role } }));
}

async function grant(repo: string, who: Who, role: string, by: Who = 'owner'): Promise<Response> {
  return call(`/api/v1/repos/${repo}/grants/${logins[who]}`, as(by, { method: 'PUT', json: { role } }));
}

beforeAll(async () => {
  for (const who of Object.keys(logins) as Who[]) {
    const id = await seedUser(logins[who]);
    tok[who] = (await mintPAT(env, id, `tn-${who}`, FULL)).token;
  }
  const res = await call('/api/v1/orgs', as('owner', { method: 'POST', json: { login: ORG, name: 'Acme Labs' } }));
  expect(res.status).toBe(201);
  expect((await setRole('maint', 'maintainer')).status).toBe(200);
  expect((await setRole('member', 'member')).status).toBe(200);
  await seedRepo(ORG, 'vault', 'private');
  await seedRepo(ORG, 'lobby', 'public');
  await seedRepo(ORG, 'flip', 'public');
  await seedRepo(logins.owner, 'diary', 'private');
});

describe('account namespace', () => {
  it('rejects an org login already taken by a user, in any case, and reserved or duplicate logins', async () => {
    const taken = await call('/api/v1/orgs', as('outsider', { method: 'POST', json: { login: logins.member } }));
    expect(taken.status).toBe(409);
    expect(await body(taken)).toMatchObject({ code: 'NAMESPACE_TAKEN' });
    const dup = await call('/api/v1/orgs', as('outsider', { method: 'POST', json: { login: ORG } }));
    expect(dup.status).toBe(409);
    expect(await status('/api/v1/orgs', as('outsider', { method: 'POST', json: { login: 'API' } }))).toBe(400);
    expect(await status('/api/v1/orgs', as('outsider', { method: 'POST', json: { login: 'api' } }))).toBe(400);
    expect(await status('/api/v1/orgs', { method: 'POST', body: '{"login":"anon-org"}' })).toBe(401);
  });

  it('refuses a new user whose login matches an org, even differing in case', async () => {
    // The users_claim_account_name trigger claims every login in account_names.
    await expect(seedUser(ORG)).rejects.toThrow(/UNIQUE constraint failed: account_names\.login/);
    await expect(seedUser(ORG.toUpperCase())).rejects.toThrow(/UNIQUE constraint failed: account_names\.login/);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE login = ? COLLATE NOCASE')
      .bind(ORG)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

describe('organization ownership and roles', () => {
  it('makes the creator the owner and reports viewer roles', async () => {
    const own = await body<{ viewerRole: string; org: { login: string } }>(await call(`/api/v1/orgs/${ORG}`, as('owner')));
    expect(own).toMatchObject({ viewerRole: 'owner', org: { login: ORG } });
    expect((await body(await call(`/api/v1/orgs/${ORG}`, as('maint')))).viewerRole).toBe('maintainer');
    expect((await body(await call(`/api/v1/orgs/${ORG}`, as('outsider')))).viewerRole).toBeNull();
    const mine = await body<{ orgs: { login: string; role: string }[] }>(await call('/api/v1/user/orgs', as('member')));
    expect(mine.orgs).toContainEqual(expect.objectContaining({ login: ORG, role: 'member' }));
  });

  it('lets only owners manage membership', async () => {
    for (const who of ['maint', 'member', 'outsider'] as const) {
      const res = await setRole('coowner', 'member', who);
      expect(res.status, who).toBe(403);
      expect(await body(res)).toMatchObject({ code: 'FORBIDDEN' });
      expect(await status(`/api/v1/orgs/${ORG}/members/${logins.member}`, as(who, { method: 'DELETE' }))).toBe(403);
    }
    const list = await body<{ members: { login: string; role: string }[] }>(
      await call(`/api/v1/orgs/${ORG}/members`, as('member')),
    );
    expect(list.members.map((m) => m.login)).not.toContain(logins.coowner);
    expect(await status(`/api/v1/orgs/${ORG}/members`, as('outsider'))).toBe(403);
    expect((await setRole('outsider', 'member')).status).toBe(200);
    expect(await status(`/api/v1/orgs/${ORG}/members/${logins.outsider}`, as('owner', { method: 'DELETE' }))).toBe(200);
    const missing = await call(`/api/v1/orgs/${ORG}/members/nobody-here`, as('owner', { method: 'PUT', json: { role: 'member' } }));
    expect(missing.status).toBe(404);
    expect(await body(missing)).toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('never removes or demotes the last owner', async () => {
    const org = 'acme-solo';
    expect(await status('/api/v1/orgs', as('coowner', { method: 'POST', json: { login: org } }))).toBe(201);
    const demote = await call(`/api/v1/orgs/${org}/members/${logins.coowner}`, as('coowner', { method: 'PUT', json: { role: 'member' } }));
    expect(demote.status).toBe(409);
    expect(await body(demote)).toMatchObject({ code: 'LAST_OWNER' });
    const remove = await call(`/api/v1/orgs/${org}/members/${logins.coowner}`, as('coowner', { method: 'DELETE' }));
    expect(remove.status).toBe(409);
    expect(await body(remove)).toMatchObject({ code: 'LAST_OWNER' });

    // With a second owner, the first may step down; the survivor is protected again.
    expect(await status(`/api/v1/orgs/${org}/members/${logins.outsider}`, as('coowner', { method: 'PUT', json: { role: 'owner' } }))).toBe(200);
    expect(await status(`/api/v1/orgs/${org}/members/${logins.coowner}`, as('coowner', { method: 'PUT', json: { role: 'maintainer' } }))).toBe(200);
    expect(await status(`/api/v1/orgs/${org}/members/${logins.outsider}`, as('outsider', { method: 'DELETE' }))).toBe(409);
    const owners = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE o.login = ? AND m.role = 'owner'",
    )
      .bind(org)
      .first<{ n: number }>();
    expect(owners?.n).toBe(1);
    // The demoted former owner can no longer manage membership.
    expect(await status(`/api/v1/orgs/${org}/members/${logins.member}`, as('coowner', { method: 'PUT', json: { role: 'member' } }))).toBe(403);
  });

  it('lets owners and maintainers, not members, create org repos', async () => {
    const res = await call(`/api/v1/orgs/${ORG}/repos`, as('member', { method: 'POST', json: { name: 'nope' } }));
    expect(res.status).toBe(403);
    expect(await status(`/api/v1/orgs/${ORG}/repos`, as('outsider', { method: 'POST', json: { name: 'nope' } }))).toBe(403);
    expect(await status('/api/v1/orgs/no-such-org/repos', as('owner', { method: 'POST', json: { name: 'x' } }))).toBe(404);
  });
});

describe('private org repos require explicit grants', () => {
  const vault = `${ORG}/vault`;

  it('gives members no implicit access and conceals the repo', async () => {
    expect(await status(`/api/v1/repos/${vault}`, as('member'))).toBe(404);
    expect(await git('member', vault, 'read')).toBe(404);
    expect(await git('member', vault, 'write')).toBe(404);
    expect(await status(`/${vault}`, as('member'))).toBe(404);
    expect(await status(`/api/v1/repos/${vault}`, as('outsider'))).toBe(404);
    expect(await git('outsider', vault, 'read')).toBe(404);
  });

  it('walks the read → write → admin grant matrix', async () => {
    expect((await grant(vault, 'member', 'read')).status).toBe(200);
    expect(await status(`/api/v1/repos/${vault}`, as('member'))).toBe(200);
    expect(await git('member', vault, 'read')).toBe(200);
    expect(await git('member', vault, 'write')).toBe(403);
    expect(await status(`/api/v1/repos/${vault}`, as('member', { method: 'PATCH', json: { description: 'x' } }))).toBe(403);

    expect((await grant(vault, 'member', 'write')).status).toBe(200);
    expect(await git('member', vault, 'write')).toBe(200);
    expect(await status(`/api/v1/repos/${vault}`, as('member', { method: 'PATCH', json: { visibility: 'public' } }))).toBe(403);
    expect(await status(`/api/v1/repos/${vault}/grants`, as('member'))).toBe(403);
    expect((await grant(vault, 'member', 'admin', 'member')).status).toBe(403);
    const unchanged = await body<{ repo: { visibility: string; description: string | null } }>(
      await call(`/api/v1/repos/${vault}`, as('owner')),
    );
    expect(unchanged.repo).toMatchObject({ visibility: 'private', description: null });

    expect((await grant(vault, 'member', 'admin')).status).toBe(200);
    const patched = await call(`/api/v1/repos/${vault}`, as('member', { method: 'PATCH', json: { description: 'by admin grant' } }));
    expect(patched.status).toBe(200);
    expect((await body<{ repo: { description: string } }>(patched)).repo.description).toBe('by admin grant');
    const list = await body<{ grants: { login: string; role: string }[] }>(await call(`/api/v1/repos/${vault}/grants`, as('member')));
    expect(list.grants).toContainEqual(expect.objectContaining({ login: logins.member, role: 'admin' }));
  });

  it('lets maintainers administer org repos without managing membership', async () => {
    expect(await status(`/api/v1/repos/${vault}`, as('maint'))).toBe(200);
    expect(await git('maint', vault, 'write')).toBe(200);
    expect(await status(`/api/v1/repos/${vault}`, as('maint', { method: 'PATCH', json: { description: 'maint' } }))).toBe(200);
    expect(await status(`/api/v1/repos/${vault}/grants`, as('maint'))).toBe(200);
    expect((await setRole('member', 'maintainer', 'maint')).status).toBe(403);
  });

  it('limits org repo grants to current members and validates targets', async () => {
    const res = await grant(vault, 'outsider', 'read');
    expect(res.status).toBe(422);
    expect(await body(res)).toMatchObject({ code: 'NOT_ORG_MEMBER' });
    const missing = await call(`/api/v1/repos/${vault}/grants/nobody-here`, as('owner', { method: 'PUT', json: { role: 'read' } }));
    expect(missing.status).toBe(404);
    expect(await status(`/api/v1/repos/${vault}/grants/${logins.member}`, as('owner', { method: 'PUT', json: { role: 'owner' } }))).toBe(400);
    expect(await status(`/api/v1/repos/${vault}`, as('outsider'))).toBe(404);
  });

  it('accepts personal-repo collaborators', async () => {
    const diary = `${logins.owner}/diary`;
    expect(await status(`/api/v1/repos/${diary}`, as('outsider'))).toBe(404);
    expect((await grant(diary, 'outsider', 'read')).status).toBe(200);
    expect(await status(`/api/v1/repos/${diary}`, as('outsider'))).toBe(200);
    expect(await git('outsider', diary, 'write')).toBe(403);
    expect(await status(`/api/v1/repos/${diary}/grants/${logins.outsider}`, as('owner', { method: 'DELETE' }))).toBe(200);
    expect(await status(`/api/v1/repos/${diary}`, as('outsider'))).toBe(404);
  });

  it('lists org repos according to the viewer', async () => {
    const names = async (init: RequestInit) =>
      (await body<{ repos: { name: string }[] }>(await call(`/api/v1/orgs/${ORG}/repos`, init))).repos.map((r) => r.name);
    expect(await names(as('maint'))).toEqual(expect.arrayContaining(['vault', 'lobby']));
    expect(await names(as('member'))).toEqual(expect.arrayContaining(['vault', 'lobby']));
    expect(await names(as('outsider'))).not.toContain('vault');
    expect(await names({})).not.toContain('vault');
    const page = await body<{ repos: unknown[]; nextCursor: string | null }>(
      await call(`/api/v1/orgs/${ORG}/repos?limit=1`, as('maint')),
    );
    expect(page.repos).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
  });
});

describe('revocation beats warmed state', () => {
  it('denies the next REST and git read after a grant is revoked', async () => {
    await seedRepo(ORG, 'warm-grant', 'private');
    const repo = `${ORG}/warm-grant`;
    expect((await grant(repo, 'member', 'read')).status).toBe(200);
    expect(await status(`/api/v1/repos/${repo}`, as('member'))).toBe(200);
    const warm = await call(`/api/v1/repos/${repo}`, as('member'));
    expect(warm.status).toBe(200);
    const warmCost = await costOf(warm);
    expect(warmCost).toMatchObject({ d1: 1, rw: 0, do: 0, art: 0 });
    expect(warmCost.rr).toBeLessThanOrEqual(8);
    expect(await git('member', repo, 'read')).toBe(200);

    expect(await body(await call(`/api/v1/repos/${repo}/grants/${logins.member}`, as('owner', { method: 'DELETE' })))).toEqual({ revoked: true });
    const denied = await call(`/api/v1/repos/${repo}`, as('member'));
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain('warm-grant');
    expect(await git('member', repo, 'read')).toBe(404);
    expect(await status(`/api/v1/repos/${repo}`, as('owner'))).toBe(200);
  });

  it('turns a write-grant downgrade into a write denial while reads continue', async () => {
    await seedRepo(ORG, 'downgrade', 'private');
    const repo = `${ORG}/downgrade`;
    expect((await grant(repo, 'member', 'write')).status).toBe(200);
    expect(await git('member', repo, 'write')).toBe(200);
    expect((await grant(repo, 'member', 'read')).status).toBe(200);
    expect(await git('member', repo, 'write')).toBe(403);
    expect(await git('member', repo, 'read')).toBe(200);
  });

  it('drops grants on org repos the moment membership ends', async () => {
    await seedRepo(ORG, 'leaver', 'private');
    const repo = `${ORG}/leaver`;
    expect((await setRole('coowner', 'member')).status).toBe(200);
    expect((await grant(repo, 'coowner', 'write')).status).toBe(200);
    expect(await status(`/api/v1/repos/${repo}`, as('coowner'))).toBe(200);
    // Membership row removed out of band: the grant lapses immediately.
    await env.DB.prepare(
      'DELETE FROM org_members WHERE user_id = (SELECT id FROM users WHERE login = ?) AND org_id = (SELECT id FROM orgs WHERE login = ?)',
    )
      .bind(logins.coowner, ORG)
      .run();
    expect(await status(`/api/v1/repos/${repo}`, as('coowner'))).toBe(404);
    expect(await git('coowner', repo, 'write')).toBe(404);
    // Re-added, then removed through the API: the grant row is cleaned up.
    expect((await setRole('coowner', 'member')).status).toBe(200);
    expect(await status(`/api/v1/orgs/${ORG}/members/${logins.coowner}`, as('owner', { method: 'DELETE' }))).toBe(200);
    expect((await setRole('coowner', 'member')).status).toBe(200);
    expect(await status(`/api/v1/repos/${repo}`, as('coowner'))).toBe(404);
  });

  it('cleans an owner’s grants on self-removal so rejoining as a member revives nothing', async () => {
    const org = 'acme-twins';
    const secret = `${org}/secret`;
    const notes = `${org}/notes`;
    const member = (who: Who, role: string, by: Who) =>
      call(`/api/v1/orgs/${org}/members/${logins[who]}`, as(by, { method: 'PUT', json: { role } }));
    const remove = (who: Who, by: Who) => call(`/api/v1/orgs/${org}/members/${logins[who]}`, as(by, { method: 'DELETE' }));
    const grantsOf = async (who: Who) =>
      (
        await env.DB.prepare(
          `SELECT g.role FROM repo_grants g JOIN repos r ON r.id = g.repo_id JOIN users u ON u.id = g.user_id
            WHERE r.owner_login = ? AND u.login = ? ORDER BY r.name`,
        )
          .bind(org, logins[who])
          .all<{ role: string }>()
      ).results.map((r) => r.role);

    expect(await status('/api/v1/orgs', as('twinA', { method: 'POST', json: { login: org } }))).toBe(201);
    expect((await member('twinB', 'owner', 'twinA')).status).toBe(200);
    expect((await member('twinM', 'member', 'twinA')).status).toBe(200);
    await seedRepo(org, 'secret', 'private');
    await seedRepo(org, 'notes', 'private');
    expect((await grant(secret, 'twinA', 'admin', 'twinB')).status).toBe(200);
    expect((await grant(notes, 'twinA', 'write', 'twinB')).status).toBe(200);
    expect((await grant(secret, 'twinB', 'admin', 'twinA')).status).toBe(200);
    expect(await grantsOf('twinA')).toEqual(['write', 'admin']);

    // A rejected removal deletes nothing.
    const forbidden = await remove('twinA', 'twinM');
    expect(forbidden.status).toBe(403);
    expect(await body(forbidden)).toMatchObject({ code: 'FORBIDDEN' });
    expect(await grantsOf('twinA')).toEqual(['write', 'admin']);

    // Two owners: the acting owner may remove themselves, and their grants go with them.
    const left = await remove('twinA', 'twinA');
    expect(left.status).toBe(200);
    expect(await body(left)).toEqual({ removed: true });
    expect(await grantsOf('twinA')).toEqual([]);
    expect(await status(`/api/v1/repos/${secret}`, as('twinA'))).toBe(404);
    expect(await git('twinA', secret, 'read')).toBe(404);
    expect(await git('twinA', notes, 'write')).toBe(404);

    // Re-added as a plain member: no prior read/write/admin authority returns.
    expect((await member('twinA', 'member', 'twinB')).status).toBe(200);
    expect(await grantsOf('twinA')).toEqual([]);
    expect(await status(`/api/v1/repos/${secret}`, as('twinA'))).toBe(404);
    expect(await git('twinA', secret, 'read')).toBe(404);
    expect(await git('twinA', notes, 'write')).toBe(404);
    expect(await status(`/api/v1/repos/${secret}`, as('twinA', { method: 'PATCH', json: { description: 'x' } }))).toBe(404);
    expect(await status(`/api/v1/repos/${secret}/grants`, as('twinA'))).toBe(404);
    const listed = await body<{ grants: { login: string }[] }>(await call(`/api/v1/repos/${secret}/grants`, as('twinB')));
    expect(listed.grants.map((g) => g.login)).not.toContain(logins.twinA);

    // A fresh grant works normally.
    expect((await grant(secret, 'twinA', 'read', 'twinB')).status).toBe(200);
    expect(await status(`/api/v1/repos/${secret}`, as('twinA'))).toBe(200);
    expect(await git('twinA', secret, 'read')).toBe(200);
    expect(await git('twinA', secret, 'write')).toBe(403);
    expect(await git('twinA', notes, 'read')).toBe(404);

    // The survivor is now the last owner: self-removal and demotion stay rejected, grants intact.
    const last = await remove('twinB', 'twinB');
    expect(last.status).toBe(409);
    expect(await body(last)).toMatchObject({ code: 'LAST_OWNER' });
    const demote = await member('twinB', 'member', 'twinB');
    expect(demote.status).toBe(409);
    expect(await body(demote)).toMatchObject({ code: 'LAST_OWNER' });
    expect(await grantsOf('twinB')).toEqual(['admin']);
    expect((await body(await call(`/api/v1/orgs/${org}`, as('twinB')))).viewerRole).toBe('owner');
  });

  it('cleans the same grants when removal names the org in mixed case', async () => {
    const org = 'acme-cased';
    const spelled = 'Acme-CASED';
    const secret = `${org}/secret`;
    const notes = `${org}/notes`;
    const member = (who: Who, role: string, by: Who, path = org) =>
      call(`/api/v1/orgs/${path}/members/${logins[who]}`, as(by, { method: 'PUT', json: { role } }));
    const remove = (who: Who, by: Who, path = spelled) =>
      call(`/api/v1/orgs/${path}/members/${logins[who]}`, as(by, { method: 'DELETE' }));
    const grantsOf = async (who: Who) =>
      (
        await env.DB.prepare(
          `SELECT g.role FROM repo_grants g JOIN repos r ON r.id = g.repo_id JOIN users u ON u.id = g.user_id
            WHERE r.owner_login = ? AND u.login = ? ORDER BY r.name`,
        )
          .bind(org, logins[who])
          .all<{ role: string }>()
      ).results.map((r) => r.role);
    const deniedEverywhere = async (who: Who) => {
      expect(await grantsOf(who)).toEqual([]);
      expect(await status(`/api/v1/repos/${secret}`, as(who))).toBe(404);
      expect(await git(who, secret, 'read')).toBe(404);
      expect(await git(who, notes, 'write')).toBe(404);
      expect(await status(`/api/v1/repos/${secret}`, as(who, { method: 'PATCH', json: { description: 'x' } }))).toBe(404);
      expect(await status(`/api/v1/repos/${secret}/grants`, as(who))).toBe(404);
    };

    expect(await status('/api/v1/orgs', as('twinA', { method: 'POST', json: { login: org } }))).toBe(201);
    expect((await member('twinB', 'owner', 'twinA')).status).toBe(200);
    expect((await member('twinM', 'member', 'twinA')).status).toBe(200);
    await seedRepo(org, 'secret', 'private');
    await seedRepo(org, 'notes', 'private');
    expect((await grant(secret, 'twinA', 'admin', 'twinB')).status).toBe(200);
    expect((await grant(notes, 'twinA', 'write', 'twinB')).status).toBe(200);
    expect((await grant(secret, 'twinM', 'admin', 'twinB')).status).toBe(200);
    expect((await grant(notes, 'twinM', 'write', 'twinB')).status).toBe(200);
    expect((await grant(secret, 'twinB', 'admin', 'twinA')).status).toBe(200);

    // A rejected mixed-case removal deletes nothing.
    expect((await remove('twinA', 'twinM')).status).toBe(403);
    expect(await grantsOf('twinA')).toEqual(['write', 'admin']);

    // Owner self-removal through a mixed-case path.
    const left = await remove('twinA', 'twinA');
    expect(left.status).toBe(200);
    expect(await body(left)).toEqual({ removed: true });
    await deniedEverywhere('twinA');
    expect((await member('twinA', 'member', 'twinB')).status).toBe(200);
    await deniedEverywhere('twinA');

    // Ordinary owner-removes-member through another mixed-case spelling.
    expect((await remove('twinM', 'twinB', 'ACME-cased')).status).toBe(200);
    await deniedEverywhere('twinM');
    expect((await member('twinM', 'member', 'twinB')).status).toBe(200);
    await deniedEverywhere('twinM');

    // Fresh grants work normally.
    expect((await grant(secret, 'twinA', 'read', 'twinB')).status).toBe(200);
    expect(await status(`/api/v1/repos/${secret}`, as('twinA'))).toBe(200);
    expect(await git('twinA', secret, 'read')).toBe(200);
    expect(await git('twinA', secret, 'write')).toBe(403);
    expect((await grant(notes, 'twinM', 'write', 'twinB')).status).toBe(200);
    expect(await git('twinM', notes, 'write')).toBe(200);
    expect(await git('twinM', secret, 'read')).toBe(404);

    // The survivor is the last owner: mixed-case self-removal and demotion stay rejected, grants intact.
    const last = await remove('twinB', 'twinB');
    expect(last.status).toBe(409);
    expect(await body(last)).toMatchObject({ code: 'LAST_OWNER' });
    const demote = await member('twinB', 'member', 'twinB', spelled);
    expect(demote.status).toBe(409);
    expect(await body(demote)).toMatchObject({ code: 'LAST_OWNER' });
    expect(await grantsOf('twinB')).toEqual(['admin']);
    expect((await body(await call(`/api/v1/orgs/${org}`, as('twinB')))).viewerRole).toBe('owner');
  });

  it('denies a warmed public read right after the repo becomes private', async () => {
    const repo = `${ORG}/flip`;
    expect(await status(`/api/v1/repos/${repo}`, as('outsider'))).toBe(200);
    const warm = await call(`/api/v1/repos/${repo}`, as('outsider'));
    expect(await costOf(warm)).toMatchObject({ d1: 1, rw: 0, do: 0 });
    expect(await git('outsider', repo, 'read')).toBe(200);
    expect(await status(`/api/v1/repos/${repo}`, as('maint', { method: 'PATCH', json: { visibility: 'private' } }))).toBe(200);
    expect(await status(`/api/v1/repos/${repo}`, as('outsider'))).toBe(404);
    expect(await git('outsider', repo, 'read')).toBe(404);
    expect(await git(null, repo, 'read')).toBe(401);
    expect(await status(`/api/v1/repos/${repo}`, as('maint'))).toBe(200);
  });

  it('keeps a still-authorized private personal read within the bounded budget', async () => {
    const repo = `${logins.owner}/diary`;
    await call(`/api/v1/repos/${repo}`, as('owner')).then((r) => r.body?.cancel());
    const warm = await call(`/api/v1/repos/${repo}`, as('owner'));
    expect(warm.status).toBe(200);
    const cost = await costOf(warm);
    expect(cost).toMatchObject({ d1: 1, rw: 0, do: 0, art: 0 });
    expect(cost.rr).toBeLessThanOrEqual(8);
  });
});
