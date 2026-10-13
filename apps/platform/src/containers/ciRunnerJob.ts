/**
 * One Container CI job inside an already-started container: readiness,
 * one-time preparation (cold), then the runner exec. The runner claims the
 * job and materializes its workspace, prints PREPARED_LINE and waits for the
 * go file. A cold run snapshots the container at that point, so the saved
 * filesystem holds the runner, the toolchain and the claimed job's prepared
 * workspace (slot state included) but no command output. A warm run, started
 * from that snapshot, releases the runner straight away; its warm delta sync
 * finds the prepared workspace instead of checking the tree out again.
 *
 * Only structural container types are used (no runtime imports), so Node
 * tests drive this with a local stand-in for `ctx.container`.
 */

import { DRAIN_ENTRY_FILE, GO_FILE, PREPARED_LINE, RUNNER_DIR, WORK_ROOT, WRITE_FILES_SCRIPT, containerRunnerFiles, runnerExecEnv, type RunnerExecInput } from './runnerFiles';

export interface ExecLike {
  readonly stdout: ReadableStream | null;
  readonly stderr: ReadableStream | null;
  readonly exitCode: Promise<number>;
  output(): Promise<{ stdout: ArrayBuffer; stderr: ArrayBuffer; exitCode: number }>;
}

export interface SnapshotHandle {
  id: string;
  size: number;
  name?: string;
}

/** The part of `ctx.container` a job needs. Concurrent exec() calls run as separate processes. */
export interface ContainerLike {
  exec(cmd: string[], options?: { cwd?: string; env?: Record<string, string>; stdin?: ReadableStream }): Promise<ExecLike>;
  snapshotContainer(options: { name?: string }): Promise<SnapshotHandle>;
}

export interface JobPhases {
  /** start() until the first exec() returns: start() is not readiness. */
  boot: number;
  /** Runner modules plus toolchain (cold only). */
  setup: number | null;
  /** Runner exec start until the claimed job's workspace is prepared (claim plus checkout or warm sync); null when no job was prepared. */
  workspace: number | null;
  /** snapshotContainer() of the prepared workspace (cold only). */
  snapshot: number | null;
  /** From releasing the prepared runner (or from the exec start when none was prepared) until it exits: command plus report. */
  run: number;
}

export interface JobOutcome {
  phases: JobPhases;
  /** The snapshot this run saved (cold), else null. */
  snapshot: SnapshotHandle | null;
  runner: { exitCode: number; stdout: string; stderr: string };
}

export interface JobOptions {
  cold: boolean;
  /** When start() was called. */
  started: number;
  exec: RunnerExecInput;
  toolchain: string[];
  snapshotName: string;
  timeoutSeconds?: number;
  runnerDir?: string;
  goFile?: string;
  /** Persists the saved snapshot handle before the runner is released. */
  saveSnapshot?: (snapshot: SnapshotHandle) => Promise<void>;
}

const OUTPUT_TAIL = 4_000;

const tailText = (text: string) => (text.length <= OUTPUT_TAIL ? text : `[...]${text.slice(-OUTPUT_TAIL)}`);

/**
 * Reads a byte stream as text, keeping only a bounded tail once `until` is
 * not being waited on, so command output cannot grow without limit.
 */
function textReader(stream: ReadableStream | null) {
  const reader = (stream as ReadableStream<Uint8Array> | null)?.getReader();
  const dec = new TextDecoder();
  let text = '';
  let done = !reader;
  const pull = async () => {
    const r = await reader!.read();
    if (r.done) {
      text += dec.decode();
      done = true;
    } else {
      text += dec.decode(r.value, { stream: true });
    }
  };
  return {
    /** Resolves true once a whole line equal to `line` has been read, false at end of stream. */
    async until(line: string): Promise<boolean> {
      for (;;) {
        if (`\n${text}`.includes(`\n${line}\n`)) return true;
        if (done) return false;
        await pull();
      }
    },
    async rest(): Promise<string> {
      while (!done) {
        await pull();
        if (text.length > OUTPUT_TAIL * 2) text = text.slice(-OUTPUT_TAIL - 1);
      }
      return tailText(text);
    },
  };
}

