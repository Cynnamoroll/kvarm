// @ts-check
/**
 * User-owned CI runner: claim one immutable job, materialize its exact SHA
 * in the runner's persistent per-repository workdir — a fresh snapshot
 * checkout for the first job in a slot, then warm delta syncs that fetch
 * only the paths changed since the recorded commit (see workdir.js) —
 * execute the repository command under the execution-trust policy (on the
 * host or in an isolated container, see executor.js) with a timeout, and
 * report through the fenced claim generation. Idle claim polls back off
 * adaptively (2 s doubling to a 10 s cap) instead of polling at a fixed
 * rate, resetting as soon as a job is claimed.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkout } from './checkout.js';
import { CliError } from './checkout.js';
import { DEFAULT_IMAGE, TRUNCATED, bounded, containerName, detectRuntime, executeContainer, executeShell, planExecution } from './executor.js';
import { materialize, openWorkdir } from './workdir.js';

export { executeShell } from './executor.js';

const SUMMARY_SERVER_LIMIT = 64 * 1024;
const SUMMARY_SAFETY_MARGIN = 1024;
const SUMMARY_LIMIT = SUMMARY_SERVER_LIMIT - SUMMARY_SAFETY_MARGIN;
const IDLE_MIN_MS = 2_000;
const IDLE_MAX_MS = 10_000;
/** Past this many changed paths a whole-tree checkout is cheaper than the delta. */
const MAX_DELTA_CHANGES = 1_000;
const utf8 = new TextEncoder();

/** @param {unknown} value */
function jsonBytes(value) {
  return utf8.encode(JSON.stringify(value)).length;
}

/**
 * Trim one output field as far as necessary while retaining a marker.
 * Measuring the complete serialized summary accounts for JSON escaping too.
 * @param {Record<string, unknown>} summary
 * @param {'stdout'|'stderr'} field
 */
function trimSummaryField(summary, field) {
  const original = typeof summary[field] === 'string' ? summary[field] : '';
  if (!original) return;
  const points = [...original];
  summary[field] = TRUNCATED;
  if (jsonBytes(summary) > SUMMARY_LIMIT) return;
  let low = 0;
  let high = points.length;
  let best = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${points.slice(0, middle).join('')}${TRUNCATED}`;
    summary[field] = candidate;
    if (jsonBytes(summary) <= SUMMARY_LIMIT) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  summary[field] = best || TRUNCATED;
}

/** @template {Record<string, unknown>} T @param {T} summary @returns {T} */
function boundedSummary(summary) {
  if (jsonBytes(summary) <= SUMMARY_LIMIT) return summary;
  const result = { ...summary };
  trimSummaryField(result, 'stdout');
  if (jsonBytes(result) > SUMMARY_LIMIT) trimSummaryField(result, 'stderr');
  return /** @type {T} */ (result);
}

/** A job the execution-trust policy will not run on this runner. */
class JobRefused extends Error {}

/** How long a failed container-runtime probe is remembered. */
const RUNTIME_RETRY_MS = 60_000;

const REFUSAL_HINT =
  'A runner with a container runtime (docker or podman) and --executor auto or container can run it isolated; a runner started with --trust all runs it on the host.';

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Milliseconds to wait before the next claim after `consecutive` idle polls:
 * doubling from 2 s to a 10 s cap, reset as soon as a job is claimed so a
 * queued job is never delayed by a long idle streak.
 * @param {number} consecutive
 */
export function idleDelayMs(consecutive) {
  return Math.min(IDLE_MIN_MS * 2 ** Math.max(0, consecutive), IDLE_MAX_MS);
}

/**
 * @param {string} baseUrl
 * @param {string} repo
 * @param {string} pat
 * @param {string} path
 * @param {unknown} body
 * @param {typeof fetch} apiFetch
 */
async function post(baseUrl, repo, pat, path, body, apiFetch) {
  const res = await apiFetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/repos/${repo}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 204) return { status: 204, body: null };
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new CliError(`${path}: ${json.error ?? `HTTP ${res.status}`}${json.code ? ` (${json.code})` : ''}`);
  return { status: res.status, body: json };
}

/**
 * @param {string} baseUrl
 * @param {string} repo
 * @param {string} pat
 * @param {string} path
 * @param {typeof fetch} apiFetch
 * @returns {Promise<Record<string, unknown>>}
 */
async function getJson(baseUrl, repo, pat, path, apiFetch) {
  const res = await apiFetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/repos/${repo}/${path}`, {
    headers: { Authorization: `Bearer ${pat}`, accept: 'application/json' },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json === null || typeof json !== 'object' || Array.isArray(json)) {
    const err = /** @type {{error?: unknown, code?: unknown}} */ (json);
    const detail = err !== null && typeof err === 'object' && typeof err.error === 'string' ? err.error : `HTTP ${res.status}`;
    const code = err !== null && typeof err === 'object' && typeof err.code === 'string' ? ` (${err.code})` : '';
    throw new CliError(`${path.split('?')[0]}: ${detail}${code}`);
  }
  return /** @type {Record<string, unknown>} */ (json);
}

