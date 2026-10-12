/**
 * @kvarm/diffcore — line diff engine sized for 1M-line pull requests.
 *
 * Core: the linear-space Myers "middle snake" algorithm, ported faithfully
 * from the formulation used by git's xdiff (as documented by James Coglan's
 * "Myers diff in linear space" series, which itself follows Myers' paper
 * and git's implementation). Produces balanced, optimal-length edit scripts
 * with O(N + M) memory.
 *
 * Budgeting for the 1M-line requirement:
 *  - Diagonal walks are linear and never budgeted.
 *  - The quadratic part (k-iterations across d) is budgeted: over budget,
 *    we fall back to chunked replace hunks — a *correct* (every changed
 *    line shown), never-hanging view, labeled `approximate` so the UI can
 *    say so. This mirrors how big code hosts degrade on pathological files.
 *
 * Fuzz-verified against `git diff` by scripts/fuzz-diff.mjs.
 */

export type LineOp = 'eq' | 'ins' | 'del';

export interface DiffLine {
  type: LineOp;
  text: string;
  /** 1-based old file line number, when present. */
  oldNo?: number;
  /** 1-based new file line number, when present. */
  newNo?: number;
  /** The line ends its file without a newline (git's "\ No newline at end of file"). */
  noEol?: true;
}

export interface Hunk {
  /** 1-based start line in the old file; 0 when the hunk has no old lines. */
  oldStart: number;
  oldLines: number;
  /** 1-based start line in the new file; 0 when the hunk has no new lines. */
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  /** Set when produced by the over-budget fallback, so UI can label it. */
  approximate?: boolean;
}

export interface FileDiff {
  hunks: Hunk[];
  totalAdditions: number;
  totalDeletions: number;
  /** True if the middle-section diff was budget-fallback chunked. */
  approximate: boolean;
  /** Hunks were cut at `maxLines` / `maxBytes`; the totals still cover the file. */
  truncated?: true;
}

export interface DiffOptions {
  /** Max k-iterations before falling back (default 400_000). */
  nodeBudget?: number;
  /** Lines of context around changes (default 3). */
  context?: number;
  /**
   * Treat a missing final newline as part of the last line, like git: adding
   * or removing it changes that line (default false).
   */
  eolAware?: boolean;
  /** diffToHunks: max hunk lines materialized across all hunks (default unbounded). */
  maxLines?: number;
  /** diffToHunks: max line-text characters materialized across all hunks (default unbounded). */
  maxBytes?: number;
}

// ---------------------------------------------------------------------------
// Budget sentinel
// ---------------------------------------------------------------------------

export class DiffBudgetExceeded extends Error {
  constructor() {
    super('diff node budget exceeded');
  }
}

class Budget {
  remaining: number;
  constructor(limit: number) {
    this.remaining = limit;
  }
  spend(n = 1): void {
    this.remaining -= n;
    if (this.remaining < 0) throw new DiffBudgetExceeded();
  }
}

// ---------------------------------------------------------------------------
// Middle-snake Myers (ported from git's xdiff formulation)
// ---------------------------------------------------------------------------

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Point {
  x: number;
  y: number;
}

interface Snake {
  start: Point;
  finish: Point;
}

/** Finds the middle snake of a box, or null when the box is empty. */
function midpoint(a: readonly string[], b: readonly string[], box: Box, budget: Budget): Snake | null {
  const size = box.right - box.left + (box.bottom - box.top);
  if (size === 0) return null;

  const max = Math.ceil(size / 2);
  const off = max;
  const delta = box.right - box.left - (box.bottom - box.top);
  const vf = new Int32Array(2 * max + 1);
  const vb = new Int32Array(2 * max + 1);
  vf[1 + off] = box.left;
  vb[1 + off] = box.bottom;

  for (let d = 0; d <= max; d++) {
    // Forward scan: maximise x (prefer deletions first, like git).
    for (let k = d; k >= -d; k -= 2) {
      const c = k - delta;
      let x: number;
      let px: number;
      if (k === -d || (k !== d && vf[k - 1 + off]! < vf[k + 1 + off]!)) {
        px = x = vf[k + 1 + off]!;
      } else {
        px = vf[k - 1 + off]!;
        x = px + 1;
      }
      let y = box.top + (x - box.left) - k;
      const py = d === 0 || x !== px ? y : y - 1;

      while (x < box.right && y < box.bottom && a[x] === b[y]) {
        x++;
        y++;
      }
      vf[k + off] = x;
      budget.spend();

      // Overlap check: delta odd means forward and reverse diagonals meet.
      if ((delta & 1) !== 0 && c >= -(d - 1) && c <= d - 1 && y >= vb[c + off]!) {
        return { start: { x: px, y: py }, finish: { x, y } };
      }
    }

    // Backward scan: minimise y.
    for (let c = d; c >= -d; c -= 2) {
      const k = c + delta;
      let y: number;
      let py: number;
      if (c === -d || (c !== d && vb[c - 1 + off]! > vb[c + 1 + off]!)) {
        py = y = vb[c + 1 + off]!;
      } else {
        py = vb[c - 1 + off]!;
        y = py - 1;
      }
      let x = box.left + (y - box.top) + k;
      const px = d === 0 || y !== py ? x : x + 1;

      while (x > box.left && y > box.top && a[x - 1] === b[y - 1]) {
        x--;
        y--;
      }
      vb[c + off] = y;
      budget.spend();

      // Overlap check: delta even.
      if ((delta & 1) === 0 && k >= -d && k <= d && x <= vf[k + off]!) {
        return { start: { x, y }, finish: { x: px, y: py } };
      }
    }
  }
  // Unreachable for non-empty boxes, but keep the type honest.
  return null;
}

