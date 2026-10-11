/**
 * Container CI runner showcase (Cloudflare Containers, public beta): one
 * Durable Object per repository that runs one `forge runner --once` job in a
 * Container through the native `ctx.container` API, with the
 * `durable_object` scheduling policy and the Cloudflare-managed
 * `cloudflare/debian-trixie` image. CI check jobs only; the user-owned CLI
 * runner stays the primary path.
 *
 * - cold: start a fresh container, prepare it once (write the runner modules,
 *   install the toolchain), save it with `snapshotContainer`, then claim, run
 *   and report one job.
 * - warm: start from the saved snapshot (the prepared runner and toolchain)
 *   and go straight to claim, run and report.
 *
 * Both modes run the same claim -> snapshot checkout -> run -> report REST
 * loop as `forge runner` against the deployed worker, so their check runs
 * record identically. The caller's token reaches the container only through
 * the runner exec's environment and is never written to its filesystem,
 * which a snapshot would capture. The container is destroyed after every run.
 */

import { DurableObject } from 'cloudflare:workers';
import { RUNNER_DIR, WRITE_FILES_SCRIPT, containerRunnerFiles, runnerExecEnv } from './runnerFiles';

const IMAGE = 'cloudflare/debian-trixie';
const INSTANCE = 'standard-2';
// The image's own entrypoint exits; this keeps the container up between exec() calls.
const ENTRYPOINT = ['sleep', 'infinity'];
const TOOLCHAIN = ['npm', 'install', '--global', '--no-audit', '--no-fund', '--loglevel=error', 'typescript@5.9.3'];
const RUN_TIMEOUT_SECONDS = 600;
const INACTIVITY_MS = 15 * 60 * 1000;
const SNAPSHOT_KEY = 'workspace-snapshot';
const SNAPSHOT_NAME = 'forge-ci-workspace';
const OUTPUT_TAIL = 4_000;

export type ContainerRunMode = 'cold' | 'warm';

export interface ContainerRunRequest {
  mode: ContainerRunMode;
  /** owner/name */
  repo: string;
  baseUrl: string;
  token: string;
  runnerId: string;
}

export interface SnapshotView {
  id: string;
  size: number;
  name: string | null;
}

export interface ContainerRunReport {
  mode: ContainerRunMode;
  runnerId: string;
  startedFrom: { image: string } | { snapshot: string };
  instance: string;
  /** Milliseconds measured inside the Durable Object. */
  phases: {
    /** start() until the first exec() returns: start() is not readiness. */
    boot: number;
    /** Runner modules plus toolchain (cold only). */
    setup: number | null;
    /** snapshotContainer() (cold only). */
    snapshot: number | null;
    /** The runner exec: claim, snapshot checkout, command, report. */
    run: number;
    /** destroy() */
    stop: number;
  };
  totalMs: number;
  snapshot: SnapshotView | null;
  runner: { exitCode: number; stdout: string; stderr: string };
}

export type ContainerRunResult = { ok: true; value: ContainerRunReport } | { ok: false; status: number; code: string; error: string };

const tail = (buf: ArrayBuffer) => {
  const text = new TextDecoder().decode(buf);
  return text.length <= OUTPUT_TAIL ? text : `[...]${text.slice(-OUTPUT_TAIL)}`;
};

const snapshotView = (s: ContainerSnapshot | undefined): SnapshotView | null => (s ? { id: s.id, size: s.size, name: s.name ?? null } : null);

export class CiRunnerSandbox extends DurableObject<Env> {
  private busy = false;

