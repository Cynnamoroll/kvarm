/**
 * The train view's one read set (architecture §11.4, §4). The page shows the
 * live train per target branch, the entries that recently left it with the
 * reason they left, and the open `resolve-conflict` tasks its ejections may
 * have spawned. Composed here so the route stays an adapter and the read set
 * is bounded in one place: three indexed D1 round trips, no Artifacts, never
 * a write and never a queue kick (repeated views are idempotent).
 */

import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import { listTasks, type TaskPage } from './tasks';
import { listTrainExits, trainStatus, type TrainExits, type TrainStatus } from './queue';

export const TRAIN_VIEW_LIMITS = {
  /** Active entries per target branch. */
  entries: 50,
  /** Exit history rows. */
  exits: 20,
  /** Open resolve-conflict tasks. */
  tasks: 20,
} as const;

export interface TrainView {
  train: TrainStatus;
  exits: TrainExits;
  /** Open resolve-conflict tasks, newest first (empty when the train is healthy). */
  tasks: TaskPage;
}

export async function trainView(env: Env, repo: RepoRow, q: { base?: string } = {}): Promise<ServiceResult<TrainView>> {
  const [train, exits, tasks] = await Promise.all([
    trainStatus(env, repo, { limit: String(TRAIN_VIEW_LIMITS.entries), base: q.base }),
    listTrainExits(env, repo, { limit: String(TRAIN_VIEW_LIMITS.exits), base: q.base }),
    listTasks(env, repo, { kind: 'resolve-conflict', status: 'open', limit: String(TRAIN_VIEW_LIMITS.tasks) }),
  ]);
  if (!train.ok) return train;
  if (!exits.ok) return exits;
  if (!tasks.ok) return tasks;
  return { ok: true, value: { train: train.value, exits: exits.value, tasks: tasks.value } };
}
