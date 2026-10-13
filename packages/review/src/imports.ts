export interface ReviewImport {
  specifier: string;
  line: number;
  names?: string[];
  typeOnly?: boolean;
}

const RELATIVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.d.ts'] as const;

function blank(char: string): string {
  return char === '\n' ? '\n' : ' ';
}

function maskCode(text: string): string {
  const out = text.split('');
  for (let i = 0; i < text.length;) {
    const char = text[i]!;
    if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') out[i] = blank(text[i++]!);
      continue;
    }
    if (char === '/' && text[i + 1] === '*') {
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
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      const start = i++;
      while (i < text.length) {
        if (text[i] === '\\' && i + 1 < text.length) {
          i += 2;
          continue;
        }
        if (text[i] === '\n' && quote !== '`') break;
        if (text[i] === quote) break;
        i++;
      }
      const end = i < text.length && text[i] === quote ? i + 1 : i;
      for (let at = start + 1; at < end - 1; at++) out[at] = blank(text[at]!);
      i = end;
      continue;
    }
    i++;
  }
  return out.join('');
}

function wordAt(text: string, index: number, word: string): boolean {
  return text.startsWith(word, index) &&
    !/[\w$]/.test(text[index - 1] ?? '') &&
    !/[\w$]/.test(text[index + word.length] ?? '');
}

function skipSpace(text: string, index: number): number {
  while (index < text.length && /\s/.test(text[index]!)) index++;
  return index;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle]! <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function stringAt(masked: string, source: string, start: number): { specifier: string; end: number } | null {
  const quote = masked[start];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let i = start + 1;
  while (i < masked.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (masked[i] === quote) {
      const value = source.slice(start + 1, i);
      if (quote === '`' && value.includes('${')) return null;
      return { specifier: value, end: i + 1 };
    }
    i++;
  }
  return null;
}

function importedNames(clause: string): string[] | undefined {
  const trimmed = clause.trim().replace(/^type\s+/, '');
  if (!trimmed) return undefined;
  const result: string[] = [];
  const named = /\{([^}]*)\}/.exec(trimmed);
  const outside = named ? trimmed.replace(named[0], ' ') : trimmed;
  for (const part of outside.split(',')) {
    const value = part.trim();
    if (!value) continue;
    if (value.startsWith('*')) result.push('*');
    else if (/^[A-Za-z_$][\w$]*$/.test(value)) result.push('default');
  }
  if (named) {
    for (const part of named[1]!.split(',')) {
      const value = part.trim().replace(/^type\s+/, '');
      const original = value.split(/\s+as\s+/)[0]?.trim();
      if (original) result.push(original);
    }
  }
  return result.length ? result : undefined;
}

function findFromSpecifier(
  masked: string,
  source: string,
  start: number,
): { specifier: string; quoteStart: number; end: number } | null {
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  for (let i = start; i < masked.length; i++) {
    const char = masked[i]!;
    if (char === '{') braces++;
    else if (char === '}') braces = Math.max(0, braces - 1);
    else if (char === '(') parens++;
    else if (char === ')') parens = Math.max(0, parens - 1);
    else if (char === '[') brackets++;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
    else if (char === ';' && braces === 0 && parens === 0 && brackets === 0) return null;
    if (braces || parens || brackets || !wordAt(masked, i, 'from')) continue;
    const quoteStart = skipSpace(masked, i + 'from'.length);
    const literal = stringAt(masked, source, quoteStart);
    if (literal) return { specifier: literal.specifier, quoteStart, end: literal.end };
  }
  return null;
}

function callSpecifier(masked: string, source: string, openParen: number): string | null {
  const literal = stringAt(masked, source, skipSpace(masked, openParen + 1));
  if (!literal) return null;
  const after = skipSpace(masked, literal.end);
  return masked[after] === ')' || masked[after] === ',' ? literal.specifier : null;
}

