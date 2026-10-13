/**
 * The Container CI runner (Cloudflare Containers, public beta): one Durable
 * Object per repository, through the native `ctx.container` API with the
 * `durable_object` scheduling policy and the Cloudflare-managed
 * `cloudflare/debian-trixie` image. Two paths share the object:
 *
 * - The hosted drain (services/hostedCi.ts, opt-in per repository): whenever
 *   CI jobs are queued, a kick arms the object's alarm, and the alarm drains
 *   the whole queue in one container session — one runner install and
 *   toolchain (cold) or a start from the saved container snapshot (warm), a
 *   small number of concurrent runner workers looping claim → snapshot
 *   checkout or warm sync → run → report until a claim finds the queue
 *   empty, then destroy. The first prepared workspace is snapshotted, so an
 *   interrupted drain resumes without the setup or a checkout. Kicks during
 *   a drain coalesce into one more pass; the DO alarm makes the drain
 *   self-healing after an isolate restart.
 * - The single-run showcase (routes/api/containerRunner.ts, instance
 *   admins): one `kvarm runner --once` job per request, same claim →
 *   materialize → run → report REST loop, so both paths' check runs record
 *   identically.
 *
 * The user-owned CLI runner stays the primary path and races on the same
 * fenced queue. A token reaches the container only through the runner
 * exec's environment and is never written to its filesystem, which a
 * snapshot would capture. Containers are destroyed when their session ends.
 */

import { DurableObject } from 'cloudflare:workers';
import { drainAndRunJobs, prepareAndRunJob, type DrainPhases, type DrainWorkerResult, type JobPhases, type SnapshotHandle } from './ciRunnerJob';
import { getRepoById } from '../db/repos';
import { mintHostedRunnerPat, revokeHostedRunnerPat } from '../services/hostedCi';

const IMAGE = 'cloudflare/debian-trixie';
const INSTANCE = 'standard-2';
// The image's own entrypoint exits; this keeps the container up between exec() calls.
const ENTRYPOINT = ['sleep', 'infinity'];
const TOOLCHAIN = ['npm', 'install', '--global', '--no-audit', '--no-fund', '--loglevel=error', 'typescript@5.9.3'];
const RUN_TIMEOUT_SECONDS = 600;
const INACTIVITY_MS = 15 * 60 * 1000;
const SNAPSHOT_KEY = 'workspace-snapshot';
const SNAPSHOT_NAME = 'kvarm-ci-workspace';
/** Concurrent drain workers; matches the train's checking capacity without starving a 2-vCPU instance. */
const HOSTED_WORKERS = 2;
const DRAINING_KEY = 'draining';
const DRAIN_PENDING_KEY = 'drain-pending';
const LAST_DRAIN_KEY = 'last-drain';
const LAST_KICK_KEY = 'last-kick';
/** Re-arm delay when the single-run showcase holds the container. */
const DRAIN_BACKOFF_MS = 30_000;

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

export interface DrainReport {
  at: number;
  mode: ContainerRunMode;
  workers: number;
  /** Claimable jobs when the drain started. */
  claimable: number;
  startedFrom: { image: string } | { snapshot: string };
  phases: DrainPhases & {
    /** destroy() */
    stop: number;
  };
  workerResults: DrainWorkerResult[];
  snapshot: SnapshotView | null;
  totalMs: number;
  error?: { code: string; message: string };
}

export interface HostedDrainStatus {
  draining: boolean;
  /** A kick arrived while a drain was running; one more pass follows. */
  pending: boolean;
  kickedAt: number | null;
  lastDrain: DrainReport | null;
  snapshot: SnapshotView | null;
}

const snapshotView = (s: SnapshotHandle | null | undefined): SnapshotView | null => (s ? { id: s.id, size: s.size, name: s.name ?? null } : null);

export class CiRunnerSandbox extends DurableObject<Env> {
  private busy = false;

  // -------------------------------------------------------------------------
  // Hosted drain: kick -> alarm -> drainUntilEmpty workers
  // -------------------------------------------------------------------------

  /** Wakes the drain; safe to call for every queued job and from every queueing path. */
  async kick(): Promise<{ started: boolean; queued: boolean }> {
    await this.ctx.storage.put(LAST_KICK_KEY, Date.now());
    if ((await this.ctx.storage.get<number>(DRAINING_KEY)) !== undefined) {
      await this.ctx.storage.put(DRAIN_PENDING_KEY, true);
      return { started: false, queued: true };
    }
    await this.ctx.storage.setAlarm(Date.now());
    return { started: true, queued: false };
  }

  async status(): Promise<HostedDrainStatus> {
    const [draining, pending, kickedAt, lastDrain, snapshot] = await Promise.all([
      this.ctx.storage.get<number>(DRAINING_KEY),
      this.ctx.storage.get<boolean>(DRAIN_PENDING_KEY),
      this.ctx.storage.get<number>(LAST_KICK_KEY),
      this.ctx.storage.get<DrainReport>(LAST_DRAIN_KEY),
      this.ctx.storage.get<ContainerSnapshot>(SNAPSHOT_KEY),
    ]);
    return {
      draining: draining !== undefined,
      pending: pending === true,
      kickedAt: kickedAt ?? null,
      lastDrain: lastDrain ?? null,
      snapshot: snapshotView(snapshot),
    };
  }

