import { describe, expect, it } from 'vitest';
import { renderLsRefs, renderV0, type MirrorRenderRef } from '../src/do/repoMirror';

function oidHex(value: number): string {
  return value.toString(16).padStart(40, '0');
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const response = new Response(bytes);
  const compressed = response.body!.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)]!;
}

describe('RepoMirror representation microbenchmark', () => {
  it('measures identity and gzip for 1k, 10k, and 100k refs', async () => {
    const rows: Array<{ count: number; kind: string; variant: string; ms: number; bytes: number }> = [];
    for (const count of [1_000, 10_000, 100_000]) {
      const refs: MirrorRenderRef[] = [
        { name: 'HEAD', oid: oidHex(1), peeled: null },
        ...Array.from({ length: count }, (_, i) => ({
          name: `refs/heads/bench-${String(i).padStart(6, '0')}`,
          oid: oidHex(i + 2),
          peeled: null,
        })),
      ];
      const meta = { caps_v0: 'multi_ack thin-pack side-band-64k ofs-delta symref=HEAD:refs/heads/bench-000000', head_symref: 'refs/heads/bench-000000' };
      const measured = [
        ['v0', () => renderV0(meta, refs)],
        ['ls-refs', () => renderLsRefs(meta, refs, { prefixes: ['refs/heads/'], symrefs: true, peel: true })],
      ] as const;
      for (const [kind, render] of measured) {
        render();
        const renderTimes: number[] = [];
        let identity: Uint8Array<ArrayBufferLike> = new Uint8Array();
        for (let sample = 0; sample < 3; sample++) {
          const started = performance.now();
          identity = render();
          renderTimes.push(performance.now() - started);
        }
        const identityMs = median(renderTimes);
        rows.push({ count, kind, variant: 'identity', ms: Number(identityMs.toFixed(3)), bytes: identity.byteLength });

        const gzipTimes: number[] = [];
        let compressed: Uint8Array<ArrayBufferLike> = new Uint8Array();
        for (let sample = 0; sample < 3; sample++) {
          const started = performance.now();
          compressed = await gzip(identity);
          gzipTimes.push(performance.now() - started);
        }
        const gzipMs = identityMs + median(gzipTimes);
        rows.push({ count, kind, variant: 'gzip-precomputed', ms: Number(gzipMs.toFixed(3)), bytes: compressed.byteLength });
        expect(compressed.byteLength).toBeLessThan(identity.byteLength);
      }
    }
    console.info(`REPO_MIRROR_MICROBENCH ${JSON.stringify(rows)}`);
    expect(rows).toHaveLength(12);
    expect(rows.filter((row) => row.count === 100_000 && row.variant === 'identity').every((row) => row.ms < 50)).toBe(true);
  });
});
