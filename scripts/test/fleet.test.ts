/**
 * Pure pieces of the 100-workspace fleet driver (scripts/fleet-driver.mjs):
 * the fleet plan, the preflight projection and its ceiling gate, the
 * runtime request ledger and concurrency limiter, cost parsing against the
 * documented budget rows, and the publication graph/content/ledger checks
 * that decide "no lost or double publications".
 */

import { describe, expect, it } from 'vitest';
import {
  BUDGET_ROWS,
  CAMPAIGN_LIMITS,
  CHECK_IDS,
  CeilingExceeded,
  checkProjection,
  comparePublications,
  configText,
  countMarkers,
  createLimiter,
  editLine,
  endpointClass,
  findMonetary,
  longestQueueIdle,
  parseCost,
  percentile,
  planFleet,
  projectCampaign,
  reconcileWorkspaces,
  renderBenchmarkMarkdown,
  RequestLedger,
  retryAfterMs,
  sumCosts,
  verifyGraph,
  verifyNotes,
  withinBudget,
} from '../lib/fleet.mjs';

const TS = 1791700000;

describe('planFleet', () => {
  const plan = planFleet({ workspaces: 100, ts: TS });

  it('creates exactly 100 members with one sentinel, a 3-deep chain and a 12-member overlap group', () => {
    expect(plan.members).toHaveLength(100);
    const roles = new Map<string, number>();
    for (const m of plan.members) roles.set(m.role, (roles.get(m.role) ?? 0) + 1);
    expect(roles.get('sentinel')).toBe(1);
    expect(roles.get('chain')).toBe(3);
    expect(roles.get('conflict')).toBe(4);
    expect(roles.get('identical')).toBe(2);
    expect(roles.get('nonoverlap')).toBe(6);
    expect(roles.get('independent')).toBe(84);
    expect(plan.members[0]?.role).toBe('sentinel');
    expect(plan.overlapKeys).toHaveLength(12);
  });

  it('bursts every member except the sentinel', () => {
    expect(plan.burst).toHaveLength(99);
    expect(plan.burst).not.toContain(plan.sentinel);
  });

  it('enqueues the pinned chain out of dependency order (C, B first, A last)', () => {
    const { A, B, C } = plan.chain;
    const order = plan.enqueueOrder;
    expect(order).toHaveLength(99);
    expect(order.indexOf(C)).toBeLessThan(order.indexOf(B));
    expect(order.indexOf(B)).toBeLessThan(order.indexOf(A));
    expect(order[order.length - 1]).toBe(A);
    expect(new Set(order).size).toBe(99);
  });

  it('expects the overlap pairs of the shared-file group plus the chain, and none for independent work', () => {
    expect(plan.expectedPairs.size).toBe(66 + 3);
    const independent = plan.members.filter((m) => m.role === 'independent' || m.role === 'sentinel').map((m) => m.key);
    for (const pair of plan.expectedPairs) for (const k of independent) expect(pair.split('|')).not.toContain(k);
  });

  it('gives every member a unique marker that is not a substring of another', () => {
    const markers = plan.members.flatMap((m) => [m.marker, ...(m.lineMarker ? [m.lineMarker] : [])]);
    expect(new Set(markers).size).toBe(markers.length);
    for (const a of markers) for (const b of markers) if (a !== b) expect(b.includes(a)).toBe(false);
  });

  it('keeps same-file non-overlapping edits at least 4 lines apart and conflicting edits on one line', () => {
    const lines = plan.members.filter((m) => m.role === 'nonoverlap').map((m) => m.line as number);
    lines.sort((a, b) => a - b);
    for (let i = 1; i < lines.length; i++) expect(lines[i]! - lines[i - 1]!).toBeGreaterThanOrEqual(5);
    const conflictLines = new Set(plan.members.filter((m) => m.role === 'conflict').map((m) => m.line));
    expect(conflictLines.size).toBe(1);
    const identical = plan.members.filter((m) => m.role === 'identical');
    expect(identical[0]?.lineText).toBe(identical[1]?.lineText);
  });

  it('refuses a fleet too small for every role', () => {
    expect(() => planFleet({ workspaces: 10, ts: TS })).toThrow(/at least/);
  });
});

