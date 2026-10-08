#!/usr/bin/env node
/**
 * Live driver for agent credentials (VAL-AGENT-001, VAL-AGENT-002).
 *
 * Creates two private repos owned by the non-admin human `forge-bot`, a
 * durable agent and repo/ref-scoped tokens, then checks:
 *  - the granted workspace ref push succeeds (git CLI + owner readback);
 *  - base, sibling-workspace, create, delete and multi-ref escapes are denied
 *    (parsed report-status + unchanged owner readback), the other repo is
 *    concealed, and the token cannot mint credentials or change grants/members;
 *  - a 60 s token works before expiry and is rejected right after it;
 *  - a warmed token is rejected on the next REST and git request after revoke.
 *
 * Tokens come from env vars (FORGE_PAT_BOT, FORGE_BASE_URL) and are never
 * printed; agent tokens are shown by prefix only.
 *   set -a; . apps/platform/.dev.vars.validation; set +a
 *   node scripts/agent-credentials-e2e.mjs [--keep] [--skip-expiry]
 * Exit 0 only when every check holds.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: { keep: { type: 'boolean', default: false }, 'skip-expiry': { type: 'boolean', default: false } },
});

const BASE = process.env.FORGE_BASE_URL ?? die('FORGE_BASE_URL is not set');
const OWNER_PAT = process.env.FORGE_PAT_BOT ?? die('FORGE_PAT_BOT is not set');
const ts = Math.floor(Date.now() / 1000);
const results = [];

function die(msg) {
  console.error(`agent-credentials-e2e: ${msg}`);
  process.exit(2);
}

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, token, body) {
  const init = { method, headers: token ? { Authorization: `Bearer ${token}` } : {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}/api/v1${path}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, cost: res.headers.get('x-forge-cost') };
}

const auth = (t) => `Basic ${Buffer.from(`x:${t}`).toString('base64')}`;

function pkt(line) {
  return Buffer.concat([Buffer.from((line.length + 4).toString(16).padStart(4, '0')), Buffer.from(line)]);
}

function pktLines(buf) {
  const out = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString(), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      i += 4;
      continue;
    }
    out.push(buf.subarray(i + 4, i + len));
    i += len;
  }
  return out;
}

/** Authoritative ref readback: the owner's receive-pack advertisement is never edge-cached. */
async function refsOf(repo) {
  const res = await fetch(`${BASE}/${repo}.git/info/refs?service=git-receive-pack`, { headers: { Authorization: auth(OWNER_PAT) } });
  const body = Buffer.from(await res.arrayBuffer());
  const refs = {};
  for (const line of pktLines(body)) {
    const m = line.toString().replace(/\0.*$/s, '').trim().match(/^([0-9a-f]{40}) (\S+)$/);
    if (m) refs[m[2]] = m[1];
  }
  return refs;
}

// ---------------------------------------------------------------------------
// git CLI with a secret-free askpass helper; tokens travel only in env vars
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'agent-cred-e2e-'));
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in Username*) echo x ;; *) printf "%s\\n" "$E2E_GIT_TOKEN" ;; esac\n');
chmodSync(askpass, 0o700);
const repoDir = join(work, 'repo');

