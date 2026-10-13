/**
 * Kvarm diff client — the compare page's virtualized per-file line diff.
 *
 * The geometry (row model, window, row recycling) is pure and exported, and
 * the headless probe (apps/platform/test/diffClient.test.ts) asserts its
 * budgets against a 1M-line model: roughly 100 mounted rows for any file
 * size, and a deterministic mapping from scroll position to row index, so
 * scrolling can never jump. The DOM wiring below runs only in a browser
 * (guarded on `document`); rows are fixed-height (one line, `white-space:
 * pre`), so no measurement pass ever changes a row's position.
 *
 * The per-file diff JSON is fetched lazily, once per opened file, from the
 * compare page's pre-encoded file API; binary and over-4-MiB files are known
 * server-side and never fetched.
 */

/** One rendered row's height in px; fixed, never measured. */
export const ROW_HEIGHT = 20;
/** Rows kept above and below the viewport, so a fast scroll paints ahead. */
export const OVERSCAN = 24;
/** Rows visible in a file's viewport (600px). */
export const VIEWPORT_ROWS = 30;
/** Pool size; must cover a full window (viewport + both overscans). */
export const POOL_SIZE = VIEWPORT_ROWS + 2 * OVERSCAN + 18;

/**
 * @typedef {Object} ClientHunk
 * @property {number} oldStart
 * @property {number} oldLines
 * @property {number} newStart
 * @property {number} newLines
 * @property {Array<{type: 'eq'|'ins'|'del', text: string, oldNo?: number, newNo?: number}>} lines
 */

/**
 * @typedef {Object} RenderRow
 * @property {'hunk'|'line'} kind
 * @property {'eq'|'ins'|'del'|'hunk'} op
 * @property {string} text
 * @property {number|null} oldNo
 * @property {number|null} newNo
 */

/**
 * The flat row stream of a file's hunks: one hunk header row then its line
 * rows. Pure; also computes the widest row for horizontal sizing.
 *
 * @param {readonly ClientHunk[]} hunks
 * @returns {{ rows: RenderRow[], total: number, maxChars: number }}
 */
export function rowsOf(hunks) {
  const rows = [];
  let maxChars = 0;
  for (const h of hunks) {
    const header = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
    rows.push({ kind: 'hunk', op: 'hunk', text: header, oldNo: null, newNo: null });
    if (header.length > maxChars) maxChars = header.length;
    for (const l of h.lines) {
      rows.push({ kind: 'line', op: l.type, text: l.text, oldNo: l.oldNo ?? null, newNo: l.newNo ?? null });
      const width = l.text.length + 12;
      if (width > maxChars) maxChars = width;
    }
  }
  return { rows, total: rows.length, maxChars };
}

/**
 * The visible row window [start, end) of a viewport at `scrollTop`, clamped
 * to [0, total] with `overscan` rows of look-ahead on both ends. Monotonic in
 * scrollTop: a forward scroll never moves `start` backwards.
 *
 * @param {number} total
 * @param {number} scrollTop
 * @param {number} overscan
 * @returns {{ start: number, end: number }}
 */
export function windowOf(total, scrollTop, overscan) {
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - overscan);
  const last = Math.min(total, Math.ceil((scrollTop + VIEWPORT_ROWS * ROW_HEIGHT) / ROW_HEIGHT) + overscan);
  return { start: first, end: Math.max(first + 1, last) };
}

/**
 * A recycled-row assignment: `capacity` slots are reused across windows, so
 * the mounted row count stays the pool size no matter how long the file is.
 * A row keeps its identity (`slotOf`) across windows while it stays inside
 * them — the scroll anchor — and a freed slot immediately serves a newly
 * visible index.
 */
export class RowPool {
  /**
   * @param {number} capacity
   */
  constructor(capacity) {
    this.capacity = capacity;
    /** @type {Map<number, number>} rowIndex -> slot */
    this.slotOf = new Map();
    /** @type {number[]} free slot ids */
    this.free = [];
    for (let i = 0; i < capacity; i++) this.free.push(i);
  }

