/**
 * Pure pieces of the benchmark entrypoint (scripts/bench.mjs): span
 * statistics, cache hit rates and the committed docs/benchmarks/README.md
 * table with its required metric groups and its content checks.
 */

import { describe, expect, it } from 'vitest';
import { BENCH_GROUPS, cacheRate, checkBenchReadme, renderBenchReadme, spanStats } from '../lib/bench-report.mjs';

const stats = (p50: number) => ({ n: 5, min: p50 - 10, p50, max: p50 + 20 });

function sampleReport() {
  return {
    generatedAt: '2026-10-12T10:00:00.000Z',
    commit: 'abc1234',
    worker: '1234abcd',
    client: 'darwin/arm64, Node v26',
    cloneVsSnapshot: {
      measuredAt: '2026-10-12T09:00:00.000Z',
      runs: 3,
      targets: [
        { name: 'fixture', files: 502, bytes: 33_000_000, clone: stats(27_000), shallow: stats(1_800), snapshot: stats(4_200) },
        { name: 'small', files: 61, bytes: 268_000, clone: stats(900), shallow: stats(650), snapshot: stats(850) },
      ],
    },
    compare: { fixture: 'fixture-1m bench-base...bench-head, 502 changed files', cold: stats(480), warm: stats(60), coldCost: 'd1=1;art=56;sub=1;cache=bypass', warmCost: 'd1=1;art=0;cache=hit' },
    cache: [
      { surface: 'warm compare', requests: 10, hits: 10 },
      { surface: 'info/refs', requests: 6, hits: 5 },
    ],
    costs: Array.from({ length: 8 }, (_, i) => ({
      endpoint: `endpoint ${i}`,
      n: 5,
      median: { d1: 1, art: 0, do: 0, r2b: 0, sub: 0, cache: 'hit' },
      budget: 'd1<=1;art=0',
      ok: true,
    })),
    forecast: { stats: stats(120), method: '7 runs, 3 workspaces with declared intents, warm index' },
    compose: { stats: stats(1500), method: '5 runs, 2 workspaces, fresh compositions' },
    fleet: {
      workspaces: 100,
      published: 99,
      publishedInBurst: 96,
      resolvedAfterConflicts: 3,
      enqueue: 'd1=2;rr=10..12',
      publication: 'd1=3;rr=9..10;do=2',
      idleMs: 79_700,
      checks: '34/34',
      measuredAt: '2026-10-11T16:07:34.375Z',
      windowMs: 361_946,
      throughputPerMin: 15.91,
      latency: { p50: 94_045, p90: 219_098 },
    },
    loop: [
      { metric: 'explicit merge (POST merge -> 200)', stats: stats(900), method: '5 fast-forward merges' },
      { metric: 'mergeability cold', stats: stats(400), method: 'first read of a new change' },
      { metric: 'mergeability warm', stats: stats(80), method: 'repeat read' },
      { metric: 'push -> kvarm/guard recorded', stats: stats(8000), method: 'git push to first guard run at the new head' },
      { metric: 'push -> CI job claimable', stats: stats(6000), method: 'git push to a claim that returns the job' },
      { metric: 'runner claim -> report, cold install', stats: stats(20_000), method: 'runner-warm-bench' },
      { metric: 'runner claim -> report, warm workdir', stats: stats(6_000), method: 'runner-warm-bench' },
    ],
    container: { cold: { totalMs: 15_000, wall: 16_000, readyMs: 9_000 }, warm: { totalMs: 6_000, wall: 6_800, readyMs: 1_200 } },
  };
}

describe('spanStats', () => {
  it('reports n, min, nearest-rank p50 and max of Date.now() spans', () => {
    expect(spanStats([30, 10, 20, 50, 40])).toEqual({ n: 5, min: 10, p50: 30, max: 50 });
    expect(spanStats([])).toEqual({ n: 0, min: null, p50: null, max: null });
  });
});

describe('cacheRate', () => {
  it('counts cache=hit among parsed x-kvarm-cost samples', () => {
    expect(cacheRate([{ cache: 'hit' }, { cache: 'miss' }, { cache: 'hit' }, { cache: 'hit' }])).toEqual({ requests: 4, hits: 3, rate: 0.75 });
  });
});

describe('renderBenchReadme', () => {
  const md = renderBenchReadme(sampleReport());

  it('contains every required metric group as a section', () => {
    for (const g of BENCH_GROUPS) expect(md).toContain(`## ${g}`);
  });

  it('renders real numbers for compare, forecast, compose, the loop rows and the container rows', () => {
    expect(md).toMatch(/\| cold \(bypass\) \| 5 \| 470 ms \| 480 ms \| 500 ms \|/);
    expect(md).toMatch(/overlap forecast[^\n]*\| 5 \| 110 ms \| 120 ms \| 140 ms \|/);
    expect(md).toMatch(/composition[^\n]*\| 5 \| 1490 ms \| 1500 ms \| 1520 ms \|/);
    expect(md).toContain('| explicit merge (POST merge -> 200) | 5 | 890 ms | 900 ms | 920 ms |');
    expect(md).toMatch(/Container CI[\s\S]*\| run 1 cold \| 15\.0 s \| 16\.0 s \| 9\.0 s \|/);
    expect(md).toContain('| warm compare | 10 | 10 | 100% |');
    expect(md).toContain('| info/refs | 6 | 5 | 83% |');
  });

  it('names the burst population, then renders its window, throughput and server-clock latency', () => {
    expect(md).toContain('| changes published through the train | 99 (96 in the initial burst + 3 after conflict resolution) |');
    expect(md).toContain('| initial burst window (first enqueue -> last of the 96 initial-burst publications) | 361.9 s |');
    expect(md).toContain('| throughput (the 96 initial-burst publications per minute over that window) | 15.91 |');
    expect(md).toContain('| enqueue -> published latency of the 96 initial-burst publications, server clock (p50 / p90) | 94.0 s / 219.1 s |');
  });

  it('renders the per-endpoint cost medians with their budgets', () => {
    expect(md).toContain('| endpoint 0 | 5 | 1 | 0 | 0 | 0 | 0 | hit | `d1<=1;art=0` | within |');
  });

  it('passes its own content check', () => {
    expect(checkBenchReadme(md)).toEqual([]);
  });
});

describe('checkBenchReadme', () => {
  it('flags a missing group, too few cost rows, placeholders and monetary text', () => {
    const r = sampleReport();
    r.costs = r.costs.slice(0, 7);
    const md = renderBenchReadme(r).replace('## Overlap forecast and composition', '## Something else') + '\nTBD\nAbout $3 per month.\n';
    const problems = checkBenchReadme(md);
    expect(problems).toContain('missing group: Overlap forecast and composition');
    expect(problems).toContain('cost table has 7 endpoint rows (< 8)');
    expect(problems.some((p) => p.startsWith('placeholder'))).toBe(true);
    expect(problems.some((p) => p.startsWith('monetary'))).toBe(true);
  });

  it('flags a cost row outside its budget', () => {
    const r = sampleReport();
    r.costs[0] = { ...r.costs[0]!, ok: false };
    expect(checkBenchReadme(renderBenchReadme(r))).toContain('cost row outside its budget: endpoint 0');
  });
});
