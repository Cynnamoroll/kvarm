import { env as cfEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  purgeRepo,
  runRepoPurgeCron,
  sweepRepoPurges,
  type RepoPurgeTombstone,
} from '../src/services/repoPurge';

const env = cfEnv as unknown as Env;
const PREFIXES = ['trees/v1/', 'trees/v2/', 'trees/v3/', 'replica/', 'fetch/', 'bundles/'] as const;
const STEP_NAMES = ['artifacts', 'path-history', 'mirror', 'tokens', 'snapshots', ...PREFIXES] as const;

type StepName = (typeof STEP_NAMES)[number];
type StepRunner = (step: StepName) => Promise<void>;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function insertTombstone(nextAttemptAt = Date.now()): Promise<RepoPurgeTombstone> {
  const repoId = crypto.randomUUID();
  const tombstone: RepoPurgeTombstone = {
    repo_id: repoId,
    artifacts_name: `purge-test--${repoId}`,
    created_at: Date.now(),
    attempts: 0,
    next_attempt_at: nextAttemptAt,
    done_at: null,
    last_error: null,
  };
  await env.DB.prepare(
    `INSERT INTO repo_purges
       (repo_id, artifacts_name, created_at, attempts, next_attempt_at, done_at, last_error)
     VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
  ).bind(
    tombstone.repo_id,
    tombstone.artifacts_name,
    tombstone.created_at,
    tombstone.attempts,
    tombstone.next_attempt_at,
  ).run();
  return tombstone;
}

function purgeDb(runStep: StepRunner, throwUpdateFor?: string): D1Database {
  return {
    prepare(query: string) {
      const statement = env.DB.prepare(query);
      if (query.includes('SELECT "key" FROM repo_purge_keys')) {
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values);
            return {
              async all<T>() {
                await runStep('snapshots');
                return bound.all<T>();
              },
            } as D1PreparedStatement;
          },
        } as D1PreparedStatement;
      }
      if (throwUpdateFor && query.includes('UPDATE repo_purges')) {
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values);
            return {
              async run() {
                if (values[values.length - 1] === throwUpdateFor) throw new Error('tombstone update failed');
                return bound.run();
              },
            } as D1PreparedStatement;
          },
        } as D1PreparedStatement;
      }
      return statement;
    },
  } as unknown as D1Database;
}

function purgeEnv(runStep: StepRunner, throwUpdateFor?: string): Env {
  return {
    ...env,
    DB: purgeDb(runStep, throwUpdateFor),
    ARTIFACTS: {
      delete: () => runStep('artifacts'),
    },
    PATH_HISTORY: {
      idFromName: (name: string) => name,
      get: () => ({ destroy: () => runStep('path-history') }),
    },
    REPO_MIRROR: {
      idFromName: (name: string) => name,
      get: () => ({ destroy: () => runStep('mirror') }),
    },
    SNAPSHOTS: {
      async list(options: R2ListOptions) {
        const step = PREFIXES.find((prefix) => options.prefix?.startsWith(prefix));
        if (!step) throw new Error(`unexpected prefix ${options.prefix ?? ''}`);
        await runStep(step);
        return { objects: [], truncated: false } as unknown as R2Objects;
      },
      async delete() {},
    },
  } as unknown as Env;
}

function stubTokenStep(runStep: StepRunner): void {
  let running: Promise<void> | undefined;
  vi.stubGlobal('caches', {
    default: {
      async delete() {
        running ??= runStep('tokens');
        await running;
        return true;
      },
    },
  });
}

async function deleteTombstones(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await env.DB.prepare('DELETE FROM repo_purges WHERE repo_id = ?').bind(id).run();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('repo purge orchestration', () => {
  it('runs purge steps concurrently while keeping token deletion behind Artifacts deletion', async () => {
    const tombstone = await insertTombstone();
    let active = 0;
    let maxActive = 0;
    let artifactsSettled = false;
    let tokensStartedBeforeArtifactsSettled = false;
    const started = new Set<StepName>();
    const runStep: StepRunner = async (step) => {
      started.add(step);
      if (step === 'tokens' && !artifactsSettled) tokensStartedBeforeArtifactsSettled = true;
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(50);
      active--;
      if (step === 'artifacts') artifactsSettled = true;
    };
    stubTokenStep(runStep);

    const serialStarted = performance.now();
    for (const _step of STEP_NAMES) await delay(50);
    const serialMs = performance.now() - serialStarted;
    const concurrentStarted = performance.now();
    const result = await purgeRepo(purgeEnv(runStep), tombstone);
    const concurrentMs = performance.now() - concurrentStarted;
    console.log(JSON.stringify({
      repoPurgeTiming: {
        serialMs: Math.round(serialMs),
        concurrentMs: Math.round(concurrentMs),
      },
    }));

    expect(result.ok).toBe(true);
    expect(started).toEqual(new Set(STEP_NAMES));
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(tokensStartedBeforeArtifactsSettled).toBe(false);
    expect(concurrentMs).toBeLessThan(serialMs);
  });

  it('keeps failed-step errors in declaration order after every step has run', async () => {
    const tombstone = await insertTombstone();
    const started = new Set<StepName>();
    const failures = new Map<StepName, { delayMs: number; message: string }>([
      ['artifacts', { delayMs: 30, message: 'artifacts failed' }],
      ['path-history', { delayMs: 5, message: 'path failed' }],
      ['mirror', { delayMs: 20, message: 'mirror failed' }],
      ['snapshots', { delayMs: 10, message: 'snapshots failed' }],
      ['trees/v1/', { delayMs: 1, message: 'tree failed' }],
    ]);
    const runStep: StepRunner = async (step) => {
      started.add(step);
      const failure = failures.get(step);
      if (!failure) return;
      await delay(failure.delayMs);
      throw new Error(failure.message);
    };
    stubTokenStep(runStep);

    try {
      const result = await purgeRepo(purgeEnv(runStep), tombstone);
      expect(result).toEqual({
        ok: false,
        error: [
          'artifacts:Error:artifacts failed',
          'path-history:Error:path failed',
          'mirror:Error:mirror failed',
          'snapshots:Error:snapshots failed',
          'trees/v1/:Error:tree failed',
        ].join(', '),
      });
      expect(started).toEqual(new Set(STEP_NAMES));
    } finally {
      await deleteTombstones([tombstone.repo_id]);
    }
  });

  it('times out a stuck step without blocking the other steps or tombstone update', async () => {
    const tombstone = await insertTombstone();
    const started = new Set<StepName>();
    const runStep: StepRunner = async (step) => {
      started.add(step);
      if (step === 'artifacts') await new Promise<never>(() => {});
    };
    stubTokenStep(runStep);

    try {
      const outcome = await Promise.race([
        purgeRepo(purgeEnv(runStep), tombstone, { stepTimeoutMs: 20 }).then((result) => ({
          kind: 'done' as const,
          result,
        })),
        delay(150).then(() => ({ kind: 'watchdog' as const })),
      ]);
      expect(outcome.kind).toBe('done');
      if (outcome.kind !== 'done') return;
      expect(outcome.result).toEqual({ ok: false, error: 'artifacts:TimeoutError:step timeout' });
      expect(started).toEqual(new Set(STEP_NAMES));
      const stored = await env.DB.prepare(
        'SELECT attempts, done_at, last_error FROM repo_purges WHERE repo_id = ?',
      ).bind(tombstone.repo_id).first<{ attempts: number; done_at: number | null; last_error: string }>();
      expect(stored).toEqual({
        attempts: 1,
        done_at: null,
        last_error: 'artifacts:TimeoutError:step timeout',
      });
    } finally {
      await deleteTombstones([tombstone.repo_id]);
    }
  });

  it('logs the original D1 tombstone update error from the purge cron', async () => {
    const tombstone = await insertTombstone();
    const runStep: StepRunner = async () => {};
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubTokenStep(runStep);

    try {
      await runRepoPurgeCron(purgeEnv(runStep, tombstone.repo_id));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('tombstone update failed'));
    } finally {
      await deleteTombstones([tombstone.repo_id]);
    }
  });

  it('runs five due purges concurrently and counts a thrown purge without stopping the rest', async () => {
    const now = Date.now();
    const tombstones = await Promise.all(Array.from({ length: 6 }, () => insertTombstone(now)));
    const throwUpdateFor = tombstones[2]!.repo_id;
    let activeArtifacts = 0;
    let maxActiveArtifacts = 0;
    const runStep: StepRunner = async (step) => {
      if (step !== 'artifacts') return;
      activeArtifacts++;
      maxActiveArtifacts = Math.max(maxActiveArtifacts, activeArtifacts);
      await delay(30);
      activeArtifacts--;
    };
    vi.stubGlobal('caches', { default: { delete: async () => true } });

    try {
      const result = await sweepRepoPurges(purgeEnv(runStep, throwUpdateFor), {
        limit: tombstones.length,
        now: now + 1,
      });
      expect(result).toMatchObject({ count: 6, failed: 1 });
      expect(maxActiveArtifacts).toBe(5);
      for (const tombstone of tombstones.filter((row) => row.repo_id !== throwUpdateFor)) {
        const row = await env.DB.prepare('SELECT done_at FROM repo_purges WHERE repo_id = ?')
          .bind(tombstone.repo_id).first<{ done_at: number | null }>();
        expect(row?.done_at).not.toBeNull();
      }
    } finally {
      await deleteTombstones(tombstones.map((row) => row.repo_id));
    }
  });
});
