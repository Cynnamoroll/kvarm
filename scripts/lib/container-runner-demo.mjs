/**
 * Container CI runner showcase for scripts/demo-harness.mjs (--container).
 * Kept in its own module so the public-beta Containers surface cannot break
 * the core harness run.
 *
 * On a fresh private repository with one required `typecheck` job:
 *   run 1 (cold)  POST ci/container-runs {mode:cold}: a fresh
 *                 cloudflare/debian-trixie container is prepared once
 *                 (runner + toolchain), saved with snapshotContainer, then
 *                 claims, snapshot-checks-out, runs and reports the job at head 1
 *   run 2 (warm)  after a head push, POST {mode:warm}: the container starts from
 *                 the saved snapshot, skips setup, and runs the job at head 2
 * Both check runs then appear in GET changes/1/checks with distinct ids and
 * the same summary shape. Prints the Durable Object's per-phase timings for
 * both runs. The repository and the saved snapshot handle are removed at the
 * end (unless keep).
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms) => (ms === null || ms === undefined ? '-' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 10) : String(sha));

const CI_CONFIG = `${JSON.stringify({ jobs: [{ name: 'typecheck', run: 'tsc --noEmit -p .', required: true, timeoutSeconds: 300 }] })}\n`;
const TSCONFIG = `${JSON.stringify({ compilerOptions: { strict: true, target: 'es2022', module: 'es2022', noEmit: true }, include: ['src'] }, null, 2)}\n`;
const LIMITS = (limit) => `export interface Limits {\n  steady: number;\n  burst: number;\n}\n\nexport const limits: Limits = { steady: ${limit}, burst: 25 };\n`;

/**
 * `onResult` receives each completed run's Durable Object timings, harness wall
 * time and x-forge-cost, plus the snapshot reset's cost, after cleanup.
 * @param {{ base: string, pat: string, ts: number, keep?: boolean, log?: (line: string) => void, onResult?: (r: { runs: Record<string, { totalMs: number, wall: number, readyMs: number, phases: object, cost: string | null }>, resetCost: string | null }) => void }} o
 * @returns {Promise<boolean>}
 */
