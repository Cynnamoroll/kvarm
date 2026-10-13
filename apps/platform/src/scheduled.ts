import { FLEET_SWEEP_CRON, WEBHOOK_CRON } from './cron';
import { runFleetCron } from './services/sandboxes/sweeps';
import { runWebhookCron } from './services/webhooks';

export interface ScheduledJobs {
  webhooks: (env: Env) => Promise<void>;
  fleetSweeps: (env: Env) => Promise<void>;
}

export const defaultScheduledJobs: ScheduledJobs = {
  webhooks: runWebhookCron,
  fleetSweeps: runFleetCron,
};

/**
 * Runs the job a cron trigger is for. Each expression has its own cadence, so
 * one invocation never runs the other's work: the webhook pump would otherwise
 * wait for the six-hour trigger, or the fleet sweeps would run every minute.
 * An expression with no job is logged and runs nothing: a stray trigger must
 * not start unrelated work. Returns the job that ran, or null.
 */
export function dispatchScheduled(
  cron: string,
  env: Env,
  ctx: ExecutionContext,
  jobs: ScheduledJobs = defaultScheduledJobs,
): 'webhooks' | 'fleetSweeps' | null {
  if (cron === WEBHOOK_CRON) {
    ctx.waitUntil(jobs.webhooks(env));
    return 'webhooks';
  }
  if (cron === FLEET_SWEEP_CRON) {
    ctx.waitUntil(jobs.fleetSweeps(env));
    return 'fleetSweeps';
  }
  console.warn(JSON.stringify({ cron: 'unknown', expression: cron }));
  return null;
}