describe('config text helpers', () => {
  it('edits exactly one numbered line', () => {
    const base = configText(40);
    const next = editLine(base, 8, 'line 08: changed');
    const a = base.split('\n');
    const b = next.split('\n');
    expect(a.length).toBe(b.length);
    expect(a.filter((l, i) => l !== b[i])).toEqual(['line 08: base']);
    expect(b[7]).toBe('line 08: changed');
  });
});

describe('projectCampaign / checkProjection', () => {
  const plan = planFleet({ workspaces: 100, ts: TS });

  it('fits the default 10,000-request ceiling and itemizes setup, publications and polls', () => {
    const p = projectCampaign(plan, {});
    expect(p.total).toBeGreaterThan(1000);
    expect(p.total).toBeLessThanOrEqual(CAMPAIGN_LIMITS.ceiling);
    const stages = p.items.map((i: { stage: string }) => i.stage);
    for (const s of ['setup', 'fleet', 'burst', 'polls', 'cleanup']) expect(stages).toContain(s);
    expect(p.background.length).toBeGreaterThan(0);
    expect(checkProjection(p, { ...CAMPAIGN_LIMITS }).fits).toBe(true);
  });

  it('refuses an over-projection and names what cannot fit', () => {
    const p = projectCampaign(plan, {});
    const verdict = checkProjection(p, { ...CAMPAIGN_LIMITS, ceiling: 1000 });
    expect(verdict.fits).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/ceiling 1000/);
  });

  it('refuses concurrency above the mission caps', () => {
    const p = projectCampaign(plan, {});
    const verdict = checkProjection(p, { ...CAMPAIGN_LIMITS, gitChildren: 4, httpInFlight: 6 });
    expect(verdict.fits).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/git children/);
    expect(verdict.problems.join(' ')).toMatch(/HTTP/);
  });

  it('refuses a git pace above the per-credential write limit', () => {
    const p = projectCampaign(plan, { pushesPerMinute: 70 });
    const verdict = checkProjection(p, { ...CAMPAIGN_LIMITS });
    expect(verdict.fits).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/write limit/);
  });
});

describe('RequestLedger', () => {
  it('counts by kind and refuses the request that would pass the ceiling', () => {
    const l = new RequestLedger(10);
    l.reserve('http', 1, 'a');
    l.reserve('git', 8, 'push');
    expect(l.total).toBe(9);
    expect(() => l.reserve('http', 2, 'b')).toThrow(CeilingExceeded);
    expect(l.total).toBe(9);
    expect(l.byKind.git).toBe(8);
  });
});

