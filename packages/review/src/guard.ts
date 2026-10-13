/**
 * The change guard (`kvarm/guard`): pure rules over a change's files and
 * the text the caller could read for them. Three families:
 *
 *   secret/*      known credential formats and high-entropy assignments on added lines
 *   ci-gaming/*   checks made unable to fail (`|| true`, continue-on-error, `exit 0`
 *                 in CI config or test scripts) and deleted, emptied or skipped tests
 *   dependency/*  new dependencies that look like typosquats or come from outside a registry
 *
 * Findings never carry the matched value: only the rule, path, line and a
 * fixed message. Secret and CI-gaming findings fail the guard; dependency
 * findings and files that could not be scanned make it neutral.
 *
 * `complete` says whether every changed path the rules read was read in
 * full. A neutral verdict is only advisory evidence when it is incomplete:
 * a file cut at the read prefix or never read can hide anything, so the
 * result names those paths and branch rules may refuse to publish it
 * (architecture §0.3).
 */

import { countTestCases, dependencyNames } from './content';
import { isCiConfigPath, isLockfilePath, isTestPath, manifestKind, type ManifestKind } from './paths';

export type GuardConclusion = 'success' | 'failure' | 'neutral';
export type GuardSeverity = 'failure' | 'neutral';

/** The tree-diff statuses (`@kvarm/gitops` TreeChangeStatus). */
export type GuardChangeStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'typechange';

export interface GuardChange {
  path: string;
  status: GuardChangeStatus;
  oldPath?: string;
  binary?: boolean;
}

/** What the caller read for one path; absent sides were not wanted. */
export interface GuardContent {
  old?: string | null;
  new?: string | null;
  /** A side was cut at the per-file read bound: only its prefix was scanned. */
  truncated?: boolean;
  /** A wanted side could not be read (budget, size or storage). */
  unavailable?: boolean;
  /** With `unavailable`: the caller skipped the file because the change exceeded its file budget. */
  overFileBudget?: boolean;
}

export interface GuardFinding {
  rule: string;
  severity: GuardSeverity;
  path: string;
  line?: number;
  message: string;
}

/** Why a changed path was not fully inspected. */
export type GuardUninspectedReason = 'over-file-budget' | 'prefix-only' | 'line-prefix' | 'unavailable';

export interface GuardUninspected {
  /** Changed paths not fully inspected (the listed ones only; see listTruncated). */
  count: number;
  /** The change listed more files than the guard could enumerate: an unknown number more went unseen. */
  listTruncated: boolean;
  /** The first GUARD_LIMITS.maxUninspectedPaths of them, in change order. */
  paths: Array<{ path: string; reason: GuardUninspectedReason }>;
}

export interface GuardResult {
  conclusion: GuardConclusion;
  findings: GuardFinding[];
  /** Findings beyond GUARD_LIMITS.maxFindings (they still count toward the conclusion). */
  omitted?: number;
  /** Every changed path the rules read was read in full and the change list was not truncated. */
  complete: boolean;
  /** Present exactly when `complete` is false. */
  uninspected?: GuardUninspected;
}

export const GUARD_LIMITS = {
  maxFindings: 50,
  /** Uninspected paths named in a result (the count covers all of them). */
  maxUninspectedPaths: 50,
  /** Lines longer than this are scanned only up to it (minified bundles). */
  maxLineChars: 4096,
} as const;

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/**
 * Lines of `newText` not matched by a line of `oldText`, compared as a
 * multiset (order-insensitive), numbered from 1 on the new side. Lines are
 * cut at GUARD_LIMITS.maxLineChars; `cut.lines` counts the cut ones.
 */
