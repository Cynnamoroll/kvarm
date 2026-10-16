/**
 * Pure helpers for the 100-workspace fleet driver (scripts/fleet-driver.mjs):
 * the fleet plan, the preflight projection and ceiling gate, the runtime
 * request ledger and concurrency limiter, cost parsing against documented
 * budget rows, and the checks behind "no lost or double publications".
 * Nothing here talks to the network or spawns processes.
 */

/** Mission caps (AGENTS.md "Scale work is bounded") and the per-credential git write limit. */
export const CAMPAIGN_LIMITS = Object.freeze({
  gitChildren: 3,
  httpInFlight: 5,
  ceiling: 10_000,
  gitWritesPerMin: 120,
  // Upper bound of HTTP requests one git child issues (401 probe + advertisement + 1-2 POSTs).
  gitHttpPerOp: 4,
});

const MISSION_CAPS = Object.freeze({ gitChildren: CAMPAIGN_LIMITS.gitChildren, httpInFlight: CAMPAIGN_LIMITS.httpInFlight });

const pad = (n, w) => String(n).padStart(w, '0');

/** `line 01: base` … `line NN: base`, newline-terminated. */
export function configText(lines = 40) {
  return Array.from({ length: lines }, (_, i) => `line ${pad(i + 1, 2)}: base`).join('\n') + '\n';
}

/** Replaces 1-based line `lineNo` of `text`. */
export function editLine(text, lineNo, content) {
  const lines = text.split('\n');
  if (lineNo < 1 || lineNo > lines.length) throw new Error(`line ${lineNo} out of range`);
  lines[lineNo - 1] = content;
  return lines.join('\n');
}

export const CONFIG_PATH = 'shared/config.txt';
export const CONFIG_LINES = 40;
const NONOVERLAP_LINES = [3, 8, 13, 18, 23, 28];
const IDENTICAL_LINE = 33;
const CONFLICT_LINE = 38;

/**
 * The fleet: member 0 is the early sentinel (pushed, never enqueued), members
 * 1-3 the pinned chain A <- B <- C, then twelve members editing one shared
 * file (non-overlapping lines, an identical edit pair, four same-line
 * variants) spread among independent members that each add only their own
 * marker file.
 */
export function planFleet({ workspaces = 100, ts }) {
  const n = workspaces;
  if (!Number.isInteger(n) || n < 16) throw new Error(`a fleet needs at least 16 workspaces for every role (got ${n})`);
  const nonoverlap = n >= 100 ? 6 : 2;
  const overlapRoles = [
    ...NONOVERLAP_LINES.slice(0, nonoverlap).map((line) => ({ role: 'nonoverlap', line })),
    { role: 'identical', line: IDENTICAL_LINE },
    { role: 'identical', line: IDENTICAL_LINE },
    ...Array.from({ length: 4 }, () => ({ role: 'conflict', line: CONFLICT_LINE })),
  ];
  const roles = Array.from({ length: n }, () => null);
  roles[0] = { role: 'sentinel' };
  roles[1] = { role: 'chain', chain: 'A' };
  roles[2] = { role: 'chain', chain: 'B' };
  roles[3] = { role: 'chain', chain: 'C' };
  const free = n - 4;
  overlapRoles.forEach((r, k) => {
    roles[4 + Math.floor((k * free) / overlapRoles.length)] = r;
  });
  const identicalText = `line ${pad(IDENTICAL_LINE, 2)}: identical edit FLEET${ts}IDENT`;
  const members = roles.map((r, index) => {
    const key = `w${pad(index, 3)}`;
    const base = { index, key, role: r?.role ?? 'independent', marker: `FLEET${ts}${key.toUpperCase()}X` };
    if (!r || r.role === 'sentinel') return base;
    if (r.role === 'chain') return { ...base, chain: r.chain };
    if (r.role === 'identical') return { ...base, line: r.line, lineText: identicalText };
    const lineMarker = `FLEET${ts}${key.toUpperCase()}L`;
    const lineText = r.role === 'conflict' ? `line ${pad(r.line, 2)}: variant ${lineMarker}` : `line ${pad(r.line, 2)}: edited ${lineMarker}`;
    return { ...base, line: r.line, lineMarker, lineText };
  });
  const byChain = Object.fromEntries(members.filter((m) => m.chain).map((m) => [m.chain, m.key]));
  const overlapKeys = members.filter((m) => m.line !== undefined).map((m) => m.key);
  const pairKey = (a, b) => [a, b].sort().join('|');
  const expectedPairs = new Set();
  for (let i = 0; i < overlapKeys.length; i++) for (let j = i + 1; j < overlapKeys.length; j++) expectedPairs.add(pairKey(overlapKeys[i], overlapKeys[j]));
  for (const [a, b] of [
    ['A', 'B'],
    ['A', 'C'],
    ['B', 'C'],
  ])
    expectedPairs.add(pairKey(byChain[a], byChain[b]));
  const burst = members.filter((m) => m.role !== 'sentinel').map((m) => m.key);
  const middle = burst.filter((k) => k !== byChain.A && k !== byChain.B && k !== byChain.C);
  return {
    workspaces: n,
    ts,
    members,
    sentinel: members[0].key,
    chain: { A: byChain.A, B: byChain.B, C: byChain.C },
    overlapKeys,
    expectedPairs,
    pairKey,
    burst,
    enqueueOrder: [byChain.C, byChain.B, ...middle, byChain.A],
    identicalMarker: `FLEET${ts}IDENT`,
    config: configText(CONFIG_LINES),
  };
}

