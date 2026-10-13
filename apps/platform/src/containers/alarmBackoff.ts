const FAILURE_COUNT_KEY = 'alarm-failure-count';

export async function withAlarmBackoff(
  storage: DurableObjectStorage,
  alarm: string,
  run: () => Promise<void>,
): Promise<void> {
  let failures = 0;
  try {
    failures = (await storage.get<number>(FAILURE_COUNT_KEY)) ?? 0;
    await run();
    await storage.delete(FAILURE_COUNT_KEY);
  } catch (error) {
    const delay = Math.min(60_000 * 2 ** failures, 3_600_000);
    const nextFailures = failures + 1;
    await storage.put(FAILURE_COUNT_KEY, nextFailures);
    await storage.setAlarm(Date.now() + delay);
    console.warn(
      JSON.stringify({
        alarm,
        failures: nextFailures,
        error: String(error instanceof Error ? error.message : error),
      }),
    );
  }
}
