export type ExportKind =
  | 'function'
  | 'class'
  | 'const'
  | 'let'
  | 'var'
  | 'type'
  | 'interface'
  | 'enum'
  | 'default'
  | 'reexport'
  | 'namespace';

export interface ExportSignature {
  name: string;
  kind: ExportKind;
  signature: string;
  line: number;
}

export interface ExtractExportsResult {
  exports: ExportSignature[];
  truncated?: true;
}

export interface ExportSignatureChange {
  name: string;
  change: 'removed' | 'changed' | 'added';
  before?: string;
  after?: string;
}

const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_DECLARATION_SIGNATURE = 2 * 1024;
const REGEX_PRECEDERS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);
const DECLARATION_START = /^(?:export|declare|const|let|var|function|class|interface|type|enum|namespace|import)\b/;

function blank(char: string): string {
  return char === '\n' ? '\n' : ' ';
}

function maskSource(text: string, maskStrings: boolean): string {
  const out = text.split('');
  let i = 0;
  let last = '';
  let word = '';
  while (i < text.length) {
    const char = text[i]!;
    const next = text[i + 1];
    if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') out[i] = blank(text[i++]!);
      continue;
    }
    if (char === '/' && next === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) out[i] = blank(text[i++]!);
      if (i < text.length) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    const regex = char === '/' && next !== '/' && next !== '*' &&
      (REGEX_PRECEDERS.has(last) || (last === 'x' && REGEX_KEYWORDS.has(word)));
    if (char === '"' || char === "'" || char === '`' || regex) {
      const closing = regex ? '/' : char;
      const start = i;
      let inClass = false;
      i++;
      while (i < text.length) {
        const current = text[i]!;
        if (current === '\\' && i + 1 < text.length) {
          i += 2;
          continue;
        }
        if (current === '\n' && !regex && char !== '`') break;
        if (regex && current === '[') inClass = true;
        else if (regex && current === ']') inClass = false;
        else if (current === closing && !inClass) break;
        i++;
      }
      const end = i < text.length && text[i] === closing ? i + 1 : i;
      if (maskStrings) {
        for (let at = start + 1; at < end - 1; at++) out[at] = blank(text[at]!);
      }
      i = end;
      last = regex ? 'x' : char;
      word = '';
      continue;
    }
    if (/[\w$]/.test(char)) {
      word = last === 'x' ? word + char : char;
      last = 'x';
    } else if (!/\s/.test(char)) {
      last = char;
      word = '';
    }
    i++;
  }
  return out.join('');
}

function normalizeSignature(signature: string): string {
  return signature.replace(/\s+/g, ' ').trim().replace(/,\s*}/g, ' }').replace(/[;,]+$/, '').trim();
}

function wordAt(source: string, index: number, word: string): boolean {
  return source.startsWith(word, index) &&
    !/[\w$]/.test(source[index - 1] ?? '') &&
    !/[\w$]/.test(source[index + word.length] ?? '');
}

function skipSpace(source: string, index: number): number {
  while (index < source.length && /\s/.test(source[index]!)) index++;
  return index;
}

function lineStarts(source: string): number[] {
  const result = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') result.push(i + 1);
  return result;
}

function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid]! <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function declarationAhead(source: string, index: number): boolean {
  const next = skipSpace(source, index);
  return DECLARATION_START.test(source.slice(next, next + 16));
}

function statementEnd(source: string, start: number): number {
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  for (let i = start; i < source.length; i++) {
    const char = source[i]!;
    if (char === '{') braces++;
    else if (char === '}') braces = Math.max(0, braces - 1);
    else if (char === '(') parens++;
    else if (char === ')') parens = Math.max(0, parens - 1);
    else if (char === '[') brackets++;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
    else if (char === ';' && braces === 0 && parens === 0 && brackets === 0) return i + 1;
    else if (char === '\n' && braces === 0 && parens === 0 && brackets === 0 && declarationAhead(source, i + 1)) return i;
  }
  return source.length;
}

function functionSignatureEnd(source: string, start: number, isDts: boolean): number {
  if (isDts) return statementEnd(source, start);
  let parens = 0;
  let brackets = 0;
  let angle = 0;
  for (let i = start; i < source.length; i++) {
    const char = source[i]!;
    if (char === '(') parens++;
    else if (char === ')') parens = Math.max(0, parens - 1);
    else if (char === '[') brackets++;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
    else if (char === '<' && parens === 0) angle++;
    else if (char === '>' && parens === 0) angle = Math.max(0, angle - 1);
    else if (char === '{' && parens === 0 && brackets === 0 && angle === 0) return i;
    else if (char === ';' && parens === 0 && brackets === 0 && angle === 0) return i + 1;
    else if (char === '\n' && parens === 0 && brackets === 0 && angle === 0 && declarationAhead(source, i + 1)) return i;
  }
  return source.length;
}