/** Files a member's own commit adds or changes (relative to its parent commit). */
export function memberFiles(plan, member, parentConfig = plan.config) {
  const files = { [`fleet/${member.key}.txt`]: `${member.marker}\nworkspace ${member.key} (${member.role})\n` };
  if (member.line !== undefined) files['shared/config.txt'] = editLine(parentConfig, member.line, member.lineText);
  if (member.chain) {
    const prev = { A: null, B: 'a', C: 'b' }[member.chain];
    const name = member.chain.toLowerCase();
    files[`iface/${name}.txt`] = `interface ${name}${prev ? ` builds on ${prev}` : ''}\n`;
  }
  return files;
}

/**
 * Harness-issued request projection for one run (REST requests plus git
 * children × gitHttpPerOp) and the server-side background work it causes
 * (reported separately, not counted against the ceiling).
 */
export function projectCampaign(plan, opts = {}) {
  const o = {
    pushesPerMinute: 30,
    enqueueIntervalMs: 600,
    pollIntervalMs: 4000,
    maxBurstMs: 40 * 60_000,
    maxObserveMs: 240_000,
    observePollMs: 4000,
    maxResolutions: 5,
    resolutionWaitMs: 180_000,
    retryBudget: 100,
    listLimit: 30,
    overlapLimit: 50,
    gitHttpPerOp: CAMPAIGN_LIMITS.gitHttpPerOp,
    ...opts,
  };
  const N = plan.workspaces;
  const B = plan.burst.length;
  const R = Math.min(o.maxResolutions, plan.members.filter((m) => m.role === 'conflict').length);
  const pairs = plan.expectedPairs.size;
  const changePages = Math.ceil((B + 1) / 100) + 1;
  const items = [
    { stage: 'setup', label: 'bootstrap snapshot (user, kvarm-e2e, token list), repo existence check, repo create', http: 5, git: 0 },
    { stage: 'setup', label: 'seed push of main', http: 0, git: 1 },
    { stage: 'fleet', label: `${N} × (create agent, mint write token, create workspace)`, http: 3 * N, git: 0 },
    { stage: 'fleet', label: `${N} workspace pushes (one agent token each)`, http: 0, git: N },
    { stage: 'fleet', label: 'chain pins (2) and their reads (2)', http: 4, git: 0 },
    { stage: 'observe', label: `forecast polls until all ${N} observed (≤ ${o.maxObserveMs / 1000} s every ${o.observePollMs / 1000} s, 2 pages)`, http: 2 * Math.ceil(o.maxObserveMs / o.observePollMs), git: 0 },
    {
      stage: 'verify-pre',
      label: `pre-burst: ls-remote, workspace list pages (limit ${o.listLimit}), overlap pages (limit ${o.overlapLimit}), forecast`,
      http: Math.ceil(N / o.listLimit) + 1 + Math.ceil(pairs / o.overlapLimit) + 1 + 2,
      git: 1,
    },
    { stage: 'burst', label: `${B} change sets`, http: B, git: 0 },
    { stage: 'burst', label: `${B} enqueues + ≤ ${o.retryBudget} 429 retries (campaign retry budget)`, http: B + o.retryBudget, git: 0 },
    {
      stage: 'polls',
      label: `burst polls every ${o.pollIntervalMs / 1000} s for ≤ ${o.maxBurstMs / 60_000} min (changes pages + queue)`,
      http: Math.ceil(o.maxBurstMs / o.pollIntervalMs) * (changePages + 1),
      git: 0,
    },
    {
      stage: 'resolve',
      label: `≤ ${R} conflict resolutions (tasks, claim, complete, change read, enqueue, polls ≤ ${o.resolutionWaitMs / 1000} s)`,
      http: R * (5 + Math.ceil(o.resolutionWaitMs / o.pollIntervalMs)),
      git: R * 2,
    },
    { stage: 'verify-final', label: 'final: fresh clone, ls-remote, workspace pages, change details, queue, sentinel, bootstrap', http: 12 + Math.ceil((N + R) / 100) + 1 + 12, git: 2 },
    { stage: 'cleanup', label: `${N} agent revocations, repo delete, 404 readback`, http: N + 2, git: 0 },
  ].map((i) => ({ ...i, requests: i.http + i.git * o.gitHttpPerOp }));
  const total = items.reduce((s, i) => s + i.requests, 0);
  const gitOps = items.reduce((s, i) => s + i.git, 0);
  const background = [
    { label: 'push events (fleet pushes, seed, resolutions, one per publication on main)', count: N + 1 + R + B + R },
    { label: 'kvarm/guard runs (one per change at creation, one per resolved head)', count: B + R },
    { label: 'Nexus observed-index reconciliations', count: N + R },
    { label: 'train kicks (enqueues, publications, pin settlement)', count: B + R + B + 2 },
    { label: 'train publications (MergeLock acquire + release each)', count: B },
    { label: 'eager default-branch snapshot builds (one per main move, tree-deduped)', count: B + 1 },
  ];
  return {
    items,
    total,
    gitOps,
    opts: o,
    // A push is one receive-pack advertisement plus one receive-pack POST under the pushing credential.
    gitWritesPerMinute: o.pushesPerMinute * 2,
    background,
  };
}