  async run(req: ContainerRunRequest): Promise<ContainerRunResult> {
    const stored = await this.ctx.storage.get<ContainerSnapshot>(SNAPSHOT_KEY);
    if (req.mode === 'warm' && !stored) return { ok: false, status: 409, code: 'NO_SNAPSHOT', error: 'no prepared workspace snapshot; run mode cold first' };
    const container = this.ctx.container;
    if (!container) return { ok: false, status: 503, code: 'CONTAINER_UNAVAILABLE', error: 'no container runtime is bound to CiRunnerSandbox in this deployment' };
    if (this.busy) return { ok: false, status: 409, code: 'RUN_IN_PROGRESS', error: 'a container run for this repository is in progress' };
    this.busy = true;
    try {
      return { ok: true, value: await this.runIn(container, req, stored) };
    } catch (err) {
      return { ok: false, status: 502, code: 'CONTAINER_FAILED', error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.busy = false;
    }
  }

  async reset(): Promise<{ reset: true; snapshot: SnapshotView | null }> {
    const stored = await this.ctx.storage.get<ContainerSnapshot>(SNAPSHOT_KEY);
    await this.ctx.storage.delete(SNAPSHOT_KEY);
    if (this.ctx.container?.running) await this.ctx.container.destroy();
    return { reset: true, snapshot: snapshotView(stored) };
  }

  private async runIn(container: Container, req: ContainerRunRequest, stored: ContainerSnapshot | undefined): Promise<ContainerRunReport> {
    // A container left by an interrupted run would make start() throw.
    if (container.running) await container.destroy();
    const cold = req.mode === 'cold';
    const started = Date.now();
    if (cold) container.start({ image: IMAGE, instance: INSTANCE, entrypoint: ENTRYPOINT, enableInternet: true });
    else container.start({ containerSnapshot: { id: stored!.id }, instance: INSTANCE, entrypoint: ENTRYPOINT, enableInternet: true });
    const phases: ContainerRunReport['phases'] = { boot: 0, setup: null, snapshot: null, run: 0, stop: 0 };
    let snapshot = stored;
    let runner: ContainerRunReport['runner'];
    try {
      await container.setInactivityTimeout(INACTIVITY_MS);
      // exec() waits for a container that is still starting: the first one is the readiness gate.
      await this.mustExec(container, ['node', '--version'], {}, 'readiness probe');
      phases.boot = Date.now() - started;
      if (cold) {
        let t = Date.now();
        const files = JSON.stringify({ dir: RUNNER_DIR, files: containerRunnerFiles() });
        await this.mustExec(container, ['node', '-e', WRITE_FILES_SCRIPT], { stdin: new Blob([files]).stream() }, 'writing the runner');
        await this.mustExec(container, TOOLCHAIN, { env: { HOME: '/root' } }, 'installing the toolchain');
        phases.setup = Date.now() - t;
        t = Date.now();
        snapshot = await container.snapshotContainer({ name: SNAPSHOT_NAME });
        await this.ctx.storage.put(SNAPSHOT_KEY, snapshot);
        phases.snapshot = Date.now() - t;
      }
      const t = Date.now();
      const proc = await container.exec(['timeout', '--kill-after=5', String(RUN_TIMEOUT_SECONDS), 'node', `${RUNNER_DIR}/run.mjs`], {
        cwd: RUNNER_DIR,
        env: runnerExecEnv({ baseUrl: req.baseUrl, token: req.token, repo: req.repo, runnerId: req.runnerId }),
      });
      const out = await proc.output();
      phases.run = Date.now() - t;
      runner = { exitCode: out.exitCode, stdout: tail(out.stdout), stderr: tail(out.stderr) };
    } finally {
      const t = Date.now();
      await container.destroy();
      phases.stop = Date.now() - t;
    }
    return {
      mode: req.mode,
      runnerId: req.runnerId,
      startedFrom: cold ? { image: IMAGE } : { snapshot: stored!.id },
      instance: INSTANCE,
      phases,
      totalMs: Date.now() - started,
      snapshot: snapshotView(snapshot),
      runner,
    };
  }

  private async mustExec(container: Container, cmd: string[], options: ContainerExecOptions, what: string): Promise<void> {
    const proc = await container.exec(cmd, options);
    const out = await proc.output();
    if (out.exitCode !== 0) throw new Error(`${what} exited ${out.exitCode}: ${tail(out.stderr) || tail(out.stdout)}`);
  }
}