function classSignatureEnd(source: string, start: number): number {
  let angle = 0;
  for (let i = start; i < source.length; i++) {
    const char = source[i]!;
    if (char === '<') angle++;
    else if (char === '>') angle = Math.max(0, angle - 1);
    else if (char === '{' && angle === 0) return i;
    else if (char === ';' && angle === 0) return i + 1;
  }
  return source.length;
}

function splitTopLevel(source: string, start: number, end: number): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = [];
  let segment = start;
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  let angles = 0;
  for (let i = start; i < end; i++) {
    const char = source[i]!;
    if (char === '{') braces++;
    else if (char === '}') braces = Math.max(0, braces - 1);
    else if (char === '(') parens++;
    else if (char === ')') parens = Math.max(0, parens - 1);
    else if (char === '[') brackets++;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
    else if (char === '<') angles++;
    else if (char === '>') angles = Math.max(0, angles - 1);
    else if (char === ',' && braces === 0 && parens === 0 && brackets === 0 && angles === 0) {
      result.push({ start: segment, end: i });
      segment = i + 1;
    }
  }
  result.push({ start: segment, end });
  return result;
}

function clauseNames(clause: string): string[] {
  return clause.split(',').map((part) => {
    const withoutType = part.trim().replace(/^type\s+/, '');
    const names = withoutType.split(/\s+as\s+/);
    return names.at(-1)?.trim() ?? '';
  }).filter(Boolean);
}

function signature(
  source: string,
  start: number,
  end: number,
  name: string,
  kind: ExportKind,
  line: number,
  cap = false,
): ExportSignature {
  const normalized = normalizeSignature(source.slice(start, end));
  return { name, kind, signature: cap ? normalized.slice(0, MAX_DECLARATION_SIGNATURE) : normalized, line };
}

function parseExport(
  path: string,
  source: string,
  masked: string,
  start: number,
  line: number,
): { entries: ExportSignature[]; end: number } | null {
  const isDts = path.toLowerCase().endsWith('.d.ts');
  let cursor = skipSpace(masked, start + 'export'.length);
  if (wordAt(masked, cursor, 'default')) {
    cursor = skipSpace(masked, cursor + 'default'.length);
    if (wordAt(masked, cursor, 'async')) cursor = skipSpace(masked, cursor + 'async'.length);
    let end: number;
    if (wordAt(masked, cursor, 'function')) {
      const nameMatch = /^function\s*\*?\s*([A-Za-z_$][\w$]*)?/.exec(masked.slice(cursor));
      const afterName = cursor + (nameMatch?.[0].length ?? 'function'.length);
      end = functionSignatureEnd(masked, afterName, isDts);
    } else if (wordAt(masked, cursor, 'class')) {
      end = classSignatureEnd(masked, cursor + 'class'.length);
    } else {
      end = statementEnd(masked, cursor);
    }
    return { entries: [signature(source, start, end, 'default', 'default', line)], end };
  }
  if (isDts && wordAt(masked, cursor, 'declare')) cursor = skipSpace(masked, cursor + 'declare'.length);
  if (wordAt(masked, cursor, 'async')) cursor = skipSpace(masked, cursor + 'async'.length);

  if (wordAt(masked, cursor, 'function')) {
    const nameMatch = /^function\s*\*?\s*([A-Za-z_$][\w$]*)?/.exec(masked.slice(cursor));
    const name = nameMatch?.[1];
    if (!name) return null;
    const end = functionSignatureEnd(masked, cursor + nameMatch[0].length, isDts);
    return { entries: [signature(source, start, end, name, 'function', line)], end };
  }
  if (wordAt(masked, cursor, 'class')) {
    const name = /^class\s+([A-Za-z_$][\w$]*)/.exec(masked.slice(cursor))?.[1];
    if (!name) return null;
    const end = classSignatureEnd(masked, cursor + 'class'.length);
    return { entries: [signature(source, start, end, name, 'class', line)], end };
  }
  const constEnum = wordAt(masked, cursor, 'const') && wordAt(masked, skipSpace(masked, cursor + 'const'.length), 'enum');
  if (constEnum) cursor = skipSpace(masked, cursor + 'const'.length);
  for (const kind of ['type', 'interface', 'enum', 'namespace'] as const) {
    if (!wordAt(masked, cursor, kind)) continue;
    const name = new RegExp(`^${kind}\\s+([A-Za-z_$][\\w$]*)`).exec(masked.slice(cursor))?.[1];
    if (!name) return null;
    const end = statementEnd(masked, cursor + kind.length);
    return { entries: [signature(source, start, end, name, kind, line, true)], end };
  }
  if (wordAt(masked, cursor, 'as') && wordAt(masked, skipSpace(masked, cursor + 2), 'namespace')) {
    const namespaceAt = skipSpace(masked, cursor + 2) + 'namespace'.length;
    const name = /^[A-Za-z_$][\w$]*/.exec(masked.slice(skipSpace(masked, namespaceAt)))?.[0];
    if (!name) return null;
    const end = statementEnd(masked, namespaceAt);
    return { entries: [signature(source, start, end, name, 'namespace', line)], end };
  }
  if (wordAt(masked, cursor, 'const') || wordAt(masked, cursor, 'let') || wordAt(masked, cursor, 'var')) {
    const kind = masked.slice(cursor).match(/^(const|let|var)\b/)?.[1] as 'const' | 'let' | 'var' | undefined;
    if (!kind) return null;
    const declarationsAt = cursor + kind.length;
    const end = statementEnd(masked, declarationsAt);
    const entries = splitTopLevel(masked, declarationsAt, end)
      .flatMap(({ start: partStart, end: partEnd }): ExportSignature[] => {
        const part = masked.slice(partStart, partEnd);
        const name = /^\s*([A-Za-z_$][\w$]*)/.exec(part)?.[1];
        if (!name) return [];
        const exportedSignature = `export ${kind} ${source.slice(partStart, partEnd)}`;
        return [{
          name,
          kind,
          signature: normalizeSignature(exportedSignature),
          line,
        }];
      });
    return entries.length ? { entries, end } : null;
  }
  if (masked[cursor] === '*') {
    const end = statementEnd(masked, cursor + 1);
    const clause = masked.slice(cursor, end);
    const namespace = /^\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause)?.[1];
    return {
      entries: [signature(source, start, end, namespace ?? '*', namespace ? 'namespace' : 'reexport', line)],
      end,
    };
  }
  if (masked[cursor] === '{') {
    const close = masked.indexOf('}', cursor + 1);
    if (close < 0) return null;
    const end = statementEnd(masked, close + 1);
    const clause = masked.slice(cursor + 1, close);
    const entries = clauseNames(clause).map((name) => signature(source, start, end, name, 'reexport', line));
    return entries.length ? { entries, end } : null;
  }
  return null;
}

