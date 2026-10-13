#!/usr/bin/env node
/**
 * Live driver for opt-in branch rules (VAL-PROTECT-001).
 *
 * As the non-admin human `kvarm-bot` (KVARM_PAT_BOT) it creates a private repo,
 * grants `kvarm-org-maint` (KVARM_PAT_MAINT) write, seeds `main` and `scratch`,
 * protects `main` with a required check and one separate approval, then checks:
 *  - rule management is repo-admin only (collaborator 403) and the effective
 *    policy is readable;
 *  - ordinary workflows on unprotected refs still succeed (git CLI fast-forward,
 *    new branch, force update), with owner readback;
 *  - direct pushes to the protected ref are denied for the owner, the write
 *    collaborator and the global instance admin (KVARM_PAT, no grant):
 *    git CLI fast-forward and force push, plus raw receive-pack commands with
 *    the exact expected old OID (fast-forward, non-fast-forward, delete, mixed
 *    push), each with parsed report-status and unchanged owner readback;
 *  - removing the rule restores the ordinary fast-forward push.
 *
 * Tokens come from env vars and are never printed.
 *   set -a; . ./.env.local; set +a
 *   node scripts/branch-rules-e2e.mjs [--keep]
 * Exit 0 only when every check holds, 1 when a check failed, 2 on a fatal
 * error; a fatal error still deletes the scratch repo.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({ options: { keep: { type: 'boolean', default: false } } });

const BASE = process.env.KVARM_BASE_URL;
const OWNER_PAT = process.env.KVARM_PAT_BOT;
const COLLAB_PAT = process.env.KVARM_PAT_MAINT;
const ADMIN_PAT = process.env.KVARM_PAT;
const ts = Math.floor(Date.now() / 1000);
const results = [];
const Z = '0'.repeat(40);

class FatalError extends Error {}

/** Throws: exiting here would skip the `finally` that deletes the scratch repo. */
function die(msg) {
  throw new FatalError(msg);
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
  return { status: res.status, json, text, cost: res.headers.get('x-kvarm-cost') };
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

const work = mkdtempSync(join(tmpdir(), 'branch-rules-e2e-'));
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

const rejected = (r) => (r.stderr.split('\n').find((l) => l.includes('remote rejected')) ?? '').trim();

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
  const lines = commands.map((c, i) => pkt(i === 0 ? `${c}\0 report-status agent=branch-rules-e2e\n` : `${c}\n`));
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
  return { http: res.status, status, cost: res.headers.get('x-kvarm-cost') };
}

async function pushWithRetry(args, token) {
  for (let i = 0; i < 10; i++) {
    const r = git(args, token, { allowFail: true });
    if (r.status === 0) return r;
    await sleep(3000);
  }
  die(`git ${args.join(' ')} kept failing`);
}

// ---------------------------------------------------------------------------

let created = false;
let exitCode = 0;