/** The preflight gate: every problem that keeps the run from starting. */
export function checkProjection(projection, limits) {
  const problems = [];
  if (projection.total > limits.ceiling) {
    problems.push(
      `projected ${projection.total} harness requests exceed the campaign ceiling ${limits.ceiling}; the approved 100-workspace run cannot fit, escalate to the user (no silent scope cut)`,
    );
  }
  if (limits.gitChildren > MISSION_CAPS.gitChildren) problems.push(`${limits.gitChildren} git children exceed the mission cap of ${MISSION_CAPS.gitChildren}`);
  if (limits.httpInFlight > MISSION_CAPS.httpInFlight) problems.push(`${limits.httpInFlight} in-flight HTTP requests exceed the mission cap of ${MISSION_CAPS.httpInFlight}`);
  if (projection.gitWritesPerMinute > limits.gitWritesPerMin) {
    problems.push(`planned git pace of ${projection.gitWritesPerMinute} write requests/min exceeds the per-credential git write limit ${limits.gitWritesPerMin}/min`);
  }
  return { fits: problems.length === 0, problems };
}

export class CeilingExceeded extends Error {
  constructor(message) {
    super(message);
    this.name = 'CeilingExceeded';
  }
}

export class CampaignAbort extends Error {}

/**
 * The driver's invariant results: `check` records one and continues, `gate`
 * records it and throws CampaignAbort when it fails, so no later stage (the
 * live burst included) starts after a failed gate.
 * @param {{ log: (line: string) => void, stage: () => string }} o
 */
