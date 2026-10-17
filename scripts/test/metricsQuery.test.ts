import { describe, expect, it } from 'vitest';
import { buildMetricsQueries, parseMetricsQueryArgs } from '../lib/metrics-query.mjs';

describe('parseMetricsQueryArgs', () => {
  it('defaults to 24 hours and reads the dataset positional argument', () => {
    expect(parseMetricsQueryArgs(['kvarm_bench_m8q4_git'])).toEqual({
      dataset: 'kvarm_bench_m8q4_git',
      sinceHours: 24,
    });
  });

  it('accepts a positive integer --since value', () => {
    expect(parseMetricsQueryArgs(['kvarm_bench_m8q4_git', '--since', '6'])).toEqual({
      dataset: 'kvarm_bench_m8q4_git',
      sinceHours: 6,
    });
  });

  it.each([
    { args: [] as string[] },
    { args: ['kvarm-bench-m8q4-git'] },
    { args: ['kvarm_bench_m8q4_git', '--since', '0'] },
    { args: ['kvarm_bench_m8q4_git', '--since', '-1'] },
    { args: ['kvarm_bench_m8q4_git', '--since', '1.5'] },
    { args: ['kvarm_bench_m8q4_git', '--since'] },
    { args: ['kvarm_bench_m8q4_git', 'other'] },
  ])('rejects invalid arguments $args', ({ args }) => {
    expect(() => parseMetricsQueryArgs(args)).toThrow();
  });
});

describe('buildMetricsQueries', () => {
  it('builds the mirror-compare and receive-pack SQL with validated identifiers and hours', () => {
    expect(buildMetricsQueries('kvarm_bench_m8q4_git', 6)).toEqual({
      mirrorCompare: "SELECT blob3 AS kind, blob4 AS outcome, blob5 AS reason, SUM(_sample_interval) AS n FROM kvarm_bench_m8q4_git WHERE blob1 = 'mirror_compare' AND timestamp > NOW() - INTERVAL '6' HOUR GROUP BY kind, outcome, reason ORDER BY n DESC",
      receivePack: "SELECT blob3 AS outcome, SUM(_sample_interval) AS pushes, SUM(_sample_interval * double1) AS retries, SUM(_sample_interval * double2) AS attempts FROM kvarm_bench_m8q4_git WHERE blob1 = 'receive_pack' AND timestamp > NOW() - INTERVAL '6' HOUR GROUP BY outcome ORDER BY pushes DESC",
    });
  });

  it('rejects invalid dataset names and non-positive or non-integer hours', () => {
    expect(() => buildMetricsQueries('x; DROP TABLE y', 24)).toThrow(/dataset/);
    expect(() => buildMetricsQueries('valid_dataset', 0)).toThrow(/positive integer/);
    expect(() => buildMetricsQueries('valid_dataset', 1.5)).toThrow(/positive integer/);
  });
});
