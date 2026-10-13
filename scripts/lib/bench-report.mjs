/**
 * Pure pieces of scripts/bench.mjs: span statistics, cache hit rates and the
 * committed docs/benchmarks/README.md table.
 */

import { findMonetary, percentile } from './fleet.mjs';

export const BENCH_GROUPS = Object.freeze([
  'Clone vs snapshot',
  'Compare timings',
  'Edge cache hit rates',
  'Per-endpoint cost medians',
  'Overlap forecast and composition',
  '100-workspace fleet run',
  'Dev-loop and CI turnaround',
  'Container CI: cold vs snapshot-warm',
]);

const MIN_COST_ROWS = 8;

export function spanStats(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!xs.length) return { n: 0, min: null, p50: null, max: null };
  return { n: xs.length, min: Math.min(...xs), p50: percentile(xs, 50), max: Math.max(...xs) };
}

export function cacheRate(costs) {
  const hits = costs.filter((c) => c?.cache === 'hit').length;
  return { requests: costs.length, hits, rate: costs.length ? hits / costs.length : 0 };
}

const ms = (v) => (v === null || v === undefined ? '-' : v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const sec = (v) => (v === null || v === undefined ? '-' : `${(v / 1000).toFixed(1)} s`);
const pct = (hits, n) => (n ? `${Math.round((hits / n) * 100)}%` : '-');
const statCells = (s) => `${s?.n ?? 0} | ${ms(s?.min)} | ${ms(s?.p50)} | ${ms(s?.max)}`;
const mib = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MiB` : `${(b / 1024).toFixed(1)} KiB`);
const counter = (m, k) => (m?.[k] === undefined ? '0' : String(m[k]));

export function renderBenchReadme(r) {
  const out = [];
  const push = (...lines) => out.push(...lines);
  push(
    '# Benchmarks',
    '',
    'Measured against the deployed worker by `node scripts/bench.mjs` (see "Reproduce" below). Every timing is a client-side `Date.now()` span around the request or process; every counter is the `x-kvarm-cost` header the worker returns. The counters are work counts (D1 round trips, Artifacts RPCs, Durable Object calls, R2 reads, subrequests), not a bill.',
    '',
    `Generated ${r.generatedAt} from commit \`${r.commit}\`${r.worker ? ` against worker version \`${r.worker}\`` : ''}; client ${r.client}.`,
    '',
    'Detailed reports: [clone vs snapshot](clone-vs-snapshot.md), [compare](compare.md), [100-workspace fleet](fleet-100.md), [runner warm workdir](runner-warm-workdir.md), [container runner](container-runner.md).',
    '',
  );

  const cvs = r.cloneVsSnapshot;
  push(
    `## ${BENCH_GROUPS[0]}`,
    '',
    `Wall time to materialize a ref into an empty directory, median of ${cvs.runs} runs per variant (measured ${cvs.measuredAt}).`,
    '',
    '| target | files | tree bytes | `git clone` + checkout | `git clone --depth=1` | `kvarm checkout` (snapshot) |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...cvs.targets.map((t) => `| ${t.name} | ${t.files} | ${mib(t.bytes)} | ${ms(t.clone.p50)} | ${ms(t.shallow.p50)} | ${ms(t.snapshot.p50)} |`),
    '',
  );

  const c = r.compare;
  push(
    `## ${BENCH_GROUPS[1]}`,
    '',
    `Fixture: ${c.fixture}. Cold runs use the instance-admin \`?nocache=1\` bypass, which reads and writes no compare cache entry; warm runs repeat the same URL after the tree-pair body is cached.`,
    '',
    '| state | n | min | p50 | max | `x-kvarm-cost` (last run) |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    `| cold (bypass) | ${statCells(c.cold)} | \`${c.coldCost}\` |`,
    `| warm (cache hit) | ${statCells(c.warm)} | \`${c.warmCost}\` |`,
    '',
  );

  push(
    `## ${BENCH_GROUPS[2]}`,
    '',
    'Share of repeated requests answered from the Cache API (`cache=hit` in `x-kvarm-cost`). The first request of each URL fills the entry and counts as a miss. The authority lookup still runs on every hit.',
    '',
    '| surface | requests | hits | hit rate |',
    '| --- | ---: | ---: | ---: |',
    ...r.cache.map((x) => `| ${x.surface} | ${x.requests} | ${x.hits} | ${pct(x.hits, x.requests)} |`),
    '',
  );

  push(
    `## ${BENCH_GROUPS[3]}`,
    '',
    'Median of each counter over n requests of the same endpoint in the same state, compared with its budget (the `budget` column; `scripts/lib/cost-catalog.mjs` holds every budget spec and `scripts/cost-sweep.mjs` checks them).',
    '',
    '| endpoint | n | d1 | art | do | r2b | sub | cache | budget | verdict |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |',
    ...r.costs.map((x) => `| ${x.endpoint} | ${x.n} | ${counter(x.median, 'd1')} | ${counter(x.median, 'art')} | ${counter(x.median, 'do')} | ${counter(x.median, 'r2b')} | ${counter(x.median, 'sub')} | ${x.median?.cache ?? 'none'} | \`${x.budget}\` | ${x.ok ? 'within' : 'outside'} |`),
    '',
  );

  push(
    `## ${BENCH_GROUPS[4]}`,
    '',
    '| call | n | min | p50 | max | methodology |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    `| overlap forecast (\`GET …/forecast\`) | ${statCells(r.forecast.stats)} | ${r.forecast.method} |`,
    `| composition (\`POST …/candidates/compose\`) | ${statCells(r.compose.stats)} | ${r.compose.method} |`,
    '',
  );

  const f = r.fleet;
  push(
    `## ${BENCH_GROUPS[5]}`,
    '',
    `From the committed [fleet-100](fleet-100.md) run (finished ${f.measuredAt}).`,
    '',
    '| measure | value |',
    '| --- | --- |',
    `| active workspaces | ${f.workspaces} |`,
    `| changes published through the train | ${f.published} |`,
    `| burst window (first enqueue -> last publication) | ${sec(f.windowMs)} |`,
    `| throughput (publications per minute over the burst window) | ${f.throughputPerMin} |`,
    `| enqueue -> published latency, server clock (p50 / p90) | ${sec(f.latency?.p50)} / ${sec(f.latency?.p90)} |`,
    `| enqueue \`x-kvarm-cost\`, median per counter (all published) | \`${f.enqueue}\` |`,
    `| stored publication cost, median per counter (all published) | \`${f.publication}\` |`,
    `| longest interval with no queue entry reaching a terminal state | ${sec(f.idleMs)} |`,
    `| driver checks | ${f.checks} |`,
    '',
  );

  push(
    `## ${BENCH_GROUPS[6]}`,
    '',
    'Wall-clock turnaround of the developer and CI loop, from the client side.',
    '',
    '| metric | n | min | p50 | max | methodology |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...r.loop.map((x) => `| ${x.metric} | ${statCells(x.stats)} | ${x.method} |`),
    '',
  );

  const k = r.container;
  push(
    `## ${BENCH_GROUPS[7]}`,
    '',
    'Container CI runner (Cloudflare Containers, public beta): run 1 starts from the image, prepares the workspace and saves it with `snapshotContainer`; run 2 starts from that snapshot and skips setup. "total" is measured inside the controlling Durable Object, "wall" is the client round trip of `POST …/ci/container-runs`, "ready to run" is boot plus setup. One sample per run; container start times in the beta vary.',
    '',
    '| run | total | wall | ready to run |',
    '| --- | ---: | ---: | ---: |',
    `| run 1 cold | ${sec(k.cold.totalMs)} | ${sec(k.cold.wall)} | ${sec(k.cold.readyMs)} |`,
    `| run 2 snapshot-warm | ${sec(k.warm.totalMs)} | ${sec(k.warm.wall)} | ${sec(k.warm.readyMs)} |`,
    '',
  );

  push(
    '## Reproduce',
    '',
    '```sh',
    'set -a; . ./.env.local; set +a   # KVARM_BASE_URL, KVARM_PAT (instance admin, api + ci scopes)',
    'node scripts/bench.mjs --write                         # rewrites this file',
    'node scripts/cost-sweep.mjs --cost-md <path to cost.md> # every budget row, non-zero exit on a violation',
    '```',
    '',
  );
  return out.join('\n');
}