export function createInvariants({ log, stage }) {
  /** @type {{ id: string, label: string, ok: boolean, detail: string }[]} */
  const results = [];
  const check = (id, label, ok, detail = '') => {
    results.push({ id, label, ok: Boolean(ok), detail });
    log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${label}${detail ? `  -> ${detail}` : ''}`);
    return Boolean(ok);
  };
  const gate = (id, label, ok, detail = '') => {
    if (!check(id, label, ok, detail)) throw new CampaignAbort(`invariant failed at ${stage()}: ${label}${detail ? ` (${detail})` : ''}`);
  };
  return { results, check, gate };
}

/**
 * The pre-burst forecast invariant: a 200 answer whose matches are exactly
 * the shared-file members, no more and no fewer.
 * @param {{ status: number, matches: { workspace: string }[] | undefined, idToKey: Map<string, string>, overlapKeys: string[] }} o
 */
export function forecastMemberSet({ status, matches, idToKey, overlapKeys }) {
  const keys = new Set((matches ?? []).map((m) => idToKey.get(m.workspace)));
  return { ok: status === 200 && keys.size === overlapKeys.length && overlapKeys.every((k) => keys.has(k)), size: keys.size };
}

/** Counts every harness-issued request and refuses the one that would pass the ceiling. */
export class RequestLedger {
  constructor(ceiling) {
    this.ceiling = ceiling;
    this.total = 0;
    this.byKind = { http: 0, git: 0 };
    this.byLabel = {};
  }

  reserve(kind, n = 1, label = kind) {
    if (this.total + n > this.ceiling) {
      throw new CeilingExceeded(`request ceiling ${this.ceiling} reached at ${this.total} (+${n} for ${label})`);
    }
    this.total += n;
    this.byKind[kind] = (this.byKind[kind] ?? 0) + n;
    this.byLabel[label] = (this.byLabel[label] ?? 0) + n;
  }
}

/** A FIFO semaphore: at most `max` tasks run at once; `peak` records the highest concurrency seen. */
export function createLimiter(max) {
  let active = 0;
  const waiting = [];
  const lim = {
    peak: 0,
    get active() {
      return active;
    },
    async run(fn) {
      if (active >= max) await new Promise((resolve) => waiting.push(resolve));
      active++;
      lim.peak = Math.max(lim.peak, active);
      try {
        return await fn();
      } finally {
        active--;
        waiting.shift()?.();
      }
    },
  };
  return lim;
}

/** Retry-After seconds → ms, falling back when absent or malformed, capped. */
export function retryAfterMs(header, fallbackMs, capMs) {
  const s = Number(header);
  if (header === null || header === undefined || header === '' || !Number.isFinite(s) || s < 0) return fallbackMs;
  return Math.min(s * 1000, capMs);
}

/** `d1=3;rr=9;cache=hit` → {d1: 3, rr: 9, cache: 'hit'}. */
export function parseCost(header) {
  const out = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    out[k] = v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
  }
  return out;
}

export function sumCosts(list) {
  const out = {};
  for (const c of list) for (const [k, v] of Object.entries(c ?? {})) if (typeof v === 'number') out[k] = (out[k] ?? 0) + v;
  return out;
}

/** Checks parsed counters against a budget row such as `d1<=3;rr<=12;do=2` (absent counters read 0). */
export function withinBudget(cost, spec) {
  const violations = [];
  for (const part of spec.split(';')) {
    const m = /^\s*([a-z0-9]+)\s*(<=|=)\s*(\d+)\s*$/.exec(part);
    if (!m) continue;
    const [, k, op, limStr] = m;
    const lim = Number(limStr);
    const v = typeof cost?.[k] === 'number' ? cost[k] : 0;
    if (op === '<=' && v > lim) violations.push(`${k}=${v} > ${lim}`);
    if (op === '=' && v !== lim) violations.push(`${k}=${v} != ${lim}`);
  }
  return { ok: violations.length === 0, violations };
}

/**
 * The budget rows the run is compared with. Publications are keyed
 * on incoming pins (a dependent's pins on its sources), as the enqueue
 * comparison is; the documented publication row covers both classes.
 */
const PUBLICATION_ROW = 'd1<=3;rr<=12;rw<=8;art<=4;do=2;sub<=2';
export const BUDGET_ROWS = Object.freeze({
  workspaceList: 'd1<=2;art=0;do=0;sub=0',
  overlap: 'd1<=2;art=0;do=0;sub=0',
  forecast: 'd1<=2;art=0;do=0;sub=0',
  enqueue: 'd1<=2;rr<=12;rw<=4;art=0;do<=1;q<=1',
  publication: Object.freeze({ unpinned: PUBLICATION_ROW, pinned: PUBLICATION_ROW }),
});

export const CHECK_IDS = Object.freeze({ publication: 'VAL-SCALE-004d', monetary: 'VAL-SCALE-004d-monetary' });

/**
 * Each publication's stored counters against the row applicable to it:
 * `rows.pinned` for a change with incoming pins (`pinnedNumbers`), else
 * `rows.unpinned`.
 */
export function comparePublications(pubs, pinnedNumbers, rows) {
  const classes = {
    unpinned: { row: rows.unpinned, total: 0, within: 0 },
    pinned: { row: rows.pinned, total: 0, within: 0 },
  };
  const outside = [];
  for (const p of pubs) {
    const pinned = pinnedNumbers.has(p.number);
    const cls = classes[pinned ? 'pinned' : 'unpinned'];
    const v = withinBudget(p.cost, cls.row);
    cls.total++;
    if (v.ok) cls.within++;
    else outside.push({ number: p.number, pinned, row: cls.row, cost: fmtCounters(p.cost), violations: v.violations });
  }
  const detail = `unpinned ${classes.unpinned.within}/${classes.unpinned.total} within ${classes.unpinned.row}; with incoming pins ${classes.pinned.within}/${classes.pinned.total} within ${classes.pinned.row}`;
  return { ok: outside.length === 0, classes, outside, detail };
}

const LITERALS = new Set([
  'repos', 'agents', 'tokens', 'user', 'changes', 'enqueue', 'queue', 'train', 'workspaces', 'overlap', 'change-set', 'intent',
  'dependencies', 'repin', 'forecast', 'tasks', 'claim', 'complete', 'heartbeat', 'mergeability', 'checks', 'merge', 'abandon', 'candidates',
]);

/** `POST /api/v1/repos/o/r/changes/12/enqueue?x` → `POST /repos/:o/:r/changes/:n/enqueue`. */
export function endpointClass(method, url) {
  const path = url.split('?')[0].replace(/^https?:\/\/[^/]+/, '').replace(/^\/api\/v1/, '');
  const segs = path.split('/').filter(Boolean);
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s === 'repos' && segs.length >= i + 3) {
      out.push('repos', ':o', ':r');
      i += 2;
    } else if (LITERALS.has(s)) out.push(s);
    else out.push(/^\d+$/.test(s) ? ':n' : ':id');
  }
  return `${method} /${out.join('/')}`;
}

/**
 * Publication graph check over main's first-parent history (newest first,
 * ending at `seed`): every first-parent step is exactly one accepted
 * publication (a fast-forward to the change head, or a merge commit with
 * parents [previous tip, head]), or a driver-made commit inside a
 * fast-forwarded head; every accepted change appears exactly once.
 */
export function verifyGraph({ firstParent, seed, accepted, ledgerCommits }) {
  const problems = [];
  const byMerge = new Map();
  for (const a of accepted) {
    if (byMerge.has(a.mergeCommit)) problems.push(`#${a.number} and #${byMerge.get(a.mergeCommit).number} both claim merge commit ${a.mergeCommit}`);
    else byMerge.set(a.mergeCommit, a);
  }
  const chain = [...firstParent].reverse();
  const seedAt = chain.findIndex((c) => c.sha === seed);
  if (seedAt !== 0) problems.push(`main's first-parent history does not end at the seed ${seed}`);
  const seen = new Set();
  const order = [];
  const secondParents = new Map();
  let pendingInner = [];
  for (let i = Math.max(seedAt, 0) + 1; i < chain.length; i++) {
    const c = chain[i];
    const prev = chain[i - 1].sha;
    if (c.parents.length > 1) {
      const head = c.parents[1];
      if (secondParents.has(head)) problems.push(`head ${head} merged twice (${secondParents.get(head)} and ${c.sha})`);
      secondParents.set(head, c.sha);
    }
    const a = byMerge.get(c.sha);
    if (a) {
      if (seen.has(a.number)) problems.push(`#${a.number} published twice`);
      seen.add(a.number);
      order.push(a.number);
      if (a.mergeCommit !== a.headSha) {
        if (c.parents[0] !== prev || c.parents[1] !== a.headSha) {
          problems.push(`#${a.number} merge commit ${c.sha} parents [${c.parents.join(', ')}] are not [${prev}, ${a.headSha}]`);
        }
        if (a.previous && a.previous !== c.parents[0]) problems.push(`#${a.number} recorded previous tip ${a.previous} but merge commit's first parent is ${c.parents[0]}`);
        if (pendingInner.length) problems.push(`commits ${pendingInner.join(', ')} reached main without a publication`);
      }
      pendingInner = [];
    } else if (ledgerCommits.has(c.sha) && c.parents.length === 1) {
      pendingInner.push(c.sha);
    } else {
      problems.push(`unexpected commit ${c.sha} on main's first-parent history`);
    }
  }
  if (pendingInner.length) problems.push(`commits ${pendingInner.join(', ')} reached main without a publication`);
  for (const a of accepted) if (!seen.has(a.number)) problems.push(`#${a.number} merge commit ${a.mergeCommit} is not on main's first-parent history`);
  return { ok: problems.length === 0, problems, order };
}

