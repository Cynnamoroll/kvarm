/**
 * Server-side syntax highlighting for the file view, in the site's few hues:
 * one HTML string per input line, tokens wrapped in spans, every byte
 * escaped. Comments, strings, numbers and keywords only — a readable file
 * view, not a rainbow. Large inputs degrade to escaped plain text so a
 * giant blob costs one pass of escaping, never a slow tokenizer.
 */

export type Language = 'ts' | 'json' | 'css' | 'html' | 'yaml' | 'toml' | 'sh' | 'py' | 'go' | 'rs' | 'sql' | 'plain';

const TS_KEYWORDS = new Set(
  ('abstract any as asserts async await break case catch class const continue debugger declare default delete do ' +
    'else enum export extends false finally for from function get if implements import in infer instanceof is ' +
    'keyof let namespace never new null number object of out override private protected public readonly return ' +
    'satisfies set static string super switch symbol this throw true try type typeof undefined union unknown var ' +
    'void while yield').split(' '),
);
const PY_KEYWORDS = new Set(
  ('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None').split(' '),
);
const GO_KEYWORDS = new Set(
  ('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false').split(' '),
);
const RS_KEYWORDS = new Set(
  ('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while true false').split(' '),
);
const SQL_KEYWORDS = new Set(
  ('alter and as asc between by case create cross default delete desc distinct drop else end exists from full group having if in index inner insert into is join key left like limit not null offset on or order outer primary references right select set table then union unique update values view when where with true false').split(' '),
);
const SH_KEYWORDS = new Set(
  ('break case cd continue do done echo elif else esac exit export fi for function if in local return set shift then unset until while').split(' '),
);

interface LangConfig {
  lineComment: string[];
  blockComment?: [string, string];
  quotes: string[];
  multiline: Array<[string, string]>;
  keywords: Set<string>;
  /** A string or word token followed by this separator is a key/property. */
  keyAfter?: string;
  /** Words starting with @ are directives (css at-rules). */
  atWords?: boolean;
  caseInsensitive?: boolean;
  hexColors?: boolean;
}

const TS: LangConfig = {
  lineComment: ['//'],
  blockComment: ['/*', '*/'],
  quotes: ['"', "'"],
  multiline: [['`', '`']],
  keywords: TS_KEYWORDS,
};

const LANGS: Record<Exclude<Language, 'plain'>, LangConfig> = {
  ts: TS,
  json: { lineComment: [], quotes: ['"'], multiline: [], keywords: new Set(['true', 'false', 'null']), keyAfter: ':' },
  css: {
    lineComment: [],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
    multiline: [],
    keywords: new Set(),
    atWords: true,
    hexColors: true,
  },
  html: { lineComment: [], blockComment: ['<!--', '-->'], quotes: ['"', "'"], multiline: [], keywords: new Set() },
  yaml: { lineComment: ['#'], quotes: ['"', "'"], multiline: [], keywords: new Set(), keyAfter: ':' },
  toml: { lineComment: ['#', ';'], quotes: ['"', "'"], multiline: [], keywords: new Set(), keyAfter: '=' },
  sh: { lineComment: ['#'], quotes: ['"', "'"], multiline: [], keywords: SH_KEYWORDS },
  py: {
    lineComment: ['#'],
    quotes: ['"', "'"],
    multiline: [['"""', '"""'], ["'''", "'''"]],
    keywords: PY_KEYWORDS,
  },
  go: { lineComment: ['//'], blockComment: ['/*', '*/'], quotes: ['"'], multiline: [['`', '`']], keywords: GO_KEYWORDS },
  rs: { lineComment: ['//'], blockComment: ['/*', '*/'], quotes: ['"'], multiline: [], keywords: RS_KEYWORDS },
  sql: { lineComment: ['--'], blockComment: ['/*', '*/'], quotes: ["'"], multiline: [], keywords: SQL_KEYWORDS, caseInsensitive: true },
};

const EXTENSION_LANGUAGE: Record<string, Exclude<Language, 'plain'>> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts',
  json: 'json', jsonc: 'json', 'json5': 'json',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html',
  yml: 'yaml', yaml: 'yaml',
  toml: 'toml', ini: 'toml', properties: 'toml', editorconfig: 'toml',
  sh: 'sh', bash: 'sh', zsh: 'sh', command: 'sh',
  py: 'py', pyi: 'py',
  go: 'go', rs: 'rs', sql: 'sql',
};

/** The language a path's file is highlighted as; unknown extensions are plain. */
export function languageOf(path: string): Language {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  return EXTENSION_LANGUAGE[ext] ?? 'plain';
}

function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

interface Segment {
  text: string;
  cls: string | null;
}

const NUMBER_START = /[0-9]/;
const WORD_START = /[A-Za-z_$@]/;
const WORD_CHAR = /[A-Za-z0-9_$@]/;

function isBoundaryBefore(text: string, pos: number): boolean {
  // A number only starts where no word character precedes it, so `x2` stays plain.
  return pos === 0 || !WORD_CHAR.test(text[pos - 1] ?? '');
}