describe('createLimiter', () => {
  it('never runs more than max tasks at once', async () => {
    const lim = createLimiter(3);
    let live = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        lim.run(async () => {
          live++;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 2));
          live--;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(lim.peak).toBe(3);
  });

  it('releases the slot when a task throws', async () => {
    const lim = createLimiter(1);
    await expect(lim.run(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(lim.run(async () => 1)).resolves.toBe(1);
  });
});

describe('retryAfterMs', () => {
  it('reads seconds, falls back and caps', () => {
    expect(retryAfterMs('30', 5000, 60_000)).toBe(30_000);
    expect(retryAfterMs(null, 5000, 60_000)).toBe(5000);
    expect(retryAfterMs('abc', 5000, 60_000)).toBe(5000);
    expect(retryAfterMs('600', 5000, 60_000)).toBe(60_000);
  });
});

describe('cost parsing and budgets', () => {
  it('parses x-forge-cost and checks a documented budget row', () => {
    const c = parseCost('d1=3;rr=9;rw=3;art=2;do=2;sub=2;cache=none');
    expect(c).toMatchObject({ d1: 3, rr: 9, rw: 3, art: 2, do: 2, sub: 2 });
    expect(withinBudget(c, 'd1<=3;rr<=12;rw<=8;art<=4;do=2').ok).toBe(true);
    const bad = withinBudget(parseCost('d1=4;rr=13;do=1'), 'd1<=3;rr<=12;do=2');
    expect(bad.ok).toBe(false);
    expect(bad.violations).toEqual(['d1=4 > 3', 'rr=13 > 12', 'do=1 != 2']);
  });

  it('sums numeric counters only', () => {
    expect(sumCosts([parseCost('d1=1;rr=5;cache=hit'), parseCost('d1=2;rr=7')])).toEqual({ d1: 3, rr: 12 });
  });

  it('classifies endpoints by template, never by id', () => {
    expect(endpointClass('POST', '/api/v1/repos/cynthia/r-1/changes/12/enqueue')).toBe('POST /repos/:o/:r/changes/:n/enqueue');
    expect(endpointClass('GET', '/api/v1/repos/cynthia/r-1/workspaces?status=active&limit=30&cursor=x')).toBe('GET /repos/:o/:r/workspaces');
    expect(endpointClass('POST', '/api/v1/agents/abc123/tokens')).toBe('POST /agents/:id/tokens');
    expect(endpointClass('POST', '/api/v1/repos/cynthia/r-1/workspaces/0123456789abcdef/change-set')).toBe(
      'POST /repos/:o/:r/workspaces/:id/change-set',
    );
    expect(endpointClass('GET', '/api/v1/repos/cynthia/r-1/workspaces/overlap?base=main')).toBe('GET /repos/:o/:r/workspaces/overlap');
  });
});

describe('comparePublications', () => {
  const rows = { unpinned: 'd1<=3;rr<=12;do=2', pinned: 'd1<=3;rr<=14;do=2' };
  const pubs = [
    { number: 1, cost: parseCost('d1=3;rr=12;do=2') },
    { number: 2, cost: parseCost('d1=3;rr=14;do=2') },
    { number: 3, cost: parseCost('d1=3;rr=13;do=2') },
    { number: 4, cost: parseCost('d1=3;rr=9;do=2') },
  ];

  it('compares each publication with the row applicable to its incoming pins', () => {
    const r = comparePublications(pubs, new Set([2, 3]), rows);
    expect(r.ok).toBe(true);
    expect(r.classes.unpinned).toMatchObject({ row: rows.unpinned, total: 2, within: 2 });
    expect(r.classes.pinned).toMatchObject({ row: rows.pinned, total: 2, within: 2 });
    expect(r.outside).toEqual([]);
  });

  it('a pinned publication judged by the unpinned row, or the reverse, is outside', () => {
    const r = comparePublications(pubs, new Set([1, 4]), rows);
    expect(r.ok).toBe(false);
    expect(r.outside).toEqual([
      { number: 2, pinned: false, row: rows.unpinned, cost: 'd1=3;rr=14;do=2', violations: ['rr=14 > 12'] },
      { number: 3, pinned: false, row: rows.unpinned, cost: 'd1=3;rr=13;do=2', violations: ['rr=13 > 12'] },
    ]);
    expect(r.classes.unpinned).toMatchObject({ total: 2, within: 0 });
    expect(r.classes.pinned).toMatchObject({ total: 2, within: 2 });
    expect(r.detail).toBe(`unpinned 0/2 within ${rows.unpinned}; with incoming pins 2/2 within ${rows.pinned}`);
  });

  it('the transcribed publication row is the documented one, git subrequests included, for both classes', () => {
    const documented = 'd1<=3;rr<=12;rw<=8;art<=4;do=2;sub<=2';
    expect(BUDGET_ROWS.publication).toEqual({ unpinned: documented, pinned: documented });
    const r = comparePublications([{ number: 7, cost: parseCost('d1=3;rr=9;rw=3;art=0;do=2;sub=3') }], new Set([7]), BUDGET_ROWS.publication);
    expect(r.outside.map((o) => o.violations)).toEqual([['sub=3 > 2']]);
  });
});

describe('check ids', () => {
  it('the monetary scan has its own check id, distinct from the per-publication counters check', () => {
    expect(CHECK_IDS.publication).toBe('VAL-SCALE-004d');
    expect(CHECK_IDS.monetary).not.toBe(CHECK_IDS.publication);
    expect(CHECK_IDS.monetary).toMatch(/^VAL-SCALE-004d-/);
  });
});

describe('verifyGraph', () => {
  // seed <- w1 (fast-forward) <- m2 [w1, h2] <- m3 [m2, h3] <- r4 [m3, h4] (resolution, fast-forward)
  const firstParent = [
    { sha: 'r4', parents: ['m3', 'h4'] },
    { sha: 'm3', parents: ['m2', 'h3'] },
    { sha: 'm2', parents: ['w1', 'h2'] },
    { sha: 'w1', parents: ['seed'] },
    { sha: 'seed', parents: [] },
  ];
  const accepted = [
    { number: 1, headSha: 'w1', mergeCommit: 'w1' },
    { number: 2, headSha: 'h2', mergeCommit: 'm2', previous: 'w1' },
    { number: 3, headSha: 'h3', mergeCommit: 'm3', previous: 'm2' },
    { number: 4, headSha: 'r4', mergeCommit: 'r4' },
  ];

  it('accepts one first-parent step per publication and returns publication order', () => {
    const v = verifyGraph({ firstParent, seed: 'seed', accepted, ledgerCommits: new Set(['w1', 'h2', 'h3', 'h4', 'r4']) });
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.order).toEqual([1, 2, 3, 4]);
  });

  it('flags a change whose head was merged twice (double publication)', () => {
    const fp = [{ sha: 'm5', parents: ['r4', 'h2'] }, ...firstParent];
    const v = verifyGraph({ firstParent: fp, seed: 'seed', accepted, ledgerCommits: new Set(['w1', 'h2', 'h3', 'h4', 'r4']) });
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/m5/);
  });

  it('flags an accepted change missing from main (lost publication)', () => {
    const v = verifyGraph({
      firstParent,
      seed: 'seed',
      accepted: [...accepted, { number: 9, headSha: 'h9', mergeCommit: 'm9', previous: 'r4' }],
      ledgerCommits: new Set(['w1', 'h2', 'h3', 'h4', 'r4', 'h9']),
    });
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/#9/);
  });

  it('flags a merge commit whose parents disagree with the recorded publication', () => {
    const v = verifyGraph({
      firstParent,
      seed: 'seed',
      accepted: accepted.map((a) => (a.number === 3 ? { ...a, previous: 'w1' } : a)),
      ledgerCommits: new Set(['w1', 'h2', 'h3', 'h4', 'r4']),
    });
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/#3/);
  });

  it('flags two changes claiming one merge commit', () => {
    const v = verifyGraph({
      firstParent,
      seed: 'seed',
      accepted: [...accepted, { number: 5, headSha: 'h3', mergeCommit: 'm3' }],
      ledgerCommits: new Set(['w1', 'h2', 'h3', 'h4', 'r4']),
    });
    expect(v.ok).toBe(false);
  });
});