/**
 * Compares `git notes list` output (`<note blob> <annotated commit>` lines,
 * or null when the notes ref is absent) with the commits that must carry
 * exactly one note.
 */
export function verifyNotes({ notesList, expected }) {
  const noted = new Set(
    (notesList ?? '')
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[1])
      .filter(Boolean),
  );
  const want = new Set(expected);
  const missing = [...want].filter((sha) => !noted.has(sha));
  const unexpected = [...noted].filter((sha) => !want.has(sha));
  return { ok: missing.length === 0 && unexpected.length === 0, missing, unexpected, noted: noted.size };
}

/**
 * The longest stretch, from the first enqueue on, in which no queue entry
 * reached a terminal state (`published` or ejected/cancelled), and the
 * transition that ended it. Times are relative to the first enqueue.
 */
export function longestQueueIdle(rows) {
  if (!rows?.length) return null;
  const t0 = Math.min(...rows.map((r) => r.enqueued_at));
  const ends = rows
    .filter((r) => !['queued', 'checking', 'ready', 'publishing'].includes(r.state))
    .map((r) => ({ at: r.updated_at - t0, label: `#${r.change_number} ${r.state}${r.reason_code ? ` ${r.reason_code}` : ''}` }))
    .sort((a, b) => a.at - b.at);
  if (ends.length === 0) return null;
  let best = { ms: ends[0].at, fromMs: 0, toMs: ends[0].at, endedBy: ends[0].label };
  for (let i = 1; i < ends.length; i++) {
    const gap = ends[i].at - ends[i - 1].at;
    if (gap > best.ms) best = { ms: gap, fromMs: ends[i - 1].at, toMs: ends[i].at, endedBy: ends[i].label };
  }
  return best;
}

