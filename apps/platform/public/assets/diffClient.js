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
 * Diffs up to this many rows render inline: every row present in the DOM,
 * lines wrapping inside the card, no horizontal scrolling and no
 * virtualized geometry. Larger diffs keep the virtualized viewport, whose
 * fixed row heights are what a 1M-line file can afford.
 */
export const INLINE_MAX_ROWS = 2000;

/** Whether a diff of `total` rows renders inline (wrapped) or virtualized. */
export function inlineOf(total) {
  return total <= INLINE_MAX_ROWS;
}

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
 * @property {[number, number]} [mark] the changed span, for a paired del/ins line
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

/** Paired lines longer than this skip the intraline pass (cost is linear, but marks stop helping). */
export const INTRALINE_MAX_CHARS = 1000;

/**
 * The changed span between a deleted line and the inserted line that
 * replaces it: the common prefix and suffix are trimmed, so `[start, end)`
 * on each side is what actually changed. Null when nothing is shared (the
 * whole line changed, so a mark would add nothing).
 *
 * @param {string} a deleted text
 * @param {string} b inserted text
 * @returns {{ del: [number, number], ins: [number, number] } | null}
 */
export function intralineOf(a, b) {
  if (a.length > INTRALINE_MAX_CHARS || b.length > INTRALINE_MAX_CHARS) return null;
  const max = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < max && a.charCodeAt(pre) === b.charCodeAt(pre)) pre++;
  let suf = 0;
  while (suf < max - pre && a.charCodeAt(a.length - 1 - suf) === b.charCodeAt(b.length - 1 - suf)) suf++;
  if (pre + suf === 0) return null;
  if (pre === a.length && pre === b.length) return null;
  return { del: [pre, a.length - suf], ins: [pre, b.length - suf] };
}

/**
 * Marks intraline spans in place: within each hunk, a run of deleted lines
 * followed by a run of inserted lines is paired line by line, and each pair
 * gets its changed span as `mark`. Linear in the row count.
 *
 * @param {RenderRow[]} rows
 * @returns {RenderRow[]} the same array
 */
export function markIntraline(rows) {
  let i = 0;
  while (i < rows.length) {
    if (rows[i].op !== 'del') {
      i++;
      continue;
    }
    const delStart = i;
    while (i < rows.length && rows[i].op === 'del') i++;
    const insStart = i;
    while (i < rows.length && rows[i].op === 'ins') i++;
    const pairs = Math.min(insStart - delStart, i - insStart);
    for (let k = 0; k < pairs; k++) {
      const d = rows[delStart + k];
      const n = rows[insStart + k];
      const span = intralineOf(d.text, n.text);
      if (!span) continue;
      d.mark = span.del;
      n.mark = span.ins;
    }
  }
  return rows;
}

/**
 * @typedef {Object} SplitRow
 * @property {'hunk'|'pair'} kind
 * @property {string} [text]
 * @property {RenderRow|null} [left]
 * @property {RenderRow|null} [right]
 */

/**
 * The side-by-side row stream: unchanged lines appear on both sides, a run
 * of deletions sits beside the insertions that follow it, and an unpaired
 * line leaves the other side empty.
 *
 * @param {readonly RenderRow[]} rows
 * @returns {SplitRow[]}
 */
export function splitRowsOf(rows) {
  /** @type {SplitRow[]} */
  const out = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.kind === 'hunk') {
      out.push({ kind: 'hunk', text: r.text });
      i++;
    } else if (r.op === 'eq') {
      out.push({ kind: 'pair', left: r, right: r });
      i++;
    } else {
      const dels = [];
      const ins = [];
      while (i < rows.length && rows[i].op === 'del') dels.push(rows[i++]);
      while (i < rows.length && rows[i].op === 'ins') ins.push(rows[i++]);
      for (let k = 0; k < Math.max(dels.length, ins.length); k++) {
        out.push({ kind: 'pair', left: dels[k] ?? null, right: ins[k] ?? null });
      }
    }
  }
  return out;
}

