/**
 * Content-derived risk signals: test-case counts, declared dependencies,
 * whitespace-only edits and "generated" markers. Pure and line-based; no
 * full parsers, so results are deterministic for any input.
 */

import { manifestKind } from './paths';

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

const CASE_PATTERNS = [
  // JS/TS (jest, vitest, mocha) and RSpec/minitest
  /^\s*x?(?:it|test|specify)(?:\.(?:only|skip|todo|concurrent|failing))?\s*\(/gm,
  /^\s*(?:it|test|specify)\s+['"]/gm,
  // Python
  /^\s*(?:async\s+)?def\s+test\w*\s*\(/gm,
  // Go
  /^func\s+Test\w*\s*\(/gm,
  // Rust
  /#\[(?:tokio::|async_std::)?test\]/g,
  // JUnit / TestNG / NUnit / xUnit / MSTest
  /@Test\b/g,
  /\[(?:Test|Fact|Theory|TestMethod|TestCase)\b/g,
];

const SKIP_PATTERNS = [
  /^\s*(?:it|test|specify|describe)\.(?:skip|todo)\s*\(/gm,
  /^\s*x(?:it|test|describe)\s*\(/gm,
  /^\s*@(?:pytest\.mark\.skip|unittest\.skip)\w*/gm,
  /\bt\.Skip(?:Now|f)?\s*\(/g,
  /#\[ignore\b/g,
  /@(?:Disabled|Ignore)\b/g,
  /\[Ignore\b/g,
];

function countAll(text: string, patterns: RegExp[]): number {
  let n = 0;
  for (const re of patterns) n += [...text.matchAll(re)].length;
  return n;
}

/** Declared test cases and skip/disable markers in one file. */
export function countTestCases(text: string): { cases: number; skipped: number } {
  return { cases: countAll(text, CASE_PATTERNS), skipped: countAll(text, SKIP_PATTERNS) };
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

const NPM_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function npmDeps(text: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object') return [];
  const out: string[] = [];
  for (const section of NPM_SECTIONS) {
    const deps = (doc as Record<string, unknown>)[section];
    if (deps && typeof deps === 'object' && !Array.isArray(deps)) out.push(...Object.keys(deps));
  }
  return out;
}

/** PEP 503 normalized distribution name from a PEP 508 requirement. */
function pythonName(requirement: string): string | null {
  const m = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/.exec(requirement);
  return m ? m[1]!.toLowerCase().replace(/[-_.]+/g, '-') : null;
}

function requirementsDeps(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line || line.startsWith('-')) continue;
    if (line.includes('://') && !/^[A-Za-z0-9._-]+(\[[^\]]*\])?\s*@/.test(line)) continue;
    const name = pythonName(line);
    if (name) out.push(name);
  }
  return out;
}

function goDeps(text: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (inBlock) {
      if (line.startsWith(')')) inBlock = false;
      else if (line) out.push(line.split(/\s+/)[0]!);
      continue;
    }
    if (/^require\s*\($/.test(line)) inBlock = true;
    else {
      const m = /^require\s+(\S+)\s+\S+/.exec(line);
      if (m) out.push(m[1]!);
    }
  }
  return out;
}

const CARGO_SECTION = /^(?:target\..+\.)?(?:dev-|build-)?dependencies$/;
const CARGO_TABLE = /^(?:target\..+\.)?(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/;

function cargoDeps(text: string): string[] {
  const out: string[] = [];
  let inDeps = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const section = header[1]!.trim();
      inDeps = CARGO_SECTION.test(section);
      const table = CARGO_TABLE.exec(section);
      if (table) out.push(table[1]!);
      continue;
    }
    if (!inDeps) continue;
    const key = /^([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (key) out.push(key[1]!);
  }
  return out;
}

const POETRY_SECTION = /^tool\.poetry\.(?:dependencies|dev-dependencies|group\.[^.]+\.dependencies)$/;

function quoted(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '');
}

function pyprojectDeps(text: string): string[] {
  const out: string[] = [];
  let section = '';
  let collecting = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (collecting) {
      for (const s of quoted(line)) {
        const name = pythonName(s);
        if (name) out.push(name);
      }
      if (line.includes(']')) collecting = false;
      continue;
    }
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      continue;
    }
    const arrayStart =
      (section === 'project' && /^dependencies\s*=\s*\[/.test(line)) ||
      (section === 'project.optional-dependencies' && /^[\w.-]+\s*=\s*\[/.test(line));
    if (arrayStart) {
      const rest = line.slice(line.indexOf('[') + 1);
      for (const s of quoted(rest)) {
        const name = pythonName(s);
        if (name) out.push(name);
      }
      collecting = !rest.includes(']');
      continue;
    }
    if (POETRY_SECTION.test(section)) {
      const key = /^([A-Za-z0-9._-]+)\s*=/.exec(line);
      if (key && key[1]!.toLowerCase() !== 'python') out.push(pythonName(key[1]!) ?? key[1]!);
    }
  }
  return out;
}

/**
 * Declared dependency names of a supported manifest (sorted, unique), or
 * null when `path` is not a supported manifest. Unparseable content declares
 * nothing.
 */
export function dependencyNames(path: string, text: string): string[] | null {
  const kind = manifestKind(path);
  if (!kind) return null;
  const names =
    kind === 'npm'
      ? npmDeps(text)
      : kind === 'requirements'
        ? requirementsDeps(text)
        : kind === 'go'
          ? goDeps(text)
          : kind === 'cargo'
            ? cargoDeps(text)
            : pyprojectDeps(text);
  return [...new Set(names)].sort(byteOrder);
}

// ---------------------------------------------------------------------------
// Whitespace and generated markers
// ---------------------------------------------------------------------------

/** True when two texts differ only in whitespace (spaces, tabs, newlines). */
export function isWhitespaceOnlyChange(oldText: string, newText: string): boolean {
  if (oldText === newText) return false;
  return oldText.replace(/\s+/g, '') === newText.replace(/\s+/g, '');
}

/** Characters at the start of a file searched for a "generated" marker. */
export const GENERATED_MARKER_WINDOW = 2048;
const GENERATED_MARKER = /@generated\b|\bcode generated\b|\bdo not edit\b|\bauto-?generated\b|\bautomatically generated\b/i;

export function hasGeneratedMarker(text: string): boolean {
  return GENERATED_MARKER.test(text.slice(0, GENERATED_MARKER_WINDOW));
}

export function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