/** Occurrences of each marker across all files. */
export function countMarkers(files, markers) {
  const counts = new Map(markers.map((m) => [m, 0]));
  for (const f of files) for (const m of markers) counts.set(m, counts.get(m) + (f.text.split(m).length - 1));
  return counts;
}

/** Every created workspace accounted for by its listed final status; nothing unexplained. */
export function reconcileWorkspaces({ created, abandoned = [], listed }) {
  const byStatus = {};
  const listedMap = new Map();
  for (const w of listed) {
    byStatus[w.status] = (byStatus[w.status] ?? 0) + 1;
    listedMap.set(w.id, w.status);
  }
  const createdIds = new Set(created.map((c) => c.id));
  const missing = created.filter((c) => !listedMap.has(c.id)).map((c) => c.id);
  const unexpected = listed.filter((w) => !createdIds.has(w.id)).map((w) => w.id);
  const mismatched = created
    .filter((c) => listedMap.has(c.id) && c.expect !== '*' && listedMap.get(c.id) !== (abandoned.includes(c.id) ? 'abandoned' : c.expect))
    .map((c) => ({ id: c.id, expected: c.expect, actual: listedMap.get(c.id) }));
  return { ok: !missing.length && !unexpected.length && !mismatched.length, byStatus, missing, unexpected, mismatched };
}

