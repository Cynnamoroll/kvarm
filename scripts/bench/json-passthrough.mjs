#!/usr/bin/env node
/**
 * CPU micro-benchmark for two JSON re-serialization paths (performance audit
 * item 11), on deterministic synthetic bodies:
 *
 *  1. Warm compare hit: the Cache API body is parsed (`hit.json()`), rendered
 *     into the response object and stringified again by `c.json`. Compared
 *     with a byte splice of the cached text (what a passthrough would cost).
 *  2. MCP tool result: the REST reply text is parsed and stringified back
 *     (`text(JSON.parse(body))`) before the SDK serializes the JSON-RPC
 *     envelope. Compared with returning the reply text as is.
 *
 * Usage: node scripts/bench/json-passthrough.mjs [--runs 50] [--files 3700]
 * Prints one JSON object with per-path median/p90 milliseconds.
 */

import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};
const RUNS = opt('runs', 50);
const WARMUP = Math.max(5, Math.floor(RUNS / 5));
const FILES = opt('files', 3700);

// Deterministic PRNG (mulberry32) so every run builds the same bodies.
let seed = 0x5eed;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const hex = (n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

const DIRS = ['src', 'src/services', 'src/routes/api', 'packages/gitops/src', 'packages/container-runner/src', 'test/fixtures', 'docs/guide'];
const EXT = ['ts', 'js', 'json', 'md', 'sql', 'tsx'];
const TAGS = ['config', 'migration', 'auth', 'deps', 'generated', 'tests', 'large', 'binary'];

/** A CompareBody shaped like services/compare.ts writes under treediff/v4. */
function compareBody(files) {
  const out = [];
  let additions = 0;
  let deletions = 0;
  for (let i = 0; i < files; i++) {
    const status = pick(['modified', 'modified', 'modified', 'added', 'deleted', 'renamed']);
    const path = `${pick(DIRS)}/module-${i.toString(36)}/${hex(6)}-file.${pick(EXT)}`;
    const a = Math.floor(rand() * 200);
    const d = Math.floor(rand() * 120);
    additions += a;
    deletions += d;
    const f = {
      path,
      status,
      ...(status === 'renamed' ? { oldPath: `${pick(DIRS)}/old-${hex(6)}.${pick(EXT)}` } : {}),
      oldHash: status === 'added' ? null : hex(40),
      newHash: status === 'deleted' ? null : hex(40),
      oldMode: status === 'added' ? null : '100644',
      newMode: status === 'deleted' ? null : '100644',
      additions: a,
      deletions: d,
      risk: { score: Math.floor(rand() * 100), tags: rand() < 0.3 ? [pick(TAGS), pick(TAGS)] : [] },
    };
    out.push(f);
  }
  return {
    files: out,
    totals: { files, additions, deletions },
    totalsComplete: true,
    rating: { level: 'medium', score: 42, reasons: ['many files', 'touches migrations'] },
    truncated: false,
    treeReads: 180,
    blobReads: 600,
  };
}

/** services/compare.ts render() for order=path, no limit or cursor. */
function render(body, base, head) {
  const files = body.files.slice(0, body.files.length);
  const out = {
    base,
    head,
    files,
    totals: body.totals,
    totalsComplete: body.totalsComplete,
    rating: body.rating,
    truncated: body.truncated,
    treeReads: body.treeReads,
    blobReads: body.blobReads,
  };
  if (body.truncatedReason !== undefined) out.truncatedReason = body.truncatedReason;
  if (body.statsOmitted) out.statsOmitted = true;
  return out;
}

/** A change detail reply, the typical MCP tool result size. */
function changeDetail() {
  return {
    number: 42,
    title: 'Tighten the snapshot cache',
    body: 'x'.repeat(600),
    state: 'open',
    mergePolicy: 'review',
    kind: 'change',
    base: 'main',
    head: 'agents/w1',
    baseSha: hex(40),
    headSha: hex(40),
    author: 'owner',
    agent: { id: hex(16), name: 'agent-1' },
    mergeCommit: null,
    rating: { level: 'low', score: 12, reasons: [] },
    checks: Array.from({ length: 8 }, (_, i) => ({ id: hex(16), name: `ci-${i}`, status: 'success', headSha: hex(40), createdAt: '2026-10-11T00:00:00.000Z' })),
    mergeability: { status: 'clean', conflicts: [] },
  };
}

function time(fn) {
  for (let i = 0; i < WARMUP; i++) fn();
  const samples = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const q = (p) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
  return { medianMs: +q(0.5).toFixed(3), p90Ms: +q(0.9).toFixed(3) };
}

let sink = 0;
const base = { ref: 'main', sha: hex(40), tree: hex(40) };
const head = { ref: 'agents/w1', sha: hex(40), tree: hex(40) };

const encoder = new TextEncoder();
const cachedText = JSON.stringify(compareBody(FILES));
// Both compare paths end in the UTF-8 response bytes, which also flattens the
// spliced string (V8 would otherwise keep it as an unmeasured rope).
const compareCurrent = () => {
  const body = JSON.parse(cachedText);
  const text = JSON.stringify(render(body, base, head));
  sink += encoder.encode(text).length;
};
// The splice a passthrough would do: base/head prepended to the cached text.
// Only valid when the cached key order matches the response order.
const compareSplice = () => {
  const text = `{"base":${JSON.stringify(base)},"head":${JSON.stringify(head)},${cachedText.slice(1)}`;
  sink += encoder.encode(text).length;
};
const compareParseOnly = () => {
  sink += JSON.parse(cachedText).files.length;
};

const replyLarge = JSON.stringify(render(JSON.parse(cachedText), base, head));
const replyTypical = JSON.stringify(changeDetail());
const mcpCurrent = (reply) => () => {
  let parsed = reply;
  try {
    parsed = JSON.parse(reply);
  } catch {
    // non-JSON reply
  }
  const text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
  // The SDK then serializes the JSON-RPC envelope that carries the text.
  sink += JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }).length;
};
const mcpPassthrough = (reply) => () => {
  sink += JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: reply }] } }).length;
};

if (JSON.stringify(JSON.parse(replyLarge)) !== replyLarge || JSON.stringify(JSON.parse(replyTypical)) !== replyTypical) {
  throw new Error('round trip is not the identity on these bodies');
}

const result = {
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  runs: RUNS,
  warmup: WARMUP,
  compare: {
    files: FILES,
    cachedBytes: cachedText.length,
    responseBytes: replyLarge.length,
    currentParseRenderStringify: time(compareCurrent),
    parseOnly: time(compareParseOnly),
    passthroughSplice: time(compareSplice),
  },
  mcp: {
    typicalBytes: replyTypical.length,
    typicalCurrent: time(mcpCurrent(replyTypical)),
    typicalPassthrough: time(mcpPassthrough(replyTypical)),
    largeBytes: replyLarge.length,
    largeCurrent: time(mcpCurrent(replyLarge)),
    largePassthrough: time(mcpPassthrough(replyLarge)),
  },
};
if (sink < 0) console.error(sink);
console.log(JSON.stringify(result, null, 2));
