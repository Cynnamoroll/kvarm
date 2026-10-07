/**
 * @forge/diffcore — line diff engine sized for 1M-line pull requests.
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
 *    say so. This mirrors how big forges degrade on pathological files.
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
}

export interface DiffOptions {
  /** Max k-iterations before falling back (default 400_000). */
  nodeBudget?: number;
  /** Lines of context around changes (default 3). */
  context?: number;
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

/** Expands snake endpoints into single steps. */
function walkSnakes(a: readonly string[], b: readonly string[], path: Point[]): LineOp[] {
  const ops: LineOp[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    let x1 = path[i]!.x;
    let y1 = path[i]!.y;
    const x2 = path[i + 1]!.x;
    const y2 = path[i + 1]!.y;

    while (x1 < x2 && y1 < y2 && a[x1] === b[y1]) {
      ops.push('eq');
      x1++;
      y1++;
    }
    if (x2 - x1 > y2 - y1) {
      ops.push('del');
      x1++;
    } else if (y2 - y1 > x2 - x1) {
      ops.push('ins');
      y1++;
    }
    while (x1 < x2 && y1 < y2 && a[x1] === b[y1]) {
      ops.push('eq');
      x1++;
      y1++;
    }
  }
  return ops;
}

/**
 * Full line-level diff. Returns null if the budget was exceeded (callers
 * should fall back to a structural replace view).
 */
export function diffLineOps(
  a: readonly string[],
  b: readonly string[],
  nodeBudget = 400_000,
): LineOp[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return Array.from({ length: m }, () => 'ins' as LineOp);
  if (m === 0) return Array.from({ length: n }, () => 'del' as LineOp);
  try {
    const budget = new Budget(nodeBudget);
    const path = findPath(a, b, { left: 0, top: 0, right: n, bottom: m }, budget);
    return walkSnakes(a, b, path ?? [{ x: 0, y: 0 }, { x: n, y: m }]);
  } catch (err) {
    if (err instanceof DiffBudgetExceeded) return null;
    throw err;
  }
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

export function diffOps(
  oldText: string,
  newText: string,
  opts: DiffOptions = {},
): { ops: LineOp[]; approximate: boolean } {
  const budget = opts.nodeBudget ?? 400_000;
  const a = splitLines(oldText);
  const b = splitLines(newText);

  // Trim the common prefix and suffix (cheap, and keeps big near-identical
  // files far inside the budget).
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) {
    s++;
  }

  const midA = a.slice(p, a.length - s);
  const midB = b.slice(p, b.length - s);
  const mid = diffLineOps(midA, midB, budget);
  if (mid !== null) {
    const ops: LineOp[] = Array.from({ length: p }, () => 'eq' as LineOp);
    ops.push(...mid);
    ops.push(...Array.from({ length: s }, () => 'eq' as LineOp));
    return { ops, approximate: false };
  }

  return { ops: fallbackOps(a, b), approximate: true };
}

/** Over-budget fallback: common prefix/suffix + chunked replace middle. */
function fallbackOps(a: readonly string[], b: readonly string[]): LineOp[] {
  const ops: LineOp[] = [];
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) {
    ops.push('eq');
    p++;
  }
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) {
    s++;
  }
  const midA = a.length - p - s;
  const midB = b.length - p - s;
  const CHUNK = 1000;
  for (let i = 0; i < midA; i += CHUNK) {
    ops.push(...Array.from({ length: Math.min(CHUNK, midA - i) }, () => 'del' as LineOp));
  }
  for (let i = 0; i < midB; i += CHUNK) {
    ops.push(...Array.from({ length: Math.min(CHUNK, midB - i) }, () => 'ins' as LineOp));
  }
  ops.push(...Array.from({ length: s }, () => 'eq' as LineOp));
  return ops;
}

export function diffToHunks(oldText: string, newText: string, opts: DiffOptions = {}): FileDiff {
  const context = opts.context ?? 3;
  const { ops, approximate } = diffOps(oldText, newText, opts);
  const a = splitLines(oldText);
  const b = splitLines(newText);

  // Annotate ops with line numbers and text.
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let i = 0;
  let j = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const op of ops) {
    if (op === 'eq') {
      oldNo++;
      newNo++;
      lines.push({ type: 'eq', text: a[i] ?? '', oldNo, newNo });
      i++;
      j++;
    } else if (op === 'del') {
      oldNo++;
      totalDeletions++;
      lines.push({ type: 'del', text: a[i] ?? '', oldNo });
      i++;
    } else {
      newNo++;
      totalAdditions++;
      lines.push({ type: 'ins', text: b[j] ?? '', newNo });
      j++;
    }
  }

  // Group changed lines (bridged when within context*2+1 of each other)
  // into git-style hunks.
  const changedIdx: number[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    if (lines[idx]!.type !== 'eq') changedIdx.push(idx);
  }
  const hunks: Hunk[] = [];
  let ci = 0;
  while (ci < changedIdx.length) {
    const group: number[] = [changedIdx[ci]!];
    let last = changedIdx[ci]!;
    let next = ci + 1;
    while (next < changedIdx.length && changedIdx[next]! - last <= context * 2 + 1) {
      last = changedIdx[next]!;
      group.push(last);
      next++;
    }
    ci = next;

    const start = Math.max(0, group[0]! - context);
    const end = Math.min(lines.length, last + context + 1);
    const slice = lines.slice(start, end);

    const oldCount = slice.filter((l) => l.type === 'eq' || l.type === 'del').length;
    const newCount = slice.filter((l) => l.type === 'eq' || l.type === 'ins').length;

    // Git hunk-start conventions: the first line's number on each side, or
    // the line *before* the hunk when that side has no lines at all.
    const firstOld = slice.find((l) => l.oldNo !== undefined)?.oldNo;
    const firstNew = slice.find((l) => l.newNo !== undefined)?.newNo;
    const prevOld = start > 0 ? lines[start - 1]!.oldNo : undefined;
    const prevNew = start > 0 ? lines[start - 1]!.newNo : undefined;

    hunks.push({
      oldStart: oldCount > 0 ? (firstOld ?? 1) : (prevOld ?? 0),
      oldLines: oldCount,
      newStart: newCount > 0 ? (firstNew ?? 1) : (prevNew ?? 0),
      newLines: newCount,
      lines: slice,
      approximate: approximate || undefined,
    });
  }

  return { hunks, totalAdditions, totalDeletions, approximate };
}