export function addedLines(oldText: string | null | undefined, newText: string, cut?: { lines: number }): Array<{ line: number; text: string }> {
  const remaining = new Map<string, number>();
  for (const l of oldText ? splitLines(oldText) : []) remaining.set(l, (remaining.get(l) ?? 0) + 1);
  const out: Array<{ line: number; text: string }> = [];
  splitLines(newText).forEach((text, i) => {
    const n = remaining.get(text) ?? 0;
    if (n > 0) remaining.set(text, n - 1);
    else if (text.length > GUARD_LIMITS.maxLineChars) {
      if (cut) cut.lines++;
      out.push({ line: i + 1, text: text.slice(0, GUARD_LIMITS.maxLineChars) });
    } else out.push({ line: i + 1, text });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

interface SecretRule {
  rule: string;
  re: RegExp;
  what: string;
}

const SECRET_RULES: SecretRule[] = [
  { rule: 'secret/private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/, what: 'a private key' },
  { rule: 'secret/kvarm-token', re: /\bkvarm_(?:pat|agt)_[0-9a-f]{64}\b/, what: 'a Kvarm access token' },
  { rule: 'secret/aws-access-key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/, what: 'an AWS access key ID' },
  {
    rule: 'secret/aws-secret-key',
    re: /aws.{0,20}secret.{0,20}["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/i,
    what: 'an AWS secret access key',
  },
  { rule: 'secret/github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/, what: 'a GitHub token' },
  { rule: 'secret/stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/, what: 'a Stripe secret key' },
  {
    rule: 'secret/slack-token',
    re: /\bxox[abposr]-[A-Za-z0-9-]{10,}|https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/,
    what: 'a Slack token or webhook',
  },
];

const ASSIGNMENT =
  /([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth[_-]?key|client[_-]?secret|credentials?)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["'`]?([^\s"'`,;]{20,})/gi;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksRandom(value: string): boolean {
  if (/[<>{}$()[\]]/.test(value)) return false;
  if (/^(?:process\.env|os\.environ|env\.|https?:\/\/)/i.test(value)) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  return entropy(value) >= 3.5;
}

function secretOn(text: string): SecretRule | null {
  for (const r of SECRET_RULES) if (r.re.test(text)) return r;
  for (const m of text.matchAll(ASSIGNMENT)) {
    if (looksRandom(m[2]!)) return { rule: 'secret/high-entropy', re: ASSIGNMENT, what: 'a high-entropy value assigned to a credential-like name' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// CI gaming
// ---------------------------------------------------------------------------

const GAMING_RULES: Array<{ rule: string; re: RegExp; message: string }> = [
  { rule: 'ci-gaming/or-true', re: /\|\|\s*(?:true\b|:(?=\s|$|["';]))/, message: 'a command was made unable to fail with `|| true`' },
  {
    rule: 'ci-gaming/continue-on-error',
    re: /["']?(?:continue-on-error|continueOnError|allow_failure)["']?\s*:\s*true\b/,
    message: 'a CI step or job was set to continue on error',
  },
  { rule: 'ci-gaming/exit-zero', re: /(?:^|[\s;&|"'`(])exit\s+0\b/, message: 'a CI command was made to exit 0 unconditionally' },
];

/** package.json lines that define a test or CI script. */
const TEST_SCRIPT_LINE = /^\s*"(?:pre|post)?(?:test|tests|ci|check|verify|lint)(?:[:\w-]*)"\s*:/;

function gamingScope(path: string): ((line: string) => boolean) | null {
  if (isCiConfigPath(path)) return () => true;
  if (manifestKind(path) === 'npm') return (line) => TEST_SCRIPT_LINE.test(line);
  return null;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Widely used package names per ecosystem, plus legitimate near neighbours (never flagged). */
const POPULAR: Partial<Record<ManifestKind, readonly string[]>> = {
  npm: [
    'lodash', 'react', 'react-dom', 'preact', 'express', 'axios', 'chalk', 'commander', 'debug', 'moment', 'request', 'webpack',
    'typescript', 'eslint', 'prettier', 'jest', 'mocha', 'vitest', 'vite', 'rollup', 'esbuild', 'babel-core', 'underscore',
    'jquery', 'vue', 'vuex', 'angular', 'next', 'nuxt', 'svelte', 'redux', 'mobx', 'rxjs', 'uuid', 'dotenv', 'yargs', 'minimist',
    'glob', 'rimraf', 'mkdirp', 'semver', 'async', 'bluebird', 'body-parser', 'cors', 'helmet', 'morgan', 'mongoose', 'mongodb',
    'mysql', 'mysql2', 'pg', 'redis', 'ioredis', 'sequelize', 'socket.io', 'jsonwebtoken', 'bcrypt', 'bcryptjs', 'passport',
    'nodemon', 'cross-env', 'classnames', 'prop-types', 'styled-components', 'tailwindcss', 'postcss', 'autoprefixer', 'sass',
    'dayjs', 'date-fns', 'luxon', 'node-fetch', 'cross-fetch', 'got', 'superagent', 'cheerio', 'puppeteer', 'playwright',
    'graphql', 'apollo-server', 'zod', 'yup', 'joi', 'ajv', 'immer', 'ramda', 'colors', 'inquirer', 'ora', 'execa', 'fs-extra',
    'chokidar', 'ws', 'koa', 'fastify', 'hono', 'nestjs', 'electron', 'three', 'd3', 'chart.js', 'highlight.js', 'marked',
    'markdown-it', 'handlebars', 'ejs', 'pug', 'nanoid', 'shelljs', 'event-stream', 'coffee-script', 'crossenv', 'electron-builder',
  ],
  requirements: [
    'requests', 'numpy', 'pandas', 'django', 'flask', 'fastapi', 'pytest', 'boto3', 'botocore', 'urllib3', 'setuptools', 'six',
    'pyyaml', 'scipy', 'matplotlib', 'pillow', 'sqlalchemy', 'jinja2', 'click', 'cryptography', 'pydantic', 'tensorflow',
    'torch', 'scikit-learn', 'beautifulsoup4', 'selenium', 'celery', 'redis', 'psycopg2', 'httpx', 'aiohttp', 'uvicorn',
    'gunicorn', 'colorama', 'python-dateutil', 'certifi', 'idna', 'charset-normalizer', 'attrs', 'packaging', 'wheel', 'pip',
  ],
  cargo: ['serde', 'serde_json', 'tokio', 'rand', 'clap', 'regex', 'reqwest', 'anyhow', 'thiserror', 'log', 'chrono', 'hyper', 'futures'],
  go: [],
};
POPULAR.pyproject = POPULAR.requirements;

function squash(name: string): string {
  return name.toLowerCase().replace(/[-_.]/g, '');
}

/** Optimal string alignment distance (adjacent transpositions cost 1), stopped early past `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

/** The popular package `name` imitates, or null (popular names themselves and short names never match). */
export function typosquatOf(name: string, kind: ManifestKind): string | null {
  const popular = POPULAR[kind] ?? [];
  const lower = name.toLowerCase();
  if (lower.length < 4 || popular.includes(lower)) return null;
  const max = lower.length >= 8 ? 2 : 1;
  for (const p of popular) {
    if (p.length < 4) continue;
    if (squash(p) === squash(lower)) return p;
    if (editDistance(lower, p, max) <= max) return p;
  }
  return null;
}

const NPM_NON_REGISTRY = /^(?:git\+|git:|github:|gitlab:|bitbucket:|gist:|https?:|file:|link:)|^[\w.-]+\/[\w.-]+(?:#.*)?$/;

/** New npm dependency specs that point outside the registry, by name. */
function npmSpecs(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return out;
  }
  if (!doc || typeof doc !== 'object') return out;
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = (doc as Record<string, unknown>)[section];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
    for (const [name, spec] of Object.entries(deps)) if (typeof spec === 'string') out.set(name, spec);
  }
  return out;
}

function lineOf(text: string, needle: string): number | undefined {
  const i = splitLines(text).findIndex((l) => l.includes(needle));
  return i >= 0 ? i + 1 : undefined;
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/** Which sides of a change the guard reads. */
export function guardWants(c: GuardChange): { old: boolean; new: boolean } {
  if (c.binary || c.status === 'removed' || isLockfilePath(c.path)) return { old: false, new: false };
  if (c.status === 'added') return { old: false, new: true };
  return { old: true, new: true };
}

class Findings {
  readonly list: GuardFinding[] = [];
  omitted = 0;
  failed = false;

  add(f: GuardFinding): void {
    if (f.severity === 'failure') this.failed = true;
    if (this.list.length < GUARD_LIMITS.maxFindings) this.list.push(f);
    else this.omitted++;
  }
}

/** Scans one file's added text; returns how many added lines were cut at the per-line limit. */
function scanText(c: GuardChange, content: GuardContent, out: Findings): number {
  const newText = content.new ?? '';
  const oldText = content.old ?? null;
  const cut = { lines: 0 };
  const added = addedLines(oldText, newText, cut);
  const gaming = gamingScope(c.path);
  for (const { line, text } of added) {
    const secret = secretOn(text);
    if (secret) {
      out.add({ rule: secret.rule, severity: 'failure', path: c.path, line, message: `${secret.what} was added (value redacted)` });
      continue;
    }
    if (gaming && gaming(text)) {
      const g = GAMING_RULES.find((r) => r.re.test(text));
      if (g) out.add({ rule: g.rule, severity: 'failure', path: c.path, line, message: g.message });
    }
  }

  if (isTestPath(c.path) && oldText !== null && c.status !== 'added') {
    const before = countTestCases(oldText);
    const after = countTestCases(newText);
    if (before.cases > 0 && after.cases === 0) {
      out.add({ rule: 'ci-gaming/test-emptied', severity: 'failure', path: c.path, message: `all ${before.cases} test case(s) were removed from the file` });
    } else if (after.skipped > before.skipped) {
      const first = added.find(({ text }) => countTestCases(text).skipped > 0);
      out.add({
        rule: 'ci-gaming/test-skipped',
        severity: 'failure',
        path: c.path,
        ...(first ? { line: first.line } : {}),
        message: `${after.skipped - before.skipped} test(s) were newly skipped or disabled`,
      });
    }
  }

  const kind = manifestKind(c.path);
  if (kind) {
    const before = new Set(oldText !== null ? (dependencyNames(c.path, oldText) ?? []) : []);
    const fresh = (dependencyNames(c.path, newText) ?? []).filter((n) => !before.has(n));
    const specs = kind === 'npm' ? npmSpecs(newText) : null;
    const flagged = new Set<string>();
    for (const name of fresh) {
      const line = lineOf(newText, kind === 'npm' ? `"${name}"` : name);
      const like = typosquatOf(name, kind);
      if (like) {
        flagged.add(name);
        out.add({
          rule: 'dependency/typosquat',
          severity: 'neutral',
          path: c.path,
          ...(line ? { line } : {}),
          message: `new dependency "${name}" is within a typo of the popular package "${like}"`,
        });
      }
      const spec = specs?.get(name);
      if (spec !== undefined && NPM_NON_REGISTRY.test(spec) && !flagged.has(name)) {
        out.add({
          rule: 'dependency/non-registry',
          severity: 'neutral',
          path: c.path,
          ...(line ? { line } : {}),
          message: `new dependency "${name}" is installed from outside the package registry`,
        });
      }
    }
    if (kind !== 'npm') {
      for (const { line, text } of added) {
        const direct = /(?:git\+|:\/\/)/.test(text) || (kind === 'cargo' && /\b(?:git|path)\s*=/.test(text));
        if (!direct || text.trim().startsWith('#')) continue;
        out.add({ rule: 'dependency/non-registry', severity: 'neutral', path: c.path, line, message: 'a dependency is installed from outside the package registry' });
      }
    }
  }
  return cut.lines;
}

/**
 * Runs every rule over the changes. `contents` maps a change's path to what
 * was read for the sides guardWants asked for.
 */
export function guard(changes: readonly GuardChange[], contents: ReadonlyMap<string, GuardContent>, opts: { listTruncated?: boolean } = {}): GuardResult {
  const out = new Findings();
  // One guard/incomplete finding per kind of shortfall, in this order: count and first path.
  const shortfalls = new Map<'prefix' | 'line' | 'unscanned', { count: number; first: string }>();
  const uninspected: GuardUninspected = { count: 0, listTruncated: opts.listTruncated === true, paths: [] };
  const skip = (path: string, reason: GuardUninspectedReason) => {
    uninspected.count++;
    if (uninspected.paths.length < GUARD_LIMITS.maxUninspectedPaths) uninspected.paths.push({ path, reason });
    const kind = reason === 'prefix-only' ? 'prefix' : reason === 'line-prefix' ? 'line' : 'unscanned';
    const seen = shortfalls.get(kind);
    if (seen) seen.count++;
    else shortfalls.set(kind, { count: 1, first: path });
  };
  if (opts.listTruncated) {
    out.add({ rule: 'guard/incomplete', severity: 'neutral', path: '.', message: 'the change lists more files than the guard can enumerate; only the listed files were scanned' });
  }
  for (const c of changes) {
    const removedTest = (c.status === 'removed' && isTestPath(c.path)) || (c.oldPath !== undefined && isTestPath(c.oldPath) && !isTestPath(c.path));
    if (removedTest) {
      const path = c.status === 'removed' ? c.path : c.oldPath!;
      out.add({ rule: 'ci-gaming/test-deleted', severity: 'failure', path, message: `test file ${path} was deleted` });
    }
    const wants = guardWants(c);
    if (!wants.new) continue;
    const content = contents.get(c.path);
    if (!content || content.unavailable || (wants.new && typeof content.new !== 'string') || (wants.old && content.old === undefined)) {
      skip(c.path, content?.overFileBudget ? 'over-file-budget' : 'unavailable');
      continue;
    }
    const cutLines = scanText(c, content, out);
    if (content.truncated) skip(c.path, 'prefix-only');
    else if (cutLines > 0) skip(c.path, 'line-prefix');
  }
  const messages = {
    prefix: (n: number) => `${n} changed file(s) were scanned only up to the guard's per-file read budget`,
    line: (n: number) => `${n} changed file(s) have added lines longer than ${GUARD_LIMITS.maxLineChars} characters that were scanned only up to that length`,
    unscanned: (n: number) => `${n} changed file(s) could not be scanned within the guard's read budget`,
  };
  for (const kind of ['prefix', 'line', 'unscanned'] as const) {
    const s = shortfalls.get(kind);
    if (s) out.add({ rule: 'guard/incomplete', severity: 'neutral', path: s.first, message: messages[kind](s.count) });
  }
  const conclusion: GuardConclusion = out.failed ? 'failure' : out.list.length + out.omitted > 0 ? 'neutral' : 'success';
  const complete = uninspected.count === 0 && !uninspected.listTruncated;
  return { conclusion, findings: out.list, ...(out.omitted > 0 ? { omitted: out.omitted } : {}), complete, ...(complete ? {} : { uninspected }) };
}