  /** Rows currently mounted. */
  get size() {
    return this.slotOf.size;
  }

  /**
   * Assign slots to every index in [start, end); returns only the changed
   * assignments (rowIndex -> slot) so kept rows are not repainted.
   * Requires capacity >= end - start (POOL_SIZE guarantees it).
   *
   * @param {number} start
   * @param {number} end
   * @returns {Map<number, number>}
   */
  assign(start, end) {
    for (const [idx, slot] of this.slotOf) {
      if (idx < start || idx >= end) {
        this.slotOf.delete(idx);
        this.free.push(slot);
      }
    }
    const updates = new Map();
    for (let i = start; i < end; i++) {
      if (this.slotOf.has(i)) continue;
      const slot = this.free.pop();
      if (slot === undefined) break; // capacity < window: cannot happen with POOL_SIZE
      this.slotOf.set(i, slot);
      updates.set(i, slot);
    }
    return updates;
  }

  /** The slots in use; slots outside it are hidden. */
  usedSlots() {
    return new Set(this.slotOf.values());
  }
}

// ---------------------------------------------------------------------------
// DOM wiring (browser only)
// ---------------------------------------------------------------------------

function dom() {
  const d = /** @type {any} */ (globalThis).document;
  return typeof d !== 'undefined' && d ? d : null;
}

function notice(doc, cls, text) {
  const n = doc.createElement('div');
  n.className = cls;
  n.textContent = text;
  return n;
}

/**
 * One expanded file: rows + pool + its viewport.
 * @typedef {Object} FileState
 * @property {RenderRow[]} rows
 * @property {RowPool} pool
 * @property {HTMLDivElement[]} slotDivs
 * @property {any} viewport
 */

/**
 * Paints `state.rows[idx]` into the div of the slot `state` assigned to it.
 *
 * @param {FileState} state
 * @param {number} idx
 */
function paintRow(state, idx) {
  const slot = state.pool.slotOf.get(idx);
  const div = state.slotDivs[slot];
  if (!div) return;
  const r = state.rows[idx];
  div.className = 'diff-row ' + (r.kind === 'hunk' ? 'hunk-row' : r.op);
  div.style.transform = `translateY(${idx * ROW_HEIGHT}px)`;
  div.children[0].textContent = r.oldNo === null ? '' : String(r.oldNo);
  div.children[1].textContent = r.newNo === null ? '' : String(r.newNo);
  div.children[2].textContent = r.text;
}

/**
 * Re-window a file's viewport at its current scroll position.
 *
 * @param {FileState} state
 */
function updateWindow(state) {
  const scrollTop = state.viewport.scrollTop;
  const { start, end } = windowOf(state.rows.length, scrollTop, OVERSCAN);
  const updates = state.pool.assign(start, end);
  for (const idx of updates.keys()) paintRow(state, idx);
  const used = state.pool.usedSlots();
  for (let slot = 0; slot < state.slotDivs.length; slot++) {
    state.slotDivs[slot].style.display = used.has(slot) ? 'flex' : 'none';
  }
}

/**
 * Builds a file's virtualized viewport into `body`.
 *
 * @param {any} doc
 * @param {any} body
 * @param {RenderRow[]} rows
 * @param {number} maxChars
 */
function mountViewport(doc, body, rows, maxChars) {
  const viewport = doc.createElement('div');
  viewport.className = 'diff-viewport';
  const canvas = doc.createElement('div');
  canvas.className = 'diff-canvas';
  canvas.style.height = `${rows.length * ROW_HEIGHT}px`;
  canvas.style.minWidth = `${maxChars + 4}ch`;
  viewport.appendChild(canvas);
  const pool = new RowPool(POOL_SIZE);
  /** @type {any[]} */
  const slotDivs = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const div = doc.createElement('div');
    div.className = 'diff-row';
    div.style.display = 'none';
    for (const cls of ['ln old', 'ln new', 'code']) {
      const span = doc.createElement('span');
      span.className = cls;
      div.appendChild(span);
    }
    canvas.appendChild(div);
    slotDivs.push(div);
  }
  body.appendChild(viewport);
  /** @type {FileState} */
  const state = { rows, pool, slotDivs, viewport };
  viewport.addEventListener('scroll', () => updateWindow(state));
  updateWindow(state);
}