/** Recursively builds the list of snake endpoints from (0,0) to (N,M). */
function findPath(
  a: readonly string[],
  b: readonly string[],
  box: Box,
  budget: Budget,
): Point[] | null {
  const snake = midpoint(a, b, box, budget);
  if (!snake) return null;
  const head = findPath(
    a,
    b,
    { left: box.left, top: box.top, right: snake.start.x, bottom: snake.start.y },
    budget,
  );
  const tail = findPath(
    a,
    b,
    { left: snake.finish.x, top: snake.finish.y, right: box.right, bottom: box.bottom },
    budget,
  );
  return (head ?? [snake.start]).concat(tail ?? [snake.finish]);
}

// ---------------------------------------------------------------------------
// Edit scripts
// ---------------------------------------------------------------------------

const EQ = 0;
const DEL = 1;
const INS = 2;
const OP_NAMES: readonly LineOp[] = ['eq', 'del', 'ins'];
const DEFAULT_NODE_BUDGET = 400_000;

/**
 * An edit script as one byte per step. Steps are only ever appended one at a
 * time or filled in runs, never spread into call arguments, so a file with
 * millions of lines costs megabytes, not a stack overflow.
 */
class OpBuffer {
  readonly codes: Uint8Array;
  length = 0;

  constructor(capacity: number) {
    this.codes = new Uint8Array(capacity);
  }

  push(code: number): void {
    this.codes[this.length++] = code;
  }

  fill(code: number, count: number): void {
    this.codes.fill(code, this.length, this.length + count);
    this.length += count;
  }
}

function toLineOps(buf: OpBuffer): LineOp[] {
  return Array.from({ length: buf.length }, (_, i) => OP_NAMES[buf.codes[i]!]!);
}

/** Expands snake endpoints into single steps. */
function walkSnakes(a: readonly string[], b: readonly string[], path: Point[], out: OpBuffer): void {
  for (let i = 0; i + 1 < path.length; i++) {
    let x1 = path[i]!.x;
    let y1 = path[i]!.y;
    const x2 = path[i + 1]!.x;
    const y2 = path[i + 1]!.y;

    while (x1 < x2 && y1 < y2 && a[x1] === b[y1]) {
      out.push(EQ);
      x1++;
      y1++;
    }
    if (x2 - x1 > y2 - y1) {
      out.push(DEL);
      x1++;
    } else if (y2 - y1 > x2 - x1) {
      out.push(INS);
      y1++;
    }
    while (x1 < x2 && y1 < y2 && a[x1] === b[y1]) {
      out.push(EQ);
      x1++;
      y1++;
    }
  }
}

/**
 * Appends the optimal edit script for `box` (absolute line coordinates into
 * `a` and `b`). Returns false, having appended nothing, when the budget ran out.
 */
function diffBox(a: readonly string[], b: readonly string[], box: Box, nodeBudget: number, out: OpBuffer): boolean {
  const n = box.right - box.left;
  const m = box.bottom - box.top;
  if (n === 0) {
    out.fill(INS, m);
    return true;
  }
  if (m === 0) {
    out.fill(DEL, n);
    return true;
  }
  let path: Point[] | null;
  try {
    path = findPath(a, b, box, new Budget(nodeBudget));
  } catch (err) {
    if (err instanceof DiffBudgetExceeded) return false;
    throw err;
  }
  walkSnakes(a, b, path ?? [{ x: box.left, y: box.top }, { x: box.right, y: box.bottom }], out);
  return true;
}

