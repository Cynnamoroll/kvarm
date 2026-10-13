import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { FLEET_SWEEP_CRON, WEBHOOK_CRON } from '../src/cron';
import { dispatchScheduled, type ScheduledJobs } from '../src/scheduled';

function spies() {
  const webhooks = vi.fn(async () => {});
  const fleetSweeps = vi.fn(async () => {});
  return { webhooks, fleetSweeps, jobs: { webhooks, fleetSweeps } satisfies ScheduledJobs };
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
    expect(s.fleetSweeps).not.toHaveBeenCalled();
  });

  it('the six-hour trigger runs the fleet sweeps and not the webhook job', async () => {
    const s = spies();
    expect(await run(FLEET_SWEEP_CRON, s.jobs)).toBe('fleetSweeps');
    expect(s.fleetSweeps).toHaveBeenCalledTimes(1);
    expect(s.webhooks).not.toHaveBeenCalled();
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
        if (cron === WEBHOOK_CRON) {
          expect(log.mock.calls.some((c) => String(c[0]).includes('"cron":"webhooks"'))).toBe(true);
        } else if (cron === 'bogus') {
          expect(warn).toHaveBeenCalledTimes(1);
          expect(log).not.toHaveBeenCalled();
        } else {
          expect(log.mock.calls.some((c) => String(c[0]).includes('"cron":"webhooks"'))).toBe(false);
        }
      } finally {
        log.mockRestore();
        warn.mockRestore();
      }
    }
  });
});
