/**
 * Pure pieces of the final cost sweep (scripts/cost-sweep.mjs): reading the
 * budget tables of library/cost.md, matching every row to a catalog entry,
 * checking measured x-kvarm-cost samples against a budget spec, and the
 * per-row verdicts that decide the exit code.
 */

import { describe, expect, it } from 'vitest';
import {
  checkBudget,
  evaluateEntry,
  matchCatalog,
  medianCounters,
  normalizeCell,
  parseCostTables,
  requireKinds,
  smallVsMany,
  splitRow,
  summarizeVerdicts,
} from '../lib/cost-sweep.mjs';
import type { Sample } from '../lib/cost-sweep.mjs';

const MD = `# Cost budgets

Intro text | not a table.

## Per-endpoint budgets

| Endpoint / job | State | Budget | Feature | Notes |
|---|---|---|---|---|
| \`GET /healthz\` | any | all counters 0 | m3 | Measured \`d1=0\`. |
| repo page \`GET /:o/:r\` (public) | cold / warm | warm **d1 ≤ 1** | access | uses \`a|b\` inside code |

Paragraph between tables.

### Change requests (m5-change-requests)

| Endpoint | Budget | Live |
|---|---|---|
| \`GET …/changes\` (list) | d1 = 2 | \`d1=2;rr=8\` |
| \`GET …/changes/:n\` (detail, open) | **d1 = 3** | warm |
| \`GET …/changes/:n/checks\` | d1 = 2 | — |
`;

describe('splitRow', () => {
  it('splits on pipes outside code spans and trims cells', () => {
    expect(splitRow('| a | `x|y` | **b** |')).toEqual(['a', '`x|y`', '**b**']);
  });
});

describe('normalizeCell', () => {
  it('drops markdown emphasis and code ticks, folds case and whitespace, and maps ... to …', () => {
    expect(normalizeCell('**`GET .../changes`**  (List)')).toBe('get …/changes (list)');
  });
});

describe('parseCostTables', () => {
  it('reads every body row with its nearest heading, line number, endpoint and state', () => {
    const rows = parseCostTables(MD);
    expect(rows.map((r) => r.endpoint)).toEqual([
      'GET /healthz',
      'repo page GET /:o/:r (public)',
      'GET …/changes (list)',
      'GET …/changes/:n (detail, open)',
      'GET …/changes/:n/checks',
    ]);
    expect(rows[0]).toMatchObject({ section: 'Per-endpoint budgets', state: 'any', line: 9 });
    expect(rows[1]!.cells).toHaveLength(5);
    expect(rows[1]!.cells[4]).toContain('`a|b`');
    expect(rows[2]).toMatchObject({ section: 'Change requests (m5-change-requests)', state: null, line: 18 });
  });
});

describe('matchCatalog', () => {
  const rows = parseCostTables(MD);
  it('maps each row to exactly one entry and reports unmatched rows, ambiguous rows and unused entries', () => {
    const r = matchCatalog(rows, [
      { id: 'healthz', section: 'per-endpoint', row: 'GET /healthz' },
      { id: 'page', section: 'per-endpoint', row: 'repo page', state: 'cold' },
      { id: 'list', section: 'change requests', row: 'GET …/changes (list)' },
      { id: 'detail-a', section: 'change requests', row: 'GET .../changes/:n (detail' },
      { id: 'detail-b', section: 'change requests', row: 'GET …/changes/:n (' },
      { id: 'orphan', section: 'nowhere', row: 'nothing' },
    ]);
    expect(r.matched.get(rows[0]!)?.id).toBe('healthz');
    expect(r.matched.get(rows[1]!)?.id).toBe('page');
    expect(r.matched.get(rows[2]!)?.id).toBe('list');
    expect(r.ambiguous.map((a) => [a.row.endpoint, a.entries.map((e) => e.id)])).toEqual([
      ['GET …/changes/:n (detail, open)', ['detail-a', 'detail-b']],
    ]);
    expect(r.unmatched.map((u) => u.endpoint)).toEqual(['GET …/changes/:n/checks']);
    expect(r.unused.map((e) => e.id)).toEqual(['orphan']);
  });

  it('a row prefix matches only at the start of the endpoint cell', () => {
    const r = matchCatalog(rows, [{ id: 'x', section: 'change requests', row: '/changes' }]);
    expect(r.matched.size).toBe(0);
  });

  it('an entry with exact: true matches only the whole cell', () => {
    const r = matchCatalog(rows, [{ id: 'x', section: 'change requests', row: 'GET …/changes/:n', exact: true }]);
    expect(r.matched.size).toBe(0);
    const r2 = matchCatalog(rows, [{ id: 'x', section: 'change requests', row: 'GET …/changes/:n/checks', exact: true }]);
    expect([...r2.matched.values()].map((e) => e.id)).toEqual(['x']);
  });

  it('an entry with exactState: true matches only the whole State cell', () => {
    const r = matchCatalog(rows, [{ id: 'x', section: 'per-endpoint', row: 'repo page', state: 'cold', exactState: true }]);
    expect(r.matched.size).toBe(0);
    const r2 = matchCatalog(rows, [{ id: 'x', section: 'per-endpoint', row: 'repo page', state: 'cold / warm', exactState: true }]);
    expect([...r2.matched.values()].map((e) => e.id)).toEqual(['x']);
  });
});