describe('longestQueueIdle', () => {
  it('finds the longest interval without a terminal queue transition and what ended it', () => {
    const rows = [
      { change_number: 1, state: 'published', reason_code: null, enqueued_at: 1000, updated_at: 5000 },
      { change_number: 2, state: 'published', reason_code: null, enqueued_at: 1500, updated_at: 9000 },
      { change_number: 3, state: 'ejected', reason_code: 'MERGE_CONFLICT', enqueued_at: 2000, updated_at: 60000 },
      { change_number: 4, state: 'published', reason_code: null, enqueued_at: 2500, updated_at: 61000 },
      { change_number: 3, state: 'published', reason_code: null, enqueued_at: 62000, updated_at: 70000 },
    ];
    expect(longestQueueIdle(rows)).toEqual({ ms: 51000, fromMs: 8000, toMs: 59000, endedBy: '#3 ejected MERGE_CONFLICT' });
  });

  it('measures from the first enqueue and ignores entries still active', () => {
    const rows = [
      { change_number: 1, state: 'queued', reason_code: null, enqueued_at: 0, updated_at: 100 },
      { change_number: 2, state: 'published', reason_code: null, enqueued_at: 10, updated_at: 4000 },
    ];
    expect(longestQueueIdle(rows)).toEqual({ ms: 4000, fromMs: 0, toMs: 4000, endedBy: '#2 published' });
    expect(longestQueueIdle([])).toBeNull();
  });
});