async function mustExec(container: ContainerLike, cmd: string[], options: { cwd?: string; env?: Record<string, string>; stdin?: ReadableStream }, what: string): Promise<void> {
  const out = await (await container.exec(cmd, options)).output();
  if (out.exitCode !== 0) {
    const dec = new TextDecoder();
    throw new Error(`${what} exited ${out.exitCode}: ${tailText(dec.decode(out.stderr)) || tailText(dec.decode(out.stdout))}`);
  }
}

export async function prepareAndRunJob(container: ContainerLike, o: JobOptions): Promise<JobOutcome> {
  const runnerDir = o.runnerDir ?? RUNNER_DIR;
  const goFile = o.goFile ?? GO_FILE;
  const phases: JobPhases = { boot: 0, setup: null, workspace: null, snapshot: null, run: 0 };
  // exec() waits for a container that is still starting: the first one is the readiness gate.
  await mustExec(container, ['node', '--version'], {}, 'readiness probe');
  phases.boot = Date.now() - o.started;
  if (o.cold) {
    const t = Date.now();
    const files = JSON.stringify({ dir: runnerDir, files: containerRunnerFiles() });
    await mustExec(container, ['node', '-e', WRITE_FILES_SCRIPT], { stdin: new Blob([files]).stream() }, 'writing the runner');
    await mustExec(container, o.toolchain, { env: { HOME: '/root' } }, 'installing the toolchain');
    phases.setup = Date.now() - t;
  }

  let t = Date.now();
  const proc = await container.exec(['timeout', '--kill-after=5', String(o.timeoutSeconds ?? 600), 'node', `${runnerDir}/run.mjs`], {
    cwd: runnerDir,
    env: runnerExecEnv({ ...o.exec, goFile }),
  });
  const stdout = textReader(proc.stdout);
  // Drained concurrently so a chatty runner never blocks on a full stderr pipe.
  const stderr = textReader(proc.stderr).rest();
  let snapshot: SnapshotHandle | null = null;
  if (await stdout.until(PREPARED_LINE)) {
    phases.workspace = Date.now() - t;
    if (o.cold) {
      const s = Date.now();
      snapshot = await container.snapshotContainer({ name: o.snapshotName });
      await o.saveSnapshot?.(snapshot);
      phases.snapshot = Date.now() - s;
    }
    t = Date.now();
    await mustExec(container, ['touch', goFile], {}, 'releasing the prepared runner');
  }
  const [out, err, exitCode] = await Promise.all([stdout.rest(), stderr, proc.exitCode]);
  phases.run = Date.now() - t;
  return { phases, snapshot, runner: { exitCode, stdout: out, stderr: err } };
}

// ---------------------------------------------------------------------------
// Hosted drain
// ---------------------------------------------------------------------------

export interface DrainOptions {
  cold: boolean;
  /** When start() was called. */
  started: number;
  /** Worker count: concurrent runner execs, each claiming until the queue is empty. */
  workers: number;
  exec: RunnerExecInput;
  toolchain: string[];
  snapshotName: string;
  saveSnapshot?: (snapshot: SnapshotHandle) => Promise<void>;
  runnerDir?: string;
  goFile?: string;
}