/** Files at or under this many changed lines open on load when the page lists few files. */
export const AUTO_OPEN_MAX_LINES = 400;
export const AUTO_OPEN_MAX_FILES = 30;

// ---------------------------------------------------------------------------
// DOM wiring (browser only)
// ---------------------------------------------------------------------------

const LAYOUT_KEY = 'kvarm.diff.layout';

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

function storedLayout() {
  try {
    return globalThis.localStorage?.getItem(LAYOUT_KEY) === 'split' ? 'split' : 'unified';
  } catch {
    return 'unified';
  }
}

/**
 * Fills `el` with `text`, wrapping the changed span `mark` (if any) in <mark>.
 *
 * @param {any} el
 * @param {string} text
 * @param {[number, number] | undefined} mark
 */
function fillText(el, text, mark) {
  if (!mark) {
    el.textContent = text;
    return;
  }
  const doc = el.ownerDocument;
  const m = doc.createElement('mark');
  m.textContent = text.slice(mark[0], mark[1]);
  el.replaceChildren(doc.createTextNode(text.slice(0, mark[0])), m, doc.createTextNode(text.slice(mark[1])));
}

const SIGN = { ins: '+', del: '−', eq: ' ', hunk: '' };

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
  div.children[2].textContent = SIGN[r.op] ?? '';
  fillText(div.children[3], r.text, r.mark);
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
 * Builds a file's virtualized viewport into `body`. Always unified: split
 * rows would need per-side horizontal scrolling the fixed geometry cannot give.
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
  canvas.style.minWidth = `${maxChars + 6}ch`;
  viewport.appendChild(canvas);
  const pool = new RowPool(POOL_SIZE);
  /** @type {any[]} */
  const slotDivs = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const div = doc.createElement('div');
    div.className = 'diff-row';
    div.style.display = 'none';
    for (const cls of ['ln old', 'ln new', 'sign', 'code']) {
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

function cell(doc, cls, text, mark) {
  const span = doc.createElement('span');
  span.className = cls;
  fillText(span, text, mark);
  return span;
}

/**
 * Builds a file's wrapped inline diff into `body`: one row per line, grid
 * columns for the two line numbers, the +/− sign and the wrapping text.
 * Rows keep their natural heights, so nothing ever scrolls sideways.
 *
 * @param {any} doc
 * @param {any} body
 * @param {RenderRow[]} rows
 */
function mountInline(doc, body, rows) {
  const list = doc.createElement('div');
  list.className = 'diff-inline';
  for (const r of rows) {
    const div = doc.createElement('div');
    if (r.kind === 'hunk') {
      div.className = 'diff-row hunk-row';
      div.appendChild(cell(doc, 'line-text', r.text));
    } else {
      div.className = 'diff-row ' + r.op;
      div.append(
        cell(doc, 'ln old', r.oldNo === null ? '' : String(r.oldNo)),
        cell(doc, 'ln new', r.newNo === null ? '' : String(r.newNo)),
        cell(doc, 'sign', SIGN[r.op] ?? ''),
        cell(doc, 'line-text', r.text, r.mark),
      );
    }
    list.appendChild(div);
  }
  body.appendChild(list);
}

/**
 * Builds the side-by-side diff: old on the left, new on the right, each
 * side wrapping in its own half.
 *
 * @param {any} doc
 * @param {any} body
 * @param {RenderRow[]} rows
 */
function mountSplit(doc, body, rows) {
  const list = doc.createElement('div');
  list.className = 'diff-inline diff-split';
  const side = (r, which) => {
    const op = r === null ? 'empty' : r.op;
    const no = r === null ? '' : String((which === 'left' ? r.oldNo : r.newNo) ?? '');
    return [cell(doc, `ln ${op}`, no), cell(doc, `line-text ${op}`, r === null ? '' : r.text, r?.mark)];
  };
  for (const s of splitRowsOf(rows)) {
    const div = doc.createElement('div');
    if (s.kind === 'hunk') {
      div.className = 'diff-row hunk-row';
      div.appendChild(cell(doc, 'line-text', s.text ?? ''));
    } else {
      div.className = 'diff-row split-row';
      div.append(...side(s.left ?? null, 'left'), ...side(s.right ?? null, 'right'));
    }
    list.appendChild(div);
  }
  body.appendChild(list);
}

/** Runs `fn` once `el` is within a screen of the viewport; files opened off screen fetch only when reached. */
function whenNear(el, fn) {
  const IO = /** @type {any} */ (globalThis).IntersectionObserver;
  if (!IO) {
    fn();
    return () => {};
  }
  const io = new IO(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        fn();
      }
    },
    { rootMargin: '800px 0px' },
  );
  io.observe(el);
  return () => io.disconnect();
}