export async function runContainerShowcase(o) {
  const log = o.log ?? ((line) => console.log(line));
  const work = mkdtempSync(join(tmpdir(), 'demo-container-'));
  const askpass = join(work, 'askpass.sh');
  writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv DEMO_GIT_TOKEN ;; esac\n');
  chmodSync(askpass, 0o700);
  const dir = join(work, 'repo');
  const state = { created: false, owner: '', name: `demo-harness-ci-${o.ts}` };
  const runs = {};
  let resetCost = null;
  let ok = false;

  async function rest(path, { method = 'GET', json } = {}) {
    const headers = { Authorization: `Bearer ${o.pat}` };
    if (json !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${o.base}${path}`, { method, headers, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, json: body, cost: res.headers.get('x-forge-cost') };
  }
  function git(args) {
    const r = spawnSync('git', ['-c', 'credential.helper=', ...args], {
      cwd: dir,
      env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', DEMO_GIT_TOKEN: o.pat },
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr ?? '').slice(0, 300)}`);
    return (r.stdout ?? '').trim();
  }
  function commit(files, message) {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    git(['add', '-A']);
    git(['commit', '-q', '-m', message]);
    return git(['rev-parse', 'HEAD']);
  }
  const R = () => `/api/v1/repos/${state.owner}/${state.name}`;

  async function waitFor(label, fn, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = await fn();
      if (v) return v;
      await sleep(1000);
    }
    throw new Error(`${label} did not happen within ${ms / 1000} s`);
  }
  const checks = async () => (await rest(`${R()}/changes/1/checks`)).json?.checks ?? [];
  const typecheckAt = (sha, status) => async () => (await checks()).find((k) => k.name === 'typecheck' && k.headSha === sha && (!status || status.includes(k.status)));

  /** The runner's checkout is snapshot-first; demand the build and wait so neither run measures it. */
  async function snapshotReady(sha) {
    const t0 = Date.now();
    await waitFor(`snapshot of ${short(sha)}`, async () => (await rest(`${R()}/snapshots/${sha}`, { method: 'POST' })).json?.state === 'ready', 120_000);
    log(`  human  ${'POST snapshots/:sha'.padEnd(19)} -> snapshot of ${short(sha)} ready (${fmt(Date.now() - t0)})`);
  }

  async function containerRun(mode, sha) {
    const t0 = Date.now();
    const r = await rest(`${R()}/ci/container-runs`, { method: 'POST', json: { mode } });
    const wall = Date.now() - t0;
    if (r.status !== 200) throw new Error(`container run (${mode}) -> ${r.status} ${r.json?.code ?? ''} ${r.json?.error ?? ''}`.trim());
    const rep = r.json;
    const from = 'image' in rep.startedFrom ? `image ${rep.startedFrom.image}` : `snapshot ${rep.startedFrom.snapshot}`;
    log(`  human  ${'POST container-runs'.padEnd(19)} -> ${mode}: ${rep.instance} from ${from}; runner exit ${rep.runner.exitCode} (${fmt(wall)} wall, x-forge-cost ${r.cost})`);
    for (const line of rep.runner.stdout.split('\n').filter(Boolean)) log(`           container | ${line}`);
    if (rep.runner.exitCode !== 0) {
      for (const line of rep.runner.stderr.split('\n').filter(Boolean).slice(-10)) log(`           container ! ${line}`);
      throw new Error(`the ${mode} container runner exited ${rep.runner.exitCode}`);
    }
    const run = await waitFor(`typecheck result at ${short(sha)}`, typecheckAt(sha, ['success', 'failure']), 30_000);
    log(`  human  ${'GET changes/1/checks'.padEnd(19)} -> typecheck ${run.id} ${run.status} at ${short(run.headSha)} (source ${run.summary?.source}, command ${run.summary?.durationMs} ms)`);
    runs[mode] = { totalMs: rep.totalMs, wall, readyMs: rep.phases.boot + (rep.phases.setup ?? 0), phases: rep.phases, cost: r.cost };
    return { report: rep, wall, run };
  }

  log('\n== Container CI runner showcase (native ctx.container, durable_object policy, public beta)');
  try {
    const me = await rest('/api/v1/user');
    if (me.status !== 200) throw new Error(`GET /user -> ${me.status}`);
    state.owner = me.json.user.login;
    const made = await rest('/api/v1/repos', { method: 'POST', json: { name: state.name, visibility: 'private', description: 'demo-harness container CI scratch repo' } });
    log(`  human  ${'REST POST repos'.padEnd(19)} -> ${made.status} ${state.owner}/${state.name} (private)`);
    if (made.status !== 201) throw new Error(`repo create failed: ${made.status} ${made.json?.code ?? ''}`);
    state.created = true;
    const url = `${o.base}/${state.owner}/${state.name}.git`;

    mkdirSync(dir);
    git(['init', '-q', '-b', 'main']);
    const base = commit({ '.forge/ci.json': CI_CONFIG, 'tsconfig.json': TSCONFIG, 'src/limits.ts': LIMITS(5) }, 'Seed a typed config with a typecheck job');
    git(['checkout', '-q', '-b', 'feature']);
    const head1 = commit({ 'src/limits.ts': LIMITS(10) }, 'Raise the steady limit to 10');
    git(['push', '-q', url, 'main', 'feature']);
    log(`  human  ${'git push'.padEnd(19)} -> main ${short(base)}, feature ${short(head1)}`);
    const change = await rest(`${R()}/changes`, { method: 'POST', json: { title: 'Raise the steady limit', base: 'main', head: 'feature', mergePolicy: 'review' } });
    if (change.status !== 201) throw new Error(`change create -> ${change.status} ${change.json?.code ?? ''}`);
    const queued1 = await waitFor('typecheck queued at head 1', typecheckAt(head1, ['queued']), 60_000);
    log(`  human  ${'REST POST changes'.padEnd(19)} -> #${change.json.number}; typecheck ${queued1.id} queued at ${short(head1)}`);
    await snapshotReady(head1);

    log('  -- run 1 (cold): fresh image, prepare once, snapshotContainer, claim -> checkout -> run -> report');
    const cold = await containerRun('cold', head1);
    if (cold.report.phases.setup === null || !cold.report.snapshot) throw new Error('the cold run did not prepare and save the workspace');
    log(`           saved containerSnapshot ${cold.report.snapshot.id} (${cold.report.snapshot.name}, ${(cold.report.snapshot.size / 1048576).toFixed(1)} MiB)`);

    const head2 = commit({ 'src/limits.ts': LIMITS(15) }, 'Raise the steady limit to 15');
    git(['push', '-q', url, 'feature']);
    const queued2 = await waitFor('typecheck queued at head 2', typecheckAt(head2, ['queued']), 60_000);
    log(`  human  ${'git push'.padEnd(19)} -> feature ${short(head2)}; typecheck ${queued2.id} queued`);
    await snapshotReady(head2);

    log('  -- run 2 (warm): restore the saved containerSnapshot, skip setup, claim -> checkout -> run -> report');
    const warm = await containerRun('warm', head2);
    if (warm.report.phases.setup !== null || !('snapshot' in warm.report.startedFrom) || warm.report.startedFrom.snapshot !== cold.report.snapshot.id) {
      throw new Error('the warm run did not start from the saved snapshot');
    }

    const all = (await checks()).filter((k) => k.name === 'typecheck' && (k.id === cold.run.id || k.id === warm.run.id));
    const same = (a, b) => JSON.stringify(Object.keys(a.summary ?? {}).sort()) === JSON.stringify(Object.keys(b.summary ?? {}).sort()) && a.summary?.command === b.summary?.command && a.summary?.source === b.summary?.source;
    log(`  human  ${'GET changes/1/checks'.padEnd(19)} -> ${all.map((k) => `${k.name} ${k.id} ${k.status} at ${short(k.headSha)}`).join('; ')}`);
    if (all.length !== 2 || cold.run.id === warm.run.id || !all.every((k) => k.status === 'success') || !same(all[0], all[1])) {
      throw new Error('both container check runs should be listed with distinct ids, success and the same summary shape');
    }

    const c = cold.report.phases;
    const w = warm.report.phases;
    log('\n  container runner timings (measured inside the Durable Object; wall = harness round trip)');
    log(`    ${'phase'.padEnd(34)} ${'run 1 cold'.padStart(12)} ${'run 2 warm'.padStart(12)}`);
    const row = (label, a, b) => log(`    ${label.padEnd(34)} ${fmt(a).padStart(12)} ${fmt(b).padStart(12)}`);
    row('boot (start -> first exec)', c.boot, w.boot);
    row('setup (runner + toolchain)', c.setup, w.setup);
    row('snapshotContainer', c.snapshot, w.snapshot);
    row('job (claim/checkout/run/report)', c.run, w.run);
    row('stop (destroy)', c.stop, w.stop);
    row('ready to run the job', c.boot + (c.setup ?? 0), w.boot + (w.setup ?? 0));
    row('total in the Durable Object', cold.report.totalMs, warm.report.totalMs);
    row('harness wall', cold.wall, warm.wall);
    const readyCold = c.boot + (c.setup ?? 0);
    const readyWarm = w.boot + (w.setup ?? 0);
    log(`    container reuse: ready-to-run ${(readyCold / Math.max(1, readyWarm)).toFixed(1)}x faster from the snapshot; end to end ${((cold.report.totalMs - (c.snapshot ?? 0)) / Math.max(1, warm.report.totalMs)).toFixed(1)}x excluding the one-time snapshot save`);
    ok = true;
  } catch (err) {
    log(`  container showcase FAILED: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (state.created) {
      const reset = await rest(`${R()}/ci/container-runs/snapshot`, { method: 'DELETE' }).catch(() => ({ status: 0, cost: null }));
      resetCost = reset.cost ?? null;
      log(`  human  ${'DELETE container snap'.padEnd(19)} -> ${reset.status} (stored snapshot handle cleared${reset.json?.snapshot ? `: ${reset.json.snapshot.id}` : ''})`);
      if (!o.keep) {
        const del = await rest(`/api/v1/repos/${state.owner}/${state.name}`, { method: 'DELETE' });
        log(`  human  ${'REST DELETE repo'.padEnd(19)} -> ${del.status} ${state.owner}/${state.name}`);
        if (del.status !== 200) ok = false;
      } else {
        log(`  kept ${state.owner}/${state.name} (--keep)`);
      }
    }
    rmSync(work, { recursive: true, force: true });
  }
  o.onResult?.({ runs, resetCost });
  log(`  container showcase ${ok ? 'ok' : 'FAILED'}`);
  return ok;
}
