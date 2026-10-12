/**
 * Line-level three-way merge (diff3) with git's rules, so a merge that git
 * calls clean produces the same bytes here and a conflict here is a conflict
 * in git. This follows xdiff (`xdiff/xmerge.c`, `xdiffi.c`):
 *
 *  - Records are lines including their `\n`; a last line without one is a
 *    different record from the same text with one.
 *  - Both diffs (base->ours, base->theirs) are compacted like
 *    `xdl_change_compact`: each change group slides as far down as its
 *    lines allow, or back to line up with a change on the other side.
 *  - Changes on both sides that overlap or merely touch are a conflict,
 *    unless both sides made the identical change. Conflict regions are then
 *    refined (zealous): a region whose two sides are identical is clean, the
 *    rest is split around lines both sides agree on, and conflicts at most
 *    three lines apart are joined again.
 *
 * Line diffs come from diffcore's Myers implementation over byte-exact
 * records. Over its node budget the merge returns null; callers must treat
 * that as "unknown", never as clean.
 */

import { diffLineOps } from '@kvarm/diffcore';

const DEFAULT_NODE_BUDGET = 400_000;
const DEFAULT_MARKER_SIZE = 7;
/** git's buffer_is_binary looks for a NUL in this many leading bytes. */
const BINARY_SNIFF_BYTES = 8000;

export interface MergeTextOptions {
  /** Myers node budget per diff (default 400_000). */
  nodeBudget?: number;
  /** Conflict marker labels (`<<<<<<< ours`, `>>>>>>> theirs`). */
  labels?: { ours?: string; theirs?: string };
  /** Marker length (default 7). */
  markerSize?: number;
  /**
   * Also join conflicts separated only by lines without letters or digits
   * (`git merge-file`'s level). Merges (`merge-tree`, `merge`) leave this off.
   */
  simplifyNonAlnum?: boolean;
  /**
   * Called for each conflicting hunk with its records on both sides (lines
   * as byte strings, one char per byte, `\n` included). Returning a side
   * takes that side's lines for the hunk; null keeps the conflict. Hunks are
   * offered before nearby conflicts are joined, so one resolvable hunk next
   * to a real conflict is decided on its own lines.
   */
  resolveHunk?: (ours: readonly string[], theirs: readonly string[]) => 'ours' | 'theirs' | null;
}

export interface MergeTextResult {
  clean: boolean;
  /** Conflict hunks in `merged`. */
  conflicts: number;
  /** Conflicting hunks `resolveHunk` decided (0 without a resolver). */
  resolved: number;
  /** The merged bytes; conflict hunks carry git-style markers. */
  merged: Uint8Array;
}

/** git's binary test for a content merge: any of the three has a NUL in its first 8000 bytes. */
export function isBinaryContent3(base: Uint8Array, ours: Uint8Array, theirs: Uint8Array): boolean {
  return [base, ours, theirs].some((b) => b.subarray(0, BINARY_SNIFF_BYTES).includes(0));
}

/** Bytes as a string of one char per byte, so record equality is byte equality. */
function byteString(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}

function stringBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Lines including their terminating `\n`; a final unterminated line is its own record. */
function records(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl + 1;
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Change marks and compaction (xdiffi.c)
// ---------------------------------------------------------------------------

/** One side of a diff: its records and a changed flag per record, with a 0 sentinel on each end. */
class Side {
  /** rchg[i + 1] is record i's flag, so indexes -1 and n read the sentinels. */
  readonly rchg: Uint8Array;

  constructor(readonly recs: readonly string[]) {
    this.rchg = new Uint8Array(recs.length + 2);
  }

  get n(): number {
    return this.recs.length;
  }

  changed(i: number): boolean {
    return (this.rchg[i + 1] ?? 0) !== 0;
  }

  mark(i: number, v: 0 | 1): void {
    this.rchg[i + 1] = v;
  }
}

interface Group {
  start: number;
  end: number;
}

function groupInit(f: Side): Group {
  const g = { start: 0, end: 0 };
  while (f.changed(g.end)) g.end++;
  return g;
}

/** Moves to the next group (past one unchanged record); false at the end. */
function groupNext(f: Side, g: Group): boolean {
  if (g.end === f.n) return false;
  g.start = g.end + 1;
  for (g.end = g.start; f.changed(g.end); g.end++);
  return true;
}

function groupPrevious(f: Side, g: Group): boolean {
  if (g.start === 0) return false;
  g.end = g.start - 1;
  for (g.start = g.end; f.changed(g.start - 1); g.start--);
  return true;
}

function groupSlideDown(f: Side, g: Group): boolean {
  if (g.end < f.n && f.recs[g.start] === f.recs[g.end]) {
    f.mark(g.start++, 0);
    f.mark(g.end++, 1);
    while (f.changed(g.end)) g.end++;
    return true;
  }
  return false;
}

function groupSlideUp(f: Side, g: Group): boolean {
  if (g.start > 0 && f.recs[g.start - 1] === f.recs[g.end - 1]) {
    f.mark(--g.start, 1);
    f.mark(--g.end, 0);
    while (f.changed(g.start - 1)) g.start--;
    return true;
  }
  return false;
}

/** xdl_change_compact without the indent heuristic (merges do not use it). */
function compact(f: Side, other: Side): void {
  const g = groupInit(f);
  const go = groupInit(other);
  for (;;) {
    if (g.end !== g.start) {
      let groupSize: number;
      let earliestEnd: number;
      let endMatchingOther: number;
      do {
        groupSize = g.end - g.start;
        endMatchingOther = -1;
        while (groupSlideUp(f, g)) {
          if (!groupPrevious(other, go)) throw new Error('merge3: group sync broken sliding up');
        }
        earliestEnd = g.end;
        if (go.end > go.start) endMatchingOther = g.end;
        while (groupSlideDown(f, g)) {
          if (!groupNext(other, go)) throw new Error('merge3: group sync broken sliding down');
          if (go.end > go.start) endMatchingOther = g.end;
        }
      } while (groupSize !== g.end - g.start);

      if (g.end !== earliestEnd && endMatchingOther !== -1) {
        while (go.end === go.start) {
          if (!groupSlideUp(f, g)) throw new Error('merge3: match disappeared');
          if (!groupPrevious(other, go)) throw new Error('merge3: group sync broken sliding to match');
        }
      }
    }
    if (!groupNext(f, g)) break;
    if (!groupNext(other, go)) throw new Error('merge3: group sync broken moving to next group');
  }
}

/** A change: `chg1` records at `i1` in the old file became `chg2` records at `i2` in the new one. */
interface Change {
  i1: number;
  chg1: number;
  i2: number;
  chg2: number;
}

/** xdl_build_script: pair the change runs of both sides, in ascending order. */
function buildScript(a: Side, b: Side): Change[] {
  const out: Change[] = [];
  for (let i1 = a.n, i2 = b.n; i1 >= 0 || i2 >= 0; i1--, i2--) {
    if (a.changed(i1 - 1) || b.changed(i2 - 1)) {
      const l1 = i1;
      const l2 = i2;
      while (a.changed(i1 - 1)) i1--;
      while (b.changed(i2 - 1)) i2--;
      out.push({ i1, chg1: l1 - i1, i2, chg2: l2 - i2 });
    }
  }
  return out.reverse();
}

/** The compacted change script from `a` to `b`, or null over the node budget. */
function diffScript(a: readonly string[], b: readonly string[], nodeBudget: number): Change[] | null {
  const sa = new Side(a);
  const sb = new Side(b);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const ops = diffLineOps(a.slice(p, a.length - s), b.slice(p, b.length - s), nodeBudget);
  if (!ops) return null;
  let x = p;
  let y = p;
  for (const op of ops) {
    if (op === 'eq') {
      x++;
      y++;
    } else if (op === 'del') sa.mark(x++, 1);
    else sb.mark(y++, 1);
  }
  compact(sa, sb);
  compact(sb, sa);
  return buildScript(sa, sb);
}

// ---------------------------------------------------------------------------
// The merge (xmerge.c)
// ---------------------------------------------------------------------------

/** mode: 0 conflict, 1 ours, 2 theirs, 4 identical on both sides. Positions: base (0), ours (1), theirs (2). */
interface Region {
  mode: number;
  i0: number;
  chg0: number;
  i1: number;
  chg1: number;
  i2: number;
  chg2: number;
}

function appendRegion(list: Region[], mode: number, i0: number, chg0: number, i1: number, chg1: number, i2: number, chg2: number): void {
  const m = list[list.length - 1];
  if (m && (i1 <= m.i1 + m.chg1 || i2 <= m.i2 + m.chg2)) {
    if (mode !== m.mode) m.mode = 0;
    m.chg0 = i0 + chg0 - m.i0;
    m.chg1 = i1 + chg1 - m.i1;
    m.chg2 = i2 + chg2 - m.i2;
    return;
  }
  list.push({ mode, i0, chg0, i1, chg1, i2, chg2 });
}

function sameRecords(a: readonly string[], ai: number, b: readonly string[], bi: number, n: number): boolean {
  for (let k = 0; k < n; k++) if (a[ai + k] !== b[bi + k]) return false;
  return true;
}

function regions(
  ours: readonly string[],
  theirs: readonly string[],
  baseLen: number,
  script1: Change[],
  script2: Change[],
): Region[] {
  const out: Region[] = [];
  let a = 0;
  let b = 0;
  while (a < script1.length && b < script2.length) {
    const x1 = script1[a]!;
    const x2 = script2[b]!;
    if (x1.i1 + x1.chg1 < x2.i1) {
      appendRegion(out, 1, x1.i1, x1.chg1, x1.i2, x1.chg2, x2.i2 - x2.i1 + x1.i1, x1.chg1);
      a++;
      continue;
    }
    if (x2.i1 + x2.chg1 < x1.i1) {
      appendRegion(out, 2, x2.i1, x2.chg1, x1.i2 - x1.i1 + x2.i1, x2.chg1, x2.i2, x2.chg2);
      b++;
      continue;
    }
    if (x1.i1 !== x2.i1 || x1.chg1 !== x2.chg1 || x1.chg2 !== x2.chg2 || !sameRecords(ours, x1.i2, theirs, x2.i2, x1.chg2)) {
      const off = x1.i1 - x2.i1;
      const ffo = off + x1.chg1 - x2.chg1;
      let i0 = x1.i1;
      let i1 = x1.i2;
      let i2 = x2.i2;
      if (off > 0) {
        i0 -= off;
        i1 -= off;
      } else i2 += off;
      let chg0 = x1.i1 + x1.chg1 - i0;
      let chg1 = x1.i2 + x1.chg2 - i1;
      let chg2 = x2.i2 + x2.chg2 - i2;
      if (ffo < 0) {
        chg0 -= ffo;
        chg1 -= ffo;
      } else chg2 += ffo;
      appendRegion(out, 0, i0, chg0, i1, chg1, i2, chg2);
    }
    const end1 = x1.i1 + x1.chg1;
    const end2 = x2.i1 + x2.chg1;
    if (end1 >= end2) b++;
    if (end2 >= end1) a++;
  }
  const oursDelta = ours.length - baseLen;
  const theirsDelta = theirs.length - baseLen;
  for (; a < script1.length; a++) {
    const x1 = script1[a]!;
    appendRegion(out, 1, x1.i1, x1.chg1, x1.i2, x1.chg2, x1.i1 + theirsDelta, x1.chg1);
  }
  for (; b < script2.length; b++) {
    const x2 = script2[b]!;
    appendRegion(out, 2, x2.i1, x2.chg1, x2.i1 + oursDelta, x2.chg1, x2.i2, x2.chg2);
  }
  return out;
}

/** xdl_refine_conflicts: identical sides become clean, the rest splits around agreeing lines. */
function refine(list: Region[], ours: readonly string[], theirs: readonly string[], nodeBudget: number): Region[] {
  const out: Region[] = [];
  for (const m of list) {
    if (m.mode !== 0 || m.chg1 === 0 || m.chg2 === 0) {
      out.push(m);
      continue;
    }
    const a = ours.slice(m.i1, m.i1 + m.chg1);
    const b = theirs.slice(m.i2, m.i2 + m.chg2);
    const script = diffScript(a, b, nodeBudget);
    if (!script) {
      // Over budget: keep the conflict whole rather than guess a split.
      out.push(m);
      continue;
    }
    if (script.length === 0) {
      out.push({ ...m, mode: 4 });
      continue;
    }
    script.forEach((x, k) => {
      out.push({ ...(k === 0 ? m : { i0: m.i0, chg0: m.chg0 }), mode: 0, i1: x.i1 + m.i1, chg1: x.chg1, i2: x.i2 + m.i2, chg2: x.chg2 });
    });
  }
  return out;
}

const ALNUM = /[0-9A-Za-z]/;

/** xdl_simplify_non_conflicts: join conflicts with at most three (or only non-alphanumeric) lines between. */
function simplify(list: Region[], ours: readonly string[], ifNoAlnum: boolean): Region[] {
  const out: Region[] = [];
  for (const next of list) {
    const m = out[out.length - 1];
    if (m && m.mode === 0 && next.mode === 0) {
      const begin = m.i1 + m.chg1;
      const end = next.i1;
      const keepApart = end - begin > 3 && (!ifNoAlnum || ours.slice(begin, end).some((l) => ALNUM.test(l)));
      if (!keepApart) {
        m.chg0 = next.i0 + next.chg0 - m.i0;
        m.chg1 = next.i1 + next.chg1 - m.i1;
        m.chg2 = next.i2 + next.chg2 - m.i2;
        continue;
      }
    }
    out.push(next);
  }
  return out;
}

/** git's is_eol_crlf: 1 CRLF, 0 LF, -1 undecidable. */
function eolCrlf(recs: readonly string[], i: number): number {
  const crlf = (r: string) => (r.length > 1 && r.charCodeAt(r.length - 2) === 13 ? 1 : 0);
  if (i < recs.length - 1) return crlf(recs[i]!);
  if (recs.length === 0) return -1;
  const last = recs[i]!;
  if (last.endsWith('\n')) return crlf(last);
  if (i === 0) return -1;
  return crlf(recs[i - 1]!);
}

function needsCr(base: readonly string[], ours: readonly string[], theirs: readonly string[], m: Region): boolean {
  let cr = eolCrlf(ours, m.i1 ? m.i1 - 1 : 0);
  if (cr) cr = eolCrlf(theirs, m.i2 ? m.i2 - 1 : 0);
  if (cr) cr = eolCrlf(base, 0);
  return cr > 0;
}

function copyRecords(out: string[], recs: readonly string[], start: number, count: number, addNl: boolean, cr: boolean): void {
  if (count < 1) return;
  for (let k = start; k < start + count; k++) out.push(recs[k]!);
  if (addNl && !recs[start + count - 1]!.endsWith('\n')) out.push(cr ? '\r\n' : '\n');
}

export function mergeText(base: Uint8Array, ours: Uint8Array, theirs: Uint8Array, opts: MergeTextOptions = {}): MergeTextResult | null {
  const budget = opts.nodeBudget ?? DEFAULT_NODE_BUDGET;
  const b = records(byteString(base));
  const o = records(byteString(ours));
  const t = records(byteString(theirs));

  const s1 = diffScript(b, o, budget);
  if (!s1) return null;
  const s2 = diffScript(b, t, budget);
  if (!s2) return null;
  if (s1.length === 0) return { clean: true, conflicts: 0, resolved: 0, merged: theirs.slice() };
  if (s2.length === 0) return { clean: true, conflicts: 0, resolved: 0, merged: ours.slice() };

  let resolved = 0;
  const refined = refine(regions(o, t, b.length, s1, s2), o, t, budget);
  if (opts.resolveHunk) {
    for (const m of refined) {
      if (m.mode !== 0) continue;
      const side = opts.resolveHunk(o.slice(m.i1, m.i1 + m.chg1), t.slice(m.i2, m.i2 + m.chg2));
      if (side === null) continue;
      m.mode = side === 'ours' ? 1 : 2;
      resolved++;
    }
  }
  const list = simplify(refined, o, opts.simplifyNonAlnum === true);

  const marker = opts.markerSize ?? DEFAULT_MARKER_SIZE;
  const label = (ch: string, name: string | undefined) => ch.repeat(marker) + (name ? ` ${name}` : '');
  const out: string[] = [];
  let conflicts = 0;
  let i = 0;
  for (const m of list) {
    if (m.mode === 0) {
      conflicts++;
      const cr = needsCr(b, o, t, m);
      const eol = cr ? '\r\n' : '\n';
      copyRecords(out, o, i, m.i1 - i, false, false);
      out.push(label('<', opts.labels?.ours) + eol);
      copyRecords(out, o, m.i1, m.chg1, true, cr);
      out.push('='.repeat(marker) + eol);
      copyRecords(out, t, m.i2, m.chg2, true, cr);
      out.push(label('>', opts.labels?.theirs) + eol);
    } else if (m.mode & 3) {
      copyRecords(out, o, i, m.i1 - i, false, false);
      if (m.mode & 1) copyRecords(out, o, m.i1, m.chg1, false, false);
      if (m.mode & 2) copyRecords(out, t, m.i2, m.chg2, false, false);
    } else {
      continue;
    }
    i = m.i1 + m.chg1;
  }
  copyRecords(out, o, i, o.length - i, false, false);
  return { clean: conflicts === 0, conflicts, resolved, merged: stringBytes(out.join('')) };
}