/**
 * Attaches expand/collapse behavior to one file row. Returns a repaint hook
 * the layout toggle calls; a repaint reuses the fetched diff.
 *
 * @param {any} details
 * @param {string} fileApi
 * @param {() => 'unified'|'split'} layoutOf
 * @returns {() => void}
 */
function attachFile(details, fileApi, layoutOf) {
  const path = details.dataset.path;
  const body = details.querySelector('.diff-body');
  if (!path || !body) return () => {};
  const doc = details.ownerDocument;
  // Incremented on every expand; in-flight callbacks check it, so a fast
  // close/reopen can never paint a stale fetch into the fresh body.
  let epoch = 0;
  /** The in-flight fetch's controller, aborted when the row closes. */
  let controller = null;
  let cancelNear = () => {};
  /** The last painted model, kept while open so a layout switch repaints without refetching. */
  let model = null;
  let notes = [];

  const clear = () => {
    epoch++;
    cancelNear();
    if (controller) controller.abort();
    controller = null;
    model = null;
    body.replaceChildren();
  };

  const paint = () => {
    if (!model) return;
    body.replaceChildren(...notes.map(([cls, text]) => notice(doc, cls, text)));
    if (!inlineOf(model.total)) {
      if (layoutOf() === 'split') body.appendChild(notice(doc, 'muted diff-note', 'Large diff: shown unified in a scrolling viewport.'));
      mountViewport(doc, body, model.rows, model.maxChars);
    } else if (layoutOf() === 'split') {
      mountSplit(doc, body, model.rows);
    } else {
      mountInline(doc, body, model.rows);
    }
  };

  const load = () => {
    const thisEpoch = ++epoch;
    controller = new AbortController();
    body.replaceChildren(notice(doc, 'muted diff-note', 'loading diff…'));
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
          body.appendChild(notice(doc, 'flash warn', 'Binary file — no line diff.'));
          return;
        }
        if (diff.tooLarge === true) {
          body.appendChild(notice(doc, 'flash warn', 'File over 4 MiB — no inline diff.'));
          return;
        }
        notes = [];
        if (diff.approximate === true) {
          notes.push(['flash warn', 'Approximate hunks (the diff budget fallback): every changed line is shown, but the hunk structure is chunked.']);
        }
        if (diff.truncated === true) {
          notes.push([
            'flash warn',
            `Hunks cut at the output budget — +${diff.totalAdditions ?? '?'} / −${diff.totalDeletions ?? '?'} still covers the whole file. Close and reopen for a fresh load.`,
          ]);
        }
        const built = rowsOf(diff.hunks ?? []);
        if (built.total === 0) {
          body.replaceChildren(...notes.map(([cls, text]) => notice(doc, cls, text)), notice(doc, 'muted diff-note', 'no changed lines'));
          return;
        }
        markIntraline(built.rows);
        model = built;
        paint();
      })
      .catch((err) => {
        if (thisEpoch !== epoch) return; // superseded by a reopen or close
        body.replaceChildren();
        body.appendChild(notice(doc, 'flash err', `Failed to load the diff: ${err.message}`));
        body.appendChild(notice(doc, 'muted', 'Close and reopen the file to retry.'));
      });
  };

  details.addEventListener('toggle', () => {
    if (!details.open) {
      clear();
      return;
    }
    if (details.dataset.binary === '1') {
      body.replaceChildren(notice(doc, 'flash warn', 'Binary file — no line diff.'));
      return;
    }
    if (details.dataset.toolarge === '1') {
      body.replaceChildren(notice(doc, 'flash warn', 'File over 4 MiB — no inline diff. The counts above still cover it.'));
      return;
    }
    cancelNear();
    cancelNear = whenNear(details, load);
  });
  return paint;
}

