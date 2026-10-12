/**
 * Container CI runner showcase (Cloudflare Containers, public beta): one
 * Durable Object per repository that runs one `kvarm runner --once` job in a
 * Container through the native `ctx.container` API, with the
 * `durable_object` scheduling policy and the Cloudflare-managed
 * `cloudflare/debian-trixie` image. CI check jobs only; the user-owned CLI
 * runner stays the primary path.
 *
 * - cold: start a fresh container, prepare it once (write the runner modules,
 *   install the toolchain), then claim the job and materialize its workspace;
 *   the runner holds there while `snapshotContainer` saves the prepared
 *   workspace, then runs and reports the job.
 * - warm: start from the saved snapshot (runner, toolchain and the prepared
 *   workspace with its slot state) and go straight to claim; the runner's
 *   warm sync reuses the restored workspace instead of checking out again.
 *
 * Both modes run the same claim -> materialize -> run -> report REST loop as
 * `kvarm runner` against the deployed worker (ciRunnerJob.ts), so their
 * check runs record identically. The caller's token reaches the container
 * only through the runner exec's environment and is never written to its
 * filesystem, which a snapshot would capture. The container is destroyed
 * after every run.
 */

import { DurableObject } from 'cloudflare:workers';
import { prepareAndRunJob, type JobPhases, type SnapshotHandle } from './ciRunnerJob';

const IMAGE = 'cloudflare/debian-trixie';
const INSTANCE = 'standard-2';
// The image's own entrypoint exits; this keeps the container up between exec() calls.
const ENTRYPOINT = ['sleep', 'infinity'];
const TOOLCHAIN = ['npm', 'install', '--global', '--no-audit', '--no-fund', '--loglevel=error', 'typescript@5.9.3'];
const RUN_TIMEOUT_SECONDS = 600;
const INACTIVITY_MS = 15 * 60 * 1000;
const SNAPSHOT_KEY = 'workspace-snapshot';
const SNAPSHOT_NAME = 'kvarm-ci-workspace';

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
  phases: JobPhases & {
    /** destroy() */
    stop: number;
  };
  totalMs: number;
  snapshot: SnapshotView | null;
  runner: { exitCode: number; stdout: string; stderr: string };
}

export type ContainerRunResult = { ok: true; value: ContainerRunReport } | { ok: false; status: number; code: string; error: string };

const snapshotView = (s: SnapshotHandle | null | undefined): SnapshotView | null => (s ? { id: s.id, size: s.size, name: s.name ?? null } : null);

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
    let job: Awaited<ReturnType<typeof prepareAndRunJob>>;
    let stop = 0;
    try {
      await container.setInactivityTimeout(INACTIVITY_MS);
      job = await prepareAndRunJob(container, {
        cold,
        started,
        exec: { baseUrl: req.baseUrl, token: req.token, repo: req.repo, runnerId: req.runnerId },
        toolchain: TOOLCHAIN,
        snapshotName: SNAPSHOT_NAME,
        timeoutSeconds: RUN_TIMEOUT_SECONDS,
        saveSnapshot: (snapshot) => this.ctx.storage.put(SNAPSHOT_KEY, snapshot),
      });
    } finally {
      const t = Date.now();
      await container.destroy();
      stop = Date.now() - t;
    }
    return {
      mode: req.mode,
      runnerId: req.runnerId,
      startedFrom: cold ? { image: IMAGE } : { snapshot: stored!.id },
      instance: INSTANCE,
      phases: { ...job.phases, stop },
      totalMs: Date.now() - started,
      snapshot: snapshotView(cold ? job.snapshot : stored),
      runner: job.runner,
    };
  }
}
