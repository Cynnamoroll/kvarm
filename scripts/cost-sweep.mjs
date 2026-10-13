#!/usr/bin/env node
/**
 * Final cost sweep: every row of a markdown budget table against the live worker.
 *
 *   set -a; . ./.env.local; set +a
 *   . "$HOME/.config/vite-plus/env"          # wrangler (tail + read-only D1)
 *   node scripts/cost-sweep.mjs --cost-md <budget table .md> [--out report.json] [--keep]
 *   node scripts/cost-sweep.mjs --cost-md <path> --coverage-only   # no network
 *
 * Each row of the budget document is matched to one entry of
 * scripts/lib/cost-catalog.mjs. Live entries are checked against the
 * x-kvarm-cost samples (or stored/logged counters) this run records under
 * their probe tag; non-live entries print their category and reason. The run
 * prints one verdict per row, the sweep row count against the document's
 * table row count, and exits 1 on any violation, missing sample, unmatched or
 * ambiguous row, or unused catalog entry (2 on a usage error).
 *
 * Isolation: scratch repos named m7-benchmarks-cost-sweep-<purpose>-<ts>
 * (deleted at the end unless --keep), one scratch org (orgs have no delete
 * API), agents revoked at the end. Bounded like every live driver: at most 5
 * HTTP requests and 3 git children in flight, 429/Retry-After honored, a
 * 10,000-request ceiling.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { CATALOG } from './lib/cost-catalog.mjs';
import { evaluateEntry, matchCatalog, parseCostTables, summarizeVerdicts } from './lib/cost-sweep.mjs';
import { parseCost } from './lib/fleet.mjs';
import { ROOT, createLive, sleep, tailLogLines } from './lib/live.mjs';
import { runContainerShowcase } from './lib/container-runner-demo.mjs';

const { values: args } = parseArgs({
  options: {
    'cost-md': { type: 'string', default: process.env.KVARM_COST_MD ?? '' },
    'coverage-only': { type: 'boolean', default: false },
    out: { type: 'string', default: '' },
    keep: { type: 'boolean', default: false },
    'skip-container': { type: 'boolean', default: false },
  },
});
if (!args['cost-md']) {
  console.error('usage: node scripts/cost-sweep.mjs --cost-md <budget table .md> [--coverage-only] [--out file] [--keep]');
  process.exit(2);
}
const costMd = readFileSync(args['cost-md'], 'utf8');
const rows = parseCostTables(costMd);
const coverage = matchCatalog(rows, CATALOG);
const separators = costMd.split('\n').filter((l) => /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(l)).length;
const pipeLines = costMd.split('\n').filter((l) => /^\s*\|/.test(l)).length;
const documentRows = pipeLines - 2 * separators;

function printCoverage() {
  console.log(`cost.md: ${separators} tables, ${documentRows} table rows (pipe lines minus header and separator lines); parsed ${rows.length}; catalog ${CATALOG.length} entries`);
  for (const u of coverage.unmatched) console.log(`  UNMATCHED line ${u.line}: [${u.section}] ${u.endpoint}${u.state ? ` (${u.state})` : ''}`);
  for (const a of coverage.ambiguous) console.log(`  AMBIGUOUS line ${a.row.line}: ${a.row.endpoint} -> ${a.entries.map((e) => e.id).join(', ')}`);
  for (const e of coverage.unused) console.log(`  UNUSED catalog entry ${e.id} ([${e.section}] ${e.row})`);
}
printCoverage();
const coverageOk = coverage.unmatched.length === 0 && coverage.ambiguous.length === 0 && coverage.unused.length === 0 && rows.length === documentRows;
if (args['coverage-only']) {
  const live = CATALOG.filter((e) => e.kind === 'live').length;
  console.log(`coverage ${coverageOk ? 'ok' : 'FAILED'}: ${coverage.matched.size}/${rows.length} rows matched; ${live} live entries, ${CATALOG.length - live} non-live`);
  process.exit(coverageOk ? 0 : 1);
}

const BASE = process.env.KVARM_BASE_URL;
const PAT = process.env.KVARM_PAT;
const OWNER = process.env.KVARM_USER;
const TOKENS = {
  bot: process.env.KVARM_PAT_BOT,
  noApi: process.env.KVARM_PAT_NO_API,
  maint: process.env.KVARM_PAT_MAINT,
  member: process.env.KVARM_PAT_MEMBER,
  outsider: process.env.KVARM_PAT_OUTSIDER,
};
for (const [k, v] of Object.entries({ KVARM_BASE_URL: BASE, KVARM_PAT: PAT, KVARM_USER: OWNER, ...Object.fromEntries(Object.entries(TOKENS).map(([k, v]) => [`token ${k}`, v])) })) {
  if (!v) {
    console.error(`missing ${k}: source .env.local first`);
    process.exit(2);
  }
}
const LOGINS = { bot: 'kvarm-bot', maint: 'kvarm-org-maint', member: 'kvarm-org-member' };
const FIXTURE = process.env.KVARM_FIXTURE_REPO ?? `${OWNER}/fixture-1m`;

const live = createLive({ base: BASE, pat: PAT, log: (l) => console.log(l) });
const { http, git } = live;
const TS = Math.floor(Date.now() / 1000);
const repoName = (purpose) => `m7-benchmarks-cost-sweep-${purpose}-${TS}`;
const R = (name, owner = OWNER) => `/api/v1/repos/${owner}/${name}`;
const gitUrl = (name, owner = OWNER) => `${BASE}/${owner}/${name}.git`;
const basic = (token) => `Basic ${Buffer.from(`x:${token}`).toString('base64')}`;
const ZERO = '0'.repeat(40);
const badPat = () => `kvarm_pat_${randomBytes(32).toString('hex')}`;

const samples = new Map();
function rec(tags, res, extra = {}, costOverride) {
  const cost = costOverride ?? res.cost;
  for (const t of [].concat(tags)) {
    if (!samples.has(t)) samples.set(t, []);
    samples.get(t).push({ status: res.status, cost, extra: { ...extra, ms: extra.ms ?? res.ms } });
  }
  return res;
}
/** Recorded or logged counters (format stored | log | build): no HTTP status of their own. */
function recCounters(tags, format, cost, extra = {}) {
  for (const t of [].concat(tags)) {
    if (!samples.has(t)) samples.set(t, []);
    samples.get(t).push({ format, cost, extra: { ...extra, ms: extra.ms ?? 0 } });
  }
}
const created = [];
const agents = [];
const notes = [];
const say = (s) => console.log(s);

async function until(label, fn, ms, every = 1500) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`${label}: not within ${ms / 1000} s`);
    await sleep(every);
  }
}
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function createRepo(purpose, visibility = 'public') {
  const name = repoName(purpose);
  const r = rec('repo.create', await http('/api/v1/repos', { method: 'POST', json: { name, visibility, description: 'cost-sweep scratch repo' } }));
  expect(r.status === 201, `create ${name} -> ${r.status} ${r.text.slice(0, 120)}`);
  created.push({ owner: OWNER, name });
  return name;
}

function local(dirName) {
  const dir = join(live.work, dirName);
  mkdirSync(dir, { recursive: true });
  const g = (a, o = {}) => git(a, { cwd: dir, ...o });
  return {
    dir,
    g,
    async init() {
      await g(['init', '-q', '-b', 'main']);
    },
    write(files) {
      for (const [p, c] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), c);
      }
    },
    async commit(files, msg) {
      this.write(files);
      await g(['add', '-A']);
      await g(['commit', '-q', '--allow-empty', '-m', msg]);
      return g(['rev-parse', 'HEAD']);
    },
    async branch(name, from) {
      await g(['checkout', '-q', '-B', name, from]);
    },
    async push(url, refspecs, token = PAT) {
      return g(['push', '-q', url, ...refspecs], { network: true, token });
    },
    async fetchMain(url, token = PAT) {
      await g(['fetch', '-q', url, '+refs/heads/main:refs/remotes/origin/main'], { network: true, token });
      return g(['rev-parse', 'refs/remotes/origin/main']);
    },
  };
}

const pkt = (s) => {
  const b = Buffer.isBuffer(s) ? s : Buffer.from(s);
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]);
};
function pktLines(buf) {
  const out = [];
  for (let i = 0; i + 4 <= buf.length; ) {
    const len = parseInt(buf.subarray(i, i + 4).toString(), 16);
    if (!len || len < 4) {
      i += 4;
      continue;
    }
    out.push(buf.subarray(i + 4, i + len));
    i += len;
  }
  return out;
}
const EMPTY_PACK = (() => {
  const h = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
  return Buffer.concat([h, createHash('sha1').update(h).digest()]);
})();

