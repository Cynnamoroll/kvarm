import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseJsonc } from '../lib/wrangler-target.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const configs = ['wrangler.jsonc', 'wrangler.dev.jsonc'];

function stripComments(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      result += text.slice(start, i + 1);
      i++;
    } else if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const comment = text.slice(i, end === -1 ? text.length : end + 2);
      result += comment.replace(/[^\n]/g, ' ');
      i = end === -1 ? text.length : end + 2;
    } else {
      result += text[i];
      i++;
    }
  }
  return result;
}

describe('Wrangler webhook triggers', () => {
  for (const file of configs) {
    const source = readFileSync(`${ROOT}apps/platform/${file}`, 'utf8');
    const withoutComments = stripComments(source);
    const config = parseJsonc(source) as { triggers?: { crons?: string[] } };

    it(`${file} declares triggers only once at the top level`, () => {
      expect(withoutComments.match(/^  "triggers"\s*:/gm) ?? []).toHaveLength(1);
    });

    it(`${file} contains only the webhook cron`, () => {
      expect(config.triggers?.crons).toEqual(['* * * * *']);
    });
  }
});