/** details element -> its repaint hook; a WeakMap, so rows a live refresh replaced are dropped. */
const bound = new WeakMap();

/**
 * Binds every not-yet-bound file row under a `.compare-root`, unhides its
 * controls and auto-opens small diffs. Runs on load and again whenever a
 * live refresh (live.js) swaps a region in with fresh, unbound markup.
 *
 * @param {any} doc
 * @param {() => 'unified'|'split'} layoutOf
 * @param {() => void} syncLayoutButtons
 */
function bindAll(doc, layoutOf, syncLayoutButtons) {
  for (const root of doc.querySelectorAll('.compare-root')) {
    const fileApi = root.dataset.fileApi;
    if (!fileApi) continue;
    const fresh = [];
    for (const d of root.querySelectorAll('details.diff-file')) {
      if (bound.has(d)) continue;
      bound.set(d, attachFile(d, fileApi, layoutOf));
      fresh.push(d);
    }
    for (const c of root.querySelectorAll('[data-diff-controls]')) c.hidden = false;
    if (fresh.length === 0) continue;
    // Few, small files: open them all so the page reads like a diff, not a list.
    const all = root.querySelectorAll('details.diff-file').length;
    if (all <= AUTO_OPEN_MAX_FILES) {
      for (const d of fresh) {
        const lines = Number(d.dataset.lines ?? 'NaN');
        if (d.dataset.binary === '1' || d.dataset.toolarge === '1') continue;
        if (Number.isFinite(lines) && lines <= AUTO_OPEN_MAX_LINES) d.open = true;
      }
    }
  }
  syncLayoutButtons();
}

function init() {
  const doc = dom();
  if (!doc) return;
  if (!doc.querySelector('.compare-root')) return;
  let layout = storedLayout();
  const layoutOf = () => layout;
  const files = () => [...doc.querySelectorAll('.compare-root details.diff-file')];
  const syncLayoutButtons = () => {
    for (const b of doc.querySelectorAll('[data-diff-layout]')) b.setAttribute('aria-pressed', String(b.dataset.diffLayout === layout));
  };
  bindAll(doc, layoutOf, syncLayoutButtons);
  const MO = /** @type {any} */ (globalThis).MutationObserver;
  if (MO) {
    let queued = false;
    new MO(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        bindAll(doc, layoutOf, syncLayoutButtons);
      });
    }).observe(doc.body, { childList: true, subtree: true });
  }
  doc.addEventListener('click', (e) => {
    const t = /** @type {any} */ (e.target);
    const layoutBtn = t?.closest?.('[data-diff-layout]');
    if (layoutBtn) {
      layout = layoutBtn.dataset.diffLayout === 'split' ? 'split' : 'unified';
      try {
        globalThis.localStorage?.setItem(LAYOUT_KEY, layout);
      } catch {}
      syncLayoutButtons();
      for (const d of files()) bound.get(d)?.();
      return;
    }
    const expandBtn = t?.closest?.('[data-diff-expand]');
    if (expandBtn) {
      const open = expandBtn.dataset.diffExpand === 'open';
      for (const d of files()) if (d.open !== open) d.open = open;
      return;
    }
    const navLink = t?.closest?.('.diff-nav a[href^="#"]');
    if (navLink) {
      const target = doc.getElementById(navLink.getAttribute('href').slice(1));
      if (target && target.tagName === 'DETAILS') target.open = true;
    }
  });
  const hash = globalThis.location?.hash?.slice(1);
  if (hash) {
    const target = doc.getElementById(hash);
    if (target && target.tagName === 'DETAILS') target.open = true;
  }
}

init();
