/**
 * Pure pieces of the final cost sweep (scripts/cost-sweep.mjs).
 *
 * library/cost.md is the budget document: every markdown table row in it is
 * one documented path. The sweep parses those rows, matches each one to a
 * catalog entry (a live probe with a normalized budget spec, or a non-live
 * entry with its category and reason), checks the measured x-forge-cost
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

/** `d1<=1;art=0;cache=hit|miss` against parsed counters; absent numeric counters read 0. */
export function checkBudget(cost, spec) {
  const violations = [];
  for (const raw of spec.split(';')) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^([a-z0-9]+)\s*(<=|=)\s*([a-z0-9|]+)$/i.exec(part);
    if (!m) throw new Error(`malformed budget part "${part}" in "${spec}"`);
    const [, k, op, lim] = m;
    if (/^\d+$/.test(lim)) {
      const n = Number(lim);
      const v = typeof cost?.[k] === 'number' ? cost[k] : 0;
      if (op === '<=' && v > n) violations.push(`${k}=${v} > ${n}`);
      if (op === '=' && v !== n) violations.push(`${k}=${v} != ${n}`);
    } else {
      const v = cost?.[k] ?? 'absent';
      if (!lim.split('|').includes(String(v))) violations.push(`${k}=${v} != ${lim}`);
    }
  }
  return { ok: violations.length === 0, violations };
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
    if (Array.isArray(entry.status)) {
      if (!entry.status.includes(s.status)) problems.push(`status ${s.status} not in ${entry.status.join('|')}`);
    } else if (entry.status !== undefined && s.status !== entry.status) problems.push(`status ${s.status} != ${entry.status}`);
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
