/**
 * The file view's server-side highlighter: one HTML string per input line,
 * token spans for comments, strings, numbers and keywords, and every text
 * byte escaped no matter what the file contains.
 */

import { describe, expect, it } from 'vitest';
import { highlightLines, languageOf } from '../src/highlight.js';

describe('languageOf', () => {
  it('maps extensions to languages and falls back to plain text', () => {
    expect(languageOf('src/v4/core/util.ts')).toBe('ts');
    expect(languageOf('lib/parser.test.tsx')).toBe('ts');
    expect(languageOf('app.js')).toBe('ts');
    expect(languageOf('package.json')).toBe('json');
    expect(languageOf('assets/site.css')).toBe('css');
    expect(languageOf('index.html')).toBe('html');
    expect(languageOf('.github/workflows/test.yml')).toBe('yaml');
    expect(languageOf('scripts/build.sh')).toBe('sh');
    expect(languageOf('flake.nix')).toBe('plain');
  });
});

describe('highlightLines', () => {
  it('returns exactly one HTML string per line', () => {
    const out = highlightLines('a.ts', 'const x = 1;\nconst y = 2;\n');
    expect(out).toHaveLength(3);
    expect(out[2]).toBe('');
  });

  it('escapes everything, even inside tokens', () => {
    const out = highlightLines('a.ts', 'const s = "<script>"; // <b>&amp;</b>\n');
    expect(out[0]).not.toContain('<script>');
    expect(out[0]).not.toContain('<b>');
    expect(out[0]).toContain('&lt;script&gt;');
    expect(out[0]).toContain('&amp;amp;');
  });

  it('highlights TypeScript keywords, strings, numbers and line comments', () => {
    const [line] = highlightLines('a.ts', 'export type Foo = "bar" | 42; // tail');
    expect(line).toContain('tok-key">export');
    expect(line).toContain('tok-key">type');
    expect(line).toContain('tok-str">"bar"');
    expect(line).toContain('tok-num">42');
    expect(line).toContain('tok-com">');
    expect(line).toContain('// tail');
  });

  it('carries block comments across lines', () => {
    const out = highlightLines('a.ts', '/* first\nstill comment\nlast */ code();');
    expect(out[0]).toContain('tok-com');
    expect(out[1]).toBe('<span class="tok-com">still comment</span>');
    expect(out[2]).toContain('tok-com');
    expect(out[2]).toContain('code');
  });

  it('carries template strings across lines and closes them', () => {
    const out = highlightLines('a.ts', 'const t = `one\ntwo`;\nx();');
    expect(out[0]).toContain('tok-key');
    expect(out[0]).toContain('tok-str');
    expect(out[1]).toContain('tok-str');
    expect(out[1]).toContain('two');
    expect(out[2]).toBe('x();');
  });

  it('highlights JSON keys, numbers and literals distinctly from values', () => {
    const [line] = highlightLines('a.json', '{"name": "zod", "stars": 38000, "ok": true}');
    expect(line).toContain('tok-typ">"name"');
    expect(line).toContain('tok-str">"zod"');
    expect(line).toContain('tok-num">38000');
    expect(line).toContain('tok-key">true');
  });

  it('highlights yaml comments and keys', () => {
    const out = highlightLines('a.yml', 'name: zod # repo\n');
    expect(out[0]).toContain('tok-typ">name');
    expect(out[0]).toContain('tok-com"># repo');
  });

  it('falls back to escaped plain text for unknown languages and over-budget files', () => {
    const plain = highlightLines('data.bin', 'x < 1\n');
    expect(plain[0]).toBe('x &lt; 1');
    const over = highlightLines('big.ts', 'const x = 1;\n'.repeat(100), { maxBytes: 32 });
    expect(over[0]).toBe('const x = 1;');
  });

  it('keeps empty input and single lines safe', () => {
    expect(highlightLines('a.ts', '')).toEqual(['']);
    expect(highlightLines('a.ts', 'no tokens')).toEqual(['no tokens']);
  });
});