describe('verifyNotes', () => {
  const list = (pairs: [string, string][]) => pairs.map(([note, sha]) => `${note} ${sha}`).join('\n');

  it('accepts exactly one note per expected commit', () => {
    const v = verifyNotes({ notesList: list([['n1', 'm1'], ['n2', 'r1']]), expected: ['m1', 'r1'] });
    expect(v).toEqual({ ok: true, missing: [], unexpected: [], noted: 2 });
  });

  it('reports a missing note and a note on a commit nobody expected', () => {
    const v = verifyNotes({ notesList: list([['n1', 'm1'], ['n3', 'x9']]), expected: ['m1', 'm2'] });
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual(['m2']);
    expect(v.unexpected).toEqual(['x9']);
  });

  it('with nothing expected, an absent notes ref is the only correct state', () => {
    expect(verifyNotes({ notesList: null, expected: [] }).ok).toBe(true);
    expect(verifyNotes({ notesList: null, expected: ['m1'] })).toMatchObject({ ok: false, missing: ['m1'] });
  });
});

describe('countMarkers', () => {
  it('counts every occurrence across files', () => {
    const counts = countMarkers(
      [
        { path: 'a', text: 'X1 X2\nX1' },
        { path: 'b', text: 'X3' },
      ],
      ['X1', 'X2', 'X3', 'X4'],
    );
    expect(Object.fromEntries(counts)).toEqual({ X1: 2, X2: 1, X3: 1, X4: 0 });
  });
});