/** Nearest-rank percentile; null for no samples. */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const TRAIN_PHASES = ['enqueued', 'prepareStart', 'prepareEnd', 'checksReady', 'leaseAcquired', 'packBuilt', 'pushSent', 'pushConfirmed', 'recorded'];

/** Aggregate per-entry train phase deltas; omitted events do not become zero samples. */
export function aggregateTrainPhases(entries) {
  const samples = new Map();
  const add = (name, value) => {
    if (!Number.isFinite(value) || value < 0) return;
    const values = samples.get(name) ?? [];
    values.push(value);
    samples.set(name, values);
  };
  for (const entry of entries) {
    const present = TRAIN_PHASES.filter((phase) => Number.isFinite(entry?.[phase]));
    for (let i = 1; i < present.length; i++) {
      const from = present[i - 1];
      const to = present[i];
      add(`${from}→${to}`, entry[to] - entry[from]);
    }
    if (Number.isFinite(entry?.leaseAcquired) && Number.isFinite(entry?.pushConfirmed)) {
      add('lockHeld', entry.pushConfirmed - entry.leaseAcquired);
    }
    if (Number.isFinite(entry?.enqueued) && Number.isFinite(entry?.recorded)) {
      add('total', entry.recorded - entry.enqueued);
    }
  }
  return Object.fromEntries(
    [...samples].map(([name, values]) => [name, { n: values.length, p50: percentile(values, 50), p90: percentile(values, 90), max: Math.max(...values) }]),
  );
}

const MONETARY = [/[$€£]\s?\d/g, /\b\d+(?:\.\d+)?\s?(?:USD|EUR|GBP|cents?)\b/gi, /\b(?:price[ds]?|pricing|invoice[ds]?|dollars?)\b/gi];

/** Currency amounts or pricing derivations in `text` (the report must have none). */
export function findMonetary(text) {
  return MONETARY.flatMap((re) => [...text.matchAll(re)].map((m) => m[0]));
}

