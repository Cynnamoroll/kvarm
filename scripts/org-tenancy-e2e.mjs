#!/usr/bin/env node
/**
 * Live validation driver for organization tenancy (VAL-ORG-001, VAL-ORG-002,
 * VAL-ORG-003, VAL-ACCESS-003, VAL-COST-021). Creates its own orgs and repos
 * named `org-tenancy-*-<ts>` / `org-self-rm*-<ts>`, walks the role/grant
 * matrix and the owner self-removal lifecycle over REST, the repo page and
 * git, and deletes its repos at the end (orgs have no delete API and are left
 * as inert test data).
 *
 * Principals come from env vars by NAME (load apps/platform/.dev.vars.validation):
 *   FORGE_PAT_BOT (org owner, non-admin), FORGE_PAT_MAINT, FORGE_PAT_MEMBER,
 *   FORGE_PAT_OUTSIDER. Tokens are never printed; git runs with
 *   `-c credential.helper=` and a secret-free GIT_ASKPASS helper.
 *
 * Usage: node scripts/org-tenancy-e2e.mjs [--keep]
 * Exit code 0 when every expectation held, 1 otherwise.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.FORGE_BASE_URL ?? 'https://forge-platform.cynnamoroll.workers.dev';
const KEEP = process.argv.includes('--keep');
const P = { owner: 'FORGE_PAT_BOT', maint: 'FORGE_PAT_MAINT', member: 'FORGE_PAT_MEMBER', outsider: 'FORGE_PAT_OUTSIDER' };
for (const k of Object.values(P)) if (!process.env[k]) throw new Error(`env ${k} is not set`);
const LOGIN = { owner: 'forge-bot', maint: 'forge-org-maint', member: 'forge-org-member', outsider: 'forge-outsider' };

const ts = Date.now();
const ORG = `org-tenancy-e2e-${ts}`;
const MATRIX = `org-tenancy-matrix-${ts}`;
const FLIP = `org-tenancy-flip-${ts}`;
const PERSONAL = `org-tenancy-personal-${ts}`;
const SELF_ORG = `org-self-rm-${ts}`;
const SELF_REPO = `org-self-removal-${ts}`;
const probeScript = fileURLToPath(new URL('./receive-pack-probe.mjs', import.meta.url));

const results = [];
function check(label, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
  results.push({ ok, label });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  -> ${typeof actual === 'string' ? actual : JSON.stringify(actual)}`);
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(who, method, path, json) {
  const headers = {};
  if (who) headers.Authorization = `Bearer ${process.env[P[who]]}`;
  if (json !== undefined) headers['content-type'] = 'application/json';
  const init = { method, headers };
  if (json !== undefined) init.body = JSON.stringify(json);
  const res = await fetch(`${BASE}/api/v1${path}`, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, text, cost: res.headers.get('x-forge-cost') };
}

async function raw(who, path) {
  const headers = who ? { Authorization: `Basic ${Buffer.from(`x:${process.env[P[who]]}`).toString('base64')}` } : {};
  const res = await fetch(`${BASE}${path}`, { headers, redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, text, cost: res.headers.get('x-forge-cost') };
}

async function page(who, path) {
  const headers = who ? { Authorization: `Bearer ${process.env[P[who]]}` } : {};
  const res = await fetch(`${BASE}${path}`, { headers, redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, text };
}

const work = mkdtempSync(join(tmpdir(), 'org-tenancy-'));
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv FORGE_E2E_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);

function git(who, args, cwd = work) {
  const env = { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', FORGE_E2E_TOKEN: who ? process.env[P[who]] : '' };
  const r = spawnSync('git', ['-c', 'credential.helper=', ...args], { cwd, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

function lsRemote(who, repo) {
  const r = git(who, ['ls-remote', `${BASE}/${repo}.git`]);
  return { code: r.code, refs: r.code === 0 ? r.out.split('\n').filter(Boolean).length : 0 };
}

function commit(dir, file, content) {
  writeFileSync(join(dir, file), content);
  git(null, ['add', file], dir);
  git(null, ['-c', 'user.name=org-tenancy-e2e', '-c', 'user.email=e2e@forge.invalid', 'commit', '-q', '-m', `${file}: ${content.trim()}`], dir);
  return git(null, ['rev-parse', 'HEAD'], dir).out;
}

/** Owner's receive-pack advertisement: write-gated and never edge-cached. */
async function ownerRef(repo, ref) {
  const r = await raw('owner', `/${repo}.git/info/refs?service=git-receive-pack`);
  const m = r.text.match(new RegExp(`([0-9a-f]{40}) ${ref.replace(/\//g, '\\/')}`));
  return m ? m[1] : null;
}