function relativePath(fromPath: string, specifier: string): string | null {
  if (!(specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../'))) return null;
  const segments = fromPath.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments.join('/');
}

export function extractImports(text: string): ReviewImport[] {
  const masked = maskCode(text);
  const starts = lineStarts(text);
  const found: Array<ReviewImport & { at: number }> = [];
  for (let i = 0; i < masked.length; i++) {
    if (wordAt(masked, i, 'import') && masked[i - 1] !== '.') {
      const afterKeyword = skipSpace(masked, i + 'import'.length);
      if (masked[afterKeyword] === '.') continue;
      if (masked[afterKeyword] === '(') {
        const specifier = callSpecifier(masked, text, afterKeyword);
        if (specifier !== null) found.push({ specifier, line: lineAt(starts, i), at: i });
        continue;
      }
      if (masked[afterKeyword] === "'" || masked[afterKeyword] === '"' || masked[afterKeyword] === '`') {
        const literal = stringAt(masked, text, afterKeyword);
        if (literal) found.push({ specifier: literal.specifier, line: lineAt(starts, i), at: i });
        continue;
      }
      let clauseStart = afterKeyword;
      let typeOnly = false;
      if (wordAt(masked, clauseStart, 'type')) {
        typeOnly = true;
        clauseStart = skipSpace(masked, clauseStart + 'type'.length);
      }
      const foundFrom = findFromSpecifier(masked, text, clauseStart);
      if (foundFrom) {
        const clause = masked.slice(clauseStart, masked.lastIndexOf('from', foundFrom.quoteStart));
        const names = importedNames(clause);
        found.push({
          specifier: foundFrom.specifier,
          line: lineAt(starts, i),
          ...(names ? { names } : {}),
          ...(typeOnly ? { typeOnly: true } : {}),
          at: i,
        });
      }
      continue;
    }
    if (wordAt(masked, i, 'require') && masked[i - 1] !== '.') {
      const openParen = skipSpace(masked, i + 'require'.length);
      if (masked[openParen] !== '(') continue;
      const specifier = callSpecifier(masked, text, openParen);
      if (specifier !== null) found.push({ specifier, line: lineAt(starts, i), at: i });
      continue;
    }
    if (wordAt(masked, i, 'export') && masked[i - 1] !== '.') {
      let clauseStart = skipSpace(masked, i + 'export'.length);
      let typeOnly = false;
      if (wordAt(masked, clauseStart, 'type')) {
        typeOnly = true;
        clauseStart = skipSpace(masked, clauseStart + 'type'.length);
      }
      if (masked[clauseStart] !== '{' && masked[clauseStart] !== '*') continue;
      const foundFrom = findFromSpecifier(masked, text, clauseStart);
      if (!foundFrom) continue;
      const names = masked[clauseStart] === '*'
        ? ['*']
        : importedNames(`{${masked.slice(clauseStart + 1, masked.indexOf('}', clauseStart))}}`);
      found.push({
        specifier: foundFrom.specifier,
        line: lineAt(starts, i),
        ...(names ? { names } : {}),
        ...(typeOnly ? { typeOnly: true } : {}),
        at: i,
      });
    }
  }
  found.sort((a, b) => a.at - b.at);
  return found.map(({ at: _at, ...item }) => item);
}

export function resolveSpecifier(
  fromPath: string,
  specifier: string,
  files: ReadonlySet<string>,
  workspaces: ReadonlyMap<string, string>,
): string | null {
  const workspace = [...workspaces.keys()]
    .filter((name) => specifier === name || specifier.startsWith(`${name}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (workspace) {
    const entry = workspaces.get(workspace)!;
    return files.has(entry) ? entry : null;
  }

  const exact = relativePath(fromPath, specifier);
  if (exact === null) return null;
  if (files.has(exact)) return exact;
  const extension = RELATIVE_EXTENSIONS.find((item) => exact.endsWith(item));
  const base = extension ? exact.slice(0, -extension.length) : exact;
  if (base) {
    for (const item of RELATIVE_EXTENSIONS) {
      const candidate = `${base}${item}`;
      if (files.has(candidate)) return candidate;
    }
  }
  for (const item of RELATIVE_EXTENSIONS) {
    const candidate = `${exact ? `${exact.replace(/\/$/, '')}/` : ''}index${item}`;
    if (files.has(candidate)) return candidate;
  }
  return null;
}