/** Raw receive-pack POST: every command points at an existing object, so an empty pack completes it. */
async function receivePack(name, token, commands, owner = OWNER) {
  const needsPack = commands.some((c) => !c.split(' ')[1].startsWith(ZERO));
  const body = Buffer.concat([
    pkt(`${commands[0]}\0 report-status agent=cost-sweep\n`),
    ...commands.slice(1).map((c) => pkt(`${c}\n`)),
    Buffer.from('0000'),
    ...(needsPack ? [EMPTY_PACK] : []),
  ]);
  const res = await http(`/${owner}/${name}.git/git-receive-pack`, {
    method: 'POST',
    body,
    auth: basic(token),
    binary: true,
    headers: { 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' },
  });
  res.report = res.status === 200 && res.bytes ? pktLines(Buffer.from(res.bytes)).map((l) => l.toString().trim()) : [];
  return res;
}

async function mcp(body, { token = PAT, raw } = {}) {
  return http('/mcp', {
    method: 'POST',
    token,
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}
const tool = (name, args, id = 2) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

let agentSeq = 0;
async function agentFor(name, refs) {
  const a = rec('agents.create', await http('/api/v1/agents', { method: 'POST', json: { name: `sweep-${TS}-${agentSeq++}`, description: 'cost-sweep scratch agent' } }));
  expect(a.status === 201, `agent create -> ${a.status}`);
  agents.push(a.json.agent.id);
  const t = rec('agents.token.create', await http(`/api/v1/agents/${a.json.agent.id}/tokens`, { method: 'POST', json: { repo: `${OWNER}/${name}`, role: 'write', refs, expiresIn: 3600 } }));
  expect(t.status === 201, `agent token -> ${t.status} ${t.text.slice(0, 120)}`);
  return { id: a.json.agent.id, token: t.json.token };
}

async function snapReady(name, ref, ms = 240_000) {
  return until(
    `snapshot ${ref}`,
    async () => {
      const r = await http(`${R(name)}/snapshots/${ref}`);
      if (r.json?.state === 'failed') throw new Error(`snapshot ${ref} failed: ${r.json.error}`);
      return r.json?.state === 'ready' ? r : null;
    },
    ms,
    2000,
  );
}
const buildSample = (tag, meta) => {
  const bc = meta.json.buildCost ?? {};
  recCounters([tag, 'snapbuild.any'], 'build', { ...bc }, { files: meta.json.files, reused: meta.json.reused, ms: meta.ms });
};

const phases = [];
async function phase(name, fn) {
  const t0 = Date.now();
  say(`\n== ${name}`);
  try {
    await fn();
    phases.push({ name, ok: true, ms: Date.now() - t0 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    say(`  phase ${name} FAILED: ${msg}`);
    phases.push({ name, ok: false, ms: Date.now() - t0, error: msg });
  }
}

const tail = live.startTail();
const repos = {};
const eventsById = new Map();
const queueRows = [];
const repoIds = new Map();

// ---------------------------------------------------------------------------
await phase('repo basics, git gate, pages, tokens', async () => {
  rec('healthz', await http('/healthz', { token: null }));
  rec('user.get', await http('/api/v1/user'));
  const bad = badPat();
  rec('auth.unknownPat', await http('/api/v1/user', { auth: `Bearer ${bad}` }), { kind: 'first' });
  rec('auth.unknownPat', await http('/api/v1/user', { auth: `Bearer ${bad}` }), { kind: 'repeat' });

  const A = (repos.A = await createRepo('basic'));
  const la = (repos.la = local('basic'));
  await la.init();
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
  repos.c1 = await la.commit({ 'about.txt': 'sweep\n', 'src/a.ts': 'export const a = 1;\n', 'docs/x.md': 'x\n', 'lines.txt': `${lines}\n` }, 'seed');
  await la.branch('feature', 'main');
  repos.f1 = await la.commit({ 'src/a.ts': 'export const a = 2;\n', 'src/b.ts': 'export const b = 1;\n' }, 'feature');
  await la.branch('main', 'main');
  await la.push(gitUrl(A), ['main', 'feature']);

  const gp = `/${OWNER}/${A}.git`;
  rec(['git.anonWrite', 'git.any'], await http(`${gp}/info/refs?service=git-receive-pack`, { token: null }), { denied: true });
  rec(['git.pat', 'git.any'], await http(`${gp}/info/refs?service=git-receive-pack`, { auth: basic(PAT) }));
  rec(['git.inforefs.anon.cold', 'git.any'], await http(`${gp}/info/refs?service=git-upload-pack`, { token: null }));
  for (let i = 0; i < 3; i++) rec(['git.inforefs.anon.warm', 'git.any', 'auth.component'], await http(`${gp}/info/refs?service=git-upload-pack`, { token: null }));
  const lsRefs = Buffer.concat([pkt('command=ls-refs\n'), Buffer.from('0000')]);
  rec(['git.uploadpack', 'git.any', 'auth.component'], await http(`${gp}/git-upload-pack`, { method: 'POST', token: null, body: lsRefs, headers: { 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' } }));

  rec('page.plain', await http(`/${OWNER}/${A}`, { token: null }), { kind: 'cold' });
  for (let i = 0; i < 3; i++) rec(['page.plain', 'warm.cachedBody', 'auth.component'], await http(`/${OWNER}/${A}`, { token: null }), { kind: 'warm' });
  rec('page.rejectedBearer', await http(`/${OWNER}/${A}`, { auth: `Bearer ${bad}` }), { kind: 'public' });

  repos.c2 = await la.commit({ 'docs/x.md': 'x2\n' }, 'docs');
  await la.push(gitUrl(A), ['main']);
  rec('page.afterPush', await http(`/${OWNER}/${A}`, { token: null }), { kind: 'page' });
  rec('page.afterPush', await http(`${gp}/info/refs?service=git-upload-pack`, { token: null }), { kind: 'inforefs' });

  rec('repo.get.pat.cold', await http(R(A)));
  for (let i = 0; i < 5; i++) rec(['repo.get.pat.warm', 'auth.component'], await http(R(A)));
  rec('repo.patch', await http(R(A), { method: 'PATCH', json: { description: 'cost-sweep scratch repo (patched)' } }));

  // a disposable PAT: its first use is a cold PAT read, then it is revoked
  // mint-pat refuses a file that is not gitignored
  const envFile = join(ROOT, `apps/platform/.dev.vars.cost-sweep-${TS}`);
  writeFileSync(envFile, '', { mode: 0o600 });
  const mint = spawnSync(process.execPath, ['scripts/mint-pat.mjs', '--login', OWNER, '--scopes', 'read,api', '--name', `cost-sweep-${TS}`, '--token-file', envFile, '--key', 'SWEEP_PAT'], { cwd: ROOT, encoding: 'utf8', env: process.env });
  if (mint.status === 0) {
    const patId = JSON.parse(mint.stdout.slice(mint.stdout.indexOf('{'))).patId;
    const token = /SWEEP_PAT=(\S+)/.exec(readFileSync(envFile, 'utf8'))?.[1];
    rmSync(envFile, { force: true });
    rec('repo.get.pat.cold', await http(R(A), { token }));
    const del = rec('token.delete', await http(`/api/v1/user/tokens/${patId}`, { method: 'DELETE' }));
    say(`  disposable PAT: first use ${samples.get('repo.get.pat.cold').at(-1).cost.d1 ?? 0} D1, revoke -> ${del.status}`);
  } else {
    rmSync(envFile, { force: true });
    say(`  mint-pat failed (${mint.status}): ${(mint.stderr || mint.stdout).slice(0, 200)}`);
  }

  // private personal repo: owner reads, a personal grant, revocation, outsider concealment
  const P = (repos.P = await createRepo('private', 'private'));
  const lp = (repos.lp = local('private'));
  await lp.init();
  repos.p1 = await lp.commit({ 'secret.txt': 'private\n' }, 'seed');
  await lp.branch('pf', 'main');
  repos.pf = await lp.commit({ 'secret.txt': 'private 2\n', 'more.txt': 'm\n' }, 'pf');
  await lp.branch('main', 'main');
  await lp.push(gitUrl(P), ['main', 'pf']);
  await http(R(P));
  rec(['repo.get.private', 'auth.component'], await http(R(P)));
  const raw = `/${OWNER}/${P}/raw/${repos.p1}/secret.txt`;
  rec('raw.private.sha', await http(raw), { kind: 'cold' });
  rec(['raw.private.sha', 'auth.component'], await http(raw), { kind: 'warm' });
  rec('page.rejectedBearer', await http(`/${OWNER}/${P}/tree/main`, { auth: `Bearer ${bad}` }), { kind: 'private' });
  rec('grants', await http(`${R(P)}/grants/${LOGINS.bot}`, { method: 'PUT', json: { role: 'read' } }));
  rec('grants', await http(`${R(P)}/grants`));
  const botGet = await http(R(P), { token: TOKENS.bot });
  expect(botGet.status === 200, `granted bot read -> ${botGet.status}`);
  await http(raw, { token: TOKENS.bot });
  rec('grants', await http(`${R(P)}/grants/${LOGINS.bot}`, { method: 'DELETE' }));
  rec('denied.afterRevoke', await http(R(P), { token: TOKENS.bot }));
  rec('raw.private.denied', await http(raw, { token: TOKENS.bot }));
  rec('compare.denied', await http(`${R(P)}/compare/main...pf`, { token: TOKENS.outsider }));
  rec('compare.denied', await http(`${R(P)}/compare/main...pf/file?path=secret.txt`, { token: TOKENS.outsider }));
  rec('snap.denied', await http(`${R(P)}/snapshots/main`, { token: TOKENS.outsider }));

  // org tenancy
  const org = (repos.org = `m7-sweep-${TS}`);
  const oc = rec('org.create', await http('/api/v1/orgs', { method: 'POST', json: { login: org, name: 'cost-sweep scratch org' } }));
  expect(oc.status === 201, `org create -> ${oc.status}`);
  notes.push(`scratch org ${org} created (orgs have no delete API)`);
  rec('org.member.write', await http(`/api/v1/orgs/${org}/members/${LOGINS.member}`, { method: 'PUT', json: { role: 'member' } }));
  rec('org.read', await http(`/api/v1/orgs/${org}`));
  const orgRepo = repoName('org');
  const or = rec('org.repo.create', await http(`/api/v1/orgs/${org}/repos`, { method: 'POST', json: { name: orgRepo, visibility: 'private' } }));
  expect(or.status === 201, `org repo create -> ${or.status}`);
  created.push({ owner: org, name: orgRepo });
  const lo = local('org');
  await lo.init();
  await lo.commit({ 'org.txt': 'org\n' }, 'seed');
  await lo.push(gitUrl(orgRepo, org), ['main']);
  rec('grants', await http(`${R(orgRepo, org)}/grants/${LOGINS.member}`, { method: 'PUT', json: { role: 'read' } }));
  await http(R(orgRepo, org), { token: TOKENS.member });
  rec(['repo.get.orgMember', 'auth.component'], await http(R(orgRepo, org), { token: TOKENS.member }));
  rec(['git.inforefs.orgMember', 'git.any'], await http(`/${org}/${orgRepo}.git/info/refs?service=git-upload-pack`, { auth: basic(TOKENS.member) }));
  rec('grants', await http(`${R(orgRepo, org)}/grants/${LOGINS.member}`, { method: 'DELETE' }));
  rec('denied.afterRevoke', await http(R(orgRepo, org), { token: TOKENS.member }));
  rec('org.member.write', await http(`/api/v1/orgs/${org}/members/${LOGINS.member}`, { method: 'DELETE' }));

  // agent credentials on the private repo
  rec('agents.read', await http('/api/v1/agents'));
  const ag = await agentFor(P, ['refs/heads/agents/*']);
  rec('agent.repo.get', await http(R(P), { token: ag.token }));
  rec('agent.repo.get', await http(R(P), { token: ag.token }));
  const ws = rec('ws.create', await http(`${R(P)}/workspaces`, { method: 'POST', token: ag.token, json: { task: 'cost-sweep agent workspace' } }));
  expect(ws.status === 201, `agent workspace -> ${ws.status} ${ws.text.slice(0, 120)}`);
  const push = rec(['git.agentWorkspacePush', 'git.any'], await receivePack(P, ag.token, [`${ws.json.headSha} ${repos.pf} ${ws.json.ref}`]));
  expect(push.report.some((l) => l.startsWith('ok ')), `agent workspace push: ${push.status} ${push.report.join(' | ')}`);
  rec('intent.post', await http(`${R(P)}/workspaces/${ws.json.id}/intent`, { method: 'POST', token: ag.token, json: { paths: ['secret.txt'] } }), { kind: 'agent' });
  const denied = rec(['git.agentDenied', 'git.receivepack.ng', 'git.any'], await receivePack(P, ag.token, [`${repos.p1} ${ZERO} refs/heads/main`]));
  expect(denied.report.some((l) => l.startsWith('ng ')), `agent denied push: ${denied.status} ${denied.report.join(' | ')}`);
  rec('agents.delete', await http(`/api/v1/agents/${ag.id}`, { method: 'DELETE' }));
  agents.splice(agents.indexOf(ag.id), 1);
  rec('agent.revoked', await http(R(P), { token: ag.token }));

  // branch rules on the public repo
  const rule = rec('rules.write', await http(`${R(A)}/branch-rules`, { method: 'POST', json: { pattern: 'protected' } }), { created: true });
  expect(rule.status === 201, `rule create -> ${rule.status}`);
  rec('rules.read', await http(`${R(A)}/branch-rules`));
  rec('rules.write', await http(`${R(A)}/branch-rules/${rule.json.rule.id}`, { method: 'PATCH', json: { requiredApprovals: 0 } }));
  const rd = rec(['git.ruleDenied', 'git.receivepack.ng', 'git.any'], await receivePack(A, PAT, [`${ZERO} ${repos.c1} refs/heads/protected`]));
  expect(rd.report.some((l) => l.startsWith('ng ')), `protected push: ${rd.report.join(' | ')}`);
  const ra = rec(['git.ruleAllowed', 'git.any'], await receivePack(A, PAT, [`${ZERO} ${repos.c1} refs/heads/free`]));
  expect(ra.report.some((l) => l.startsWith('ok ')), `unprotected push: ${ra.report.join(' | ')}`);
  rec('rules.write', await http(`${R(A)}/branch-rules/${rule.json.rule.id}`, { method: 'DELETE' }));
});

// ---------------------------------------------------------------------------
await phase('compare, content reads, snapshots, checkout', async () => {
  const A = repos.A;
  expect(A, 'no basic repo');
  const c = (q = '') => `${R(A)}/compare/main...feature${q}`;
  const reads = (r) => ({ treeReads: r.json?.treeReads ?? 0, blobReads: r.json?.blobReads ?? 0 });
  let r = await http(c());
  rec('compare.first', r, reads(r));
  r = await http(c('?nocache=1'));
  rec('compare.bypass', r, reads(r));
  await http(c());
  for (let i = 0; i < 5; i++) rec(['compare.warm', 'compare.warm.any', 'warm.cachedBody', 'auth.component'], await http(c()));
  await http(`${R(A)}/commits/${repos.f1}/diff`);
  for (let i = 0; i < 2; i++) rec(['compare.warm', 'compare.warm.any'], await http(`${R(A)}/commits/${repos.f1}/diff`));
  rec('filediff.cold', await http(`${c('/file')}?path=src/a.ts`));
  for (let i = 0; i < 5; i++) rec(['filediff.warm', 'compare.warm.any'], await http(`${c('/file')}?path=src/a.ts`));

  const [fo, fr] = FIXTURE.split('/');
  for (let i = 0; i < 10; i++) {
    r = await http(`${R(fr, fo)}/compare/bench-base...bench-head?nocache=1`);
    rec('compare.fixture1m', r, { treeReads: r.json?.treeReads ?? 0 });
  }
  r = await http(`${R(fr, fo)}/compare/wide-base...wide-head?nocache=1`);
  rec('compare.wide', r, {}, { ...r.cost, treeReads: r.json?.treeReads ?? 0 });

  rec('tree.get', await http(`${R(A)}/tree?ref=main`), { segments: 0 });
  rec('tree.get', await http(`${R(A)}/tree?ref=main&path=src`), { segments: 1 });
  rec('contents.get', await http(`${R(A)}/contents?path=about.txt&ref=main`), { kind: 'branch' });
  await http(`${R(A)}/contents?path=about.txt&ref=${repos.c2}`);
  rec('contents.get', await http(`${R(A)}/contents?path=about.txt&ref=${repos.c2}`), { kind: 'sha' });
  rec('events.list', await http(`${R(A)}/events?limit=20`));

  rec('snap.meta.first', await http(`${R(A)}/snapshots/main`));
  const meta = await snapReady(A, 'main');
  buildSample('snapbuild.small', meta);
  for (let i = 0; i < 2; i++) rec(['snap.meta.warm', 'warm.serviceRow'], await http(`${R(A)}/snapshots/main`));
  rec('snap.meta.anon', await http(`${R(A)}/snapshots/main`, { token: null }));
  const sha = meta.json.sha;
  rec('snap.download.miss', await http(`${R(A)}/snapshots/${sha}/download`, { binary: true }));
  rec('snap.download.hit', await http(`${R(A)}/snapshots/${sha}/download`, { binary: true }));
  rec('checkout.ready', await http(`${R(A)}/snapshots/main`, { method: 'POST', headers: { accept: 'application/json' } }), { kind: 'demand' });
  rec('checkout.ready', await http(`${R(A)}/snapshots/${sha}/download`, { binary: true }), { kind: 'download' });
  const out = join(live.work, 'checkout');
  const co = spawnSync(process.execPath, [join(ROOT, 'apps/cli/bin/kvarm.js'), 'checkout', `${OWNER}/${A}`, 'main', out], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, KVARM_BASE_URL: BASE, KVARM_PAT: PAT } });
  say(`  kvarm checkout -> exit ${co.status}; ${(co.stdout.match(/source: \w+/) ?? ['source: ?'])[0]}`);
  rec('snap.demand.noApi', await http(`${R(A)}/snapshots/main`, { method: 'POST', token: TOKENS.noApi }));

  rec(['snap.demand'], await http(`${R(A)}/snapshots/feature`, { method: 'POST' }));
  buildSample('snapbuild.demanded', await snapReady(A, 'feature'));
  const la = repos.la;
  await la.branch('same', 'feature');
  await la.commit({}, 'same tree as feature');
  await la.push(gitUrl(A), ['same']);
  await http(`${R(A)}/snapshots/same`, { method: 'POST' });
  const same = await snapReady(A, 'same');
  expect(same.json.reused === true, `same-tree build reused=${same.json.reused}`);
  buildSample('snapbuild.reuse', same);
  await la.branch('many', 'main');
  const many = {};
  for (let i = 0; i < 1200; i++) many[`many/f${String(i).padStart(4, '0')}.txt`] = `file ${i}\n`;
  await la.commit(many, '1,200 files');
  await la.push(gitUrl(A), ['many']);
  await http(`${R(A)}/snapshots/many`, { method: 'POST' });
  buildSample('snapbuild.many', await snapReady(A, 'many', 300_000));
  await la.branch('main', 'main');
  const fx = await http(`${R(fr, fo)}/snapshots/bench-head`);
  if (fx.json?.state === 'ready') buildSample('snapbuild.fixture1m', fx);
  else say(`  fixture snapshot bench-head state ${fx.json?.state ?? fx.status}`);
});

// ---------------------------------------------------------------------------
const CONFLICT_LINES = (side) => `${Array.from({ length: 10 }, (_, i) => (i === 4 ? `line 5 ${side}` : `line ${i + 1}`)).join('\n')}\n`;

await phase('change requests, conflicts, tasks', async () => {
  const B = (repos.B = await createRepo('flow'));
  const lb = (repos.lb = local('flow'));
  await lb.init();
  const m0 = await lb.commit({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n', 'lines.txt': CONFLICT_LINES('base'), 'shared.txt': 'shared 1\nshared 2\n', 'src/util.ts': 'export const u = 1;\n', 'docs/n.md': 'n\n' }, 'seed');
  const fork = async (branch, files) => {
    await lb.branch(branch, m0);
    return lb.commit(files, branch);
  };
  const heads = {
    f1: await fork('f1', { 'a.txt': 'a1\n' }),
    f2: await fork('f2', { 'c2.txt': 'draft\n' }),
    f3: await fork('f3', { 'd.txt': 'd\n' }),
    f5: await fork('f5', { 'b.txt': 'b5\n' }),
    f6: await fork('f6', { 'e.txt': 'e\n' }),
    cr: await fork('c-review', { 'lines.txt': CONFLICT_LINES('review') }),
    ca: await fork('c-auto', { 'lines.txt': CONFLICT_LINES('auto') }),
  };
  await lb.branch('main', m0);
  await lb.push(gitUrl(B), ['main', 'f1', 'f2', 'f3', 'f5', 'f6', 'c-review', 'c-auto']);
  const ch = (path = '') => `${R(B)}/changes${path}`;
  const create = (head, mergePolicy = 'review') => http(ch(), { method: 'POST', json: { title: `sweep ${head}`, base: 'main', head, mergePolicy } });

  const c1 = rec('changes.create', await create('f1'));
  expect(c1.status === 201, `create f1 -> ${c1.status} ${c1.text.slice(0, 160)}`);
  rec('changes.create.missing', await create('nope'));
  rec('changes.list', await http(ch()));
  rec('changes.listAll', await http(ch('?state=all')));
  await http(ch('/1'));
  for (let i = 0; i < 5; i++) rec('changes.detail.open', await http(ch('/1')));
  rec('changes.checks', await http(ch('/1/checks')));
  rec('changes.mergeability', await http(ch('/1/mergeability')), { kind: 'cold' });
  rec('changes.mergeability', await http(ch('/1/mergeability')), { kind: 'warm' });
  rec('changes.patch', await http(ch('/1'), { method: 'PATCH', json: { title: 'sweep f1 (patched)' } }));
  rec('commit.status', await http(`${R(B)}/commits/${heads.f1}/status`));
  rec('checkruns.post', await http(`${R(B)}/check-runs`, { method: 'POST', json: { headSha: heads.f1, name: 'lint', conclusion: 'success' } }));
  const m1 = rec('changes.merge.ff', await http(ch('/1/merge'), { method: 'POST' }));
  expect(m1.status === 200, `merge #1 -> ${m1.status} ${m1.text.slice(0, 160)}`);
  rec('changes.detail.closed', await http(ch('/1')));

  const c2 = await create('f2', 'draft');
  rec('changes.merge.draft', await http(ch(`/${c2.json.number}/merge`), { method: 'POST' }));

  // main moves (a direct push on this rule-less repo) so later merges are three-way
  const main1 = await lb.fetchMain(gitUrl(B));
  await lb.branch('main', main1);
  await lb.commit({ 'lines.txt': CONFLICT_LINES('main') }, 'main side of line 5');
  await lb.push(gitUrl(B), ['main']);

  const c4 = await create('f5');
  const m4 = rec('changes.merge.threeWay', await http(ch(`/${c4.json.number}/merge`), { method: 'POST' }));
  expect(m4.status === 200 && m4.json?.merge?.kind === 'merge', `three-way merge -> ${m4.status} ${m4.json?.merge?.kind ?? m4.text.slice(0, 160)}`);

  const c5 = rec(['changes.create.conflict'], await create('c-review'));
  expect(c5.json?.state === 'conflicted', `c-review state ${c5.json?.state}`);
  const c6 = rec('changes.create.autoConflict', await create('c-auto', 'auto'));
  expect(c6.json?.state === 'conflicted', `c-auto state ${c6.json?.state}`);
  // the merge just above moved main; letting its push event land first keeps the create off the documented re-plan path
  await sleep(12_000);
  const c7res = await create('f6', 'auto');
  const c7 = rec('changes.create.autoMerged', c7res, { kind: c7res.json?.mergeCommit && c7res.json.mergeCommit === c7res.json.headSha ? 'fast-forward' : 'two-parent' });
  expect(c7.json?.state === 'merged', `auto f6 state ${c7.json?.state} ${c7.text.slice(0, 160)}`);

  const n5 = c5.json.number;
  const n6 = c6.json.number;
  await http(ch(`/${n5}`));
  rec('changes.detail.conflicted', await http(ch(`/${n5}`)));
  await http(ch(`/${n5}/mergeability`));
  rec('changes.mergeability.conflicted', await http(ch(`/${n5}/mergeability`)));
  rec('changes.merge.conflict', await http(ch(`/${n5}/merge`), { method: 'POST' }));

  const agent = (repos.agentB = await agentFor(B, ['refs/heads/*']));
  const tl = rec('tasks.list', await http(`${R(B)}/tasks?status=open`));
  const taskOf = (n) => tl.json.tasks.find((t) => t.change?.number === n);
  const t5 = taskOf(n5);
  const t6 = taskOf(n6);
  expect(t5 && t6, `tasks for #${n5}/#${n6}: ${tl.text.slice(0, 200)}`);
  rec('task.get', await http(`${R(B)}/tasks/${t5.id}`));

  async function resolve(task, head, side, tag) {
    const cl = rec(tag === 'task.complete' ? 'task.claim' : [], await http(`${R(B)}/tasks/${task.id}/claim`, { method: 'POST', token: agent.token, json: { ttlSeconds: 600 } }));
    expect(cl.status === 200, `claim -> ${cl.status} ${cl.text.slice(0, 160)}`);
    const gen = cl.json.lease.generation;
    if (tag === 'task.complete') {
      rec('task.claim.refused', await http(`${R(B)}/tasks/${task.id}/claim`, { method: 'POST', token: agent.token, json: { ttlSeconds: 600 } }));
      rec('task.heartbeat', await http(`${R(B)}/tasks/${task.id}/heartbeat`, { method: 'POST', token: agent.token, json: { generation: gen } }));
      rec('task.complete.refused', await http(`${R(B)}/tasks/${task.id}/complete`, { method: 'POST', token: agent.token, json: { generation: gen, sha: head } }));
    }
    const mainNow = await lb.fetchMain(gitUrl(B));
    await lb.g(['checkout', '-q', '--detach', head]);
    await lb.g(['merge', '-q', '--no-edit', mainNow], { allowFail: true });
    lb.write({ 'lines.txt': CONFLICT_LINES(`resolved ${side}`) });
    await lb.g(['add', '-A']);
    await lb.g(['commit', '-q', '--no-edit']);
    const sha = await lb.g(['rev-parse', 'HEAD']);
    await lb.push(gitUrl(B), [`${sha}:${cl.json.workspace.ref}`], agent.token);
    const done = rec(tag, await http(`${R(B)}/tasks/${task.id}/complete`, { method: 'POST', token: agent.token, json: { generation: gen, sha } }));
    expect(done.status === 200, `complete -> ${done.status} ${done.text.slice(0, 200)}`);
    return { sha, done };
  }
  const r5 = await resolve(t5, heads.cr, 'review', 'task.complete');
  rec('changes.detail.transition', await http(ch(`/${n5}`)));
  await until(
    `kvarm/guard at the resolution of #${n5}`,
    async () => (await http(ch(`/${n5}/checks`))).json?.checks?.some((k) => k.name === 'kvarm/guard' && k.headSha === r5.sha && k.status !== 'queued' && k.status !== 'running'),
    90_000,
    1000,
  );
  const m5 = rec('changes.merge.resolved', await http(ch(`/${n5}/merge`), { method: 'POST' }));
  expect(m5.status === 200, `merge resolved #${n5} -> ${m5.status} ${m5.text.slice(0, 160)}`);
  const r6 = await resolve(t6, heads.ca, 'auto', 'task.complete.auto');
  expect(r6.done.json?.change?.state === 'merged', `auto completion state ${r6.done.json?.change?.state}`);

  // HEAD_MOVED: a head push answered by an immediate merge, before the push event lands
  const c3 = await create('f3');
  let moved = null;
  await lb.branch('f3', heads.f3);
  for (let i = 0; i < 3 && !moved; i++) {
    await lb.commit({ 'd.txt': `d${i + 2}\n` }, `f3 move ${i}`);
    await lb.push(gitUrl(B), ['f3']);
    const m = await http(ch(`/${c3.json.number}/merge`), { method: 'POST' });
    if (m.status === 409 && m.json?.code === 'HEAD_MOVED') moved = rec('changes.merge.headMoved', m);
    else say(`  head-moved attempt ${i + 1}: ${m.status} ${m.json?.code ?? ''}`);
    if (m.status === 200) break;
  }
  await lb.branch('main', 'main');
});

// ---------------------------------------------------------------------------
await phase('workspaces, Nexus, candidates, arenas, attribution, MCP', async () => {
  const B = repos.B;
  const agent = repos.agentB;
  expect(B && agent, 'no flow repo');
  const lb = repos.lb;
  const wsPost = (json, tag) => http(`${R(B)}/workspaces`, { method: 'POST', token: agent.token, json }).then((r) => rec(tag, r));
  const wsA = await wsPost({ task: 'sweep a' }, 'ws.create');
  const wsB = await wsPost({ task: 'sweep b', intent: { paths: ['docs/n.md'] } }, 'ws.create.intent');
  const wsC = await wsPost({ task: 'sweep c' }, 'ws.create');
  const wsD = await wsPost({ task: 'sweep d' }, 'ws.create');
  for (const w of [wsA, wsB, wsC, wsD]) expect(w.status === 201, `workspace -> ${w.status} ${w.text.slice(0, 160)}`);
  await lb.fetchMain(gitUrl(B));
  async function wsCommit(ws, files) {
    await lb.g(['checkout', '-q', '--detach', ws.json.baseSha]);
    const sha = await lb.commit(files, ws.json.ref);
    await lb.push(gitUrl(B), [`${sha}:${ws.json.ref}`], agent.token);
    return sha;
  }
  await wsCommit(wsA, { 'src/util.ts': 'export const u = 2;\n' });
  await wsCommit(wsB, { 'docs/n.md': 'n2\n' });
  await wsCommit(wsC, { 'shared.txt': 'shared C\nshared 2\n' });
  await wsCommit(wsD, { 'shared.txt': 'shared D\nshared 2\n' });
  await until(
    'observed paths of workspace a',
    async () => {
      const r = await http(`${R(B)}/workspaces/${wsA.json.id}/intent`);
      return r.json?.observedCurrent && r.json.observedPaths?.length ? r : null;
    },
    90_000,
    1500,
  );
  rec('ws.get', await http(`${R(B)}/workspaces/${wsA.json.id}`));
  rec(['ws.list', 'warm.serviceRow'], await http(`${R(B)}/workspaces`));
  let cursor = null;
  for (let i = 0; i < 3; i++) {
    const p = rec('fleet.wsPages', await http(`${R(B)}/workspaces?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
    cursor = p.json?.nextCursor;
    if (!cursor) break;
  }
  rec('intent.get', await http(`${R(B)}/workspaces/${wsA.json.id}/intent`));
  rec('intent.post', await http(`${R(B)}/workspaces/${wsB.json.id}/intent`, { method: 'POST', json: { paths: ['docs/n.md', 'docs/'] } }), { kind: 'person' });
  for (let i = 0; i < 2; i++) rec(['forecast', 'forecast.exact', 'fleet.forecast'], await http(`${R(B)}/forecast?paths=src/util.ts`));
  rec(['forecast', 'forecast.prefix'], await http(`${R(B)}/forecast?paths=src/`));
  for (let i = 0; i < 2; i++) rec(['overlap', 'fleet.overlap'], await http(`${R(B)}/workspaces/overlap?base=main&limit=50`));

  const pair = `${wsA.json.id},${wsB.json.id}`;
  rec('cand.cold', await http(`${R(B)}/candidates?base=main&workspaces=${pair}`));
  for (let i = 0; i < 5; i++) rec(['cand.warm'], await http(`${R(B)}/candidates?base=main&workspaces=${pair}`));
  const nine = Array.from({ length: 9 }, () => randomBytes(8).toString('hex')).join(',');
  rec('cand.overCap', await http(`${R(B)}/candidates?base=main&workspaces=${nine}`));
  const comp = rec('compose.clean', await http(`${R(B)}/candidates/compose`, { method: 'POST', json: { base: 'main', workspaces: [wsA.json.id, wsB.json.id] } }));
  expect(comp.status === 201, `compose -> ${comp.status} ${comp.text.slice(0, 160)}`);
  rec('composition.get', await http(`${R(B)}/compositions/${comp.json.id}`));
  rec('composition.list', await http(`${R(B)}/compositions?limit=10`));
  rec('compose.refused', await http(`${R(B)}/candidates/compose`, { method: 'POST', json: { base: 'main', workspaces: [wsC.json.id, wsD.json.id] } }));

  const arena = await http(`${R(B)}/arenas`, { method: 'POST', token: agent.token, json: { brief: 'cost-sweep arena', base: 'main', candidates: 2 } });
  rec('arena.create', arena, { n: 2 });
  expect(arena.status === 201, `arena -> ${arena.status} ${arena.text.slice(0, 160)}`);
  rec('arena.read', await http(`${R(B)}/arenas/${arena.json.id}`));
  rec('arena.read', await http(`${R(B)}/arenas?limit=10`));
  await http(`${R(B)}/arenas/${arena.json.id}/candidates`);
  for (let i = 0; i < 2; i++) rec('arena.cand.warm', await http(`${R(B)}/arenas/${arena.json.id}/candidates`));
  rec('arena.select', await http(`${R(B)}/arenas/${arena.json.id}/select`, { method: 'POST', json: { workspace: arena.json.workspaces[0].id } }));

  const cs = rec('ws.changeSet', await http(`${R(B)}/workspaces/${wsB.json.id}/change-set`, { method: 'POST', token: agent.token, json: { title: 'sweep workspace b' } }));
  expect(cs.status === 201, `change-set -> ${cs.status} ${cs.text.slice(0, 160)}`);
  const wm = rec('ws.merge', await http(`${R(B)}/changes/${cs.json.number}/merge`, { method: 'POST' }));
  say(`  workspace change merge -> ${wm.status} ${wm.json?.code ?? wm.json?.merge?.kind ?? ''}`);
  rec('ws.abandon', await http(`${R(B)}/workspaces/${wsD.json.id}/abandon`, { method: 'POST', token: agent.token }));

  const target = (await http(`${R(B)}/changes/1`)).json?.headSha;
  rec('attr.post', await http(`${R(B)}/commits/${target}/attribution`, { method: 'POST', json: { agent: 'cost-sweep', session: `s-${TS}`, promptHash: `sha256:${'a'.repeat(64)}`, model: 'none' } }));
  rec('attr.get', await http(`${R(B)}/commits/${target}/attribution`));
  rec('decision.post', await http(`${R(B)}/decisions`, { method: 'POST', json: { task: `sweep-${TS}`, paths: ['a.txt'], chosen: 'keep a', rejected: ['drop a'], reason: 'cost sweep sample' } }));
  rec('context.get', await http(`${R(B)}/context?task=sweep-${TS}`), { branches: 1, limit: 20 });

  // MCP
  rec('mcp.init', await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cost-sweep', version: '0' } } }));
  rec('mcp.unauth', await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: null }));
  rec('mcp.unauth', await http('/mcp', { method: 'POST', auth: `Bearer ${badPat()}`, headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }));
  const sha = (await http(`${R(B)}/changes/1`)).json?.headSha;
  await http(`${R(B)}/contents?path=a.txt&ref=${sha}`);
  const rest = await http(`${R(B)}/contents?path=a.txt&ref=${sha}`);
  for (let i = 0; i < 5; i++) {
    const r = rec('mcp.call', await mcp(tool('read_file', { repo: `${OWNER}/${B}`, path: 'a.txt', ref: sha })), { rest: rest.cost });
    expect(r.status === 200 && !r.json?.result?.isError, `read_file -> ${r.status} ${r.text.slice(0, 160)}`);
  }
  rec('mcp.oversize', await mcp(null, { raw: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(1_100_000) } }) }));
  const forkName = repoName('mcpfork');
  const fk = rec('mcp.repoOps', await mcp(tool('fork_repo', { repo: `${OWNER}/${B}`, name: forkName })), { kind: 'fork' });
  if (fk.status === 200 && !fk.json?.result?.isError) {
    const del = rec('mcp.repoOps', await mcp(tool('delete_repo', { repo: `${OWNER}/${forkName}` })), { kind: 'delete' });
    if (del.json?.result?.isError) created.push({ owner: OWNER, name: forkName });
  } else say(`  fork_repo -> ${fk.status} ${fk.text.slice(0, 160)}`);
});

// ---------------------------------------------------------------------------
await phase('merge queue, train, reviews, dependencies, CI', async () => {
  const Q = (repos.Q = await createRepo('queue'));
  const lq = local('queue');
  await lq.init();
  const q0 = await lq.commit({ 'q.txt': 'q\n', 'docs/q.md': 'q\n' }, 'seed');
  const fork = async (branch, files) => {
    await lq.branch(branch, q0);
    return lq.commit(files, branch);
  };
  await fork('qb1', { 'q1.txt': '1\n' });
  await fork('qdraft', { 'qd.txt': 'd\n' });
  await fork('qci', { 'qc.txt': 'c\n', '.kvarm/ci.json': `${JSON.stringify({ jobs: [{ name: 'test', run: 'true', required: true, timeoutSeconds: 60 }] })}\n` });
  await fork('r1', { 'r1.txt': '1\n' });
  await fork('r2', { 'r2.txt': '2\n' });
  await lq.branch('main', q0);
  await lq.push(gitUrl(Q), ['main', 'qb1', 'qdraft', 'qci', 'r1', 'r2']);
  const ch = (p = '') => `${R(Q)}/changes${p}`;
  const create = (head, mergePolicy = 'review') => http(ch(), { method: 'POST', json: { title: `sweep ${head}`, base: 'main', head, mergePolicy } });
  const merged = (n, ms = 240_000) => until(`#${n} merged`, async () => ((await http(ch(`/${n}`))).json?.state === 'merged' ? true : null), ms, 2000);

  const b1 = await create('qb1');
  repos.branchChange = b1.json.number;
  const e1 = rec(['enqueue.branch'], await http(ch(`/${b1.json.number}/enqueue`), { method: 'POST', json: {} }));
  expect(e1.status === 201, `enqueue -> ${e1.status} ${e1.text.slice(0, 160)}`);
  rec('queue.get', await http(`${R(Q)}/queue`));
  rec('train.get', await http(`${R(Q)}/train?base=main`));
  await merged(b1.json.number);

  const d = await create('qdraft', 'draft');
  rec('enqueue.refused', await http(ch(`/${d.json.number}/enqueue`), { method: 'POST', json: {} }));

  const qc = await create('qci');
  const eq = await http(ch(`/${qc.json.number}/enqueue`), { method: 'POST', json: {} });
  if (eq.status === 201) rec('enqueue.branch', eq);
  rec('enqueue.delete', await http(ch(`/${qc.json.number}/enqueue`), { method: 'DELETE' }));
  const claim = await until(
    'a claimable CI job',
    async () => {
      const r = await http(`${R(Q)}/ci/jobs/claim`, { method: 'POST', json: { runnerId: `sweep-${TS}` } });
      return r.status === 200 ? r : null;
    },
    60_000,
    2000,
  );
  rec('ci.claim', claim);
  const job = claim.json.job;
  rec('ci.heartbeat', await http(`${R(Q)}/ci/jobs/${job.id}/heartbeat`, { method: 'POST', json: { runnerId: `sweep-${TS}`, generation: job.generation } }));
  rec('ci.report', await http(`${R(Q)}/ci/jobs/${job.id}/report`, { method: 'POST', json: { runnerId: `sweep-${TS}`, generation: job.generation, conclusion: 'success', summary: { by: 'cost-sweep' } } }));

  // review policy, approvals, escalations, the protected-target gate
  rec('review.policy.put', await http(`${R(Q)}/review-policy`, { method: 'PUT', json: { requiredReviews: 1 } }));
  rec('review.policy.get', await http(`${R(Q)}/review-policy`));
  // the rule exists before the human approval: an approval only closes a protected-path escalation opened before it
  const rule = rec('rules.write', await http(`${R(Q)}/branch-rules`, { method: 'POST', json: { pattern: 'main', requiredApprovals: 1 } }), { created: true });
  expect(rule.status === 201, `main rule -> ${rule.status}`);
  const r1 = await create('r1');
  const r2 = await create('r2');
  rec('enqueue.reviewRefused', await http(ch(`/${r1.json.number}/enqueue`), { method: 'POST', json: {} }));
  rec('grants', await http(`${R(Q)}/grants/${LOGINS.maint}`, { method: 'PUT', json: { role: 'write' } }));
  rec('review.post', await http(ch(`/${r1.json.number}/approve`), { method: 'POST', token: TOKENS.maint, json: {} }));
  rec('review.list', await http(ch(`/${r1.json.number}/reviews`)));
  rec('reviews.pending', await http(`${R(Q)}/reviews/pending`));
  rec('reviewers.assign', await http(ch(`/${r1.json.number}/reviewers/assign`), { method: 'POST', json: {} }));
  await http(ch(`/${r2.json.number}/request-changes`), { method: 'POST', token: TOKENS.maint, json: { body: 'cost sweep' } });
  const packet = await http(ch(`/${r2.json.number}/reviews`));
  const esc = packet.json?.escalations?.find((e) => !e.resolvedAt && e.state !== 'resolved') ?? packet.json?.escalations?.[0];
  if (esc) rec('escalation.resolve', await http(ch(`/${r2.json.number}/escalations/${esc.id}/resolve`), { method: 'POST', json: { resolution: 'resolve', note: 'cost sweep' } }));
  else say(`  no escalation on #${r2.json.number}: ${packet.text.slice(0, 200)}`);
  await http(`${R(Q)}/review-policy`, { method: 'PUT', json: { requiredReviews: 0 } });
  const ep = rec('enqueue.protected', await http(ch(`/${r1.json.number}/enqueue`), { method: 'POST', json: {} }));
  expect(ep.status === 201, `protected enqueue -> ${ep.status} ${ep.text.slice(0, 160)}`);
  await merged(r1.json.number);
  rec('rules.write', await http(`${R(Q)}/branch-rules/${rule.json.rule.id}`, { method: 'DELETE' }));

  // pinned dependencies and workspace-backed publications
  const agent = (repos.agentQ = await agentFor(Q, ['refs/heads/agents/*']));
  const ws = {};
  const mainNow = await lq.fetchMain(gitUrl(Q));
  for (const k of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7']) {
    const w = rec('ws.create', await http(`${R(Q)}/workspaces`, { method: 'POST', token: agent.token, json: { task: `sweep ${k}` } }));
    expect(w.status === 201, `workspace ${k} -> ${w.status}`);
    await lq.g(['checkout', '-q', '--detach', w.json.baseSha ?? mainNow]);
    const sha = await lq.commit({ [`ws/${k}.txt`]: `${k}\n` }, k);
    await lq.push(gitUrl(Q), [`${sha}:${w.json.ref}`], agent.token);
    ws[k] = { id: w.json.id, head: sha };
  }
  const pin = (from, on, revision) => http(`${R(Q)}/workspaces/${ws[from].id}/dependencies`, { method: 'POST', json: { onWorkspace: ws[on].id, revision } });
  const p21 = rec('deps.create', await pin('w2', 'w1', ws.w1.head));
  expect(p21.status === 201, `pin w2->w1 -> ${p21.status} ${p21.text.slice(0, 160)}`);
  rec('deps.create', await pin('w3', 'w1', ws.w1.head));
  rec('deps.create', await pin('w5', 'w4', ws.w4.head));
  rec('deps.create', await pin('w3', 'w4', ws.w4.head));
  rec('deps.refused', await pin('w1', 'w2', ws.w2.head));
  rec('deps.revNotCurrent', await pin('w6', 'w1', 'f'.repeat(40)));
  await http(`${R(Q)}/workspaces/${ws.w2.id}/dependencies`);
  rec(['deps.list'], await http(`${R(Q)}/workspaces/${ws.w2.id}/dependencies`));
  rec('deps.repin', await http(`${R(Q)}/workspaces/${ws.w2.id}/dependencies/${p21.json.id}/repin`, { method: 'POST', json: { revision: ws.w1.head } }));
  const p64 = await pin('w6', 'w4', ws.w4.head);
  if (p64.status === 201) rec('deps.delete', await http(`${R(Q)}/workspaces/${ws.w6.id}/dependencies/${p64.json.id}`, { method: 'DELETE' }));
  for (const p of ['/workspaces?status=active&limit=100', `/workspaces/${ws.w2.id}/dependencies`, '/train', '/tasks?status=open']) rec('status.reads', await http(`${R(Q)}${p}`));

  const numbers = {};
  for (const k of ['w1', 'w2', 'w3', 'w4', 'w5', 'w7']) {
    const cs = await http(`${R(Q)}/workspaces/${ws[k].id}/change-set`, { method: 'POST', token: agent.token, json: { title: `sweep ${k}` } });
    expect(cs.status === 201, `change-set ${k} -> ${cs.status} ${cs.text.slice(0, 160)}`);
    numbers[k] = cs.json.number;
  }
  for (const k of ['w1', 'w4', 'w7', 'w2', 'w3', 'w5']) {
    const pinned = ['w2', 'w3', 'w5'].includes(k);
    const e = rec(pinned ? 'fleet.enqueuePinned' : ['enqueue.ws', 'fleet.enqueue'], await http(ch(`/${numbers[k]}/enqueue`), { method: 'POST', json: {} }));
    expect(e.status === 201, `enqueue ${k} -> ${e.status} ${e.text.slice(0, 160)}`);
  }
  for (const k of ['w1', 'w4', 'w7', 'w2', 'w3', 'w5']) await merged(numbers[k], 420_000);
  repos.queueNumbers = numbers;
  rec('ws.abandon', await http(`${R(Q)}/workspaces/${ws.w6.id}/abandon`, { method: 'POST', token: agent.token }));
});

// ---------------------------------------------------------------------------
// VAL-COST-026 dependency classes: the same depth-4 chain in a fresh repo and in
// one with 12 unrelated workspaces (6 pinned to each other), its depth-5 and
// cycle refusals, a cross-repo probe, and the warm list. Refusals and reads are
// repeated in the same session (and the depth-4 edge detached and re-created),
// so the small-vs-many comparison judges medians at the documented ±3.
await phase('dependency classes (depth 4, depth 5, cycle, cross-repo, many workspaces)', async () => {
  const REPEATS = 3;
  const env = {};
  for (const side of ['small', 'many']) {
    const name = await createRepo(`deps-${side}`);
    const l = local(`deps-${side}`);
    await l.init();
    const base = await l.commit({ 'deps.txt': `${side}\n` }, 'seed');
    await l.push(gitUrl(name), ['main']);
    env[side] = { name, l, base, agent: await agentFor(name, ['refs/heads/agents/*']) };
  }
  const wsCreate = async (side, task) => {
    const w = await http(`${R(env[side].name)}/workspaces`, { method: 'POST', token: env[side].agent.token, json: { task } });
    expect(w.status === 201, `${side} workspace "${task}" -> ${w.status} ${w.text.slice(0, 160)}`);
    return w.json;
  };
  const pin = (side, from, on, revision) => http(`${R(env[side].name)}/workspaces/${from}/dependencies`, { method: 'POST', json: { onWorkspace: on, revision } });

  const noise = [];
  for (let i = 0; i < 12; i++) noise.push(await wsCreate('many', `noise ${i}`));
  let noisePins = 0;
  for (let i = 1; i < noise.length; i += 2) if ((await pin('many', noise[i].id, noise[i - 1].id, noise[i - 1].headSha)).status === 201) noisePins++;
  say(`  many-workspace repo: ${noise.length} unrelated workspaces, ${noisePins} of 6 pins among them created`);

  const chain = {};
  for (const side of ['small', 'many']) {
    const { l, name, agent, base } = env[side];
    chain[side] = [];
    for (let i = 1; i <= 5; i++) {
      const w = await wsCreate(side, `chain ${i}`);
      await l.g(['checkout', '-q', '--detach', w.baseSha ?? base]);
      const head = await l.commit({ [`chain/${i}.txt`]: `${i}\n` }, `chain ${i}`);
      await l.push(gitUrl(name), [`${head}:${w.ref}`], agent.token);
      chain[side].push({ id: w.id, head });
    }
  }
  // A pin's source read joins the push-event ref row: measure once GET workspaces lists every pushed head.
  for (const side of ['small', 'many']) {
    await until(
      `${side} chain heads recorded`,
      async () => {
        const r = await http(`${R(env[side].name)}/workspaces?status=active&limit=100`);
        const seen = new Map((r.json?.workspaces ?? []).map((w) => [w.id, w.headSha]));
        return chain[side].every((w) => seen.get(w.id) === w.head) ? true : null;
      },
      90_000,
      2000,
    );
  }

  for (const side of ['small', 'many']) {
    const x = chain[side];
    let top = null;
    for (let i = 1; i < 4; i++) {
      const r = rec('deps.create', await pin(side, x[i].id, x[i - 1].id, x[i - 1].head), { kind: `depth${i + 1}`, side });
      expect(r.status === 201 && r.json?.depth === i + 1, `${side} pin depth ${i + 1} -> ${r.status} depth ${r.json?.depth} ${r.text.slice(0, 160)}`);
      top = r.json.id;
    }
    for (let k = 1; k < REPEATS; k++) {
      const off = rec('deps.delete', await http(`${R(env[side].name)}/workspaces/${x[3].id}/dependencies/${top}`, { method: 'DELETE' }));
      expect(off.status === 200, `${side} detach depth-4 edge -> ${off.status}`);
      const again = rec('deps.create', await pin(side, x[3].id, x[2].id, x[2].head), { kind: 'depth4', side });
      expect(again.status === 201 && again.json?.depth === 4, `${side} re-pin depth 4 -> ${again.status} depth ${again.json?.depth}`);
      top = again.json.id;
    }
    await http(`${R(env[side].name)}/workspaces/${x[3].id}/dependencies`);
    for (let k = 0; k < REPEATS; k++) {
      const deep = rec('deps.refused', await pin(side, x[4].id, x[3].id, x[3].head), { kind: 'depth5', side });
      expect(deep.status === 422 && deep.json?.code === 'DEPENDENCY_DEPTH_EXCEEDED', `${side} depth 5 -> ${deep.status} ${deep.json?.code}`);
      const cyc = rec('deps.refused', await pin(side, x[0].id, x[1].id, x[1].head), { kind: 'cycle', side });
      expect(cyc.status === 422 && cyc.json?.code === 'DEPENDENCY_CYCLE', `${side} cycle -> ${cyc.status} ${cyc.json?.code}`);
      const list = rec('deps.list', await http(`${R(env[side].name)}/workspaces/${x[3].id}/dependencies`), { kind: 'warm', side });
      expect(list.status === 200 && list.json?.dependencies?.[0]?.depth === 4, `${side} warm list -> ${list.status} depth ${list.json?.dependencies?.[0]?.depth}`);
    }
  }
  for (const [side, other] of [['small', 'many'], ['many', 'small']]) {
    const foreign = chain[other][0];
    const cross = rec('deps.refused', await pin(side, chain[side][4].id, foreign.id, foreign.head), { kind: 'crossRepo', side });
    expect(cross.status === 404 && cross.json?.code === 'SOURCE_NOT_FOUND', `cross-repo ${side} -> ${other}: ${cross.status} ${cross.json?.code}`);
  }
  const show = (tag, kind) => {
    const line = (side) =>
      (samples.get(tag) ?? [])
        .filter((s) => s.extra?.kind === kind && s.extra?.side === side)
        .map((s) => `d1=${s.cost.d1};rr=${s.cost.rr}`)
        .join(', ');
    say(`  ${kind.padEnd(9)} small repo ${line('small')} | many-workspace repo ${line('many')}`);
  };
  for (const [tag, kind] of [['deps.create', 'depth2'], ['deps.create', 'depth4'], ['deps.refused', 'depth5'], ['deps.refused', 'cycle'], ['deps.refused', 'crossRepo'], ['deps.list', 'warm']]) show(tag, kind);
});

// ---------------------------------------------------------------------------
await phase('container CI runner route', async () => {
  if (args['skip-container']) {
    say('  skipped (--skip-container)');
    return;
  }
  let result = null;
  const ok = await runContainerShowcase({ base: BASE, pat: PAT, ts: TS, log: (l) => say(`  ${l}`), onResult: (r) => (result = r) });
  for (const mode of ['cold', 'warm']) if (result?.runs?.[mode]?.cost) rec('container.run', { status: 200, cost: parseCost(result.runs[mode].cost), ms: result.runs[mode].wall });
  if (result?.resetCost) rec('container.reset', { status: 200, cost: parseCost(result.resetCost), ms: 0 });
  expect(ok, 'container showcase failed');
});

// ---------------------------------------------------------------------------
await phase('stored counters and push-event lines', async () => {
  for (const name of [repos.A, repos.B, repos.Q, repos.P].filter(Boolean)) {
    let cursor = null;
    for (let i = 0; i < 5; i++) {
      const r = await http(`${R(name)}/events?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const e of r.json?.events ?? []) eventsById.set(e.id, e);
      cursor = r.json?.nextCursor;
      if (!cursor) break;
    }
  }
  const names = [repos.A, repos.B, repos.Q, repos.P].filter(Boolean).map((n) => `'${n}'`).join(',');
  const [ids] = live.d1(`SELECT id, name FROM repos WHERE owner_login = '${OWNER}' AND name IN (${names})`);
  for (const r of ids) repoIds.set(r.id, r.name);
  const qid = ids.find((r) => r.name === repos.Q)?.id;
  if (qid) {
    const [rowsQ] = live.d1(`SELECT change_number, state, cost FROM merge_queue WHERE repo_id = '${qid}' ORDER BY seq`);
    queueRows.push(...rowsQ);
  }
});

await phase('cleanup', async () => {
  for (const id of agents) rec('agents.delete', await http(`/api/v1/agents/${id}`, { method: 'DELETE' }));
  if (args.keep) {
    say(`  kept: ${created.map((c) => `${c.owner}/${c.name}`).join(', ')}`);
    return;
  }
  for (const c of created) {
    const r = await http(R(c.name, c.owner), { method: 'DELETE' });
    if (c.owner === OWNER) rec('repo.delete', r);
    say(`  DELETE ${c.name} -> ${r.status}`);
  }
});

const tailErr = await tail.stop(15_000);
const lines = tailLogLines(tail.read());
say(`\n== tail: ${lines.length} JSON log lines${tailErr && !lines.length ? ` (${tailErr.slice(0, 200)})` : ''}`);
const ourEvent = (id) => eventsById.get(id);
let consumerSeen = 0;
for (const l of lines) {
  const j = l.json;
  if (j.trainPublished) {
    const tp = j.trainPublished;
    if (repoIds.get(tp.repo) === repos.Q && tp.number === repos.branchChange) recCounters('pub.completed.branch', 'stored', tp.cost);
    continue;
  }
  if (j.outcome === 'train' && j.train) {
    recCounters('train.run', 'log', { ...j.cost, passes: j.train.passes }, { reason: j.train.reason });
    for (const pc of j.train.passCosts ?? []) recCounters('train.passes', 'stored', pc);
    continue;
  }
  if (!j.eventId || !ourEvent(j.eventId)) continue;
  consumerSeen++;
  const ev = ourEvent(j.eventId);
  const hooks = ev.effects?.find((e) => e.effect === 'change-hooks');
  const cost = { ...j.cost, wf: j.wf };
  if (j.outcome !== 'processed' || j.attempts > 1) continue;
  // a done change-hooks effect is a head push of a live change ("heads #n", a composed workspace's change set included)
  // or a base push re-evaluating conflicted auto changes ("base: …")
  if (hooks?.state === 'done') recCounters('consumer.changeHooks', 'log', cost, { detail: hooks.detail, ref: ev.ref });
  else if (ev.ref.startsWith('refs/heads/agents/')) recCounters('consumer.push.workspace', 'log', cost, { ref: ev.ref });
  else recCounters('consumer.push.initial', 'log', cost, { ref: ev.ref });
}
say(`  consumer lines for this run's push events: ${consumerSeen} of ${eventsById.size} events`);

const qn = repos.queueNumbers ?? {};
const byNumber = new Map(queueRows.filter((r) => r.state === 'published' && r.cost).map((r) => [r.change_number, JSON.parse(r.cost)]));
const stored = (tags, n) => byNumber.has(n) && recCounters(tags, 'stored', byNumber.get(n), { number: n });
for (const n of byNumber.keys()) recCounters('pub.stored.any', 'stored', byNumber.get(n), { number: n });
stored('pub.stored.branch', repos.branchChange);
// keyed on incoming pins (the publishing dependent's own pins), as scripts/lib/fleet.mjs keys them: w3 pins w1 and w4, w2 and w5 one source each
stored('pub.stored.twoPin', qn.w3);
for (const n of [qn.w2, qn.w5]) stored(['pub.stored.onePin', 'fleet.pubOnePin'], n);
stored(['pub.stored.unpinned', 'fleet.pubUnpinned'], qn.w7);

// ---------------------------------------------------------------------------
const verdicts = [];
for (const row of rows) {
  const entry = coverage.matched.get(row);
  if (!entry) {
    verdicts.push({ row, v: { status: 'fail', problems: ['no catalog entry'] } });
    continue;
  }
  let v;
  try {
    v = evaluateEntry(entry, samples);
  } catch (err) {
    v = { id: entry.id, status: 'fail', problems: [String(err instanceof Error ? err.message : err)] };
  }
  verdicts.push({ row, v });
}
const fmtCost = (m) => (m ? Object.entries(m).map(([k, x]) => `${k}=${x}`).join(';') : '');
say('\n== per-row verdicts (line, section, endpoint: verdict)');
for (const { row, v } of verdicts) {
  const head = `L${String(row.line).padStart(3)} ${v.status.toUpperCase().padEnd(7)} [${row.section.slice(0, 38)}] ${row.endpoint.slice(0, 90)}${row.state ? ` (${row.state.slice(0, 30)})` : ''}`;
  if (v.status === 'n/a') say(`${head}\n         non-live (${v.category}): ${v.reason}`);
  else say(`${head}\n         ${v.id}: n=${v.n ?? 0} budget \`${v.budget ?? ''}\` median \`${fmtCost(v.median)}\`${v.problems?.length ? `\n         problems: ${v.problems.join('; ')}` : ''}`);
}
const summary = summarizeVerdicts(
  verdicts.map((x) => x.v),
  coverage,
);
say(`\n== phases: ${phases.map((p) => `${p.name} ${p.ok ? 'ok' : 'FAILED'} (${(p.ms / 1000).toFixed(0)} s)`).join('; ')}`);
for (const n of notes) say(`  note: ${n}`);
say(`== requests: ${live.state.requests} of the ${live.state.ceiling} ceiling`);
say(`== sweep rows ${summary.rows} vs cost.md table rows ${documentRows}${summary.rows === documentRows ? ' (equal)' : ' (MISMATCH)'}`);
say(`== ${summary.pass} pass, ${summary.fail} fail, ${summary.missing} missing, ${summary.na} non-live with reason; unmatched ${summary.unmatched}, ambiguous ${summary.ambiguous}, unused ${summary.unused}`);
const ok = summary.ok && summary.rows === documentRows && phases.every((p) => p.ok);
say(`== cost sweep ${ok ? 'PASSED' : 'FAILED'}`);
if (args.out) {
  writeFileSync(
    args.out,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        summary,
        documentRows,
        phases,
        verdicts: verdicts.map(({ row, v }) => ({ line: row.line, section: row.section, endpoint: row.endpoint, state: row.state, ...v })),
        samples: Object.fromEntries([...samples.entries()].map(([k, xs]) => [k, xs.map((s) => ({ status: s.status, format: s.format ?? 'http', cost: s.cost, extra: s.extra }))])),
      },
      null,
      2,
    )}\n`,
  );
  say(`report: ${args.out}`);
}
rmSync(live.work, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
