export const UPLOAD_PACK_CACHE_MAX_LAG_BYTES = 16 * 1024 * 1024;

export interface LockstepTeeBranchOptions {
  maxLagBytes?: number;
}

interface QueuedChunk<T> {
  value: T;
  byteLength: number;
}

function chunkByteLength(value: unknown): number {
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  throw new TypeError('maxLagBytes requires byte chunks');
}

export function lockstepTee<T>(
  source: ReadableStream<T>,
  count: 2,
  branchOptions?: readonly LockstepTeeBranchOptions[],
): [ReadableStream<T>, ReadableStream<T>];
export function lockstepTee<T>(
  source: ReadableStream<T>,
  count: number,
  branchOptions?: readonly LockstepTeeBranchOptions[],
): ReadableStream<T>[];
export function lockstepTee<T>(
  source: ReadableStream<T>,
  count: number,
  branchOptions: readonly LockstepTeeBranchOptions[] = [],
): ReadableStream<T>[] {
  if (!Number.isInteger(count) || count < 1) throw new RangeError('tee requires at least one branch');
  if (branchOptions.length > count) throw new RangeError('too many branch options');
  const options = Array.from({ length: count }, (_, index) => branchOptions[index] ?? {});
  for (const option of options) {
    if (
      option.maxLagBytes !== undefined &&
      (!Number.isSafeInteger(option.maxLagBytes) || option.maxLagBytes < 0)
    ) {
      throw new RangeError('maxLagBytes must be a non-negative safe integer');
    }
  }

  const reader = source.getReader();
  const branches = options.map((option) => ({
    controller: null as ReadableStreamDefaultController<T> | null,
    options: option,
    live: true,
    queue: [] as QueuedChunk<T>[],
    queuedBytes: 0,
    resolvePull: null as (() => void) | null,
  }));
  let reading = false;
  let sourceDone = false;
  let readerReleased = false;

  const resolvePull = (branch: (typeof branches)[number]) => {
    const resolve = branch.resolvePull;
    branch.resolvePull = null;
    resolve?.();
  };

  const releaseReader = () => {
    if (!reading && !readerReleased) {
      reader.releaseLock();
      readerReleased = true;
    }
  };

  const cancelSource = (reason?: unknown): Promise<void> => {
    if (sourceDone) return Promise.resolve();
    sourceDone = true;
    return reader.cancel(reason).catch(() => undefined).finally(releaseReader);
  };

  const dropBranch = (branch: (typeof branches)[number], error: unknown) => {
    if (!branch.live) return;
    branch.live = false;
    branch.queue = [];
    branch.queuedBytes = 0;
    try {
      branch.controller?.error(error);
    } catch {
      // Cancellation can win the error race.
    }
    resolvePull(branch);
  };

  const maybeRead = () => {
    if (reading || sourceDone) return;
    const live = branches.filter((branch) => branch.live);
    if (live.length === 0) {
      cancelSource();
      return;
    }
    if (!live.some((branch) => branch.resolvePull)) return;
    if (!live.every((branch) =>
      branch.resolvePull !== null ||
      (branch.options.maxLagBytes !== undefined && branch.queuedBytes <= branch.options.maxLagBytes)
    )) return;

    reading = true;
    void reader.read().then(({ done, value }) => {
      reading = false;
      if (done) {
        sourceDone = true;
        for (const branch of branches) {
          if (!branch.live || branch.queue.length > 0) continue;
          branch.live = false;
          branch.controller?.close();
          resolvePull(branch);
        }
        releaseReader();
        return;
      }

      for (const branch of branches) {
        if (!branch.live) continue;
        if (branch.resolvePull) {
          try {
            branch.controller!.enqueue(value!);
          } catch {
            dropBranch(branch, new Error('lockstep tee branch could not accept a chunk'));
            continue;
          }
          resolvePull(branch);
        } else if (branch.options.maxLagBytes !== undefined) {
          try {
            const byteLength = chunkByteLength(value);
            branch.queue.push({ value: value!, byteLength });
            branch.queuedBytes += byteLength;
            if (branch.queuedBytes > branch.options.maxLagBytes) {
              dropBranch(branch, new Error('lockstep tee branch exceeded maxLagBytes'));
            }
          } catch (error) {
            dropBranch(branch, error);
          }
        } else {
          dropBranch(branch, new Error('lockstep tee branch was not ready'));
        }
      }
      maybeRead();
    }, (error: unknown) => {
      reading = false;
      sourceDone = true;
      for (const branch of branches) {
        if (!branch.live) continue;
        dropBranch(branch, error);
      }
      releaseReader();
    });
  };

  const streams = branches.map((branch) => new ReadableStream<T>({
    start(controller) {
      branch.controller = controller;
    },
    pull() {
      if (!branch.live) return;
      if (branch.queue.length > 0) {
        const queued = branch.queue.shift()!;
        branch.queuedBytes -= queued.byteLength;
        try {
          branch.controller!.enqueue(queued.value);
        } catch {
          dropBranch(branch, new Error('lockstep tee branch could not accept a queued chunk'));
          maybeRead();
          return;
        }
        maybeRead();
        return;
      }
      if (sourceDone) {
        branch.live = false;
        branch.controller?.close();
        return;
      }
      return new Promise<void>((resolve) => {
        branch.resolvePull = resolve;
        maybeRead();
      });
    },
    cancel(reason) {
      if (!branch.live) return;
      branch.live = false;
      branch.queue = [];
      branch.queuedBytes = 0;
      resolvePull(branch);
      if (branches.every((candidate) => !candidate.live)) return cancelSource(reason);
      maybeRead();
    },
  }, { highWaterMark: 0 }));

  maybeRead();
  return streams;
}