export function extractExportSignatures(path: string, text: string): ExtractExportsResult {
  if (new TextEncoder().encode(text).byteLength > MAX_SOURCE_BYTES) return { exports: [], truncated: true };
  const masked = maskSource(text, true);
  const signatures = maskSource(text, false);
  const starts = lineStarts(text);
  const exports: ExportSignature[] = [];
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  for (let i = 0; i < masked.length; i++) {
    if (braces === 0 && parens === 0 && brackets === 0 && wordAt(masked, i, 'export') && masked[i - 1] !== '.') {
      const parsed = parseExport(path, signatures, masked, i, lineAt(starts, i));
      if (parsed) exports.push(...parsed.entries);
    }
    const char = masked[i]!;
    if (char === '{') braces++;
    else if (char === '}') braces = Math.max(0, braces - 1);
    else if (char === '(') parens++;
    else if (char === ')') parens = Math.max(0, parens - 1);
    else if (char === '[') brackets++;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
  }
  return { exports };
}

type ExportCollection = ExtractExportsResult | readonly ExportSignature[];

function entries(value: ExportCollection): readonly ExportSignature[] {
  return Array.isArray(value) ? value : (value as ExtractExportsResult).exports;
}

function byName(value: ExportCollection): Map<string, ExportSignature> {
  const result = new Map<string, ExportSignature>();
  for (const item of entries(value)) {
    const old = result.get(item.name);
    result.set(item.name, old
      ? { ...item, kind: old.kind, signature: normalizeSignature(`${old.signature} ${item.signature}`) }
      : item);
  }
  return result;
}

export function diffExports(base: ExportCollection, head: ExportCollection): ExportSignatureChange[] {
  const before = byName(base);
  const after = byName(head);
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: ExportSignatureChange[] = [];
  for (const name of names) {
    const old = before.get(name);
    const current = after.get(name);
    if (!current && old) changes.push({ name, change: 'removed', before: old.signature });
    else if (current && !old) changes.push({ name, change: 'added', after: current.signature });
    else if (old && current && (old.kind !== current.kind || old.signature !== current.signature)) {
      changes.push({ name, change: 'changed', before: old.signature, after: current.signature });
    }
  }
  return changes;
}
