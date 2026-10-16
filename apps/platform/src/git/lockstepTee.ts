export function lockstepTee<T>(source: ReadableStream<T>, count: 2): [ReadableStream<T>, ReadableStream<T>];
export function lockstepTee<T>(source: ReadableStream<T>, count: number): ReadableStream<T>[];
export function lockstepTee<T>(source: ReadableStream<T>, count: number): ReadableStream<T>[] {
  if (!Number.isInteger(count) || count < 1) throw new RangeError('tee requires at least one branch');

  const reader = source.getReader();
  const branches = Array.from({ length: count }, () => ({
    controller: null as ReadableStreamDefaultController<T> | null,
    live: true,
    ready: true,
  }));
  let reading = false;
  let sourceDone = false;
  let readerReleased = false;

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

  const maybeRead = () => {
    if (reading || sourceDone) return;
    const live = branches.filter((branch) => branch.live);
    if (live.length === 0) {
      cancelSource();
      return;
    }
    if (!live.every((branch) => branch.ready)) return;

    for (const branch of live) branch.ready = false;
    reading = true;
    void reader.read().then(({ done, value }) => {
      reading = false;
      if (done) {
        sourceDone = true;
        for (const branch of branches) {
          if (branch.live) branch.controller?.close();
        }
        releaseReader();
        return;
      }

      for (const branch of branches) {
        if (!branch.live) continue;
        try {
          branch.controller!.enqueue(value!);
          branch.ready = false;
        } catch {
          branch.live = false;
          branch.ready = false;
        }
      }
      maybeRead();
    }, (error: unknown) => {
      reading = false;
      sourceDone = true;
      for (const branch of branches) {
        if (!branch.live) continue;
        try {
          branch.controller?.error(error);
        } catch {
          branch.live = false;
        }
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
      branch.ready = true;
      maybeRead();
    },
    cancel(reason) {
      if (!branch.live) return;
      branch.live = false;
      branch.ready = false;
      if (branches.every((candidate) => !candidate.live)) return cancelSource(reason);
      maybeRead();
    },
  }, { highWaterMark: 0 }));

  maybeRead();
  return streams;
}