describe('checkBudget', () => {
  it('checks <=, = and string equality', () => {
    expect(checkBudget({ d1: 1, art: 0, do: 0, cache: 'hit' }, 'd1<=1;art=0;do=0;cache=hit')).toEqual({ ok: true, violations: [] });
    expect(checkBudget({ d1: 2, cache: 'miss' }, 'd1<=1;cache=hit').violations).toEqual(['d1=2 > 1', 'cache=miss != hit']);
    expect(checkBudget({ d1: 3 }, 'd1=2').violations).toEqual(['d1=3 != 2']);
  });

  it('reports a budgeted counter the sample does not carry instead of reading it as 0', () => {
    expect(checkBudget({ d1: 1 }, 'd1<=1;do=0').violations).toEqual(['do absent']);
    expect(checkBudget({}, 'd1<=1').violations).toEqual(['d1 absent']);
    expect(checkBudget({ d1: 1 }, 'cache=hit').violations).toEqual(['cache absent']);
  });

  it('accepts alternatives with |, e.g. cache=hit|miss', () => {
    expect(checkBudget({ cache: 'miss' }, 'cache=hit|miss').ok).toBe(true);
    expect(checkBudget({ cache: 'none' }, 'cache=hit|miss').ok).toBe(false);
  });

  it('rejects a malformed spec part instead of silently skipping it', () => {
    expect(() => checkBudget({}, 'd1 at most 2')).toThrow(/malformed/);
  });
});

describe('medianCounters', () => {
  it('takes the nearest-rank median of each numeric counter and the most frequent cache value', () => {
    const m = medianCounters([
      { d1: 1, rr: 5, art: 0, cache: 'hit' },
      { d1: 1, rr: 7, art: 2, cache: 'miss' },
      { d1: 2, rr: 6, art: 0, cache: 'hit' },
    ]);
    expect(m).toEqual({ d1: 1, rr: 6, art: 0, cache: 'hit' });
  });
});

/** A full x-kvarm-cost counter set, as every metered response carries. */
const HDR = { d1: 0, rr: 0, rw: 0, art: 0, do: 0, r2a: 0, r2b: 0, q: 0, sub: 0, cache: 'none' };
const full = (c: Record<string, number | string>) => ({ ...HDR, ...c });

