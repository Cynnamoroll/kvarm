/**
 * Pure pieces of the final cost sweep (scripts/cost-sweep.mjs): reading the
 * budget tables of library/cost.md, matching every row to a catalog entry,
 * checking measured x-forge-cost samples against a budget spec, and the
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
  splitRow,
  summarizeVerdicts,
} from '../lib/cost-sweep.mjs';

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
  it('checks <=, = and string equality, reading absent numeric counters as 0', () => {
    expect(checkBudget({ d1: 1, art: 0, cache: 'hit' }, 'd1<=1;art=0;do=0;cache=hit')).toEqual({ ok: true, violations: [] });
    expect(checkBudget({ d1: 2, cache: 'miss' }, 'd1<=1;cache=hit').violations).toEqual(['d1=2 > 1', 'cache=miss != hit']);
    expect(checkBudget({ d1: 3 }, 'd1=2').violations).toEqual(['d1=3 != 2']);
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

describe('evaluateEntry', () => {
  const samples = new Map([
    ['compare.warm', [
      { status: 200, cost: { d1: 1, art: 0, do: 0, sub: 0, cache: 'hit' } },
      { status: 200, cost: { d1: 1, art: 0, do: 0, sub: 0, cache: 'hit' } },
    ]],
    ['compare.cold', [{ status: 200, cost: { d1: 1, art: 15, sub: 1, cache: 'bypass' }, extra: { treeReads: 4, blobReads: 9 } }]],
    ['denied', [{ status: 200, cost: { d1: 1 } }]],
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
    const entry = { id: 'k', kind: 'live' as const, probe: 'compare.warm', budget: 'd1<=1', aggregate: (xs: unknown[]) => (xs.length < 3 ? ['need 3 runs'] : []) };
    expect(evaluateEntry(entry, samples)).toMatchObject({ status: 'fail', problems: ['need 3 runs'] });
  });

  it('enforces a minimum sample count when the entry asks for one', () => {
    expect(evaluateEntry({ id: 'f', kind: 'live', probe: 'compare.warm', budget: 'd1<=1', minSamples: 5 }, samples)).toMatchObject({
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
