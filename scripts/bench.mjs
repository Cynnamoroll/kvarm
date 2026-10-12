#!/usr/bin/env node
/**
 * Benchmark entrypoint: measures the deployed worker and renders the
 * committed table in docs/benchmarks/README.md.
 *
 *   set -a; . apps/platform/.dev.vars.validation; set +a
 *   node scripts/bench.mjs [--samples 10] [--write] [--out report.json] [--reuse clone,runner,container] [--keep]
 *
 * Groups (scripts/lib/bench-report.mjs BENCH_GROUPS):
 * - clone vs snapshot: scripts/bench-clone-vs-snapshot.mjs --write (3 runs per variant)
 * - compare cold/warm on the fixture (cold = instance-admin ?nocache=1 bypass)
 * - edge cache hit rates and per-endpoint x-kvarm-cost medians (>= 5 requests
 *   per endpoint, each checked against its library/cost.md row through
 *   scripts/lib/cost-catalog.mjs)
 * - overlap forecast and composition timings over two overlapping agent workspaces
 * - the committed 100-workspace fleet run (docs/benchmarks/fleet-100.json)
 * - dev-loop turnaround: explicit merge, mergeability cold/warm, push ->
 *   kvarm/guard recorded, push -> CI job claimable, runner claim -> report
 *   (scripts/runner-warm-bench.mjs) and Container CI cold vs snapshot-warm
 *
 * Every timing is a client Date.now() span around one request or child
 * process; push-triggered spans start before `git push` and end at the
 * server-recorded timestamp or at the response that first shows the result
 * (250 ms poll). --reuse takes the named groups from the committed
 * docs/benchmarks/bench.json (clone: clone-vs-snapshot.json) instead of
 * re-measuring them. --write rewrites docs/benchmarks/README.md and bench.json.
 *
 * Isolation: scratch repos m7-benchmarks-cost-sweep-bench-<ts> and
 * m7-benchmarks-cost-sweep-loopci-<ts> plus two scratch agents, removed at the
 * end unless --keep. Bounded: <= 5 HTTP requests and <= 3 git children in
 * flight (child benchmarks run one at a time), 429/Retry-After honored, a
 * 10,000-request ceiling. Tokens are never printed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { cacheRate, checkBenchReadme, renderBenchReadme, spanStats } from './lib/bench-report.mjs';
import { CATALOG } from './lib/cost-catalog.mjs';
import { evaluateEntry, medianCounters } from './lib/cost-sweep.mjs';
import { parseCost } from './lib/fleet.mjs';
import { ROOT, createLive, sleep } from './lib/live.mjs';
import { runContainerShowcase } from './lib/container-runner-demo.mjs';

const { values: args } = parseArgs({
  options: {
    samples: { type: 'string', default: '10' },
    write: { type: 'boolean', default: false },
    out: { type: 'string', default: '' },
    reuse: { type: 'string', default: '' },
    keep: { type: 'boolean', default: false },
  },
});
const N = Math.max(5, Number(args.samples) || 10);
const REUSE = new Set(args.reuse.split(',').filter(Boolean));
const DOCS = join(ROOT, 'docs/benchmarks');
const BENCH_JSON = join(DOCS, 'bench.json');
const BASE = process.env.KVARM_BASE_URL;
const PAT = process.env.KVARM_PAT;
const OWNER = process.env.KVARM_USER;
if (!BASE || !PAT || !OWNER) {
  console.error('missing KVARM_BASE_URL / KVARM_PAT / KVARM_USER: source apps/platform/.dev.vars.validation first');
  process.exit(2);
}
const FIXTURE = process.env.KVARM_FIXTURE_REPO ?? `${OWNER}/fixture-1m`;
const previous = existsSync(BENCH_JSON) ? JSON.parse(readFileSync(BENCH_JSON, 'utf8')) : null;
for (const g of REUSE) {
  if (!['clone', 'runner', 'container'].includes(g)) {
    console.error(`--reuse accepts clone, runner, container (got ${g})`);
    process.exit(2);
  }
  if (g !== 'clone' && !previous?.[g]) {
    console.error(`--reuse ${g}: docs/benchmarks/bench.json has no measured ${g} group`);
    process.exit(2);
  }
}

const live = createLive({ base: BASE, pat: PAT, log: (l) => console.log(l) });
const { http, git } = live;
const TS = Math.floor(Date.now() / 1000);
const R = (name, owner = OWNER) => `/api/v1/repos/${owner}/${name}`;
const gitUrl = (name) => `${BASE}/${OWNER}/${name}.git`;
const say = (s) => console.log(s);
const created = [];
const agents = [];
const failures = [];

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function until(label, fn, ms, every = 1000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`${label}: not within ${ms / 1000} s`);
    await sleep(every);
  }
}
async function phase(name, fn) {
  const t0 = Date.now();
  say(`\n== ${name}`);
  try {
    await fn();
    say(`   ${name}: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    say(`   ${name} FAILED: ${msg}`);
  }
}
const fmtStats = (s) => `n=${s.n} min ${s.min} ms, p50 ${s.p50} ms, max ${s.max} ms`;
const costString = (m) => Object.entries(m ?? {}).map(([k, v]) => `${k}=${v}`).join(';');

async function createRepo(purpose) {
  const name = `m7-benchmarks-cost-sweep-${purpose}-${TS}`;
  const r = await http('/api/v1/repos', { method: 'POST', json: { name, visibility: 'public', description: 'bench scratch repo' } });
  expect(r.status === 201, `create ${name} -> ${r.status} ${r.text.slice(0, 120)}`);
  created.push(name);
  return name;
}
function local(dirName) {
  const dir = join(live.work, dirName);
  mkdirSync(dir, { recursive: true });
  const g = (a, o = {}) => git(a, { cwd: dir, ...o });
  return {
    g,
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
    async checkout(name, from) {
      await g(['checkout', '-q', '-B', name, from]);
    },
    push: (url, refspecs, token = PAT) => g(['push', '-q', url, ...refspecs], { network: true, token }),
  };
}
async function agentFor(repo, label) {
  const a = await http('/api/v1/agents', { method: 'POST', json: { name: `bench-${TS}-${label}`, description: 'bench scratch agent' } });
  expect(a.status === 201, `agent create -> ${a.status} ${a.text.slice(0, 120)}`);
  agents.push(a.json.agent.id);
  const t = await http(`/api/v1/agents/${a.json.agent.id}/tokens`, { method: 'POST', json: { repo: `${OWNER}/${repo}`, role: 'write', refs: ['refs/heads/agents/*'], expiresIn: 3600 } });
  expect(t.status === 201, `agent token -> ${t.status} ${t.text.slice(0, 120)}`);
  return t.json.token;
}

// Per-endpoint cost rows: the first request of a URL fills its entry (kept for
// the hit rate), the next >= 5 are the measured samples.
const costRows = [];
async function measure(endpoint, entryId, request, { n = 5, extra = () => ({}), fill = true } = {}) {
  const entry = CATALOG.find((e) => e.id === entryId);
  expect(entry, `no catalog entry ${entryId}`);
  const fills = [];
  if (fill) {
    const f = await request();
    fills.push(f.cost);
  }
  const samples = [];
  for (let i = 0; i < n; i++) {
    const r = await request();
    samples.push({ status: r.status, cost: r.cost, extra: { ...extra(r), ms: r.ms } });
  }
  costRows.push({ endpoint, entry, fills, samples });
  return samples;
}

const report = {
  generatedAt: '',
  commit: '',
  worker: null,
  client: `${platform()} ${release()}/${arch()} (${cpus().length} CPUs), Node ${process.version}`,
};

// ---------------------------------------------------------------------------
await phase('compare on the fixture (cold bypass vs warm cache hit)', async () => {
  const [fo, fr] = FIXTURE.split('/');
  const url = `${R(fr, fo)}/compare/bench-base...bench-head`;
  const cold = [];
  let coldCost = '';
  let files = null;
  for (let i = 0; i < N; i++) {
    const r = await http(`${url}?nocache=1`);
    expect(r.status === 200 && r.headers.get('x-kvarm-cache') === 'bypass', `cold compare -> ${r.status} ${r.headers.get('x-kvarm-cache')}`);
    cold.push(r.ms);
    coldCost = r.raw;
    files = r.json?.files?.length ?? r.json?.totalFiles ?? files;
  }
  const warmSamples = await measure('warm compare (fixture, 502 changed files)', 'cmp-warm', () => http(url), { n: N });
  const warm = warmSamples.map((s) => s.extra.ms);
  report.compare = {
    fixture: `\`${FIXTURE}\` \`bench-base...bench-head\` (${files ?? 502} changed files)`,
    cold: spanStats(cold),
    warm: spanStats(warm),
    coldCost: coldCost.replace(/;?(r2a|r2b|q)=0/g, ''),
    warmCost: costString(warmSamples.at(-1).cost).replace(/;?(r2a|r2b|q)=0/g, ''),
  };
  say(`   cold ${fmtStats(report.compare.cold)}; warm ${fmtStats(report.compare.warm)}`);
});

// ---------------------------------------------------------------------------
const UTIL = (top, bottom) =>
  `${Array.from({ length: 40 }, (_, i) => (i === 2 ? `// ${top}` : i === 37 ? `// ${bottom}` : `export const v${i + 1} = ${i + 1};`)).join('\n')}\n`;
const bench = {};

await phase('scratch repo, workspaces, overlap forecast and composition', async () => {
  const A = (bench.repo = await createRepo('bench'));
  const l = (bench.local = local('bench'));
  await l.g(['init', '-q', '-b', 'main']);
  const seed = await l.commit(
    { 'about.txt': 'bench scratch repo\n', 'src/util.js': UTIL('top: base', 'bottom: base'), 'src/limits.js': 'export const WINDOW = 5;\n', 'src/config.js': 'export const LIMIT = 10;\n', 'docs/guide.md': '# guide\n' },
    'seed',
  );
  bench.seed = seed;
  await l.checkout('feature', seed);
  await l.commit({ 'src/config.js': 'export const LIMIT = 20;\n', 'src/extra.js': 'export const extra = 1;\n' }, 'feature');
  const branches = ['feature'];
  for (let i = 1; i <= N + 1; i++) {
    await l.checkout(`m${i}`, seed);
    await l.commit({ [`loop/m${i}.txt`]: `merge sample ${i}\n` }, `merge sample ${i}`);
    branches.push(`m${i}`);
  }
  await l.checkout('main', seed);
  await l.push(gitUrl(A), ['main', ...branches]);

  const tokA = await agentFor(A, 'a');
  const tokB = await agentFor(A, 'b');
  const w1 = await http(`${R(A)}/workspaces`, { method: 'POST', token: tokA, json: { task: 'rate limit', intent: { paths: ['src/util.js', 'src/limits.js'] } } });
  const w2 = await http(`${R(A)}/workspaces`, { method: 'POST', token: tokB, json: { task: 'retries', intent: { paths: ['src/util.js', 'docs/guide.md'] } } });
  expect(w1.status === 201 && w2.status === 201, `workspaces -> ${w1.status}/${w2.status}`);
  bench.w1 = w1.json;
  bench.w2 = w2.json;
  await l.g(['checkout', '-q', '--detach', seed]);
  const a1 = await l.commit({ 'src/util.js': UTIL('top: token bucket', 'bottom: base'), 'src/limits.js': 'export const WINDOW = 10;\n' }, 'rate limit');
  await l.push(gitUrl(A), [`${a1}:${w1.json.ref}`], tokA);
  await l.g(['checkout', '-q', '--detach', seed]);
  const b1 = await l.commit({ 'src/util.js': UTIL('top: base', 'bottom: retry once'), 'docs/guide.md': '# guide\n\nTransient failures are retried once.\n' }, 'retries');
  await l.push(gitUrl(A), [`${b1}:${w2.json.ref}`], tokB);
  for (const w of [w1.json, w2.json]) {
    await until(
      `observed head of ${w.id}`,
      async () => {
        const r = await http(`${R(A)}/workspaces/${w.id}/intent`);
        return r.json?.observedCurrent && r.json?.observedPaths?.length ? r : null;
      },
      90_000,
    );
  }

  const fc = [];
  let fcCost = null;
  for (let i = 0; i < N; i++) {
    const r = await http(`${R(A)}/forecast?paths=src/util.js,docs/guide.md&exclude=${w2.json.id}`, { token: tokB });
    expect(r.status === 200 && r.json?.matches?.some((m) => m.workspace === w1.json.id), `forecast -> ${r.status} ${r.text.slice(0, 160)}`);
    fc.push(r.ms);
    fcCost = r.cost;
  }
  report.forecast = {
    stats: spanStats(fc),
    method: `${N} identical calls (\`paths=src/util.js,docs/guide.md\`, excluding the caller's workspace) over 2 active agent workspaces with declared and observed paths overlapping on \`src/util.js\`, in a 6-file repo; the forecast has no response cache (\`cache=${fcCost?.cache ?? 'none'}\`), so every call reads the Nexus index (\`d1=${fcCost?.d1 ?? 0}\`)`,
  };
  say(`   forecast ${fmtStats(report.forecast.stats)}`);

  const cp = [];
  for (let i = 0; i < N; i++) {
    const r = await http(`${R(A)}/candidates/compose`, { method: 'POST', json: { base: 'main', workspaces: [w1.json.id, w2.json.id], title: `bench composition ${i + 1}`, mergePolicy: 'draft' } });
    expect(r.status === 201 && r.json?.conflict === null, `compose -> ${r.status} ${r.text.slice(0, 160)}`);
    cp.push(r.ms);
  }
  report.compose = {
    stats: spanStats(cp),
    method: `${N} compositions of the same 2 workspaces (one clean merge3 hunk each in \`src/util.js\` plus one file each); every call folds both pieces, writes and pushes a new composed commit and records a workspace and a draft change set, so no run is served from a cache`,
  };
  say(`   compose ${fmtStats(report.compose.stats)}`);
});

// ---------------------------------------------------------------------------
await phase('per-endpoint cost medians and cache hit rates', async () => {
  const A = bench.repo;
  expect(A, 'no scratch repo');
  const cmp = `${R(A)}/compare/main...feature`;
  await measure('per-file diff', 'cmp-file-warm', () => http(`${cmp}/file?path=src/config.js`));
  await measure('repo page `GET /:o/:r` (anonymous)', 'per-page', () => http(`/${OWNER}/${A}`, { token: null }), { extra: () => ({ kind: 'warm' }) });
  await measure('git gate `info/refs` (anonymous)', 'per-inforefs-warm', () => http(`/${OWNER}/${A}.git/info/refs?service=git-upload-pack`, { token: null }));

  await http(`${R(A)}/snapshots/main`, { method: 'POST', headers: { accept: 'application/json' } });
  const meta = await until(
    'snapshot of main',
    async () => {
      const r = await http(`${R(A)}/snapshots/main`);
      if (r.json?.state === 'failed') throw new Error(`snapshot failed: ${r.json.error}`);
      return r.json?.state === 'ready' ? r : null;
    },
    240_000,
    2000,
  );
  await measure('snapshot metadata (warm ref)', 'snap-meta-warm', () => http(`${R(A)}/snapshots/main`), { fill: false });
  await measure('snapshot download (by SHA, edge cached)', 'perf-snap-hit', () => http(`${R(A)}/snapshots/${meta.json.sha}/download`, { binary: true }));

  const c = await http(`${R(A)}/changes`, { method: 'POST', json: { title: 'bench feature', base: 'main', head: 'feature' } });
  expect(c.status === 201, `change -> ${c.status} ${c.text.slice(0, 160)}`);
  bench.featureChange = c.json.number;
  await measure('change detail (open)', 'cr-detail', () => http(`${R(A)}/changes/${c.json.number}`));
  await measure('workspace list', 'ws-list', () => http(`${R(A)}/workspaces`));
  const pair = `${bench.w1.id},${bench.w2.id}`;
  await measure('candidates (2 workspaces)', 'cand-warm', () => http(`${R(A)}/candidates?base=main&workspaces=${pair}`));

  const sha = bench.seed;
  await http(`${R(A)}/contents?path=src/limits.js&ref=${sha}`);
  const rest = await http(`${R(A)}/contents?path=src/limits.js&ref=${sha}`);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: { repo: `${OWNER}/${A}`, path: 'src/limits.js', ref: sha } } });
  await measure(
    'MCP `read_file`',
    'mcp-call',
    () => http('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body }),
    { extra: () => ({ rest: rest.cost }) },
  );
});

// ---------------------------------------------------------------------------
const loop = {};
await phase('explicit merge and mergeability (cold vs warm)', async () => {
  const A = bench.repo;
  expect(A, 'no scratch repo');
  const numbers = [];
  for (let i = 1; i <= N + 1; i++) {
    const c = await http(`${R(A)}/changes`, { method: 'POST', json: { title: `merge sample ${i}`, base: 'main', head: `m${i}` } });
    expect(c.status === 201, `change m${i} -> ${c.status} ${c.text.slice(0, 160)}`);
    numbers.push(c.json.number);
  }
  const merges = [];
  const kinds = [];
  const cold = [];
  const warm = [];
  const coldArt = [];
  let retries = 0;
  for (let i = 0; i < N; i++) {
    let m;
    for (let attempt = 0; ; attempt++) {
      m = await http(`${R(A)}/changes/${numbers[i]}/merge`, { method: 'POST' });
      if (m.status === 409 && m.json?.code === 'REQUIRED_CHECKS_PENDING' && attempt < 30) {
        retries++;
        await sleep(1000);
        continue;
      }
      break;
    }
    expect(m.status === 200, `merge #${numbers[i]} -> ${m.status} ${m.text.slice(0, 160)}`);
    merges.push(m.ms);
    kinds.push(m.json?.merge?.kind ?? '?');
    // main just moved, so the next change's (target, head) plan is a cache miss
    const c1 = await http(`${R(A)}/changes/${numbers[i + 1]}/mergeability`);
    const c2 = await http(`${R(A)}/changes/${numbers[i + 1]}/mergeability`);
    expect(c1.status === 200 && c2.status === 200, `mergeability -> ${c1.status}/${c2.status}`);
    cold.push(c1.ms);
    warm.push(c2.ms);
    coldArt.push(c1.cost.art ?? 0);
    expect((c2.cost.art ?? 0) === 0, `warm mergeability read art=${c2.cost.art}`);
  }
  const ff = kinds.filter((k) => k === 'fast-forward').length;
  loop.merge = {
    stats: spanStats(merges),
    method: `\`POST …/changes/:n/merge\` until its 200 (publication happens inside the request); ${N} changes adding one file each: ${ff} fast-forward, ${N - ff} three-way (main moved by the previous merge)${retries ? `; ${retries} early attempts answered 409 REQUIRED_CHECKS_PENDING and are not counted` : ''}`,
  };
  loop.mergeCold = {
    stats: spanStats(cold),
    method: `first \`GET …/mergeability\` of a change right after main moved: new (target, head) pair, merge plan computed (\`art\` ${Math.min(...coldArt)}-${Math.max(...coldArt)})`,
  };
  loop.mergeWarm = { stats: spanStats(warm), method: 'the same read repeated: plan served from the content-addressed cache (`art=0`), gate asked fresh' };
  say(`   merge ${fmtStats(loop.merge.stats)} (${kinds.join(',')}); mergeability cold ${fmtStats(loop.mergeCold.stats)} / warm ${fmtStats(loop.mergeWarm.stats)}`);
});

// ---------------------------------------------------------------------------
await phase('push -> kvarm/guard recorded and push -> CI job claimable', async () => {
  const L = (bench.loopRepo = await createRepo('loopci'));
  const l = local('loopci');
  await l.g(['init', '-q', '-b', 'main']);
  const ci = { jobs: [{ name: 'bench', run: 'true', required: true, timeoutSeconds: 60 }] };
  const seed = await l.commit({ 'about.txt': 'loop\n', '.kvarm/ci.json': `${JSON.stringify(ci)}\n` }, 'seed');
  await l.checkout('loop', seed);
  await l.commit({ 'loop.txt': '0\n' }, 'loop 0');
  await l.checkout('main', seed);
  await l.push(gitUrl(L), ['main', 'loop']);
  const c = await http(`${R(L)}/changes`, { method: 'POST', json: { title: 'loop', base: 'main', head: 'loop' } });
  expect(c.status === 201, `loop change -> ${c.status} ${c.text.slice(0, 160)}`);
  const n = c.json.number;
  const runnerId = `bench-${TS}`;
  const report1 = (job) => http(`${R(L)}/ci/jobs/${job.id}/report`, { method: 'POST', json: { runnerId, generation: job.generation, conclusion: 'success', summary: { by: 'bench' } } });
  const first = await until(
    'the creation-time CI job',
    async () => {
      const r = await http(`${R(L)}/ci/jobs/claim`, { method: 'POST', json: { runnerId } });
      return r.status === 200 ? r : null;
    },
    60_000,
  );
  await report1(first.json.job);

  await l.checkout('loop', 'loop');
  const guardServer = [];
  const guardSeen = [];
  const jobCreated = [];
  const claimSeen = [];
  const pushMs = [];
  for (let i = 1; i <= N; i++) {
    const sha = await l.commit({ 'loop.txt': `${i}\n` }, `loop ${i}`);
    const t0 = Date.now();
    await l.push(gitUrl(L), ['loop']);
    pushMs.push(Date.now() - t0);
    const deadline = t0 + 90_000;
    const guard = (async () => {
      let guardDone = false;
      // The CI check run is registered after the guard verdict, so polling continues until both are visible.
      for (;;) {
        const r = await http(`${R(L)}/changes/${n}/checks`);
        const runs = r.json?.checks ?? [];
        const g = runs.find((k) => k.name === 'kvarm/guard' && k.headSha === sha && k.status !== 'queued' && k.status !== 'running');
        if (g && !guardDone) {
          guardDone = true;
          guardSeen.push(Date.now() - t0);
          guardServer.push(Date.parse(g.finishedAt ?? g.createdAt) - t0);
        }
        const job = runs.find((k) => k.name === 'bench' && k.headSha === sha);
        if (guardDone && job) {
          jobCreated.push(Date.parse(job.createdAt) - t0);
          return;
        }
        if (Date.now() > deadline) {
          if (guardDone) return;
          throw new Error(`no kvarm/guard run at ${sha.slice(0, 10)} within 90 s`);
        }
        await sleep(250);
      }
    })();
    const claim = (async () => {
      for (;;) {
        const r = await http(`${R(L)}/ci/jobs/claim`, { method: 'POST', json: { runnerId } });
        if (r.status === 200) {
          if (r.json.job.sha === sha) {
            claimSeen.push(Date.now() - t0);
            await report1(r.json.job);
            return;
          }
          await report1(r.json.job);
          continue;
        }
        if (Date.now() > deadline) throw new Error(`no CI job at ${sha.slice(0, 10)} within 90 s`);
        await sleep(250);
      }
    })();
    await Promise.all([guard, claim]);
    say(`   sample ${i}: push ${pushMs.at(-1)} ms, guard recorded +${guardServer.at(-1)} ms (seen +${guardSeen.at(-1)}), CI job claimed +${claimSeen.at(-1)} ms`);
  }
  loop.guardServer = {
    stats: spanStats(guardServer),
    method: `Date.now() before \`git push\` to the server-recorded \`finishedAt\` of the guard run at the pushed head (host clock NTP-synchronized); ${N} pushes of a one-file change to an open change's head branch; \`git push\` itself took p50 ${spanStats(pushMs).p50} ms`,
  };
  loop.guardSeen = { stats: spanStats(guardSeen), method: 'the same pushes, ending at the first `GET …/changes/:n/checks` (polled every 250 ms) that shows the verdict' };
  loop.ciCreated = jobCreated.length
    ? { stats: spanStats(jobCreated), method: 'the same pushes, ending at the server-recorded `createdAt` of the queued CI check run (the job is claimable from then)' }
    : null;
  loop.ciClaim = { stats: spanStats(claimSeen), method: 'the same pushes, ending at the first `POST …/ci/jobs/claim` (polled every 250 ms) that returns the job for the pushed head' };
});

// ---------------------------------------------------------------------------
function runChild(label, argv) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, argv, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (d) => {
      out += d;
      for (const line of String(d).split('\n')) if (line.trim()) say(`   ${label} | ${line}`);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => resolve({ code, out, ms: Date.now() - t0 }));
  });
}

await phase('runner claim -> report, cold install vs warm workdir', async () => {
  if (REUSE.has('runner')) {
    report.runner = previous.runner;
    say(`   reused from docs/benchmarks/bench.json (measured ${report.runner.measuredAt})`);
    return;
  }
  const r = await runChild('runner-warm-bench', ['scripts/runner-warm-bench.mjs', '--samples', '5']);
  expect(r.code === 0, `runner-warm-bench exited ${r.code}`);
  const parse = (kind) => {
    const m = new RegExp(`^${kind} \\(.*claim->report ms: ([\\d, ]+); median`, 'm').exec(r.out);
    expect(m, `no ${kind} line in runner-warm-bench output`);
    return m[1].split(',').map((x) => Number(x.trim()));
  };
  report.runner = { measuredAt: new Date().toISOString(), cold: parse('cold'), warm: parse('warm'), checks: /(\d+\/\d+) checks passed/.exec(r.out)?.[1] ?? '' };
});

await phase('Container CI: cold run 1 vs snapshot-warm run 2', async () => {
  if (REUSE.has('container')) {
    report.container = previous.container;
    say(`   reused from docs/benchmarks/bench.json (measured ${report.container.measuredAt})`);
    return;
  }
  let result = null;
  const ok = await runContainerShowcase({ base: BASE, pat: PAT, ts: TS, log: (l) => say(`   ${l}`), onResult: (x) => (result = x) });
  expect(ok && result?.runs?.cold && result?.runs?.warm, 'container showcase failed');
  report.container = { measuredAt: new Date().toISOString(), cold: result.runs.cold, warm: result.runs.warm };
});

await phase('clone vs snapshot', async () => {
  if (!REUSE.has('clone')) {
    const r = await runChild('clone-vs-snapshot', ['scripts/bench-clone-vs-snapshot.mjs', '--runs=3', '--write']);
    expect(r.code === 0, `bench-clone-vs-snapshot exited ${r.code}`);
  }
  const j = JSON.parse(readFileSync(join(DOCS, 'clone-vs-snapshot.json'), 'utf8'));
  const st = (s) => ({ n: j.runs, min: s.minMs, p50: s.medianMs, max: s.maxMs });
  report.cloneVsSnapshot = {
    measuredAt: j.measuredAt,
    runs: j.runs,
    targets: j.targets.map((t) => ({
      name: t.target === 'fixture' ? `fixture (\`${t.repo}\`@\`${t.ref}\`)` : `small (${t.snapshot.files}-file scratch repo)`,
      files: t.snapshot.files,
      bytes: t.summary.clone.treeBytes,
      clone: st(t.summary.clone),
      shallow: st(t.summary.shallow),
      snapshot: st(t.summary.snapshot),
    })),
  };
});

// ---------------------------------------------------------------------------
await phase('cleanup', async () => {
  for (const id of agents) await http(`/api/v1/agents/${id}`, { method: 'DELETE' });
  if (args.keep) {
    say(`   kept ${created.join(', ')}`);
    return;
  }
  for (const name of created) say(`   DELETE ${name} -> ${(await http(R(name), { method: 'DELETE' })).status}`);
});

// ---------------------------------------------------------------------------
const fleetJson = JSON.parse(readFileSync(join(DOCS, 'fleet-100.json'), 'utf8'));
const medianOf = (xs) => costString(medianCounters(xs.map((x) => parseCost(x.cost))));
report.fleet = {
  measuredAt: fleetJson.run.finishedAt,
  workspaces: fleetJson.fleet.workspaces,
  published: fleetJson.burst.accepted,
  windowMs: fleetJson.burst.windowMs,
  throughputPerMin: fleetJson.burst.throughputPerMin,
  latency: fleetJson.burst.latencyMs,
  enqueue: medianOf(fleetJson.enqueueCosts),
  publication: medianOf(fleetJson.publicationCosts),
  idleMs: fleetJson.burst.longestIdle.ms,
  checks: `${fleetJson.passed}/${fleetJson.passed + (fleetJson.failed ?? 0)} passed`,
};

report.cache = costRows
  .filter((r) => [...r.fills, ...r.samples.map((s) => s.cost)].some((c) => c?.cache === 'hit' || c?.cache === 'miss'))
  .map((r) => ({ surface: r.endpoint, ...cacheRate([...r.fills, ...r.samples.map((s) => s.cost)]) }));
report.costs = costRows.map((r) => {
  const v = evaluateEntry({ ...r.entry, minSamples: 5 }, new Map([[r.entry.probe, r.samples]]));
  if (v.problems?.length) say(`   cost row ${r.endpoint}: ${v.problems.join('; ')}`);
  return { endpoint: r.endpoint, n: v.n, median: v.median, budget: r.entry.id === 'mcp-call' ? `${v.budget} (= the REST contents read)` : v.budget, ok: v.status === 'pass', row: r.entry.row };
});

const runnerStats = report.runner ? { cold: spanStats(report.runner.cold), warm: spanStats(report.runner.warm) } : null;
const runnerMethod = (w) =>
  `\`scripts/runner-warm-bench.mjs --samples 5\` (measured ${report.runner?.measuredAt?.slice(0, 10)}): the runner's own claim response -> report response span for \`npm install && npm test\` on a TypeScript + vitest fixture; ${w}`;
report.loop = [
  loop.merge && { metric: 'explicit merge (`POST …/merge` -> 200)', ...loop.merge },
  loop.mergeCold && { metric: 'mergeability, cold', ...loop.mergeCold },
  loop.mergeWarm && { metric: 'mergeability, warm', ...loop.mergeWarm },
  loop.guardServer && { metric: 'push -> kvarm/guard verdict recorded', ...loop.guardServer },
  loop.guardSeen && { metric: 'push -> kvarm/guard verdict visible to the client', ...loop.guardSeen },
  loop.ciCreated && { metric: 'push -> CI job created (claimable)', ...loop.ciCreated },
  loop.ciClaim && { metric: 'push -> CI job claimed by a polling client', ...loop.ciClaim },
  runnerStats && { metric: 'runner claim -> report, cold install (`--fresh`)', stats: runnerStats.cold, method: runnerMethod('empty workdir, full install from the machine npm cache, checkout by clone fallback') },
  runnerStats && { metric: 'runner claim -> report, warm workdir', stats: runnerStats.warm, method: runnerMethod('next commit delta-synced into the same workdir, node_modules reused') },
].filter(Boolean);

const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const dirty = spawnSync('git', ['status', '--porcelain', '--', 'scripts', 'apps', 'packages'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() !== '';
report.commit = `${head}${dirty ? ' (with uncommitted script changes)' : ''}`;
report.generatedAt = new Date().toISOString();

let md = null;
let problems = [];
try {
  md = renderBenchReadme(report);
  problems = checkBenchReadme(md);
} catch (err) {
  problems.push(`render failed: ${err instanceof Error ? err.message : err}`);
}
if (md) say(`\n${md}`);
say(`== requests: ${live.state.requests} of the ${live.state.ceiling} ceiling`);
for (const f of failures) say(`== FAILED phase ${f}`);
for (const p of problems) say(`== README problem: ${p}`);
const ok = failures.length === 0 && problems.length === 0;
const raw = { ...report, samples: Object.fromEntries(costRows.map((r) => [r.endpoint, r.samples.map((s) => ({ status: s.status, cost: s.cost, ms: s.extra.ms }))])) };
if (args.out) writeFileSync(args.out, `${JSON.stringify(raw, null, 2)}\n`);
if (args.write && ok) {
  writeFileSync(join(DOCS, 'README.md'), md);
  writeFileSync(BENCH_JSON, `${JSON.stringify(raw, null, 2)}\n`);
  say('wrote docs/benchmarks/README.md and docs/benchmarks/bench.json');
} else if (args.write) say('not writing docs/benchmarks/README.md: the run had failures');
rmSync(live.work, { recursive: true, force: true });
say(`== bench ${ok ? 'ok' : 'FAILED'}`);
process.exit(ok ? 0 : 1);