/** @param {unknown} value @param {string} what */
function expectObject(value, what) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CliError(`${what}: malformed response`);
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} what */
function hashOrNull(value, what) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new CliError(`${what}: malformed blob hash`);
  return value;
}

/** @param {unknown} value @param {string} what */
function modeOrNull(value, what) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value)) throw new CliError(`${what}: malformed mode`);
  return value;
}

/**
 * One wire entry of the compare API, or a thrown error on a malformed one.
 * @param {unknown} value
 * @param {string} what
 * @returns {import('./workdir.js').DeltaChange}
 */
function parseChange(value, what) {
  const c = expectObject(value, what);
  if (typeof c.path !== 'string' || typeof c.status !== 'string') throw new CliError(`${what}: malformed entry`);
  const statuses = ['added', 'removed', 'modified', 'renamed', 'typechange'];
  if (!statuses.includes(c.status)) throw new CliError(`${what}: malformed entry`);
  /** @type {import('./workdir.js').DeltaChange} */
  const change = {
    path: c.path,
    status: /** @type {'added'|'modified'|'removed'|'renamed'|'typechange'} */ (c.status),
    oldHash: hashOrNull(c.oldHash, what),
    newHash: hashOrNull(c.newHash, what),
    oldMode: modeOrNull(c.oldMode, what),
    newMode: modeOrNull(c.newMode, what),
  };
  if (c.oldPath !== undefined) {
    if (typeof c.oldPath !== 'string') throw new CliError(`${what}: malformed entry`);
    change.oldPath = c.oldPath;
  }
  return change;
}

/** Tree modes as the compare API reports them (raw git never pads). @param {string|null} mode */
const isTreeMode = (mode) => mode === '40000' || mode === '040000';

/**
 * The changed paths between the recorded commit and the new head, fetched
 * through the content-addressed compare API, and a lazy reader for one
 * file's exact bytes at the new head.
 * @typedef {{ baseUrl: string, repo: string, pat: string, apiFetch: typeof fetch, previous: import('./workdir.js').RecordedState, sha: string }} DeltaFetch
 */

/**
 * Lists the subtree `prefix` of commit `ref` through the tree API and
 * appends its leaf files as `status` changes. Gitlinks never appear in a
 * snapshot checkout and are skipped.
 * @param {DeltaFetch} o
 * @param {string} ref
 * @param {string} prefix
 * @param {'added'|'removed'} status
 * @param {import('./workdir.js').DeltaChange[]} out
 */
async function collectTreeSide(o, ref, prefix, status, out) {
  if (out.length >= MAX_DELTA_CHANGES) throw new Error(`delta of ${JSON.stringify(prefix)} exceeds the changed-path budget`);
  const body = expectObject(await getJson(o.baseUrl, o.repo, o.pat, `tree?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(prefix)}`, o.apiFetch), 'tree');
  const entries = body.entries;
  if (!Array.isArray(entries)) throw new CliError('tree: malformed response');
  for (const entry of entries) {
    const e = expectObject(entry, 'tree');
    if (typeof e.path !== 'string' || typeof e.mode !== 'string' || typeof e.hash !== 'string' || typeof e.type !== 'string') throw new CliError('tree: malformed entry');
    if (e.type === 'tree') await collectTreeSide(o, ref, e.path, status, out);
    else if (e.type === 'blob') {
      out.push(
        status === 'added'
          ? { path: e.path, status: 'added', oldHash: null, newHash: e.hash, oldMode: null, newMode: e.mode }
          : { path: e.path, status: 'removed', oldHash: e.hash, newHash: null, oldMode: e.mode, newMode: null },
      );
    }
    // 'commit' entries are gitlinks: a snapshot checkout never holds them.
  }
}

