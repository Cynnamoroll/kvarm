// Cron expressions the Worker is scheduled with. The wrangler configs must list
// exactly these (scripts/test/wranglerCrons.test.ts asserts it); `scheduled`
// dispatches on `controller.cron`, so a trigger registered without a handler
// here would run nothing (see scheduled.ts).

/** Every minute: enqueue due webhook deliveries and prune the delivery log (services/webhooks.ts). */
export const WEBHOOK_CRON = '* * * * *';

/** Every six hours: stale-environment rebuilds, failed-build retries, sandbox expiry (services/sandboxes/sweeps.ts). */
export const FLEET_SWEEP_CRON = '0 */6 * * *';

export const SCHEDULED_CRONS: readonly string[] = [WEBHOOK_CRON, FLEET_SWEEP_CRON];