/** Reads one single-line string starting at `pos` (the opening delimiter). */
function readQuoted(text: string, pos: number, quote: string): number {
  let i = pos + quote.length;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '\n') return i;
    if (text.startsWith(quote, i)) return i + quote.length;
    i++;
  }
  return text.length;
}

/** Reads a multiline string's close delimiter from `pos`, honoring escapes. */
function readMultilineClose(text: string, pos: number, close: string): number {
  let i = pos;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text.startsWith(close, i)) return i + close.length;
    i++;
  }
  return text.length;
}

/**
 * Splits `text` into per-line HTML: token spans for the language's comments,
 * strings, numbers and keywords, plain escaped text everywhere else.
 */
export function highlightLines(path: string, text: string, opts: { maxBytes?: number } = {}): string[] {
  const lang = languageOf(path);
  const maxBytes = opts.maxBytes ?? 131_072;
  if (lang === 'plain' || text.length > maxBytes) {
    return text.split('\n').map(escapeText);
  }
  const cfg = LANGS[lang];
  const segments: Segment[] = [];

  const push = (text: string, cls: string | null) => {
    if (text.length === 0) return;
    const last = segments.at(-1);
    if (last && last.cls === cls) last.text += text;
    else segments.push({ text, cls });
  };

  let pos = 0;
  const keywordOf = (word: string) => {
    const probe = cfg.caseInsensitive ? word.toLowerCase() : word;
    return cfg.keywords.has(probe) || (cfg.atWords === true && word.startsWith('@'));
  };

  while (pos < text.length) {
    const lineComment = cfg.lineComment.find((p) => text.startsWith(p, pos));
    if (lineComment !== undefined) {
      const end = text.indexOf('\n', pos);
      const stop = end === -1 ? text.length : end;
      push(text.slice(pos, stop), 'tok-com');
      pos = stop;
      continue;
    }
    if (cfg.blockComment && text.startsWith(cfg.blockComment[0], pos)) {
      const end = text.indexOf(cfg.blockComment[1], pos + cfg.blockComment[0].length);
      const stop = end === -1 ? text.length : end + cfg.blockComment[1].length;
      push(text.slice(pos, stop), 'tok-com');
      pos = stop;
      continue;
    }
    const multi = cfg.multiline.find(([open]) => text.startsWith(open, pos));
    if (multi !== undefined) {
      const stop = readMultilineClose(text, pos + multi[0].length, multi[1]);
      push(text.slice(pos, stop), 'tok-str');
      pos = stop;
      continue;
    }
    const quote = cfg.quotes.find((q) => text.startsWith(q, pos));
    if (quote !== undefined) {
      const stop = readQuoted(text, pos, quote);
      const body = text.slice(pos, stop);
      const after = text.slice(stop).match(/^\s*([:=])/);
      push(body, after && cfg.keyAfter === after[1] ? 'tok-typ' : 'tok-str');
      pos = stop;
      continue;
    }
    const c = text[pos]!;
    if (NUMBER_START.test(c) && isBoundaryBefore(text, pos)) {
      let i = pos;
      if (c === '0' && /x/i.test(text[i + 1] ?? '')) {
        i += 2;
        while (i < text.length && /[0-9a-fA-F_]/.test(text[i]!)) i++;
      } else if (cfg.hexColors && c === '#') {
        // css colors are consumed below as plain `#` handling, not numbers.
        i = pos;
      } else {
        while (i < text.length && /[0-9._]/.test(text[i]!)) i++;
        if (/[eE]/.test(text[i] ?? '') && /[0-9+-]/.test(text[i + 1] ?? '')) {
          i++;
          if (/[+-]/.test(text[i]!)) i++;
          while (i < text.length && /[0-9]/.test(text[i]!)) i++;
        }
      }
      if (i > pos) {
        push(text.slice(pos, i), 'tok-num');
        pos = i;
        continue;
      }
    }
    if (cfg.hexColors && c === '#') {
      const hex = /^#[0-9a-fA-F]{3,8}\b/.exec(text.slice(pos));
      if (hex) {
        push(hex[0], 'tok-num');
        pos += hex[0].length;
        continue;
      }
    }
    if (WORD_START.test(c)) {
      let i = pos;
      while (i < text.length && WORD_CHAR.test(text[i]!)) i++;
      const word = text.slice(pos, i);
      const after = text.slice(i).match(/^\s*([:=])/);
      if (after && cfg.keyAfter === after[1]) {
        push(word, 'tok-typ');
      } else if (keywordOf(word)) {
        push(word, 'tok-key');
      } else {
        push(word, null);
      }
      pos = i;
      continue;
    }
    push(c, null);
    pos++;
  }

  // Segments carry their own newlines, so a token that spans lines splits
  // naturally: one piece list per line, each piece keeping its class.
  const linePieces: Array<Array<{ text: string; cls: string | null }>> = [[]];
  for (const seg of segments) {
    const parts = seg.text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) linePieces.push([]);
      if (parts[i] !== '') linePieces[linePieces.length - 1]!.push({ text: parts[i]!, cls: seg.cls });
    }
  }
  return linePieces.map((pieces) =>
    pieces.map((p) => (p.cls === null ? escapeText(p.text) : `<span class="${p.cls}">${escapeText(p.text)}</span>`)).join(''),
  );
}
