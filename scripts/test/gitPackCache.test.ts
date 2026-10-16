import { describe, expect, it } from 'vitest';
import { concat, DELIM_PKT, FLUSH_PKT, pktLine } from '@kvarm/gitops';
import {
  classifyUploadPackRequest,
  derivePackCacheKey,
  UploadPackResponseValidator,
} from '../../apps/platform/src/git/packCache';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);

function v2Request(lines: string[], headers: string[] = ['command=fetch\n', 'object-format=sha1\n']): Uint8Array {
  return concat(
    ...headers.map(pktLine),
    DELIM_PKT,
    ...lines.map(pktLine),
    FLUSH_PKT,
  );
}

describe('upload-pack request cache classification', () => {
  it('normalizes volatile fields and want/have/shallow order without changing other argument order', () => {
    const first = classifyUploadPackRequest(
      v2Request(
        [`want ${OID_B}\n`, `have ${OID_B}\n`, `want ${OID_A}\n`, `shallow ${OID_B}\n`, 'filter blob:none\n', 'done\n'],
        ['command=fetch\n', 'agent=git/2.45.0\n', 'session-id=session-a\n', 'object-format=sha1\n'],
      ),
      'v2',
    );
    const second = classifyUploadPackRequest(
      v2Request(
        [`shallow ${OID_B}\n`, `want ${OID_A}\n`, `have ${OID_B}\n`, `want ${OID_B}\n`, 'filter blob:none\n', 'done\n'],
        ['command=fetch\n', 'agent=git/2.46.0\n', 'session-id=session-b\n', 'object-format=sha1\n'],
      ),
    );

    expect(first.cacheable).toBe(true);
    expect(first.normalized).toBe(second.normalized);
    expect(first.normalized).toContain('object-format=sha1');
    expect(first.normalized).not.toContain('agent=');
    expect(first.normalized).not.toContain('session-id=');
  });

  it('passes unknown request lines through as uncacheable', () => {
    const request = classifyUploadPackRequest(v2Request(['want-ref refs/heads/main\n', 'done\n', 'unknown-option value\n']));

    expect(request.cacheable).toBe(false);
    expect(request.normalized).toBeNull();
  });

  it('keeps include-tag in the normalized key and scopes keys by ref_seq', async () => {
    const body = concat(
      pktLine(`want ${OID_A}\0include-tag side-band-64k agent=git/2.45.0\n`),
      FLUSH_PKT,
      pktLine('done\n'),
    );
    const request = classifyUploadPackRequest(body, 'v0');
    const withoutTag = classifyUploadPackRequest(
      concat(pktLine(`want ${OID_A}\0side-band-64k agent=git/2.45.0\n`), FLUSH_PKT, pktLine('done\n')),
      'v0',
    );

    expect(request.cacheable).toBe(true);
    expect(request.normalized).toContain('include-tag');
    expect(await derivePackCacheKey('repo-a', 17, 'v0', request.normalized!))
      .not.toBe(await derivePackCacheKey('repo-a', 18, 'v0', request.normalized!));
    expect(await derivePackCacheKey('repo-a', 17, 'v0', request.normalized!))
      .not.toBe(await derivePackCacheKey('repo-a', 17, 'v0', withoutTag.normalized!));
  });

  it('excludes requests with haves from the R2 tier', () => {
    const request = classifyUploadPackRequest(v2Request([`want ${OID_A}\n`, `have ${OID_B}\n`, 'done\n']));

    expect(request.cacheable).toBe(true);
    expect(request.hasHaves).toBe(true);
    expect(request.r2Eligible).toBe(false);
  });
});

describe('upload-pack response completeness', () => {
  it('requires a complete packfile response ending in a flush packet', () => {
    const response = concat(
      pktLine('acknowledgments\n'),
      DELIM_PKT,
      pktLine('packfile\n'),
      pktLine(new Uint8Array([1, 80, 65, 67, 75])),
      FLUSH_PKT,
    );
    const validator = new UploadPackResponseValidator('v2');
    for (let offset = 0; offset < response.length; offset += 3) {
      validator.push(response.subarray(offset, Math.min(offset + 3, response.length)));
    }

    expect(validator.finish()).toBe(true);
  });

  it('rejects ERR responses, missing final flushes, and truncated packets', () => {
    const errorResponse = new UploadPackResponseValidator('v2');
    errorResponse.push(pktLine('ERR not found\n'));
    errorResponse.push(FLUSH_PKT);
    expect(errorResponse.finish()).toBe(false);

    const noFlush = new UploadPackResponseValidator('v2');
    noFlush.push(concat(pktLine('packfile\n'), pktLine(new Uint8Array([1, 80, 65, 67, 75]))));
    expect(noFlush.finish()).toBe(false);

    const truncated = new UploadPackResponseValidator('v2');
    truncated.push(new TextEncoder().encode('000ap'));
    expect(truncated.finish()).toBe(false);
  });
});