function sectionBody(md, title) {
  const start = md.indexOf(`## ${title}\n`);
  if (start < 0) return null;
  const rest = md.slice(start + title.length + 4);
  const end = rest.search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end);
}

/** Problems that make a benchmark README unfit to commit; empty when it is fine. */
export function checkBenchReadme(md) {
  const problems = [];
  for (const g of BENCH_GROUPS) if (sectionBody(md, g) === null) problems.push(`missing group: ${g}`);
  const costs = sectionBody(md, BENCH_GROUPS[3]);
  if (costs !== null) {
    const rows = costs.split('\n').filter((l) => l.startsWith('|') && !/^\|\s*(endpoint\s*\||---)/.test(l));
    if (rows.length < MIN_COST_ROWS) problems.push(`cost table has ${rows.length} endpoint rows (< ${MIN_COST_ROWS})`);
    for (const row of rows) if (/\|\s*outside\s*\|\s*$/.test(row)) problems.push(`cost row outside its budget: ${row.split('|')[1].trim()}`);
  }
  for (const m of md.matchAll(/\b(TBD|TODO|XXX|placeholder)\b/gi)) problems.push(`placeholder: ${m[0]}`);
  for (const m of findMonetary(md)) problems.push(`monetary: ${m}`);
  return problems;
}