/**
 * Fetches the delta between `o.previous.sha` and `o.sha`: the compare API's
 * changed paths (following pages, refusing truncation), with every
 * directory↔file transition expanded into leaf files through the tree API
 * so each change names exactly one file. Any failure falls back to a full
 * checkout; a warm job never transfers the whole tree this way.
 * @param {DeltaFetch} o
 * @returns {Promise<import('./workdir.js').DeltaManifest>}
 */
async function fetchDelta(o) {
  /** @type {import('./workdir.js').DeltaChange[]} */
  const changes = [];
  let cursor;
  for (;;) {
    const path = `compare/${o.previous.sha}...${o.sha}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
    const body = expectObject(await getJson(o.baseUrl, o.repo, o.pat, path, o.apiFetch), 'compare');
    if (body.truncated === true) {
      throw new Error(`compare is truncated (${typeof body.truncatedReason === 'string' ? body.truncatedReason : 'budget'}); the delta would be incomplete`);
    }
    if (!Array.isArray(body.files)) throw new CliError('compare: malformed response');
    for (const file of body.files) changes.push(parseChange(file, 'compare'));
    if (typeof body.nextCursor !== 'string' || body.nextCursor === '') break;
    cursor = body.nextCursor;
  }
  /** @type {import('./workdir.js').DeltaChange[]} */
  const expanded = [];
  for (const c of changes) {
    if (isTreeMode(c.oldMode) || isTreeMode(c.newMode)) {
      // The compare wire folds a directory↔file transition into one
      // typechange whose tree side carries no leaf files.
      if (isTreeMode(c.oldMode)) await collectTreeSide(o, o.previous.sha, c.path, 'removed', expanded);
      else if (c.oldHash !== null) expanded.push({ path: c.path, status: 'removed', oldHash: c.oldHash, newHash: null, oldMode: c.oldMode, newMode: null });
      if (isTreeMode(c.newMode)) await collectTreeSide(o, o.sha, c.path, 'added', expanded);
      else if (c.newHash !== null) expanded.push({ path: c.path, status: 'added', oldHash: null, newHash: c.newHash, oldMode: null, newMode: c.newMode });
    } else {
      expanded.push(c);
    }
  }
  if (expanded.length > MAX_DELTA_CHANGES) {
    throw new Error(`delta of ${expanded.length} changed paths exceeds the warm budget of ${MAX_DELTA_CHANGES}`);
  }
  return {
    sha: o.sha,
    source: 'delta',
    changes: expanded,
    read: async (path) => {
      const body = expectObject(
        await getJson(o.baseUrl, o.repo, o.pat, `contents?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(o.sha)}`, o.apiFetch),
        'contents',
      );
      if (typeof body.content !== 'string' || (body.encoding !== 'utf-8' && body.encoding !== 'base64')) throw new CliError('contents: malformed response');
      return body.encoding === 'base64' ? new Uint8Array(Buffer.from(body.content, 'base64')) : utf8.encode(body.content);
    },
  };
}

/**
 * @typedef {object} RunnerOptions
 * @property {string} baseUrl
 * @property {string} pat
 * @property {string} repo
 * @property {boolean} [once]
 * @property {string} [runnerId]
 * @property {typeof fetch} [apiFetch]
 * @property {typeof checkout} [checkoutFn]
 * @property {(command:string,cwd:string,timeoutSeconds:number)=>Promise<import('./executor.js').ExecResult>} [execute] the host executor
 * @property {import('./executor.js').TrustMode} [trust] which jobs may run on the host (default 'humans')
 * @property {boolean} [hostWarning] warn on every host job under --trust all (default true; off only where the host itself is a throwaway sandbox)
 * @property {import('./executor.js').ExecutorMode} [executor] default 'auto': trusted jobs on the host, the rest in a container
 * @property {Partial<import('./executor.js').ContainerConfig>} [container] container settings; `runtime` unset auto-detects docker, then podman
 * @property {(command:string,cwd:string,timeoutSeconds:number,info:{jobId:string}&import('./executor.js').RuntimeProbe)=>Promise<import('./executor.js').ExecResult>} [executeContainer]
 * @property {(preferred?: import('./executor.js').ContainerRuntime) => Promise<import('./executor.js').RuntimeProbe | null>} [detectRuntimeFn]
 * @property {(line:string)=>void} stdout
 * @property {(line:string)=>void} stderr
 * @property {string} [tempRoot]
 * @property {string} [workRoot] root of the persistent workdirs (defaults below tempRoot)
 * @property {boolean} [fresh] fully rematerialize every job instead of syncing warm
 * @property {boolean} [drainUntilEmpty] exit as soon as a claim finds no job, instead of polling for more
 * @property {(previous: import('./workdir.js').RecordedState, sha: string) => Promise<import('./workdir.js').DeltaManifest>} [deltaFn] fetches a warm delta (defaults to the compare-based fetcher)
 * @property {(info: { job: { id: string, name: string, sha: string }, work: string, workdir: 'warm' | 'fresh', source: string }) => Promise<void>} [prepared]
 *   awaited after the job's workspace is materialized and before its command runs, while the lease heartbeat keeps running;
 *   a rejection reports the job as failed without running the command
 */

/**
 * @param {RunnerOptions} options
 * @returns {Promise<{claimed:number,reported:number}>}
 */
export async function runRunner(options) {
  const apiFetch = options.apiFetch ?? fetch;
  const checkoutFn = options.checkoutFn ?? checkout;
  const execute = options.execute ?? executeShell;
  const trust = options.trust ?? 'humans';
  const executorMode = options.executor ?? 'auto';
  const containerConfig = options.container ?? {};
  const runInContainer =
    options.executeContainer ??
    ((command, cwd, timeoutSeconds, info) =>
      executeContainer(command, cwd, timeoutSeconds, { ...containerConfig, runtime: info.runtime, rootless: info.rootless, name: containerName(info.jobId) }));
  const detect = options.detectRuntimeFn ?? ((preferred) => detectRuntime({ preferred }));
  /** @type {Promise<import('./executor.js').RuntimeProbe | null> | undefined} */
  let runtimeProbe;
  let probedAt = 0;
  // A runtime that answered stays known; a missing one is asked again after
  // a while, so a long-running runner notices a daemon that started later.
  const runtime = async () => {
    if (runtimeProbe && Date.now() - probedAt >= RUNTIME_RETRY_MS && (await runtimeProbe.catch(() => null)) === null) runtimeProbe = undefined;
    if (!runtimeProbe) {
      probedAt = Date.now();
      runtimeProbe = detect(containerConfig.runtime);
    }
    return runtimeProbe;
  };
  const deltaFn =
    options.deltaFn ?? ((previous, sha) => fetchDelta({ baseUrl: options.baseUrl, repo: options.repo, pat: options.pat, apiFetch, previous, sha }));
  const runnerId = options.runnerId ?? `kvarm-runner-${crypto.randomUUID()}`;
  const tempRoot = options.tempRoot ?? tmpdir();
  const workRoot = options.workRoot ?? join(tempRoot, 'kvarm-runner');
  // Container jobs get their own workdir: an isolated job must not be able to
  // plant files (node_modules/.bin, hooks) that a later host job executes.
  const containerWorkRoot = `${workRoot}-container`;
  /** @type {import('./workdir.js').Slot | undefined} */
  let hostSlot;
  /** @type {import('./workdir.js').Slot | undefined} */
  let containerSlot;
  let claimed = 0;
  let reported = 0;
  let idle = 0;
  try {
    if (executorMode === 'container' && !(await runtime())) {
      throw new CliError(`--executor container needs a running ${containerConfig.runtime ?? 'docker or podman'}, and none answered`, 2);
    }
    for (;;) {
      const got = await post(options.baseUrl, options.repo, options.pat, 'ci/jobs/claim', { runnerId }, apiFetch);
      if (got.status === 204) {
        if (options.once || options.drainUntilEmpty) return { claimed, reported };
        await sleep(idleDelayMs(idle++));
        continue;
      }
      idle = 0;
      const claimedAt = Date.now();
      const job = got.body?.job;
      if (!job || typeof job.id !== 'string' || typeof job.sha !== 'string') throw new CliError('claim returned an invalid job');
      claimed++;
      options.stdout(`claimed ${job.name} (${job.id}) at ${job.sha}`);
      let heartbeat;
      let reportBody;
      try {
        const plan = await planExecution({ trust, executor: executorMode, provenance: job.provenance, runtime });
        // Refused before any byte of the job's code reaches this machine.
        if (plan.run === null) throw new JobRefused(plan.reason);
        const every = Math.max(10_000, Math.floor(120_000 / 3));
        heartbeat = setInterval(() => {
          void post(options.baseUrl, options.repo, options.pat, `ci/jobs/${job.id}/heartbeat`, { runnerId, generation: job.generation }, apiFetch).catch((err) =>
            options.stderr(`heartbeat: ${err instanceof Error ? err.message : String(err)}`),
          );
        }, every);
        heartbeat.unref();
        const isolated = plan.run === 'container';
        const slot = isolated
          ? (containerSlot ??= openWorkdir({ workRoot: containerWorkRoot, repo: options.repo, tempRoot, stderr: options.stderr }))
          : (hostSlot ??= openWorkdir({ workRoot, repo: options.repo, tempRoot, stderr: options.stderr }));
        const quiet = () => {};
        const materialized = await materialize(slot, {
          sha: job.sha,
          fresh: options.fresh,
          delta: deltaFn,
          stderr: options.stderr,
          checkout: (dir) =>
            checkoutFn({
              baseUrl: options.baseUrl,
              pat: options.pat,
              repo: options.repo,
              ref: job.sha,
              dir,
              stdout: quiet,
              stderr: (line) => options.stderr(`checkout: ${line}`),
            }),
        });
        options.stdout(`workdir: ${materialized.workdir}`);
        if (options.prepared) {
          await options.prepared({ job: { id: job.id, name: job.name, sha: job.sha }, work: slot.work, workdir: materialized.workdir, source: materialized.source });
        }
        let result;
        if (isolated) {
          const rt = /** @type {import('./executor.js').RuntimeProbe} */ (plan.runtime);
          options.stdout(`executor: container (${rt.runtime}${rt.rootless ? ' rootless' : ''}, ${containerConfig.image ?? DEFAULT_IMAGE}): ${plan.reason}`);
          result = await runInContainer(job.command, slot.work, job.timeoutSeconds, { jobId: job.id, ...rt });
        } else {
          if (trust === 'all' && options.hostWarning !== false) options.stderr(`warning: running ${job.name} on the host with --trust all; its code has this user's files and network`);
          else if (trust !== 'all') options.stdout(`executor: host: ${plan.reason}`);
          result = await execute(job.command, slot.work, job.timeoutSeconds);
        }
        const conclusion = result.code === 0 && !result.timedOut ? 'success' : 'failure';
        const summary = boundedSummary({
          command: job.command,
          exitCode: result.code,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          stdout: result.stdout,
          stderr: result.stderr,
          source: materialized.source,
          sha: materialized.sha,
          executor: plan.run,
          ...(isolated ? { image: containerConfig.image ?? DEFAULT_IMAGE } : {}),
        });
        reportBody = { runnerId, generation: job.generation, conclusion, summary };
      } catch (err) {
        const refused = err instanceof JobRefused;
        if (refused) options.stderr(`refused ${job.name} (${job.id}): ${err.message}`);
        const summary = boundedSummary({
          command: job.command,
          exitCode: null,
          timedOut: false,
          durationMs: 0,
          stdout: '',
          stderr: refused
            ? bounded(`kvarm runner refused to run this job: ${err.message}. ${REFUSAL_HINT}`)
            : bounded(err instanceof Error ? err.message : String(err)),
          sha: job.sha,
          ...(refused ? { refused: true, trust, executor: executorMode } : {}),
        });
        reportBody = { runnerId, generation: job.generation, conclusion: 'failure', summary };
      }
      try {
        let reportError;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await post(options.baseUrl, options.repo, options.pat, `ci/jobs/${job.id}/report`, reportBody, apiFetch);
            reportError = undefined;
            break;
          } catch (err) {
            reportError = err;
            if (attempt < 2) await sleep(250 * 2 ** attempt);
          }
        }
        if (reportError) throw reportError;
        reported++;
        options.stdout(`reported ${reportBody.conclusion} for ${job.name} (${job.id}) in ${Date.now() - claimedAt} ms`);
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
      if (options.once) return { claimed, reported };
    }
  } finally {
    hostSlot?.release();
    containerSlot?.release();
  }
}