/**
 * Full line-level diff. Returns null if the budget was exceeded (callers
 * should fall back to a structural replace view).
 */
export function diffLineOps(
  a: readonly string[],
  b: readonly string[],
  nodeBudget = DEFAULT_NODE_BUDGET,
): LineOp[] | null {
  const out = new OpBuffer(a.length + b.length);
  return diffBox(a, b, { left: 0, top: 0, right: a.length, bottom: b.length }, nodeBudget, out) ? toLineOps(out) : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const out = text.split('\n');
  if (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * Appended to a last line that has no trailing newline, so it never equals
 * the same text with a newline. Text files cannot plausibly contain it.
 */
const NO_EOL_MARK = '\u0000\uffff\u0000noeol';

/** Lines of a file; with `eolAware`, a missing final newline marks the last line. */
function fileLines(text: string, eolAware: boolean): string[] {
  const lines = splitLines(text);
  if (eolAware && lines.length > 0 && !text.endsWith('\n')) {
    lines[lines.length - 1] += NO_EOL_MARK;
  }
  return lines;
}

function stripMark(line: string): { text: string; noEol: boolean } {
  return line.endsWith(NO_EOL_MARK)
    ? { text: line.slice(0, -NO_EOL_MARK.length), noEol: true }
    : { text: line, noEol: false };
}

/**
 * The edit script for two line arrays. The common prefix and suffix are
 * trimmed first (cheap, and keeps big near-identical files far inside the
 * budget); over budget, the middle becomes a replace block (all deletions,
 * then all insertions) and `approximate` is set.
 */
function diffCodes(a: readonly string[], b: readonly string[], budget: number): { ops: OpBuffer; approximate: boolean } {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) {
    s++;
  }
  const out = new OpBuffer(a.length + b.length - p - s);
  out.fill(EQ, p);
  const exact = diffBox(a, b, { left: p, top: p, right: a.length - s, bottom: b.length - s }, budget, out);
  if (!exact) {
    out.length = p;
    out.fill(DEL, a.length - p - s);
    out.fill(INS, b.length - p - s);
  }
  out.fill(EQ, s);
  return { ops: out, approximate: !exact };
}

function textDiff(oldText: string, newText: string, opts: DiffOptions) {
  const eol = opts.eolAware === true;
  const a = fileLines(oldText, eol);
  const b = fileLines(newText, eol);
  return { a, b, ...diffCodes(a, b, opts.nodeBudget ?? DEFAULT_NODE_BUDGET) };
}

export function diffOps(
  oldText: string,
  newText: string,
  opts: DiffOptions = {},
): { ops: LineOp[]; approximate: boolean } {
  const { ops, approximate } = textDiff(oldText, newText, opts);
  return { ops: toLineOps(ops), approximate };
}

/** Line counts only (what `git diff --numstat` reports), without materializing any line. */
export function diffStat(
  oldText: string,
  newText: string,
  opts: DiffOptions = {},
): { additions: number; deletions: number; approximate: boolean } {
  const { ops, approximate } = textDiff(oldText, newText, opts);
  let additions = 0;
  let deletions = 0;
  for (let k = 0; k < ops.length; k++) {
    const c = ops.codes[k];
    if (c === INS) additions++;
    else if (c === DEL) deletions++;
  }
  return { additions, deletions, approximate };
}

/**
 * git-style hunks. Totals always cover the whole file; with `maxLines` /
 * `maxBytes` only the lines that fit are materialized (same cut as
 * `limitHunks` over the full output) and `truncated` is set.
 */
export function diffToHunks(oldText: string, newText: string, opts: DiffOptions = {}): FileDiff {
  const context = opts.context ?? 3;
  const eol = opts.eolAware === true;
  const maxLines = opts.maxLines ?? Infinity;
  const maxBytes = opts.maxBytes ?? Infinity;
  const { a, b, ops, approximate } = textDiff(oldText, newText, opts);
  const codes = ops.codes;
  const len = ops.length;

  // Pass 1: totals, and groups of changed steps bridged when within
  // context*2+1 of each other, as [first, last] pairs.
  let totalAdditions = 0;
  let totalDeletions = 0;
  const groups: number[] = [];
  let first = -1;
  let last = -1;
  for (let k = 0; k < len; k++) {
    const c = codes[k];
    if (c === EQ) continue;
    if (c === INS) totalAdditions++;
    else totalDeletions++;
    if (first === -1) {
      first = k;
    } else if (k - last > context * 2 + 1) {
      groups.push(first, last);
      first = k;
    }
    last = k;
  }
  if (first !== -1) groups.push(first, last);

  // Pass 2: one forward walk; groups never overlap, so the old/new line
  // counters only move ahead.
  const hunks: Hunk[] = [];
  let truncated = false;
  let usedLines = 0;
  let usedBytes = 0;
  let k = 0;
  let i = 0;
  let j = 0;
  for (let g = 0; g < groups.length && !truncated; g += 2) {
    const start = Math.max(0, groups[g]! - context);
    const end = Math.min(len, groups[g + 1]! + context + 1);
    for (; k < start; k++) {
      if (codes[k] !== INS) i++;
      if (codes[k] !== DEL) j++;
    }
    let oldCount = 0;
    let newCount = 0;
    for (let q = start; q < end; q++) {
      if (codes[q] !== INS) oldCount++;
      if (codes[q] !== DEL) newCount++;
    }
    // Git hunk-start conventions: the first line's number on each side, or
    // the line *before* the hunk when that side has no lines at all.
    const prev = start > 0 ? codes[start - 1] : undefined;
    const oldStart = oldCount > 0 ? i + 1 : prev !== undefined && prev !== INS ? i : 0;
    const newStart = newCount > 0 ? j + 1 : prev !== undefined && prev !== DEL ? j : 0;

    const lines: DiffLine[] = [];
    let keptOld = 0;
    let keptNew = 0;
    for (; k < end; k++) {
      const c = codes[k];
      const raw = (c === INS ? b[j] : a[i]) ?? '';
      const { text, noEol } = eol ? stripMark(raw) : { text: raw, noEol: false };
      if (usedLines + 1 > maxLines || usedBytes + text.length > maxBytes) {
        truncated = true;
        break;
      }
      usedLines++;
      usedBytes += text.length;
      const line: DiffLine =
        c === EQ ? { type: 'eq', text, oldNo: i + 1, newNo: j + 1 } : c === DEL ? { type: 'del', text, oldNo: i + 1 } : { type: 'ins', text, newNo: j + 1 };
      if (noEol) line.noEol = true;
      lines.push(line);
      if (c !== INS) {
        i++;
        keptOld++;
      }
      if (c !== DEL) {
        j++;
        keptNew++;
      }
    }
    if (lines.length === 0) break;
    hunks.push({
      oldStart,
      oldLines: truncated ? keptOld : oldCount,
      newStart,
      newLines: truncated ? keptNew : newCount,
      lines,
      approximate: approximate || undefined,
    });
  }

  const out: FileDiff = { hunks, totalAdditions, totalDeletions, approximate };
  if (truncated) out.truncated = true;
  return out;
}

/** git's heuristic (xdiff `buffer_is_binary`): a NUL byte in the first 8000 bytes. */
export function isBinaryContent(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

export interface HunkLimits {
  /** Max hunk lines kept across all hunks. */
  maxLines: number;
  /** Max line-text characters kept across all hunks. */
  maxBytes: number;
}

/**
 * Bounds the rendered output of a diff. Whole hunks are kept while they fit;
 * the hunk that crosses a bound is cut short with its header recounted, and
 * everything after it is dropped.
 */
export function limitHunks(hunks: Hunk[], limits: HunkLimits): { hunks: Hunk[]; truncated: boolean } {
  let lines = 0;
  let bytes = 0;
  const out: Hunk[] = [];
  for (const h of hunks) {
    let keep = 0;
    let hunkBytes = 0;
    while (keep < h.lines.length) {
      const len = h.lines[keep]!.text.length;
      if (lines + keep + 1 > limits.maxLines || bytes + hunkBytes + len > limits.maxBytes) break;
      hunkBytes += len;
      keep++;
    }
    if (keep === h.lines.length) {
      out.push(h);
      lines += keep;
      bytes += hunkBytes;
      continue;
    }
    if (keep > 0) {
      const kept = h.lines.slice(0, keep);
      out.push({
        ...h,
        oldLines: kept.filter((l) => l.type !== 'ins').length,
        newLines: kept.filter((l) => l.type !== 'del').length,
        lines: kept,
      });
    }
    return { hunks: out, truncated: true };
  }
  return { hunks: out, truncated: false };
}