  async alarm(): Promise<void> {
    if (this.busy) {
      await this.ctx.storage.setAlarm(Date.now() + DRAIN_BACKOFF_MS);
      return;
    }
    this.busy = true;
    await this.ctx.storage.put(DRAINING_KEY, Date.now());
    try {
      await this.drainOnce();
    } catch (err) {
      await this.recordDrainError(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy = false;
      const pending = (await this.ctx.storage.get<boolean>(DRAIN_PENDING_KEY)) === true;
      await this.ctx.storage.delete(DRAINING_KEY);
      await this.ctx.storage.delete(DRAIN_PENDING_KEY);
      if (pending) await this.ctx.storage.setAlarm(Date.now());
    }
  }

  private async drainOnce(): Promise<void> {
    const at = Date.now();
    // The object is addressed by repository id (getByName), so the drain
    // learns its own repository from its name.
    const repoId = this.ctx.id.name ?? this.ctx.id.toString();
    const repo = await getRepoById(this.env.DB, repoId);
    // A no-op for repos that never opted in, and for an opt-out that raced a
    // queued kick: nothing is recorded and the stored snapshot stays.
    if (!repo || repo.hosted_ci !== 1) return;
    const claimable =
      (await this.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM ci_jobs WHERE repo_id = ?1 AND (status = 'queued' OR (status = 'running' AND lease_until <= ?2))`,
      )
        .bind(repoId, at)
        .first<{ n: number }>())?.n ?? 0;
    if (claimable === 0) return;
    const container = this.ctx.container;
    if (!container) {
      await this.recordDrainError('no container runtime is bound to CiRunnerSandbox in this deployment', 'CONTAINER_UNAVAILABLE', claimable);
      return;
    }
    const credential = await mintHostedRunnerPat(this.env, repo);
    try {
      // A container left by an interrupted session would make start() throw.
      if (container.running) await container.destroy();
      const stored = await this.ctx.storage.get<ContainerSnapshot>(SNAPSHOT_KEY);
      const cold = stored === undefined;
      container.start({
        ...(cold ? { image: IMAGE } : { containerSnapshot: { id: stored.id } }),
        instance: INSTANCE,
        entrypoint: ENTRYPOINT,
        enableInternet: true,
      });
      await container.setInactivityTimeout(INACTIVITY_MS);
      const outcome = await drainAndRunJobs(container, {
        cold,
        started: at,
        workers: HOSTED_WORKERS,
        exec: {
          baseUrl: this.env.APP_ORIGIN,
          token: credential.token,
          repo: `${repo.owner_login}/${repo.name}`,
          runnerId: `hosted-${crypto.randomUUID().slice(0, 8)}`,
        },
        toolchain: TOOLCHAIN,
        snapshotName: SNAPSHOT_NAME,
        saveSnapshot: (snapshot) => this.ctx.storage.put(SNAPSHOT_KEY, snapshot),
      });
      const t = Date.now();
      await container.destroy();
      const report: DrainReport = {
        at,
        mode: cold ? 'cold' : 'warm',
        workers: HOSTED_WORKERS,
        claimable,
        startedFrom: cold ? { image: IMAGE } : { snapshot: stored.id },
        phases: { ...outcome.phases, stop: Date.now() - t },
        workerResults: outcome.workers,
        snapshot: snapshotView(cold ? outcome.snapshot : stored),
        totalMs: Date.now() - at,
      };
      await this.ctx.storage.put(LAST_DRAIN_KEY, report);
    } finally {
      // The token never outlives its drain; the mint sweep covers an isolate
      // that died before this finally.
      await revokeHostedRunnerPat(this.env, credential).catch(() => {});
    }
  }

  private async recordDrainError(message: string, code = 'CONTAINER_FAILED', claimable = 0): Promise<void> {
    await this.ctx.storage.put(LAST_DRAIN_KEY, {
      at: Date.now(),
      mode: 'cold',
      workers: HOSTED_WORKERS,
      claimable,
      startedFrom: { image: IMAGE },
      phases: { boot: 0, setup: null, snapshot: null, drain: 0, stop: 0 },
      workerResults: [],
      snapshot: null,
      totalMs: 0,
      error: { code, message },
    } satisfies DrainReport);
  }

  // -------------------------------------------------------------------------
  // Single-run showcase (routes/api/containerRunner.ts)
  // -------------------------------------------------------------------------

  async run(req: ContainerRunRequest): Promise<ContainerRunResult> {
    const stored = await this.ctx.storage.get<ContainerSnapshot>(SNAPSHOT_KEY);
    if (req.mode === 'warm' && !stored) return { ok: false, status: 409, code: 'NO_SNAPSHOT', error: 'no prepared workspace snapshot; run mode cold first' };
    const container = this.ctx.container;
    if (!container) return { ok: false, status: 503, code: 'CONTAINER_UNAVAILABLE', error: 'no container runtime is bound to CiRunnerSandbox in this deployment' };
    if (this.busy) return { ok: false, status: 409, code: 'RUN_IN_PROGRESS', error: 'a container run for this repository is in progress' };
    if ((await this.ctx.storage.get<number>(DRAINING_KEY)) !== undefined) {
      return { ok: false, status: 409, code: 'DRAIN_IN_PROGRESS', error: 'a hosted drain for this repository is running; retry shortly' };
    }
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