export interface DrainWorkerResult {
  runnerId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DrainPhases {
  /** start() until the first exec() returned. */
  boot: number;
  /** Runner modules plus toolchain plus go-file reset (cold only). */
  setup: number | null;
  /** snapshotContainer() of the first prepared workspace (cold only). */
  snapshot: number | null;
  /** From the first worker exec start until the last worker exits. */
  drain: number;
}

export interface DrainOutcome {
  phases: DrainPhases;
  workers: DrainWorkerResult[];
  /** The snapshot this drain saved (cold), else null. */
  snapshot: SnapshotHandle | null;
}

/**
 * Drains the repository's queued jobs in one container session: one runner
 * install and toolchain, then `workers` concurrent runner execs that each
 * loop claim → snapshot checkout or warm sync → run → report until a claim
 * comes back empty. The first prepared workspace is snapshotted (cold) so
 * an interrupted drain resumes from it without the setup or a checkout, and
 * the go file is released once for every worker. No outer wall-clock kill:
 * the per-job timeout lives in the runner, and the credential's expiry ends
 * a drain that lost its revocation path.
 */
export async function drainAndRunJobs(container: ContainerLike, o: DrainOptions): Promise<DrainOutcome> {
  const runnerDir = o.runnerDir ?? RUNNER_DIR;
  const goFile = o.goFile ?? GO_FILE;
  const phases: DrainPhases = { boot: 0, setup: null, snapshot: null, drain: 0 };
  // exec() waits for a container that is still starting: the first one is the readiness gate.
  await mustExec(container, ['node', '--version'], {}, 'readiness probe');
  phases.boot = Date.now() - o.started;
  if (o.cold) {
    const t = Date.now();
    const files = JSON.stringify({ dir: runnerDir, files: containerRunnerFiles() });
    await mustExec(container, ['node', '-e', WRITE_FILES_SCRIPT], { stdin: new Blob([files]).stream() }, 'writing the runner');
    await mustExec(container, o.toolchain, { env: { HOME: '/root' } }, 'installing the toolchain');
    await mustExec(container, ['rm', '-f', goFile], {}, 'clearing the prepared point');
    phases.setup = Date.now() - t;
  } else {
    // A restored snapshot carries the go file and slot locks of the previous
    // container; both are stale here. The go file is pre-created so no worker
    // waits at the prepared point, and the slot locks are removed because a
    // restored lock's recorded pid can coincide with a live process and would
    // push the worker to a fresh slot (workdir.js steals only provably dead
    // owners).
    await mustExec(container, ['touch', goFile], {}, 'pre-releasing the prepared point');
    const repoRoot = [o.exec.workRoot ?? WORK_ROOT, ...o.exec.repo.split('/')].join('/');
    await mustExec(container, ['find', repoRoot, '-maxdepth', '1', '-name', '*.lock', '-delete'], {}, 'clearing stale slot locks');
  }

  const t = Date.now();
  // exec() registers the process when it is called, so awaiting each handle
  // in turn still starts every worker concurrently.
  const started: Array<{ runnerId: string; proc: ExecLike; stdout: ReturnType<typeof textReader>; stderrDone: Promise<string> }> = [];
  for (let i = 0; i < o.workers; i++) {
    const runnerId = `${o.exec.runnerId}-w${i}`;
    const proc = await container.exec(['node', `${runnerDir}/${DRAIN_ENTRY_FILE}`], {
      cwd: runnerDir,
      env: runnerExecEnv({ ...o.exec, runnerId, goFile }),
    });
    // Drained concurrently so a chatty runner never blocks on a full stderr pipe.
    started.push({ runnerId, proc, stdout: textReader(proc.stdout), stderrDone: textReader(proc.stderr).rest() });
  }
  let snapshot: SnapshotHandle | null = null;
  // Promise.any over "saw the prepared line": a worker that exits without a
  // job rejects, so the race resolves only when one worker truly prepared.
  const firstPrepared = Promise.any(
    started.map((w) =>
      w.stdout.until(PREPARED_LINE).then((saw) => {
        if (!saw) throw new Error('no job claimed');
        return true;
      }),
    ),
  );
  try {
    if (await firstPrepared) {
      if (o.cold) {
        const s = Date.now();
        snapshot = await container.snapshotContainer({ name: o.snapshotName });
        await o.saveSnapshot?.(snapshot);
        phases.snapshot = Date.now() - s;
      }
      await mustExec(container, ['touch', goFile], {}, 'releasing the prepared workers');
    }
  } catch {
    // Every worker exited without claiming (another runner drained the
    // queue first); the workers report empty on their own.
  }
  const workers = await Promise.all(
    started.map(async (w) => ({ runnerId: w.runnerId, exitCode: await w.proc.exitCode, stdout: await w.stdout.rest(), stderr: await w.stderrDone })),
  );
  phases.drain = Date.now() - t;
  return { phases, workers, snapshot };
}
