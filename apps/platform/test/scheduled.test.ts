import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env as cfEnv } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { FLEET_SWEEP_CRON, WEBHOOK_CRON } from '../src/cron';
import { dispatchScheduled, type ScheduledJobs } from '../src/scheduled';

const env = cfEnv as unknown as Env;

function spies() {
  const webhooks = vi.fn(async () => {});
  const fleetSweeps = vi.fn(async () => {});
  const repoPurges = vi.fn(async () => {});
  return { webhooks, fleetSweeps, repoPurges, jobs: { webhooks, fleetSweeps, repoPurges } satisfies ScheduledJobs };
}

async function run(cron: string, jobs: ScheduledJobs) {
  const ctx = createExecutionContext();
  const ran = dispatchScheduled(cron, env, ctx, jobs);
  await waitOnExecutionContext(ctx);
  return ran;
}

describe('scheduled dispatch on the cron expression', () => {
  it('the per-minute trigger runs the webhook job and not the fleet sweeps', async () => {
    const s = spies();
    expect(await run(WEBHOOK_CRON, s.jobs)).toBe('webhooks');
    expect(s.webhooks).toHaveBeenCalledTimes(1);
    expect(s.repoPurges).toHaveBeenCalledTimes(1);
    expect(s.fleetSweeps).not.toHaveBeenCalled();
  });

  it('the six-hour trigger runs the fleet sweeps and not the webhook job', async () => {
    const s = spies();
    expect(await run(FLEET_SWEEP_CRON, s.jobs)).toBe('fleetSweeps');
    expect(s.fleetSweeps).toHaveBeenCalledTimes(1);
    expect(s.webhooks).not.toHaveBeenCalled();
    expect(s.repoPurges).not.toHaveBeenCalled();
  });

  it('runs the purge sweep even if the webhook stage fails', async () => {
    const s = spies();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    s.webhooks.mockImplementationOnce(() => { throw new Error('webhook failure'); });
    try {
      expect(await run(WEBHOOK_CRON, s.jobs)).toBe('webhooks');
      expect(s.repoPurges).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith('{"cron":"webhooks","error":"Error"}');
    } finally {
      error.mockRestore();
    }
  });

  it('an unknown expression is logged and runs nothing', async () => {
    const s = spies();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await run('*/5 * * * *', s.jobs)).toBeNull();
      expect(s.webhooks).not.toHaveBeenCalled();
      expect(s.fleetSweeps).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('the Worker entrypoint routes controller.cron through the dispatcher', async () => {
    for (const cron of [WEBHOOK_CRON, FLEET_SWEEP_CRON, 'bogus']) {
      const ctx = createExecutionContext();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await worker.scheduled({ cron, scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env, ctx);
        await waitOnExecutionContext(ctx);
        const ran = (name: string) => log.mock.calls.some((c) => String(c[0]).includes(`"cron":"${name}"`));
        // A job that ran but failed logs an "error" field; that is not a pass.
        expect(log.mock.calls.some((c) => String(c[0]).includes('"error"'))).toBe(false);
        expect([ran('webhooks'), ran('fleet')]).toEqual(
          cron === WEBHOOK_CRON ? [true, false] : cron === FLEET_SWEEP_CRON ? [false, true] : [false, false],
        );
        expect(warn).toHaveBeenCalledTimes(cron === 'bogus' ? 1 : 0);
      } finally {
        log.mockRestore();
        warn.mockRestore();
      }
    }
  });
});