describe('reconcileWorkspaces', () => {
  it('explains every created workspace by its final status', () => {
    const r = reconcileWorkspaces({
      created: [
        { id: 'a', expect: 'merged' },
        { id: 'b', expect: 'active' },
      ],
      abandoned: [],
      listed: [
        { id: 'a', status: 'merged' },
        { id: 'b', status: 'active' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.byStatus).toEqual({ merged: 1, active: 1 });
  });

  it('flags a disappeared or unexpected workspace', () => {
    const r = reconcileWorkspaces({
      created: [
        { id: 'a', expect: 'merged' },
        { id: 'b', expect: 'active' },
      ],
      abandoned: [],
      listed: [
        { id: 'a', status: 'merged' },
        { id: 'z', status: 'active' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['b']);
    expect(r.unexpected).toEqual(['z']);
  });
});

describe('percentile', () => {
  it('uses nearest rank', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 90)).toBe(5);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('findMonetary', () => {
  it('finds currency amounts and pricing derivations, not counters', () => {
    expect(findMonetary('d1=3;rr=9 work counters, not a Cloudflare bill')).toEqual([]);
    expect(findMonetary('about $0.12 per run').length).toBe(1);
    expect(findMonetary('0.30 USD').length).toBe(1);
    expect(findMonetary('price per request').length).toBe(1);
  });
});

describe('renderBenchmarkMarkdown', () => {
  it('renders the measured rows with the limits in force and no monetary derivation', () => {
    const md = renderBenchmarkMarkdown({
      run: { repo: 'cynthia/x', worker: 'v1', startedAt: '2026-10-11T00:00:00Z', finishedAt: '2026-10-11T00:20:00Z', head: 'abc' },
      limits: { gitChildren: 3, httpInFlight: 5, ceiling: 10000, gitWritesPerMin: 120, pushesPerMinute: 30, enqueueIntervalMs: 600 },
      fleet: { workspaces: 100, burst: 99, overlapPairs: 69 },
      burst: {
        accepted: 99,
        incomplete: 0,
        windowMs: 600000,
        throughputPerMin: 9.9,
        latencyMs: { p50: 1000, p90: 2000, max: 3000 },
        backlogMax: 40,
        queueFull429: 2,
        retries: 2,
      },
      conflicts: { 'MERGE_CONFLICT ejections': 3 },
      requests: { projected: 2500, observed: 2000 },
      counters: { 'POST /repos/:o/:r/changes/:n/enqueue': { count: 99, sum: { d1: 198 } } },
      background: { publications: 99 },
    });
    expect(md).toMatch(/Throughput/);
    expect(md).toMatch(/enqueue .* published/i);
    expect(md).toMatch(/not a Cloudflare bill/);
    expect(md).toMatch(/≤ 3 git children/);
    expect(findMonetary(md)).toEqual([]);
    expect(md).not.toMatch(/## Notes/);
  });

  it('lists measured observations outside the tables as notes', () => {
    const md = renderBenchmarkMarkdown({
      run: { repo: 'cynthia/x', startedAt: 'a', finishedAt: 'b', head: 'abc' },
      limits: { gitChildren: 3, httpInFlight: 5, ceiling: 10000, gitWritesPerMin: 120, pushesPerMinute: 30, enqueueIntervalMs: 600 },
      fleet: { workspaces: 100, burst: 99, overlapPairs: 69 },
      burst: { accepted: 99, incomplete: 0, windowMs: 1, throughputPerMin: 1, latencyMs: { p50: 1, p90: 1, max: 1 }, backlogMax: 1, queueFull429: 0, retries: 0 },
      conflicts: {},
      requests: { projected: 1, observed: 1 },
      counters: {},
      background: {},
      notes: ['pinned dependent enqueue rr=16 (row measured without pins)'],
    });
    expect(md).toMatch(/## Notes\n\n- pinned dependent enqueue rr=16 \(row measured without pins\)\n/);
  });

  it('states the check outcome and lists every failed check with its detail', () => {
    const base = {
      run: { repo: 'cynthia/x', startedAt: 'a', finishedAt: 'b', head: 'abc' },
      limits: { gitChildren: 3, httpInFlight: 5, ceiling: 10000, gitWritesPerMin: 120, pushesPerMinute: 30, enqueueIntervalMs: 600 },
      fleet: { workspaces: 100, burst: 99, overlapPairs: 69 },
      burst: { accepted: 99, incomplete: 0, windowMs: 1, throughputPerMin: 1, latencyMs: { p50: 1, p90: 1, max: 1 }, backlogMax: 1, queueFull429: 0, retries: 0 },
      conflicts: {},
      requests: { projected: 1, observed: 1 },
      counters: {},
      background: {},
    };
    const failed = renderBenchmarkMarkdown({
      ...base,
      checks: [
        { id: 'VAL-SCALE-003', label: 'no lost publication', ok: true, detail: '99 published' },
        { id: 'VAL-SCALE-004d', label: 'publication row', ok: false, detail: '0/99 within' },
      ],
    });
    expect(failed).toMatch(/## Checks\n\n1 of 2 checks passed\. Failed:\n\n- \[VAL-SCALE-004d\] publication row: 0\/99 within\n/);
    const passed = renderBenchmarkMarkdown({ ...base, checks: [{ id: 'VAL-SCALE-003', label: 'x', ok: true, detail: '' }] });
    expect(passed).toMatch(/## Checks\n\nAll 1 checks passed\.\n/);
  });

  it('states the longest interval without a terminal queue transition when measured', () => {
    const md = renderBenchmarkMarkdown({
      run: { repo: 'cynthia/x', startedAt: 'a', finishedAt: 'b', head: 'abc' },
      limits: { gitChildren: 3, httpInFlight: 5, ceiling: 10000, gitWritesPerMin: 120, pushesPerMinute: 30, enqueueIntervalMs: 600 },
      fleet: { workspaces: 100, burst: 99, overlapPairs: 69 },
      burst: {
        accepted: 99, incomplete: 0, windowMs: 1, throughputPerMin: 1, latencyMs: { p50: 1, p90: 1, max: 1 }, backlogMax: 1, queueFull429: 0, retries: 0,
        longestIdle: { ms: 306000, fromMs: 164000, toMs: 470000, endedBy: '#93 ejected MERGE_CONFLICT' },
      },
      conflicts: {},
      requests: { projected: 1, observed: 1 },
      counters: {},
      background: {},
    });
    expect(md).toMatch(/\| Longest interval with no queue entry reaching a terminal state \| 306\.0 s \(\+164\.0 s → \+470\.0 s after the first enqueue; ended by #93 ejected MERGE_CONFLICT\) \|/);
  });
});
