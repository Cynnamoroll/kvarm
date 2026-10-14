import type { RepoEvent } from '../do/repoEvents';

export type LiveEventInput = Omit<RepoEvent, 'seq' | 'at'>;

/** Publishes a bounded repository event without changing the originating operation's result. */
export function publishRepoEvent(
  env: Env,
  repoId: string,
  event: LiveEventInput,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined = undefined,
): Promise<void> {
  const publish = (async () => {
    try {
      const stub = env.REPO_EVENTS.get(env.REPO_EVENTS.idFromName(repoId));
      await stub.fetch('https://repo-events/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      });
    } catch (error) {
      console.warn(JSON.stringify({ liveEvent: { repoId, type: event.type, error: String(error).slice(0, 200) } }));
    }
  })();
  if (waitUntil) {
    try {
      waitUntil(publish);
    } catch {
      // Publishing is best-effort even when execution-context scheduling fails.
    }
    return Promise.resolve();
  }
  return publish;
}
