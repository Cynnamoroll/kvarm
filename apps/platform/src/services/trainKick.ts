/**
 * Wake-up messages for the integration train (services/queue.ts). A kick is
 * one message on the `forge-events` queue naming a repository + target-ref
 * partition; the queue consumer runs one train pass for it. Kicks come from
 * enqueue, dequeue, a head push of a queued change, an expired publication
 * lease (do/mergeLock.ts alarm) and the train's own bounded backoff. Nothing
 * polls.
 */

export const TRAIN_MESSAGE = 'kvarm.train';

export interface TrainMessage {
  type: typeof TRAIN_MESSAGE;
  repoId: string;
  ref: string;
  reason: string;
}

export function isTrainMessage(body: unknown): body is TrainMessage {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return b.type === TRAIN_MESSAGE && typeof b.repoId === 'string' && typeof b.ref === 'string';
}

/** Sends one kick; `delaySeconds` > 0 is the train's backoff (bounded by the caller). */
export async function kickTrain(env: Pick<Env, 'EVENTS'>, repoId: string, ref: string, reason: string, delaySeconds = 0): Promise<void> {
  const msg: TrainMessage = { type: TRAIN_MESSAGE, repoId, ref, reason };
  const delay = Math.max(0, Math.min(43_200, Math.ceil(delaySeconds)));
  await env.EVENTS.send(msg, delay > 0 ? { delaySeconds: delay } : undefined);
}