describe('evaluateEntry', () => {
  const samples = new Map([
    ['compare.warm', [
      { status: 200, cost: full({ d1: 1, cache: 'hit' }) },
      { status: 200, cost: full({ d1: 1, cache: 'hit' }) },
    ]],
    ['compare.cold', [{ status: 200, cost: full({ d1: 1, art: 15, sub: 1, cache: 'bypass' }), extra: { treeReads: 4, blobReads: 9 } }]],
    ['denied', [{ status: 200, cost: full({ d1: 1 }) }]],
  ]);

  it('passes a live entry when every sample is within its budget and has the expected status', () => {
    const v = evaluateEntry({ id: 'a', kind: 'live', probe: 'compare.warm', budget: 'd1<=1;art=0;do=0;sub=0;cache=hit', status: 200 }, samples);
    expect(v).toMatchObject({ status: 'pass', n: 2, median: { d1: 1, art: 0, cache: 'hit' } });
  });

  it('evaluates a budget function against each sample (formula budgets such as treeReads + blobReads + 3)', () => {
    const entry = {
      id: 'b',
      kind: 'live' as const,
      probe: 'compare.cold',
      budget: (s: { extra: { treeReads: number; blobReads: number } }) => `d1<=2;art<=${s.extra.treeReads + s.extra.blobReads + 3};sub<=1`,
      status: 200,
    };
    expect(evaluateEntry(entry, samples).status).toBe('pass');
  });

  it('fails on a wrong status, a budget violation, or no samples at all', () => {
    expect(evaluateEntry({ id: 'c', kind: 'live', probe: 'denied', budget: 'd1=1', status: 404 }, samples)).toMatchObject({
      status: 'fail',
      problems: ['status 200 != 404'],
    });
    expect(evaluateEntry({ id: 'd', kind: 'live', probe: 'compare.warm', budget: 'd1=0' }, samples)).toMatchObject({ status: 'fail' });
    expect(evaluateEntry({ id: 'e', kind: 'live', probe: 'nothing', budget: 'd1=0' }, samples)).toMatchObject({ status: 'missing' });
  });

  it('accepts any status of a list, and an empty budget as a reported-only row', () => {
    expect(evaluateEntry({ id: 'i', kind: 'live', probe: 'denied', budget: '', status: [401, 200] }, samples).status).toBe('pass');
    expect(evaluateEntry({ id: 'j', kind: 'live', probe: 'denied', budget: 'd1=1', status: [401, 404] }, samples)).toMatchObject({
      status: 'fail',
      problems: ['status 200 not in 401|404'],
    });
  });

  it('runs an aggregate check over all samples (e.g. a p50 timing gate)', () => {
    const entry = { id: 'k', kind: 'live' as const, probe: 'compare.warm', budget: 'd1<=1', status: 200, aggregate: (xs: unknown[]) => (xs.length < 3 ? ['need 3 runs'] : []) };
    expect(evaluateEntry(entry, samples)).toMatchObject({ status: 'fail', problems: ['need 3 runs'] });
  });

  it('enforces a minimum sample count when the entry asks for one', () => {
    expect(evaluateEntry({ id: 'f', kind: 'live', probe: 'compare.warm', budget: 'd1<=1', status: 200, minSamples: 5 }, samples)).toMatchObject({
      status: 'fail',
      problems: ['2 samples < 5'],
    });
  });

  it('reports a non-live entry as n/a with its category and reason, and refuses one without a reason', () => {
    expect(evaluateEntry({ id: 'g', kind: 'nonlive', category: 'workerd-only', reason: 'needs a Workflows outage' }, samples)).toMatchObject({
      status: 'n/a',
      category: 'workerd-only',
    });
    expect(() => evaluateEntry({ id: 'h', kind: 'nonlive', category: 'workerd-only', reason: '' }, samples)).toThrow(/reason/);
  });
});