function git(args, token, { allowFail = false } = {}) {
  const r = spawnSync('git', ['-c', 'credential.helper=', '-c', 'protocol.version=0', ...args], {
    cwd: repoDir,
    env: {
      ...process.env,
      GIT_ASKPASS: askpass,
      GIT_TERMINAL_PROMPT: '0',
      E2E_GIT_TOKEN: token ?? '',
      GIT_AUTHOR_NAME: 'e2e',
      GIT_AUTHOR_EMAIL: 'e2e@forge.invalid',
      GIT_COMMITTER_NAME: 'e2e',
      GIT_COMMITTER_EMAIL: 'e2e@forge.invalid',
    },
    encoding: 'utf8',
  });
  if (r.status !== 0 && !allowFail) die(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

function commit(msg) {
  writeFileSync(join(repoDir, 'file.txt'), `${msg}\n`);
  git(['add', 'file.txt']);
  git(['commit', '-q', '-m', msg]);
  return git(['rev-parse', 'HEAD']).stdout.trim();
}

/** One raw receive-pack request; returns HTTP status and parsed report-status lines. */
async function rawPush(repo, token, commands, packRevs) {
  let pack = Buffer.alloc(0);
  if (packRevs) {
    const r = spawnSync('git', ['-C', repoDir, 'pack-objects', '--stdout', '--revs', '--thin', '-q'], {
      input: packRevs,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) die(`pack-objects failed: ${r.stderr}`);
    pack = r.stdout;
  }
  const lines = commands.map((c, i) => pkt(i === 0 ? `${c}\0 report-status agent=agent-credentials-e2e\n` : `${c}\n`));
  const res = await fetch(`${BASE}/${repo}.git/git-receive-pack`, {
    method: 'POST',
    headers: {
      Authorization: auth(token),
      'content-type': 'application/x-git-receive-pack-request',
      accept: 'application/x-git-receive-pack-result',
    },
    body: Buffer.concat([...lines, Buffer.from('0000'), pack]),
  });
  const body = Buffer.from(await res.arrayBuffer());
  const status = res.status === 200 ? pktLines(body).map((l) => l.toString().trim()) : [];
  return { http: res.status, status, cost: res.headers.get('x-forge-cost') };
}

// ---------------------------------------------------------------------------

const ownerLogin = (await api('GET', '/user', OWNER_PAT)).json?.user?.login ?? die('owner PAT rejected');
const mainName = `agent-credentials-main-${ts}`;
const otherName = `agent-credentials-other-${ts}`;
const mainRepo = `${ownerLogin}/${mainName}`;
const otherRepo = `${ownerLogin}/${otherName}`;
const created = [];

async function cleanup() {
  if (opts.keep) {
    console.log(`kept repos: ${created.join(', ')}`);
  } else {
    for (const r of created) {
      const d = await api('DELETE', `/repos/${r}`, OWNER_PAT);
      console.log(`cleanup DELETE ${r}: ${d.status}`);
    }
  }
  rmSync(work, { recursive: true, force: true });
}

try {
  for (const name of [mainName, otherName]) {
    const r = await api('POST', '/repos', OWNER_PAT, { name, visibility: 'private' });
    if (r.status !== 201) die(`create ${name}: ${r.status} ${r.text}`);
    created.push(`${ownerLogin}/${name}`);
  }
  console.log(`repos: ${mainRepo}, ${otherRepo} (private, owner ${ownerLogin})`);

  mkdirSync(repoDir);
  git(['init', '-q', '-b', 'main'], null);
  const base = commit('base');
  git(['branch', 'agents/ws1/task']);
  git(['branch', 'agents/ws2/task']);
  for (const [repo, specs] of [
    [mainRepo, ['main', 'agents/ws1/task', 'agents/ws2/task']],
    [otherRepo, ['main']],
  ]) {
    let ok = false;
    for (let i = 0; i < 10 && !ok; i++) {
      const r = git(['push', '-q', `${BASE}/${repo}.git`, ...specs.map((s) => `${s}:refs/heads/${s}`)], OWNER_PAT, { allowFail: true });
      ok = r.status === 0;
      if (!ok) await sleep(3000);
    }
    if (!ok) die(`seed push to ${repo} failed`);
  }
  const seeded = await refsOf(mainRepo);
  check('seed refs present', seeded['refs/heads/main'] === base && seeded['refs/heads/agents/ws1/task'] === base);

  // --- agent + token -------------------------------------------------------
  const agentRes = await api('POST', '/agents', OWNER_PAT, { name: `e2e-${ts}`, description: 'agent-credentials e2e' });
  check('owner creates durable agent', agentRes.status === 201, `${agentRes.status} ${JSON.stringify(agentRes.json?.agent)}`);
  const agentId = agentRes.json.agent.id;
  const mintRes = await api('POST', `/agents/${agentId}/tokens`, OWNER_PAT, {
    repo: mainRepo,
    role: 'write',
    refs: ['refs/heads/agents/ws1/*'],
    expiresIn: 900,
    name: 'ws1',
  });
  const agentTok = mintRes.json?.token;
  const { token: _secret, ...meta } = mintRes.json ?? {};
  check('owner mints scoped token', mintRes.status === 201 && /^forge_agt_[0-9a-f]{64}$/.test(agentTok ?? ''), `metadata ${JSON.stringify(meta)}`);
  const listed = await api('GET', `/agents/${agentId}/tokens`, OWNER_PAT);
  check('token listing shows prefix only', listed.status === 200 && !listed.text.includes(agentTok) && listed.json.tokens[0]?.prefix === meta.prefix, `prefix ${meta.prefix}`);

  // --- VAL-AGENT-001: permitted operation ---------------------------------
  const read = await api('GET', `/repos/${mainRepo}`, agentTok);
  check('agent REST read of granted repo', read.status === 200, `x-forge-cost ${read.cost}`);
  git(['checkout', '-q', 'agents/ws1/task']);
  const ws1New = commit('agent work on ws1');
  const okPush = git(['push', `${BASE}/${mainRepo}.git`, `HEAD:refs/heads/agents/ws1/task`, `HEAD:refs/heads/agents/ws1/extra`], agentTok, { allowFail: true });
  const afterOk = await refsOf(mainRepo);
  check(
    'agent git push to granted workspace refs',
    okPush.status === 0 && afterOk['refs/heads/agents/ws1/task'] === ws1New && afterOk['refs/heads/agents/ws1/extra'] === ws1New,
    `exit ${okPush.status}; readback ws1/task=${afterOk['refs/heads/agents/ws1/task']}`,
  );

  // --- VAL-AGENT-001: denied ref escapes -----------------------------------
  const escapeTip = commit('escape attempt');
  const before = await refsOf(mainRepo);
  const cliDenied = git(['push', `${BASE}/${mainRepo}.git`, `HEAD:refs/heads/main`], agentTok, { allowFail: true });
  const rejectedLine = cliDenied.stderr.split('\n').find((l) => l.includes('remote rejected')) ?? '';
  check('git CLI push to base is rejected', cliDenied.status !== 0 && rejectedLine.includes('ref outside agent token grant'), rejectedLine.trim());

  const Z = '0'.repeat(40);
  const denials = [
    ['update base', [`${before['refs/heads/main']} ${escapeTip} refs/heads/main`], `${escapeTip}\n^${before['refs/heads/main']}\n`],
    ['update sibling workspace', [`${before['refs/heads/agents/ws2/task']} ${escapeTip} refs/heads/agents/ws2/task`], `${escapeTip}\n^${base}\n`],
    ['create outside grant', [`${Z} ${escapeTip} refs/heads/escape-${ts}`], `${escapeTip}\n^${base}\n`],
    ['delete base', [`${before['refs/heads/main']} ${Z} refs/heads/main`], null],
    [
      'multi-ref escape (granted + base)',
      [
        `${before['refs/heads/agents/ws1/task']} ${escapeTip} refs/heads/agents/ws1/task`,
        `${before['refs/heads/main']} ${escapeTip} refs/heads/main`,
      ],
      `${escapeTip}\n^${ws1New}\n`,
    ],
  ];
  for (const [name, cmds, revs] of denials) {
    const r = await rawPush(mainRepo, agentTok, cmds, revs);
    const allNg = r.http === 200 && r.status[0] === 'unpack ok' && r.status.slice(1).length === cmds.length && r.status.slice(1).every((l) => l.startsWith('ng '));
    check(`receive-pack denies ${name}`, allNg, `HTTP ${r.http} ${JSON.stringify(r.status)} cost ${r.cost}`);
  }
  const after = await refsOf(mainRepo);
  const unchanged = Object.keys(before).every((k) => before[k] === after[k]) && Object.keys(after).length === Object.keys(before).length;
  check('refs unchanged after denied pushes', unchanged, `main=${after['refs/heads/main']} ws1/task=${after['refs/heads/agents/ws1/task']} ws2/task=${after['refs/heads/agents/ws2/task']} escape=${after[`refs/heads/escape-${ts}`] ?? 'absent'}`);

  // --- VAL-AGENT-001: other repo + credential / grant / membership escapes ---
  const otherRest = await api('GET', `/repos/${otherRepo}`, agentTok);
  check('other repo concealed on REST', otherRest.status === 404, `${otherRest.status} ${otherRest.text}`);
  const otherGit = git(['ls-remote', `${BASE}/${otherRepo}.git`], agentTok, { allowFail: true });
  check('other repo denied on git', otherGit.status !== 0, (otherGit.stderr.split('\n')[0] ?? '').trim());
  const otherBefore = await refsOf(otherRepo);
  const otherPush = await rawPush(otherRepo, agentTok, [`${otherBefore['refs/heads/main']} ${escapeTip} refs/heads/main`], `${escapeTip}\n^${base}\n`);
  const otherAfter = await refsOf(otherRepo);
  check('other repo push denied, ref unchanged', otherPush.http === 404 && otherAfter['refs/heads/main'] === otherBefore['refs/heads/main'], `HTTP ${otherPush.http}`);

  const orgLogin = `agt-e2e-${ts}`;
  const org = await api('POST', '/orgs', OWNER_PAT, { login: orgLogin });
  const escapes = [
    ['mint another token', 'POST', `/agents/${agentId}/tokens`, { repo: mainRepo, role: 'write', refs: ['refs/heads/*'] }],
    ['create agent', 'POST', '/agents', { name: `child-${ts}` }],
    ['mint human PAT', 'POST', '/user/tokens', { scopes: ['read', 'write', 'api'] }],
    ['change grants', 'PUT', `/repos/${mainRepo}/grants/forge-outsider`, { role: 'admin' }],
    ['manage org membership', 'PUT', `/orgs/${orgLogin}/members/forge-outsider`, { role: 'owner' }],
    ['make repo public', 'PATCH', `/repos/${mainRepo}`, { visibility: 'public' }],
    ['create repo', 'POST', '/repos', { name: `escape-${ts}` }],
  ];
  for (const [name, method, path, body] of escapes) {
    const r = await api(method, path, agentTok, body);
    check(`agent cannot ${name}`, r.status === 403, `${r.status} ${r.text}`);
  }
  const grants = await api('GET', `/repos/${mainRepo}/grants`, OWNER_PAT);
  const members = org.status === 201 ? await api('GET', `/orgs/${orgLogin}/members`, OWNER_PAT) : { json: { members: [] } };
  const toks = await api('GET', `/agents/${agentId}/tokens`, OWNER_PAT);
  const vis = await api('GET', `/repos/${mainRepo}`, OWNER_PAT);
  check(
    'no grant, member, token or visibility change happened',
    grants.json?.grants?.length === 0 &&
      !members.json.members.some((m) => m.login === 'forge-outsider') &&
      toks.json?.tokens?.length === 1 &&
      vis.json?.repo?.visibility === 'private',
    `grants=${grants.json?.grants?.length} tokens=${toks.json?.tokens?.length} visibility=${vis.json?.repo?.visibility}`,
  );

  // --- VAL-AGENT-002: revocation of a warmed token -------------------------
  const rev = await api('POST', `/agents/${agentId}/tokens`, OWNER_PAT, { repo: mainRepo, role: 'write', refs: ['refs/heads/agents/ws1/*'], expiresIn: 600 });
  const revTok = rev.json.token;
  await api('GET', `/repos/${mainRepo}`, revTok);
  const warm = await api('GET', `/repos/${mainRepo}`, revTok);
  const warmGit = git(['ls-remote', `${BASE}/${mainRepo}.git`], revTok, { allowFail: true });
  check('revocation token works when warm', warm.status === 200 && warmGit.status === 0, `prefix ${rev.json.prefix}; warm x-forge-cost ${warm.cost}`);
  const revBefore = await refsOf(mainRepo);
  const del = await api('DELETE', `/agents/${agentId}/tokens/${rev.json.id}`, OWNER_PAT);
  check('owner revokes token', del.status === 200 && del.json?.revoked === true, `revokedAt ${del.json?.token?.revokedAt} status ${del.json?.token?.status}`);
  const afterRevoke = await api('GET', `/repos/${mainRepo}`, revTok);
  check('first REST request after revoke denied without content', afterRevoke.status === 401 && !afterRevoke.text.includes(mainName), `${afterRevoke.status} ${afterRevoke.text} cost ${afterRevoke.cost}`);
  const revGit = git(['ls-remote', `${BASE}/${mainRepo}.git`], revTok, { allowFail: true });
  check('first git request after revoke denied', revGit.status !== 0, (revGit.stderr.split('\n')[0] ?? '').trim());
  const revPush = await rawPush(mainRepo, revTok, [`${revBefore['refs/heads/agents/ws1/task']} ${escapeTip} refs/heads/agents/ws1/task`], `${escapeTip}\n^${ws1New}\n`);
  const revAfter = await refsOf(mainRepo);
  check('revoked token push denied, ref unchanged', revPush.http === 401 && revAfter['refs/heads/agents/ws1/task'] === revBefore['refs/heads/agents/ws1/task'], `HTTP ${revPush.http}`);

  // --- VAL-AGENT-002: expiry -------------------------------------------------
  if (!opts['skip-expiry']) {
    const exp = await api('POST', `/agents/${agentId}/tokens`, OWNER_PAT, { repo: mainRepo, role: 'write', refs: ['refs/heads/agents/ws1/*'], expiresIn: 60 });
    const expTok = exp.json.token;
    console.log(`short-lived token: prefix ${exp.json.prefix}, expiresAt ${exp.json.expiresAt} (minimum expiresIn 60 s)`);
    const pre = await api('GET', `/repos/${mainRepo}`, expTok);
    const preGit = git(['ls-remote', `${BASE}/${mainRepo}.git`], expTok, { allowFail: true });
    check('short-lived token works before expiry', pre.status === 200 && preGit.status === 0);
    const waitMs = Date.parse(exp.json.expiresAt) - Date.now() + 1500;
    console.log(`waiting ${Math.ceil(waitMs / 1000)} s for expiry`);
    await sleep(Math.max(0, waitMs));
    const expBefore = await refsOf(mainRepo);
    const post = await api('GET', `/repos/${mainRepo}`, expTok);
    check('first REST request after expiry denied', post.status === 401 && !post.text.includes(mainName), `${post.status} ${post.text} at ${new Date().toISOString()}`);
    const postGit = git(['ls-remote', `${BASE}/${mainRepo}.git`], expTok, { allowFail: true });
    check('git request after expiry denied', postGit.status !== 0, (postGit.stderr.split('\n')[0] ?? '').trim());
    const expPush = await rawPush(mainRepo, expTok, [`${expBefore['refs/heads/agents/ws1/task']} ${escapeTip} refs/heads/agents/ws1/task`], `${escapeTip}\n^${ws1New}\n`);
    const expAfter = await refsOf(mainRepo);
    check('expired token push denied, ref unchanged', expPush.http === 401 && expAfter['refs/heads/agents/ws1/task'] === expBefore['refs/heads/agents/ws1/task'], `HTTP ${expPush.http}`);
    const listing = await api('GET', `/agents/${agentId}/tokens`, OWNER_PAT);
    check('listing reports expired status', listing.json.tokens.find((t) => t.id === exp.json.id)?.status === 'expired');
  }

  const revokeAgent = await api('DELETE', `/agents/${agentId}`, OWNER_PAT);
  check('agent revoked at end (record kept)', revokeAgent.status === 200 && revokeAgent.json?.agent?.status === 'revoked');
  const deadTok = await api('GET', `/repos/${mainRepo}`, agentTok);
  check('tokens of revoked agent denied', deadTok.status === 401);
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
