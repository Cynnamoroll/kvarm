export type ServerTimingName = 'auth' | 'mirror' | 'cache' | 'upstream' | 'total';
export type CacheTimingDesc = 'hit-edge' | 'hit-r2' | 'miss' | 'none';

interface Metric {
  dur: number;
  desc?: CacheTimingDesc;
}

const METRIC_ORDER: ServerTimingName[] = ['auth', 'mirror', 'cache', 'upstream', 'total'];

export class ServerTiming {
  private readonly starts = new Map<ServerTimingName, number>();
  private readonly metrics = new Map<ServerTimingName, Metric>([
    ['auth', { dur: 0 }],
    ['cache', { dur: 0, desc: 'none' }],
    ['total', { dur: 0 }],
  ]);

  constructor() {
    this.start('total');
  }

  start(name: ServerTimingName): void {
    this.starts.set(name, Date.now());
  }

  mark(name: ServerTimingName, desc?: CacheTimingDesc): void {
    const started = this.starts.get(name);
    if (started === undefined) return;
    this.starts.delete(name);

    const current = this.metrics.get(name);
    this.metrics.set(name, {
      dur: (current?.dur ?? 0) + Math.max(0, Date.now() - started),
      ...(desc ?? current?.desc ? { desc: desc ?? current?.desc } : {}),
    });
  }

  header(): string {
    return METRIC_ORDER.flatMap((name) => {
      const metric = this.metrics.get(name);
      if (!metric) return [];
      return [`${name};dur=${metric.dur}${metric.desc ? `;desc=${metric.desc}` : ''}`];
    }).join(', ');
  }
}
