/**
 * Pure pieces of the final cost sweep (scripts/cost-sweep.mjs).
 *
 * The budget document is a markdown file (`--cost-md`): every table row in it
 * is one documented path. The sweep parses those rows, matches each one to a
 * catalog entry (a live probe with a normalized budget spec, or a non-live
 * entry with its category and reason), checks the measured x-kvarm-cost
 * samples and prints one verdict per row.
 */

import { percentile } from './fleet.mjs';

/** Table cells of one markdown row; pipes inside `code spans` stay in their cell. */
export function splitRow(line) {
  const cells = [];
  let cur = '';
  let inCode = false;
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && body[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

export function normalizeCell(text) {
  return String(text ?? '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\.\.\./g, '…')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const plain = (text) => String(text ?? '').replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
const isSeparator = (line) => /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(line);

/** Every body row of every table, with its nearest heading and 1-based line number. */
export function parseCostTables(md) {
  const lines = md.split('\n');
  const rows = [];
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      section = h[1].trim();
      continue;
    }
    if (!line.trim().startsWith('|') || !isSeparator(lines[i + 1] ?? '')) continue;
    const header = splitRow(line).map(plain);
    const stateCol = header.findIndex((c) => c.toLowerCase() === 'state');
    i += 2;
    for (; i < lines.length && lines[i].trim().startsWith('|'); i++) {
      const cells = splitRow(lines[i]);
      rows.push({ section, line: i + 1, header, cells, endpoint: plain(cells[0]), state: stateCol >= 0 ? plain(cells[stateCol]) : null });
    }
    i--;
  }
  return rows;
}

function entryMatches(row, e) {
  if (!normalizeCell(row.section).includes(normalizeCell(e.section))) return false;
  const ep = normalizeCell(row.endpoint);
  const want = normalizeCell(e.row);
  if (e.exact ? ep !== want : !ep.startsWith(want)) return false;
  if (e.state !== undefined) {
    const st = normalizeCell(row.state);
    const wantState = normalizeCell(e.state);
    if (e.exactState ? st !== wantState : !st.startsWith(wantState)) return false;
  }
  return true;
}

/** Each row must match exactly one entry; each entry must match at least one row. */
export function matchCatalog(rows, catalog) {
  const matched = new Map();
  const unmatched = [];
  const ambiguous = [];
  const used = new Set();
  for (const row of rows) {
    const hits = catalog.filter((e) => entryMatches(row, e));
    hits.forEach((e) => used.add(e));
    if (hits.length === 1) matched.set(row, hits[0]);
    else if (hits.length === 0) unmatched.push(row);
    else ambiguous.push({ row, entries: hits });
  }
  return { matched, unmatched, ambiguous, unused: catalog.filter((e) => !used.has(e)) };
}

/** `d1<=1;art=0;cache=hit|miss` against parsed counters; a budgeted counter the sample lacks is a violation. */
export function checkBudget(cost, spec) {
  const violations = [];
  for (const raw of spec.split(';')) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^([a-z0-9]+)\s*(<=|=)\s*([a-z0-9|]+)$/i.exec(part);
    if (!m) throw new Error(`malformed budget part "${part}" in "${spec}"`);
    const [, k, op, lim] = m;
    if (cost?.[k] === undefined) {
      violations.push(`${k} absent`);
      continue;
    }
    if (/^\d+$/.test(lim)) {
      const n = Number(lim);
      const v = cost[k];
      if (typeof v !== 'number') violations.push(`${k}=${v} is not a number`);
      else if (op === '<=' && v > n) violations.push(`${k}=${v} > ${n}`);
      else if (op === '=' && v !== n) violations.push(`${k}=${v} != ${n}`);
    } else {
      const v = cost[k];
      if (!lim.split('|').includes(String(v))) violations.push(`${k}=${v} != ${lim}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * The counters each sample format must carry. `http` is the x-kvarm-cost
 * header every metered response sets (src/cost/meter.ts); `log` is the same
 * meter total logged by a queue consumer or train run; `stored` is a
 * publication cost (merge_queue.cost, a logged pass or completed-request
 * publication); `build` is a snapshot build's recorded buildCost.
 */
export const COUNTER_SETS = {
  http: ['d1', 'rr', 'rw', 'art', 'do', 'r2a', 'r2b', 'q', 'sub', 'cache'],
  log: ['d1', 'rr', 'rw', 'art', 'do', 'r2a', 'r2b', 'q', 'sub', 'cache'],
  stored: ['d1', 'rr', 'rw', 'art', 'do', 'q', 'sub'],
  build: ['steps', 'd1', 'rr', 'rw', 'art', 'r2a', 'r2b', 'sub'],
};
const CACHE_STATES = ['hit', 'miss', 'none', 'bypass'];

/** Problems with one sample's own shape: its format, HTTP status and counter set. */
function sampleProblems(entry, s) {
  const want = entry.format ?? 'http';
  const got = s.format ?? 'http';
  if (got !== want) return [`sample format ${got} != ${want}`];
  const problems = [];
  if (want === 'http') {
    if (typeof s.status !== 'number' || s.status < 100) problems.push('transport failure (no HTTP status)');
    const intended = typeof entry.status === 'function' ? entry.status(s) : entry.status;
    if (intended === undefined) problems.push('no intended HTTP status in the catalog entry');
    else if (typeof s.status === 'number' && s.status >= 100) {
      if (Array.isArray(intended)) {
        if (!intended.includes(s.status)) problems.push(`status ${s.status} not in ${intended.join('|')}`);
      } else if (s.status !== intended) problems.push(`status ${s.status} != ${intended}`);
    }
  }
  const cost = s.cost;
  if (cost === null || typeof cost !== 'object' || Object.keys(cost).length === 0) {
    problems.push(want === 'http' ? 'no x-kvarm-cost counter set' : `no ${want} counter set`);
    return problems;
  }
  for (const k of COUNTER_SETS[want] ?? []) {
    const v = cost[k];
    if (v === undefined) problems.push(`counter ${k} absent`);
    else if (k === 'cache') {
      if (!CACHE_STATES.includes(v)) problems.push(`counter cache=${v} is not ${CACHE_STATES.join('|')}`);
    } else if (!Number.isInteger(v) || v < 0) problems.push(`counter ${k}=${v} is not a non-negative integer`);
  }
  return problems;
}

/** Nearest-rank median per numeric counter; the most frequent value for string counters (cache). */
export function medianCounters(costs) {
  const keys = new Set(costs.flatMap((c) => Object.keys(c ?? {})));
  const out = {};
  for (const k of keys) {
    const nums = costs.map((c) => c?.[k]).filter((v) => typeof v === 'number');
    if (nums.length) {
      out[k] = percentile(nums, 50);
      continue;
    }
    const counts = new Map();
    for (const c of costs) if (c?.[k] !== undefined) counts.set(c[k], (counts.get(c[k]) ?? 0) + 1);
    out[k] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  }
  return out;
}

/** One problem per named `extra.kind` that has no sample. */
export function requireKinds(samples, kinds) {
  return kinds.filter((kind) => !samples.some((s) => s.extra?.kind === kind)).map((kind) => `no ${kind} sample`);
}

/**
 * The small-vs-many-workspace comparison (VAL-COST-026): for each kind, the
 * samples tagged `side: 'small'` and `side: 'many'` must both exist; their
 * medians (same-session repeats absorb the documented variance) must have
 * equal d1 and rr within `rrTolerance`.
 */
export function smallVsMany(samples, kinds, rrTolerance = 3) {
  const problems = [];
  for (const kind of kinds) {
    const side = (name) => samples.filter((s) => s.extra?.kind === kind && s.extra?.side === name).map((s) => s.cost);
    const small = side('small');
    const many = side('many');
    if (!small.length || !many.length) {
      problems.push(`${kind}: ${small.length} small / ${many.length} many-workspace samples`);
      continue;
    }
    const a = medianCounters(small);
    const b = medianCounters(many);
    if (![a.d1, a.rr, b.d1, b.rr].every((v) => typeof v === 'number')) {
      problems.push(`${kind}: d1 or rr missing`);
      continue;
    }
    if (a.d1 !== b.d1) problems.push(`${kind}: d1 ${a.d1} small != ${b.d1} many`);
    if (Math.abs(a.rr - b.rr) > rrTolerance) problems.push(`${kind}: rr ${a.rr} small vs ${b.rr} many differs by more than ${rrTolerance}`);
  }
  return problems;
}

/**
 * One catalog entry against the samples collected under its probe tag.
 * Live: pass | fail | missing. Non-live: n/a with its category and reason.
 */
export function evaluateEntry(entry, samplesByProbe) {
  if (entry.kind === 'nonlive') {
    if (!entry.reason) throw new Error(`non-live entry ${entry.id} has no reason`);
    return { id: entry.id, status: 'n/a', category: entry.category, reason: entry.reason };
  }
  const samples = samplesByProbe.get(entry.probe) ?? [];
  if (samples.length === 0) return { id: entry.id, status: 'missing', n: 0, problems: [`no samples for probe ${entry.probe}`] };
  const problems = [];
  for (const s of samples) {
    if ((s.format ?? 'http') !== (entry.format ?? 'http')) {
      problems.push(...sampleProblems(entry, s));
      continue;
    }
    problems.push(...sampleProblems(entry, s));
    const spec = typeof entry.budget === 'function' ? entry.budget(s) : entry.budget;
    for (const v of checkBudget(s.cost, spec).violations) problems.push(v);
  }
  if (entry.minSamples && samples.length < entry.minSamples) problems.push(`${samples.length} samples < ${entry.minSamples}`);
  if (entry.aggregate) problems.push(...entry.aggregate(samples));
  const spec = typeof entry.budget === 'function' ? entry.budget(samples[0]) : entry.budget;
  return {
    id: entry.id,
    status: problems.length ? 'fail' : 'pass',
    n: samples.length,
    budget: spec,
    median: medianCounters(samples.map((s) => s.cost)),
    problems: [...new Set(problems)],
  };
}

export function summarizeVerdicts(verdicts, coverage) {
  const count = (s) => verdicts.filter((v) => v.status === s).length;
  const out = {
    rows: verdicts.length,
    pass: count('pass'),
    fail: count('fail'),
    missing: count('missing'),
    na: count('n/a'),
    unmatched: coverage.unmatched.length,
    ambiguous: coverage.ambiguous.length,
    unused: coverage.unused.length,
  };
  return { ...out, ok: out.fail === 0 && out.missing === 0 && out.unmatched === 0 && out.ambiguous === 0 && out.unused === 0 };
}