describe('evaluateEntry sample strictness', () => {
  const ok = { status: 200, cost: full({ d1: 1 }) };
  const one = (s: Sample) => new Map([['p', [s]]]);
  const http = (more: object = {}) => ({ id: 'x', kind: 'live' as const, probe: 'p', budget: 'd1<=1', status: 200, ...more });

  it('fails an HTTP entry that names no intended status', () => {
    expect(evaluateEntry({ id: 'x', kind: 'live', probe: 'p', budget: 'd1<=1' }, one(ok))).toMatchObject({
      status: 'fail',
      problems: ['no intended HTTP status in the catalog entry'],
    });
  });

  it('fails a transport failure (status 0 after retries, no counters) even under an empty budget', () => {
    const v = evaluateEntry(http({ budget: '' }), one({ status: 0, cost: {}, extra: { error: 'fetch failed' } }));
    expect(v.status).toBe('fail');
    expect(v.problems).toContain('transport failure (no HTTP status)');
    expect(v.problems).toContain('no x-kvarm-cost counter set');
  });

  it('fails a 5xx answer of a probe that intends 200', () => {
    expect(evaluateEntry(http(), one({ status: 503, cost: full({ d1: 1 }) })).problems).toEqual(['status 503 != 200']);
  });

  it('fails a sample whose x-kvarm-cost header was absent or malformed', () => {
    expect(evaluateEntry(http({ budget: '' }), one({ status: 200, cost: {} })).problems).toEqual(['no x-kvarm-cost counter set']);
    const partial: Record<string, number | string> = { ...HDR };
    delete partial.rw;
    expect(evaluateEntry(http(), one({ status: 200, cost: { ...partial, d1: 1 } })).problems).toEqual(['counter rw absent']);
    expect(evaluateEntry(http(), one({ status: 200, cost: full({ d1: 1, art: 'x' }) })).problems).toEqual(['counter art=x is not a non-negative integer']);
    expect(evaluateEntry(http(), one({ status: 200, cost: full({ d1: 1, cache: 'warm' }) })).problems).toEqual(['counter cache=warm is not hit|miss|none|bypass']);
  });

  it('passes an expected denial only at its intended status', () => {
    const entry = http({ budget: 'd1=1;art=0', status: 404 });
    expect(evaluateEntry(entry, one({ status: 404, cost: full({ d1: 1 }) })).status).toBe('pass');
    expect(evaluateEntry(entry, one({ status: 200, cost: full({ d1: 1 }) })).problems).toEqual(['status 200 != 404']);
  });

  it('takes the intended status from a function of the sample (one probe, two intended answers)', () => {
    const entry = http({ status: (s: { extra?: { denied?: boolean } }) => (s.extra?.denied ? 401 : 200) });
    const samples = new Map<string, Sample[]>([['p', [ok, { status: 401, cost: full({ d1: 0 }), extra: { denied: true } }]]]);
    expect(evaluateEntry(entry, samples).status).toBe('pass');
    expect(evaluateEntry(entry, one({ status: 401, cost: full({ d1: 0 }) })).problems).toEqual(['status 401 != 200']);
  });

  it('checks stored and logged counters in their own formats, without an HTTP status', () => {
    const stored = { id: 's', kind: 'live' as const, probe: 'p', budget: 'd1<=3;do=2', format: 'stored' as const };
    const row = { d1: 3, rr: 6, rw: 3, art: 2, do: 2, q: 0, sub: 2 };
    expect(evaluateEntry(stored, one({ format: 'stored', cost: row })).status).toBe('pass');
    const { rr: _rr, ...noRr } = row;
    expect(evaluateEntry(stored, one({ format: 'stored', cost: noRr })).problems).toEqual(['counter rr absent']);
    expect(evaluateEntry(stored, one(ok)).problems).toEqual(['sample format http != stored']);
    expect(evaluateEntry(http(), one({ format: 'stored', cost: row })).problems).toEqual(['sample format stored != http']);
    const log = { id: 'l', kind: 'live' as const, probe: 'p', budget: 'd1<=2;wf<=1', format: 'log' as const };
    expect(evaluateEntry(log, one({ format: 'log', cost: full({ d1: 2, wf: 0 }) })).status).toBe('pass');
    expect(evaluateEntry(log, one({ format: 'log', cost: full({ d1: 2 }) })).problems).toEqual(['wf absent']);
    const build = { id: 'b', kind: 'live' as const, probe: 'p', budget: 'steps<=3', format: 'build' as const };
    expect(evaluateEntry(build, one({ format: 'build', cost: { steps: 3, d1: 3, rr: 1, rw: 1, art: 2, r2a: 1, r2b: 0, sub: 0 } })).status).toBe('pass');
  });
});