const fmtMs = (ms) => (ms === null || ms === undefined ? 'n/a' : ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const fmtCounters = (c) =>
  Object.entries(c ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(';');

/** The committed benchmark table for one fleet run. */
function checksSection(checks) {
  if (!checks?.length) return [];
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) return ['## Checks', '', `All ${checks.length} checks passed.`, ''];
  return [
    '## Checks',
    '',
    `${checks.length - failed.length} of ${checks.length} checks passed. Failed:`,
    '',
    ...failed.map((c) => `- [${c.id}] ${c.label}${c.detail ? `: ${c.detail}` : ''}`),
    '',
  ];
}

export function renderBenchmarkMarkdown(r) {
  const b = r.burst;
  // Window, throughput and latency cover only the initial burst; publications after a conflict resolution land later.
  const split = Number.isInteger(b.acceptedInBurstWindow) && Number.isInteger(b.resolvedAndPublished);
  const lines = [
    '# Fleet run: 100 active workspaces and a paced change burst',
    '',
    `Run ${r.run.startedAt} → ${r.run.finishedAt} against the live worker${r.run.worker ? ` (version ${r.run.worker})` : ''}, driver \`scripts/fleet-driver.mjs\` at \`${r.run.head}\`, scratch repo \`${r.run.repo}\` (deleted afterwards).`,
    '',
    '## Limits in force',
    '',
    `One driver process; ≤ ${r.limits.gitChildren} git children and ≤ ${r.limits.httpInFlight} in-flight HTTP requests; campaign ceiling ${r.limits.ceiling} harness requests; per-credential git write limit ${r.limits.gitWritesPerMin}/min with pushes paced at ${r.limits.pushesPerMinute}/min; enqueues paced ≥ ${r.limits.enqueueIntervalMs} ms apart; 429 Retry-After honored with bounded retries.`,
    '',
    '## Workload',
    '',
    `| Item | Value |`,
    `|---|---|`,
    `| Active workspaces (distinct agent identities) | ${r.fleet.workspaces} |`,
    `| Changes in the burst | ${r.fleet.burst} |`,
    `| Crafted overlap pairs found by the Nexus overlap query | ${r.fleet.overlapPairs} |`,
    '',
    '## Measured burst results',
    '',
    `| Metric | Value |`,
    `|---|---|`,
    ...(split
      ? [
          `| Accepted publications | ${b.accepted} (${b.acceptedInBurstWindow} in the initial burst + ${b.resolvedAndPublished} after conflict resolution) |`,
          `| Incomplete cases (listed with reasons in the JSON report) | ${b.incomplete} |`,
          `| Initial burst window (first enqueue → last of the ${b.acceptedInBurstWindow} initial-burst publications) | ${fmtMs(b.windowMs)} |`,
          `| Throughput (the ${b.acceptedInBurstWindow} initial-burst publications per minute over that window) | ${b.throughputPerMin} |`,
          `| Latency enqueue → published of the ${b.acceptedInBurstWindow} initial-burst publications, server clock (p50 / p90 / max) | ${fmtMs(b.latencyMs.p50)} / ${fmtMs(b.latencyMs.p90)} / ${fmtMs(b.latencyMs.max)} |`,
        ]
      : [
          `| Accepted publications | ${b.accepted} |`,
          `| Incomplete cases (listed with reasons in the JSON report) | ${b.incomplete} |`,
          `| Burst window (first enqueue → last publication) | ${fmtMs(b.windowMs)} |`,
          `| Throughput (accepted publications per minute over the window) | ${b.throughputPerMin} |`,
          `| Latency enqueue → published, server clock (p50 / p90 / max) | ${fmtMs(b.latencyMs.p50)} / ${fmtMs(b.latencyMs.p90)} / ${fmtMs(b.latencyMs.max)} |`,
        ]),
    `| Max queue backlog observed (active entries) | ${b.backlogMax} |`,
    ...(b.longestIdle
      ? [
          `| Longest interval with no queue entry reaching a terminal state | ${(b.longestIdle.ms / 1000).toFixed(1)} s (+${(b.longestIdle.fromMs / 1000).toFixed(1)} s → +${(b.longestIdle.toMs / 1000).toFixed(1)} s after the first enqueue; ended by ${b.longestIdle.endedBy}) |`,
        ]
      : []),
    `| 429 QUEUE_FULL answers / retries | ${b.queueFull429} / ${b.retries} |`,
    '',
    '## Conflicts by kind',
    '',
    `| Kind | Count |`,
    `|---|---|`,
    ...Object.entries(r.conflicts).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '## Requests and work counters',
    '',
    `Harness requests: projected ${r.requests.projected}, observed ${r.requests.observed} (ceiling ${r.limits.ceiling}).`,
    '',
    `| Endpoint class | Requests | Summed x-kvarm-cost counters |`,
    `|---|---|---|`,
    ...Object.entries(r.counters).map(([k, v]) => `| \`${k}\` | ${v.count} | ${fmtCounters(v.sum)} |`),
    '',
    '| Server-side background work | Count |',
    '|---|---|',
    ...Object.entries(r.background).map(([k, v]) => `| ${k} | ${typeof v === 'object' ? fmtCounters(v) : v} |`),
    '',
    ...(r.trainPhases
      ? [
          '## Train phase timing',
          '',
          '| Span | n | p50 ms | p90 ms | max ms |',
          '|---|---:|---:|---:|---:|',
          ...Object.entries(r.trainPhases).map(([name, v]) => `| ${name} | ${v.n} | ${v.p50} | ${v.p90} | ${v.max} |`),
          '',
        ]
      : []),
    ...checksSection(r.checks),
    ...(r.notes?.length ? ['## Notes', '', ...r.notes.map((n) => `- ${n}`), ''] : []),
    'Work counters (`x-kvarm-cost` classes and the stored per-publication counters) are application telemetry, not a Cloudflare bill. They come from one measured run of this workload and are not a service-level objective.',
    '',
  ];
  return lines.join('\n');
}