function probe(who, repo, ref, workdir, sha) {
  const r = spawnSync(process.execPath, [probeScript, '--repo', repo, '--ref', ref, '--workdir', workdir, '--new', sha, '--as', P[who], '--owner', P.owner], {
    encoding: 'utf8',
    env: process.env,
  });
  const last = r.stdout.trim().split('\n').pop() ?? '{}';
  const httpLine = r.stdout.split('\n').find((l) => l.startsWith('actor receive-pack POST')) ?? '';
  try {
    return { ...JSON.parse(last), http: httpLine.replace('actor receive-pack POST: ', '') };
  } catch {
    return { error: r.stderr.trim() || r.stdout.trim() };
  }
}

async function pushWithRetry(who, dir, refspec) {
  for (let i = 0; i < 10; i++) {
    const r = git(who, ['push', '-q', 'origin', refspec], dir);
    if (r.code === 0 || !/503|warming/i.test(r.err)) return r;
    await sleep(3000);
  }
  return git(who, ['push', '-q', 'origin', refspec], dir);
}

function costField(cost, key) {
  const m = cost?.match(new RegExp(`(?:^|;)${key}=([^;]+)`));
  return m ? m[1] : null;
}

try {
  console.log(`# org ${ORG}; repos ${MATRIX}, ${FLIP}, ${LOGIN.owner}/${PERSONAL}`);

  // --- Namespace and org creation (VAL-ORG-001) ---
  const clash = await api('outsider', 'POST', '/orgs', { login: LOGIN.owner });
  check('org login equal to an existing user login is rejected', `${clash.status} ${clash.body?.code}`, '409 NAMESPACE_TAKEN');
  const created = await api('owner', 'POST', '/orgs', { login: ORG, name: 'org-tenancy e2e' });
  check('non-admin human creates org and becomes owner', `${created.status} ${created.body?.role}`, '201 owner');
  const dup = await api('outsider', 'POST', '/orgs', { login: ORG });
  check('duplicate org login is rejected', `${dup.status} ${dup.body?.code}`, '409 NAMESPACE_TAKEN');

  for (const [who, role] of [['maint', 'maintainer'], ['member', 'member']]) {
    const r = await api('owner', 'PUT', `/orgs/${ORG}/members/${LOGIN[who]}`, { role });
    check(`owner adds ${LOGIN[who]} as ${role}`, `${r.status} ${r.body?.member?.role}`, `200 ${role}`);
  }
  for (const who of ['maint', 'member', 'outsider']) {
    const put = await api(who, 'PUT', `/orgs/${ORG}/members/${LOGIN.member}`, { role: 'maintainer' });
    check(`${who} cannot change membership roles`, `${put.status} ${put.body?.code}`, '403 FORBIDDEN');
    const del = await api(who, 'DELETE', `/orgs/${ORG}/members/${LOGIN.member}`);
    check(`${who} cannot remove members`, `${del.status} ${del.body?.code}`, '403 FORBIDDEN');
  }
  const demote = await api('owner', 'PUT', `/orgs/${ORG}/members/${LOGIN.owner}`, { role: 'member' });
  check('last owner cannot be demoted', `${demote.status} ${demote.body?.code}`, '409 LAST_OWNER');
  const remove = await api('owner', 'DELETE', `/orgs/${ORG}/members/${LOGIN.owner}`);
  check('last owner cannot be removed', `${remove.status} ${remove.body?.code}`, '409 LAST_OWNER');
  const members = await api('owner', 'GET', `/orgs/${ORG}/members`);
  check(
    'member list shows the surviving owner and assigned roles',
    (members.body?.members ?? []).map((m) => `${m.login}:${m.role}`).sort().join(','),
    [`${LOGIN.maint}:maintainer`, `${LOGIN.member}:member`, `${LOGIN.owner}:owner`].sort().join(','),
  );
  // Role change verified through its effect: a temporary owner can manage, then cannot after demotion.
  await api('owner', 'PUT', `/orgs/${ORG}/members/${LOGIN.outsider}`, { role: 'owner' });
  const asOwner = await api('outsider', 'PUT', `/orgs/${ORG}/members/${LOGIN.member}`, { role: 'member' });
  check('promoted owner can manage membership', asOwner.status, 200);
  await api('owner', 'DELETE', `/orgs/${ORG}/members/${LOGIN.outsider}`);
  const afterRemoval = await api('outsider', 'PUT', `/orgs/${ORG}/members/${LOGIN.member}`, { role: 'member' });
  check('removed former owner can no longer manage membership', `${afterRemoval.status} ${afterRemoval.body?.code}`, '403 FORBIDDEN');

  // --- Org repos ---
  const memberCreate = await api('member', 'POST', `/orgs/${ORG}/repos`, { name: `${MATRIX}-x` });
  check('plain member cannot create org repos', `${memberCreate.status} ${memberCreate.body?.code}`, '403 FORBIDDEN');
  const mk = await api('maint', 'POST', `/orgs/${ORG}/repos`, { name: MATRIX, visibility: 'private' });
  check('maintainer creates a private org repo', `${mk.status} ${mk.body?.repo?.owner}/${mk.body?.repo?.visibility}`, `201 ${ORG}/private`);
  const mkFlip = await api('maint', 'POST', `/orgs/${ORG}/repos`, { name: FLIP, visibility: 'public' });
  check('maintainer creates a public org repo', mkFlip.status, 201);
  const mkPersonal = await api('owner', 'POST', '/repos', { name: PERSONAL, visibility: 'private' });
  check('personal private repo created', mkPersonal.status, 201);

  const repo = `${ORG}/${MATRIX}`;
  const local = join(work, 'matrix');
  git(null, ['init', '-q', '-b', 'main', local]);
  git(null, ['remote', 'add', 'origin', `${BASE}/${repo}.git`], local);
  commit(local, 'marker.txt', `org-tenancy marker ${ts}\n`);
  const pushMain = await pushWithRetry('owner', local, 'HEAD:refs/heads/main');
  const pushProbe = await pushWithRetry('owner', local, 'HEAD:refs/heads/authz-probe');
  check('org owner pushes main and authz-probe', `${pushMain.code}/${pushProbe.code}`, '0/0');
  const flipLocal = join(work, 'flip');
  git(null, ['init', '-q', '-b', 'main', flipLocal]);
  git(null, ['remote', 'add', 'origin', `${BASE}/${ORG}/${FLIP}.git`], flipLocal);
  commit(flipLocal, 'public.txt', `formerly public ${ts}\n`);
  check('maintainer pushes the public repo', (await pushWithRetry('maint', flipLocal, 'HEAD:refs/heads/main')).code, 0);

  // --- Grant matrix (VAL-ORG-002) ---
  const probeRef = 'refs/heads/authz-probe';
  for (const who of ['member', 'outsider']) {
    check(`${who} without grant: REST read concealed`, (await api(who, 'GET', `/repos/${repo}`)).status, 404);
    check(`${who} without grant: page concealed`, (await page(who, `/${repo}`)).status, 404);
    check(`${who} without grant: git ls-remote denied`, lsRemote(who, repo).refs, 0);
    check(`${who} without grant: info/refs`, (await raw(who, `/${repo}.git/info/refs?service=git-upload-pack`)).status, 404);
  }
  const before = await ownerRef(repo, probeRef);
  const deniedSha = commit(local, 'denied.txt', `must not land ${ts}\n`);
  const p0 = probe('member', repo, probeRef, local, deniedSha);
  check('member without grant: receive-pack denied, ref unchanged', `${p0.http} accepted=${p0.accepted} moved=${p0.refMoved}`, (v) => v.includes('accepted=false moved=false'));
  check('authz-probe readback equals the pre-probe ref', await ownerRef(repo, probeRef), before);

  const outsiderGrant = await api('owner', 'PUT', `/repos/${repo}/grants/${LOGIN.outsider}`, { role: 'read' });
  check('grant to a non-member on an org repo is rejected', `${outsiderGrant.status} ${outsiderGrant.body?.code}`, '422 NOT_ORG_MEMBER');

  check('owner grants member read', (await api('owner', 'PUT', `/repos/${repo}/grants/${LOGIN.member}`, { role: 'read' })).body?.grant?.role, 'read');
  check('read grant: REST read', (await api('member', 'GET', `/repos/${repo}`)).status, 200);
  const pg = await page('member', `/${repo}`);
  check('read grant: page read shows marker file', `${pg.status} ${pg.text.includes('marker.txt')}`, '200 true');
  check('read grant: git ls-remote', lsRemote('member', repo).refs, (n) => n >= 2);
  const p1 = probe('member', repo, probeRef, local, deniedSha);
  check('read grant: receive-pack denied, ref unchanged', `${p1.http} accepted=${p1.accepted} moved=${p1.refMoved}`, (v) => v.includes('403') && v.includes('accepted=false moved=false'));
  const rp = await api('member', 'PATCH', `/repos/${repo}`, { description: 'read grant edit' });
  check('read grant: repo settings change denied', `${rp.status} ${rp.body?.code}`, '403 FORBIDDEN');

  check('owner upgrades member to write', (await api('owner', 'PUT', `/repos/${repo}/grants/${LOGIN.member}`, { role: 'write' })).body?.grant?.role, 'write');
  git(null, ['reset', '-q', '--hard', 'HEAD~1'], local);
  const writeSha = commit(local, 'write.txt', `write grant ${ts}\n`);
  const wp = git('member', ['push', '-q', 'origin', `HEAD:${probeRef}`], local);
  check('write grant: git push accepted and ref readback matches', `${wp.code} ${(await ownerRef(repo, probeRef)) === writeSha}`, '0 true');
  const wv = await api('member', 'PATCH', `/repos/${repo}`, { visibility: 'public' });
  check('write grant: visibility change denied', `${wv.status} ${wv.body?.code}`, '403 FORBIDDEN');
  const wg = await api('member', 'PUT', `/repos/${repo}/grants/${LOGIN.member}`, { role: 'admin' });
  check('write grant: self-escalation to admin denied', `${wg.status} ${wg.body?.code}`, '403 FORBIDDEN');
  const settings = (await api('owner', 'GET', `/repos/${repo}`)).body?.repo;
  check('denials left repo settings unchanged', `${settings?.visibility} ${settings?.description}`, 'private null');

  check('owner upgrades member to admin', (await api('owner', 'PUT', `/repos/${repo}/grants/${LOGIN.member}`, { role: 'admin' })).body?.grant?.role, 'admin');
  const ap = await api('member', 'PATCH', `/repos/${repo}`, { description: 'admin grant edit' });
  check('admin grant: repo settings change allowed', `${ap.status} ${ap.body?.repo?.description}`, '200 admin grant edit');
  check('admin grant: grant list allowed', (await api('member', 'GET', `/repos/${repo}/grants`)).status, 200);

  const mp = await api('maint', 'PATCH', `/repos/${repo}`, { description: 'maintainer edit' });
  check('maintainer administers org repo', `${mp.status} ${mp.body?.repo?.description}`, '200 maintainer edit');
  check('maintainer git read', lsRemote('maint', repo).refs, (n) => n >= 2);
  check('outsider still denied after grants to others', (await api('outsider', 'GET', `/repos/${repo}`)).status, 404);

  const list = async (who) => ((await api(who, 'GET', `/orgs/${ORG}/repos`)).body?.repos ?? []).map((r) => r.name).sort().join(',');
  check('org repo list for member (granted private + public)', await list('member'), [FLIP, MATRIX].sort().join(','));
  check('org repo list for outsider (public only)', await list('outsider'), FLIP);

  // --- Revocation beats warmed private reads (VAL-ACCESS-003, VAL-COST-021) ---
  await api('owner', 'PUT', `/repos/${repo}/grants/${LOGIN.member}`, { role: 'read' });
  await api('member', 'GET', `/repos/${repo}`);
  const warmOrg = await api('member', 'GET', `/repos/${repo}`);
  check('warm org private read (member, read grant)', `${warmOrg.status} ${warmOrg.cost}`, (v) => v.startsWith('200 '));
  check('warm org private read cost d1<=2', Number(costField(warmOrg.cost, 'd1')), (n) => n <= 2);
  check('warm org private read cost rr<=8', Number(costField(warmOrg.cost, 'rr')), (n) => n <= 8);
  check('warm org private read cost do=0 art=0', `${costField(warmOrg.cost, 'do')}/${costField(warmOrg.cost, 'art')}`, '0/0');
  check('warm member git read before revoke', lsRemote('member', repo).refs, (n) => n >= 2);
  await raw('member', `/${repo}.git/info/refs?service=git-upload-pack`);
  const warmGit = await raw('member', `/${repo}.git/info/refs?service=git-upload-pack`);
  check('warm private git info/refs cost d1<=2 rr<=8 do=0', `${warmGit.status} ${warmGit.cost}`, (v) =>
    v.startsWith('200 ') && Number(costField(v, 'd1')) <= 2 && Number(costField(v, 'rr')) <= 8 && costField(v, 'do') === '0');
  const revoke = await api('owner', 'DELETE', `/repos/${repo}/grants/${LOGIN.member}`);
  check('owner revokes the read grant', `${revoke.status} ${revoke.body?.revoked}`, '200 true');
  const afterRevoke = await api('member', 'GET', `/repos/${repo}`);
  check('first REST read after revoke is concealed, no warmed body', `${afterRevoke.status} ${afterRevoke.text.includes(MATRIX)} ${afterRevoke.cost}`, (v) => v.startsWith('404 false'));
  check('first page read after revoke is concealed', (await page('member', `/${repo}`)).status, 404);
  const gitAfterRevoke = await raw('member', `/${repo}.git/info/refs?service=git-upload-pack`);
  check('first git info/refs after revoke is concealed', `${gitAfterRevoke.status} ${gitAfterRevoke.cost}`, (v) => v.startsWith('404 '));
  check('first git ls-remote after revoke discloses no refs', lsRemote('member', repo).refs, 0);
  check('owner still reads after revoke', (await api('owner', 'GET', `/repos/${repo}`)).status, 200);

  await api('owner', 'PUT', `/repos/${repo}/grants/${LOGIN.member}`, { role: 'write' });
  const preDown = await ownerRef(repo, probeRef);
  const downSha = commit(local, 'downgrade.txt', `must not land after downgrade ${ts}\n`);
  await api('owner', 'PUT', `/repos/${repo}/grants/${LOGIN.member}`, { role: 'read' });
  const p2 = probe('member', repo, probeRef, local, downSha);
  check('write→read downgrade: next push denied, ref unchanged', `${p2.http} accepted=${p2.accepted} moved=${p2.refMoved}`, (v) => v.includes('403') && v.includes('accepted=false moved=false'));
  check('write→read downgrade: read still allowed', lsRemote('member', repo).refs, (n) => n >= 2);
  check('authz-probe ref unchanged across denials', await ownerRef(repo, probeRef), preDown);

  const flipRepo = `${ORG}/${FLIP}`;
  await api('outsider', 'GET', `/repos/${flipRepo}`);
  const warmPublic = await api('outsider', 'GET', `/repos/${flipRepo}`);
  check('warm public read by unrelated principal runs the authority lookup', `${warmPublic.status} d1=${costField(warmPublic.cost, 'd1')}`, '200 d1=1');
  check('unrelated principal git read of public repo', lsRemote('outsider', flipRepo).refs, (n) => n >= 1);
  const vis = await api('maint', 'PATCH', `/repos/${flipRepo}`, { visibility: 'private' });
  check('maintainer makes the public repo private', `${vis.status} ${vis.body?.repo?.visibility}`, '200 private');
  const afterVis = await api('outsider', 'GET', `/repos/${flipRepo}`);
  check('first REST read after visibility change is concealed', `${afterVis.status} ${afterVis.text.includes(FLIP)}`, '404 false');
  check('first git ls-remote after visibility change discloses no refs', lsRemote('outsider', flipRepo).refs, 0);
  check('anonymous info/refs after visibility change is challenged', (await raw(null, `/${flipRepo}.git/info/refs?service=git-upload-pack`)).status, 401);
  check('maintainer still reads after visibility change', (await api('maint', 'GET', `/repos/${flipRepo}`)).status, 200);

  const personal = `${LOGIN.owner}/${PERSONAL}`;
  await api('owner', 'GET', `/repos/${personal}`);
  const warmPersonal = await api('owner', 'GET', `/repos/${personal}`);
  check('warm personal private read', warmPersonal.status, 200);
  check('warm personal private read cost d1<=2 rr<=8 do=0 art=0', warmPersonal.cost, (c) =>
    Number(costField(c, 'd1')) <= 2 && Number(costField(c, 'rr')) <= 8 && costField(c, 'do') === '0' && costField(c, 'art') === '0');
  console.log(`# cost warm org private (member grant): ${warmOrg.cost}`);
  console.log(`# cost warm personal private (owner):   ${warmPersonal.cost}`);
  console.log(`# cost first denial after revoke:       ${afterRevoke.cost}`);
  console.log(`# cost warm private git info/refs:      ${warmGit.cost}`);
  console.log(`# cost git denial after revoke:         ${gitAfterRevoke.cost}`);

  // --- Owner self-removal cleans grants; rejoining revives nothing (VAL-ORG-003) ---
  // forge-bot and forge-org-member co-own SELF_ORG; forge-org-member holds an explicit
  // admin grant on its private repo and removes themselves.
  console.log(`# self-removal org ${SELF_ORG}; repo ${SELF_ORG}/${SELF_REPO}`);
  const selfRepo = `${SELF_ORG}/${SELF_REPO}`;
  const leaver = LOGIN.member;
  check('owner creates the self-removal org', (await api('owner', 'POST', '/orgs', { login: SELF_ORG })).status, 201);
  const coOwner = await api('owner', 'PUT', `/orgs/${SELF_ORG}/members/${leaver}`, { role: 'owner' });
  check(`${leaver} added as second owner`, `${coOwner.status} ${coOwner.body?.member?.role}`, '200 owner');
  const plain = await api('owner', 'PUT', `/orgs/${SELF_ORG}/members/${LOGIN.maint}`, { role: 'member' });
  check(`${LOGIN.maint} added as plain member`, `${plain.status} ${plain.body?.member?.role}`, '200 member');
  const mkSelf = await api('owner', 'POST', `/orgs/${SELF_ORG}/repos`, { name: SELF_REPO, visibility: 'private' });
  check('private self-removal repo created', `${mkSelf.status} ${mkSelf.body?.repo?.visibility}`, '201 private');
  const selfLocal = join(work, 'self');
  git(null, ['init', '-q', '-b', 'main', selfLocal]);
  git(null, ['remote', 'add', 'origin', `${BASE}/${selfRepo}.git`], selfLocal);
  commit(selfLocal, 'marker.txt', `self-removal marker ${ts}\n`);
  const sMain = await pushWithRetry('owner', selfLocal, 'HEAD:refs/heads/main');
  const sProbe = await pushWithRetry('owner', selfLocal, `HEAD:${probeRef}`);
  check('owner pushes main and authz-probe to the self-removal repo', `${sMain.code}/${sProbe.code}`, '0/0');
  const ga = await api('owner', 'PUT', `/repos/${selfRepo}/grants/${leaver}`, { role: 'admin' });
  check(`explicit admin grant to co-owner ${leaver}`, `${ga.status} ${ga.body?.grant?.role}`, '200 admin');
  const gm = await api('owner', 'PUT', `/repos/${selfRepo}/grants/${LOGIN.maint}`, { role: 'write' });
  check(`explicit write grant to member ${LOGIN.maint}`, `${gm.status} ${gm.body?.grant?.role}`, '200 write');
  const twoOwners = await api('owner', 'GET', `/orgs/${SELF_ORG}/members`);
  check(
    'two-owner state',
    (twoOwners.body?.members ?? []).map((m) => `${m.login}:${m.role}`).sort().join(','),
    [`${LOGIN.maint}:member`, `${leaver}:owner`, `${LOGIN.owner}:owner`].sort().join(','),
  );
  check('co-owner reads the private repo before leaving', lsRemote('member', selfRepo).refs, (n) => n >= 2);

  for (const who of ['outsider', 'maint']) {
    const r = await api(who, 'DELETE', `/orgs/${SELF_ORG}/members/${LOGIN.maint}`);
    check(`${who} cannot remove ${LOGIN.maint}`, `${r.status} ${r.body?.code}`, '403 FORBIDDEN');
  }
  check('rejected removals left the member write grant effective', lsRemote('maint', selfRepo).refs, (n) => n >= 2);

  const selfRemove = await api('member', 'DELETE', `/orgs/${SELF_ORG}/members/${leaver}`);
  check('co-owner removes themselves (another owner remains)', `${selfRemove.status} ${selfRemove.text}`, '200 {"removed":true}');
  const afterSelf = await api('owner', 'GET', `/orgs/${SELF_ORG}/members`);
  check(
    'membership after self-removal',
    (afterSelf.body?.members ?? []).map((m) => `${m.login}:${m.role}`).sort().join(','),
    [`${LOGIN.maint}:member`, `${LOGIN.owner}:owner`].sort().join(','),
  );
  const leftGrants = async () =>
    ((await api('owner', 'GET', `/repos/${selfRepo}/grants`)).body?.grants ?? []).map((g) => `${g.login}:${g.role}`).sort().join(',');
  check('self-removal deleted the leaver’s explicit grant', await leftGrants(), `${LOGIN.maint}:write`);

  const selfBefore = await ownerRef(selfRepo, probeRef);
  const leaverSha = commit(selfLocal, 'leaver.txt', `must not land ${ts}\n`);
  const deniedChecks = async (phase) => {
    const r = await api('member', 'GET', `/repos/${selfRepo}`);
    check(`${phase}: REST read concealed`, `${r.status} ${r.text.includes(SELF_REPO)}`, '404 false');
    check(`${phase}: page concealed`, (await page('member', `/${selfRepo}`)).status, 404);
    check(`${phase}: git info/refs concealed`, (await raw('member', `/${selfRepo}.git/info/refs?service=git-upload-pack`)).status, 404);
    check(`${phase}: git ls-remote discloses no refs`, lsRemote('member', selfRepo).refs, 0);
    const p = probe('member', selfRepo, probeRef, selfLocal, leaverSha);
    check(`${phase}: receive-pack denied, ref unchanged`, `${p.http} accepted=${p.accepted} moved=${p.refMoved}`, (v) => v.includes('accepted=false moved=false'));
    const pa = await api('member', 'PATCH', `/repos/${selfRepo}`, { description: 'stale admin' });
    check(`${phase}: admin settings change denied`, pa.status, 404);
    check(`${phase}: grant list denied`, (await api('member', 'GET', `/repos/${selfRepo}/grants`)).status, 404);
  };
  await deniedChecks('after self-removal');

  const rejoin = await api('owner', 'PUT', `/orgs/${SELF_ORG}/members/${leaver}`, { role: 'member' });
  check('former owner re-added as plain member', `${rejoin.status} ${rejoin.body?.member?.role}`, '200 member');
  check('re-add revived no grant', await leftGrants(), `${LOGIN.maint}:write`);
  await deniedChecks('rejoined as member');

  const fresh = await api('owner', 'PUT', `/repos/${selfRepo}/grants/${leaver}`, { role: 'read' });
  check('fresh read grant after rejoin', `${fresh.status} ${fresh.body?.grant?.role}`, '200 read');
  check('fresh grant: REST read', (await api('member', 'GET', `/repos/${selfRepo}`)).status, 200);
  check('fresh grant: git ls-remote', lsRemote('member', selfRepo).refs, (n) => n >= 2);
  const pf = probe('member', selfRepo, probeRef, selfLocal, leaverSha);
  check('fresh read grant: receive-pack denied, ref unchanged', `${pf.http} accepted=${pf.accepted} moved=${pf.refMoved}`, (v) => v.includes('403') && v.includes('accepted=false moved=false'));
  check('authz-probe ref unchanged across self-removal denials', await ownerRef(selfRepo, probeRef), selfBefore);

  const ordinary = await api('owner', 'DELETE', `/orgs/${SELF_ORG}/members/${LOGIN.maint}`);
  check('owner removes a plain member', `${ordinary.status} ${ordinary.text}`, '200 {"removed":true}');
  check('ordinary removal deleted the member’s grant', await leftGrants(), `${leaver}:read`);
  await api('owner', 'PUT', `/orgs/${SELF_ORG}/members/${LOGIN.maint}`, { role: 'member' });
  check('re-added plain member: REST read concealed', (await api('maint', 'GET', `/repos/${selfRepo}`)).status, 404);
  check('re-added plain member: git ls-remote discloses no refs', lsRemote('maint', selfRepo).refs, 0);

  const lastRemove = await api('owner', 'DELETE', `/orgs/${SELF_ORG}/members/${LOGIN.owner}`);
  check('last remaining owner cannot remove themselves', `${lastRemove.status} ${lastRemove.body?.code}`, '409 LAST_OWNER');
  const lastDemote = await api('owner', 'PUT', `/orgs/${SELF_ORG}/members/${LOGIN.owner}`, { role: 'member' });
  check('last remaining owner cannot be demoted', `${lastDemote.status} ${lastDemote.body?.code}`, '409 LAST_OWNER');
  const intact = await api('owner', 'GET', `/orgs/${SELF_ORG}/members`);
  check(
    'org intact after rejected last-owner changes',
    (intact.body?.members ?? []).map((m) => `${m.login}:${m.role}`).sort().join(','),
    [`${LOGIN.maint}:member`, `${leaver}:member`, `${LOGIN.owner}:owner`].sort().join(','),
  );
  check('grants intact after rejected last-owner changes', await leftGrants(), `${leaver}:read`);
} finally {
  if (!KEEP) {
    for (const [who, r] of [
      ['maint', `${ORG}/${MATRIX}`],
      ['maint', `${ORG}/${FLIP}`],
      ['owner', `${LOGIN.owner}/${PERSONAL}`],
      ['owner', `${SELF_ORG}/${SELF_REPO}`],
    ]) {
      const d = await api(who, 'DELETE', `/repos/${r}`);
      console.log(`# cleanup DELETE ${r}: ${d.status}`);
    }
  }
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