describe('smallVsMany and requireKinds (VAL-COST-026 dependency classes)', () => {
  const s = (kind: string, side: string, d1: number, rr: number) => ({ status: 200, cost: full({ d1, rr }), extra: { kind, side } });

  it('compares the medians of same-session repeats: equal d1 and rr within the tolerance', () => {
    const xs = [s('depth5', 'small', 2, 12), s('depth5', 'small', 2, 12), s('depth5', 'small', 2, 30), s('depth5', 'many', 2, 13), s('depth5', 'many', 2, 14), s('depth5', 'many', 2, 13)];
    expect(smallVsMany(xs, ['depth5'])).toEqual([]);
  });

  it('fails on unequal d1, an rr gap beyond 3, or a side without samples', () => {
    expect(smallVsMany([s('cycle', 'small', 2, 15), s('cycle', 'many', 3, 15)], ['cycle'])).toEqual(['cycle: d1 2 small != 3 many']);
    expect(smallVsMany([s('cycle', 'small', 2, 10), s('cycle', 'many', 2, 14)], ['cycle'])).toEqual(['cycle: rr 10 small vs 14 many differs by more than 3']);
    expect(smallVsMany([s('cycle', 'small', 2, 10)], ['cycle', 'depth4'])).toEqual(['cycle: 1 small / 0 many-workspace samples', 'depth4: 0 small / 0 many-workspace samples']);
  });

  it('requires at least one sample of each named kind', () => {
    expect(requireKinds([s('crossRepo', 'small', 2, 8)], ['crossRepo', 'depth5'])).toEqual(['no depth5 sample']);
  });

  it('the dependency rows of the catalog check depth-4, depth-5, cycle and cross-repo samples and the small-vs-many comparison', async () => {
    const { CATALOG } = await import('../lib/cost-catalog.mjs');
    const entry = (id: string) => CATALOG.find((e) => e.id === id)!;
    const ok = (kind: string, side: string, d1: number, rr: number, status = 201) => ({ status, cost: full({ d1, rr, rw: 3, sub: 1 }), extra: { kind, side } });
    const create = entry('dep-create');
    expect(evaluateEntry(create, new Map([['deps.create', [ok('depth2', 'small', 3, 10)]]])).problems).toEqual(['depth4: 0 small / 0 many-workspace samples']);
    expect(evaluateEntry(create, new Map([['deps.create', [ok('depth4', 'small', 3, 23), ok('depth4', 'many', 3, 23)]]])).status).toBe('pass');
    const refused = entry('dep-refused');
    const no = (kind: string, side: string, rr: number, status = 422) => ({ status, cost: full({ d1: 2, rr }), extra: { kind, side } });
    const all = [no('depth5', 'small', 12), no('depth5', 'many', 12), no('cycle', 'small', 15), no('cycle', 'many', 14), no('crossRepo', 'small', 8, 404)];
    expect(evaluateEntry(refused, new Map([['deps.refused', all]])).status).toBe('pass');
    expect(evaluateEntry(refused, new Map([['deps.refused', all.slice(0, 4)]])).problems).toEqual(['no crossRepo sample']);
    expect(evaluateEntry(refused, new Map([['deps.refused', [...all.slice(0, 4), no('crossRepo', 'small', 8, 422)]]])).problems).toEqual(['status 422 != 404']);
    const list = entry('dep-list');
    const read = (side: string, rr: number) => ({ status: 200, cost: full({ d1: 2, rr }), extra: { kind: 'warm', side } });
    expect(evaluateEntry(list, new Map([['deps.list', [read('small', 13), read('many', 14)]]])).status).toBe('pass');
    expect(evaluateEntry(list, new Map([['deps.list', [read('small', 13), read('many', 20)]]])).problems).toEqual([
      'warm: rr 13 small vs 20 many differs by more than 3',
    ]);
  });
});

describe('the cost catalog', () => {
  it('names an intended status for every live HTTP entry and a known format for every other live entry', async () => {
    const { CATALOG } = await import('../lib/cost-catalog.mjs');
    const live = CATALOG.filter((e) => e.kind === 'live');
    const http = live.filter((e) => (e.format ?? 'http') === 'http');
    expect(http.filter((e) => e.status === undefined).map((e) => e.id)).toEqual([]);
    expect(live.filter((e) => !['http', 'stored', 'log', 'build'].includes(e.format ?? 'http')).map((e) => e.id)).toEqual([]);
    for (const id of ['mq-publication', 'mq-mergelock', 'rev-train', 'dep-merge', 'r2-landing', 'two-live-two-pin', 'fleet-pub-unpinned', 'perf-train-passes']) {
      expect(live.find((e) => e.id === id)?.format).toBe('stored');
    }
    expect(live.find((e) => e.id === 'per-rest-user')?.status).toBe(200);
  });
});

describe('summarizeVerdicts', () => {
  it('passes only when no row failed or went unmeasured and coverage is complete', () => {
    const ok = summarizeVerdicts([{ status: 'pass' }, { status: 'n/a' }], { unmatched: [], ambiguous: [], unused: [] });
    expect(ok).toMatchObject({ ok: true, pass: 1, na: 1, fail: 0, missing: 0 });
    expect(summarizeVerdicts([{ status: 'fail' }], { unmatched: [], ambiguous: [], unused: [] }).ok).toBe(false);
    expect(summarizeVerdicts([{ status: 'missing' }], { unmatched: [], ambiguous: [], unused: [] }).ok).toBe(false);
    expect(summarizeVerdicts([{ status: 'pass' }], { unmatched: [{}], ambiguous: [], unused: [] }).ok).toBe(false);
    expect(summarizeVerdicts([{ status: 'pass' }], { unmatched: [], ambiguous: [], unused: [{}] }).ok).toBe(false);
  });
});