/**
 * Attaches expand/collapse behavior to one file row.
 *
 * @param {any} details
 * @param {string} fileApi
 */
function attachFile(details, fileApi) {
  const path = details.dataset.path;
  const body = details.querySelector('.diff-body');
  if (!path || !body) return;
  // Incremented on every expand; in-flight callbacks check it, so a fast
  // close/reopen can never paint a stale fetch into the fresh body.
  let epoch = 0;
  /** The in-flight fetch's controller, aborted when the row closes. */
  let controller = null;

  const clear = () => {
    epoch++;
    if (controller) controller.abort();
    controller = null;
    body.replaceChildren();
  };

  details.addEventListener('toggle', () => {
    if (!details.open) {
      clear();
      return;
    }
    if (details.dataset.binary === '1') {
      body.appendChild(notice(details.ownerDocument, 'flash warn', 'Binary file — no line diff.'));
      return;
    }
    if (details.dataset.toolarge === '1') {
      body.appendChild(notice(details.ownerDocument, 'flash warn', 'File over 4 MiB — no inline diff. The counts above still cover it.'));
      return;
    }
    const thisEpoch = ++epoch;
    controller = new AbortController();
    body.appendChild(notice(details.ownerDocument, 'muted', 'loading diff…'));
    fetch(`${fileApi}?path=${encodeURIComponent(path)}`, { signal: controller.signal, headers: { accept: 'application/json' } })
      .then((res) => {
        if (thisEpoch !== epoch) throw Object.assign(new Error('stale'), { stale: true });
        if (!res.ok) throw new Error(`file diff unavailable (${res.status})`);
        return res.json();
      })
      .then((diff) => {
        if (thisEpoch !== epoch) return;
        body.replaceChildren();
        if (diff.binary === true) {
          body.appendChild(notice(details.ownerDocument, 'flash warn', 'Binary file — no line diff.'));
          return;
        }
        if (diff.tooLarge === true) {
          body.appendChild(notice(details.ownerDocument, 'flash warn', 'File over 4 MiB — no inline diff.'));
          return;
        }
        if (diff.approximate === true) {
          body.appendChild(
            notice(
              details.ownerDocument,
              'flash warn',
              'Approximate hunks (the diff budget fallback): every changed line is shown, but the hunk structure is chunked.',
            ),
          );
        }
        if (diff.truncated === true) {
          body.appendChild(
            notice(
              details.ownerDocument,
              'flash warn',
              `Hunks cut at the output budget — +${diff.totalAdditions ?? '?'} / −${diff.totalDeletions ?? '?'} still covers the whole file. Close and reopen for a fresh load.`,
            ),
          );
        }
        const model = rowsOf(diff.hunks ?? []);
        if (model.total === 0) {
          body.appendChild(notice(details.ownerDocument, 'muted', 'no changed lines'));
          return;
        }
        mountViewport(details.ownerDocument, body, model.rows, model.maxChars);
      })
      .catch((err) => {
        if (thisEpoch !== epoch) return; // superseded by a reopen or close
        body.replaceChildren();
        body.appendChild(notice(details.ownerDocument, 'flash err', `Failed to load the diff: ${err.message}`));
        body.appendChild(notice(details.ownerDocument, 'muted', 'Close and reopen the file to retry.'));
      });
  });
}

function init() {
  const doc = dom();
  if (!doc) return;
  const root = doc.querySelector('.compare-root');
  if (!root) return;
  const fileApi = root.dataset.fileApi;
  if (!fileApi) return;
  for (const details of doc.querySelectorAll('details.diff-file')) attachFile(details, fileApi);
}

init();
