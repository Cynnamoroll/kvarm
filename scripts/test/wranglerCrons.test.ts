/**
 * The wrangler configs and the Worker's scheduled handler agree on the cron
 * expressions, and a config can never again carry a duplicate key (#47: a second
 * top-level "triggers" key silently replaced the per-minute cron).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCHEDULED_CRONS } from '../../apps/platform/src/cron';
import { findDuplicateKeys, parseJsonc } from '../lib/wrangler-target.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CONFIGS = ['wrangler.jsonc', 'wrangler.dev.jsonc'];
const read = (name: string) => readFileSync(`${ROOT}apps/platform/${name}`, 'utf8');

describe('findDuplicateKeys', () => {
  it('reports the issue #47 shape that JSON parsing hides', () => {
    const text = '{"triggers":{"crons":["* * * * *"]},"a":1,"triggers":{"crons":["0 */6 * * *"]}}';
    expect(findDuplicateKeys(text)).toEqual(['triggers']);
  });

  it('reports nested duplicates with their path and ignores equal keys in different objects', () => {
    const text = '{"a":{"x":1,"x":2},"b":{"x":1},"c":[{"y":1},{"y":2}],"d":{"x":1}}';
    expect(findDuplicateKeys(text)).toEqual(['a.x']);
  });

  it('sees a key followed by a comment before its colon', () => {
    expect(findDuplicateKeys('{"triggers" /* c */ : 1, "triggers" // c\n : 2}')).toEqual(['triggers']);
  });

  it('makes parseJsonc refuse a duplicate key instead of keeping the last', () => {
    expect(() => parseJsonc('{"triggers":1,"triggers":2}')).toThrow(/duplicate key.*triggers/);
  });

  it('ignores comments, key-like strings, escapes and trailing commas', () => {
    const text = `{
      // "triggers": 1
      "triggers": { "crons": ["a", "triggers", ], }, /* "triggers": 2 */
      "s": "x \\" \\"triggers\\": 3 // not a comment",
      "u": "https://example.com/a//b",
    }`;
    expect(findDuplicateKeys(text)).toEqual([]);
  });
});

describe.each(CONFIGS)('%s', (name) => {
  it('has no duplicate key at any depth', () => {
    expect(findDuplicateKeys(read(name))).toEqual([]);
  });

  it('registers exactly the crons the scheduled handler dispatches on', () => {
    const config = parseJsonc(read(name)) as { triggers?: { crons?: string[] } };
    expect([...(config.triggers?.crons ?? [])].sort()).toEqual([...SCHEDULED_CRONS].sort());
  });
});