try {
  if (!BASE) die('KVARM_BASE_URL is not set');
  if (!OWNER_PAT) die('KVARM_PAT_BOT is not set');
  if (!COLLAB_PAT) die('KVARM_PAT_MAINT is not set');
  if (!ADMIN_PAT) die('KVARM_PAT is not set');
  const ownerLogin = (await api('GET', '/user', OWNER_PAT)).json?.user?.login ?? die('owner PAT rejected');
  const collab = await api('GET', '/user', COLLAB_PAT);
  const collabLogin = collab.json?.user?.login ?? die('collaborator PAT rejected');
  const admin = await api('GET', '/user', ADMIN_PAT);
  if (admin.json?.user?.isAdmin !== true) die('KVARM_PAT is not the instance admin');
  const adminLogin = admin.json.user.login;
  const name = `access-branch-rules-e2e-${ts}`;
  const repo = `${ownerLogin}/${name}`;
  const url = `${BASE}/${repo}.git`;
  const cr = await api('POST', '/repos', OWNER_PAT, { name, visibility: 'private' });
  if (cr.status !== 201) die(`create ${name}: ${cr.status} ${cr.text}`);
  created = true;
  const grant = await api('PUT', `/repos/${repo}/grants/${collabLogin}`, OWNER_PAT, { role: 'write' });
  check('collaborator granted write', grant.status === 200, `${collabLogin} ${grant.json?.grant?.role}`);
  console.log(`repo ${repo} (private, owner ${ownerLogin}; collaborator ${collabLogin}; instance admin ${adminLogin} has no grant)`);

  mkdirSync(repoDir);
  git(['init', '-q', '-b', 'main'], null);
  const c1 = commit('base');
  await pushWithRetry(['push', '-q', url, 'main:refs/heads/main', 'main:refs/heads/scratch'], OWNER_PAT);
  const seeded = await refsOf(repo);
  check('seed main and scratch', seeded['refs/heads/main'] === c1 && seeded['refs/heads/scratch'] === c1, `main=${c1}`);

  // --- rule management ------------------------------------------------------
  const denied = await api('POST', `/repos/${repo}/branch-rules`, COLLAB_PAT, { pattern: 'main' });
  check('write collaborator cannot create rules', denied.status === 403 && denied.json?.code === 'FORBIDDEN', `${denied.status} ${denied.text}`);
  const rule = await api('POST', `/repos/${repo}/branch-rules`, OWNER_PAT, {
    pattern: 'main',
    requiredChecks: ['ci/test'],
    requiredApprovals: 1,
  });
  check('owner protects main', rule.status === 201, `${rule.status} ${JSON.stringify(rule.json?.rule)} cost ${rule.cost}`);
  const policy = await api('GET', `/repos/${repo}/branch-policy?ref=main`, COLLAB_PAT);
  check(
    'effective policy readable',
    policy.json?.protected === true && policy.json?.directPush === 'denied' && policy.json?.requiredApprovals === 1,
    `${JSON.stringify(policy.json)} cost ${policy.cost}`,
  );
  const scratchPolicy = await api('GET', `/repos/${repo}/branch-policy?ref=scratch`, COLLAB_PAT);
  check('scratch unprotected', scratchPolicy.json?.protected === false, JSON.stringify(scratchPolicy.json));

  // --- unprotected workflows preserved ----------------------------------------
  const c2 = commit('scratch fast-forward');
  const ff = git(['push', url, 'HEAD:refs/heads/scratch'], COLLAB_PAT, { allowFail: true });
  let now = await refsOf(repo);
  check('collaborator fast-forwards scratch (git CLI)', ff.status === 0 && now['refs/heads/scratch'] === c2, `exit ${ff.status}; scratch ${c1} -> ${now['refs/heads/scratch']}`);
  const nb = git(['push', url, `HEAD:refs/heads/feature-${ts}`], OWNER_PAT, { allowFail: true });
  now = await refsOf(repo);
  check('owner creates a new branch (git CLI)', nb.status === 0 && now[`refs/heads/feature-${ts}`] === c2, `exit ${nb.status}`);
  git(['checkout', '-q', '--orphan', 'rewrite']);
  const orphan = commit('unrelated history');
  const force = git(['push', '--force', url, 'HEAD:refs/heads/scratch'], OWNER_PAT, { allowFail: true });
  now = await refsOf(repo);
  check('force update of unprotected scratch still allowed', force.status === 0 && now['refs/heads/scratch'] === orphan, `exit ${force.status}; scratch -> ${now['refs/heads/scratch']}`);

  // --- protected direct pushes ------------------------------------------------
  git(['checkout', '-q', 'main']);
  const ffTip = commit('direct fast-forward on main');
  const principals = [
    ['owner', OWNER_PAT],
    ['write collaborator', COLLAB_PAT],
    ['instance admin', ADMIN_PAT],
  ];
  for (const [who, token] of principals) {
    const before = await refsOf(repo);
    const cli = git(['push', url, 'HEAD:refs/heads/main'], token, { allowFail: true });
    const cliForce = git(['push', '--force', url, `${orphan}:refs/heads/main`], token, { allowFail: true });
    const after = await refsOf(repo);
    check(
      `${who}: git CLI fast-forward and force push to main rejected`,
      cli.status !== 0 && cliForce.status !== 0 && rejected(cli).includes('protected branch') && rejected(cliForce).includes('protected branch') && after['refs/heads/main'] === before['refs/heads/main'],
      `${rejected(cli)} | ${rejected(cliForce)} | main ${before['refs/heads/main']} -> ${after['refs/heads/main']}`,
    );
  }

  for (const [who, token] of principals) {
    const before = await refsOf(repo);
    const old = before['refs/heads/main'];
    const cases = [
      ['fast-forward', [`${old} ${ffTip} refs/heads/main`], `${ffTip}\n^${old}\n`],
      ['non-fast-forward', [`${old} ${orphan} refs/heads/main`], `${orphan}\n`],
      ['delete', [`${old} ${Z} refs/heads/main`], null],
      ['mixed with unprotected scratch', [`${before['refs/heads/scratch']} ${ffTip} refs/heads/scratch`, `${old} ${ffTip} refs/heads/main`], `${ffTip}\n`],
    ];
    for (const [label, cmds, revs] of cases) {
      console.log(`  ${who} raw receive-pack: ${cmds.join(' | ')}`);
      const r = await rawPush(repo, token, cmds, revs);
      const after = await refsOf(repo);
      const allNg = r.http === 200 && r.status[0] === 'unpack ok' && r.status.length === cmds.length + 1 && r.status.slice(1).every((l) => l.startsWith('ng '));
      const unchanged = after['refs/heads/main'] === old && after['refs/heads/scratch'] === before['refs/heads/scratch'];
      check(
        `${who}: raw ${label} with correct old OID denied`,
        allNg && unchanged && r.status.some((l) => l === 'ng refs/heads/main protected branch: direct pushes are not allowed'),
        `HTTP ${r.http} ${JSON.stringify(r.status)} main ${old} -> ${after['refs/heads/main']} cost ${r.cost}`,
      );
    }
  }

  // --- opt-in: removing the rule restores ordinary pushes ---------------------
  const del = await api('DELETE', `/repos/${repo}/branch-rules/${rule.json.rule.id}`, OWNER_PAT);
  check('owner deletes the rule', del.status === 200 && del.json?.deleted === true);
  const before = await refsOf(repo);
  const r = await rawPush(repo, OWNER_PAT, [`${before['refs/heads/main']} ${ffTip} refs/heads/main`], `${ffTip}\n^${before['refs/heads/main']}\n`);
  const after = await refsOf(repo);
  check('unprotected main accepts the fast-forward again', r.status.includes('ok refs/heads/main') && after['refs/heads/main'] === ffTip, `HTTP ${r.http} ${JSON.stringify(r.status)} main -> ${after['refs/heads/main']} cost ${r.cost}`);
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (err) {
  // A driver failure, not a crash: report it and let the `finally` clean up.
  if (!(err instanceof FatalError)) throw err;
  console.error(`branch-rules-e2e: ${err.message}`);
  exitCode = 2;
} finally {
  if (created && !opts.keep) {
    const d = await api('DELETE', `/repos/${repo}`, OWNER_PAT);
    console.log(`cleanup DELETE ${repo}: ${d.status}`);
  } else if (created) {
    console.log(`kept repo: ${repo}`);
  }
  rmSync(work, { recursive: true, force: true });
}

process.exit(exitCode);
