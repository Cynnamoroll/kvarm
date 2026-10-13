/**
 * Semantic dependency signal for the Nexus forecast (architecture §11.2): a
 * bounded, deterministic reading of module imports, exported names and
 * contract files. It is a heuristic, not a compiler or a model:
 *  - imports are found by regular expressions over source text whose
 *    comments and string contents are masked first, so commented-out imports
 *    and import-like text inside strings do not count;
 *  - only relative TS/JS specifiers, Python modules (relative, or absolute
 *    under the repo root, `src/` or the file's top-level directory) and Go
 *    import paths inside the nearest `go.mod` module resolve to repo paths;
 *    bare package names, tsconfig path aliases, workspace package names,
 *    computed `require`/`import()` arguments and re-export chains through
 *    `export *` are not followed;
 *  - a Go import resolves to its package directory (a trailing `/`), whose
 *    own imports are not read;
 *  - exported names cover declarations, `export { … }`, `export * as`,
 *    `export default` and CommonJS `exports.x =`; destructured exports and
 *    names re-exported by `export *` are not listed.
 * Every walk is bounded by blob, tree, byte and time budgets and says so in
 * `reasons` when one bites. An empty result is not proof of independence.
 */

export const SEMANTIC_LIMITS = {
  /** Import hops followed from a changed file (1: what it imports directly). */
  depthMax: 2,
  /** Changed source files whose imports are read, first by path. */
  sourceFilesMax: 40,
  blobReadsMax: 96,
  treeReadsMax: 96,
  /** Bytes of source read per analysis. */
  bytesMax: 4 * 1024 * 1024,
  /** Larger files are not parsed. */
  fileBytesMax: 256 * 1024,
  timeMs: 1_500,
  /** Distinct import targets recorded per analysis. */
  edgesMax: 300,
  importsPerFileMax: 200,
  /** Changed TS/JS files whose export surface is compared base→head. */
  exportsCompareMax: 24,
  /** Exported names kept per side of one comparison. */
  exportNamesMax: 50,
  contractsMax: 50,
} as const;

export type SemanticLimits = { -readonly [K in keyof typeof SEMANTIC_LIMITS]: number };

export type SourceLanguage = 'js' | 'py' | 'go';

export interface ImportSpec {
  /** The specifier as written (`./util`, `..pkg.mod`, `example.com/m/pkg`). */
  spec: string;
  /** Names imported from it, where the syntax lists them (`default`, `*` included). */
  names?: string[];
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The directory of a path with its trailing `/` (`''` at the root). */
function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/') + 1);
}

export function languageOf(path: string): SourceLanguage | null {
  const name = basename(path).toLowerCase();
  if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(name)) return 'js';
  if (name.endsWith('.py')) return 'py';
  if (name.endsWith('.go')) return 'go';
  return null;
}

// ---------------------------------------------------------------------------
// Masking: comments become spaces, string contents become spaces (quotes kept)
// ---------------------------------------------------------------------------

/** Characters after which a `/` in JS starts a regex literal rather than a division. */
const REGEX_PRECEDERS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

function blank(ch: string): string {
  return ch === '\n' ? '\n' : ' ';
}

/**
 * Same-length text with comments and string/regex contents blanked, so
 * offsets map back to the original. Template literals are masked whole,
 * `${…}` included (a nested template inside one is a documented gap).
 */
function maskSource(text: string, lang: SourceLanguage): string {
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  let last = '';
  const hash = lang === 'py';
  const slashes = lang !== 'py';
  while (i < n) {
    const c = text[i]!;
    const d = text[i + 1];
    if (slashes && c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') out.push(blank(text[i++]!));
      continue;
    }
    if (slashes && c === '/' && d === '*') {
      out.push('  ');
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) out.push(blank(text[i++]!));
      if (i < n) {
        out.push('  ');
        i += 2;
      }
      continue;
    }
    if (hash && c === '#') {
      while (i < n && text[i] !== '\n') out.push(blank(text[i++]!));
      continue;
    }
    if (lang === 'py' && (c === '"' || c === "'") && text[i + 1] === c && text[i + 2] === c) {
      out.push(c, c, c);
      i += 3;
      while (i < n && !(text[i] === c && text[i + 1] === c && text[i + 2] === c)) {
        if (text[i] === '\\' && i + 1 < n) {
          out.push(' ', blank(text[i + 1]!));
          i += 2;
          continue;
        }
        out.push(blank(text[i++]!));
      }
      if (i < n) {
        out.push(c, c, c);
        i += 3;
      }
      last = c;
      continue;
    }
    const isRegex = lang === 'js' && c === '/' && REGEX_PRECEDERS.has(last);
    if (c === '"' || c === "'" || c === '`' || isRegex) {
      const close = c;
      const multiline = c === '`';
      out.push(c);
      i++;
      let inClass = false;
      while (i < n) {
        const e = text[i]!;
        if (e === '\\' && i + 1 < n) {
          out.push(' ', blank(text[i + 1]!));
          i += 2;
          continue;
        }
        if (e === '\n' && !multiline) break;
        if (isRegex && e === '[') inClass = true;
        else if (isRegex && e === ']') inClass = false;
        else if (e === close && !inClass) break;
        out.push(blank(e));
        i++;
      }
      if (i < n && text[i] === close) {
        out.push(close);
        i++;
      }
      last = close;
      continue;
    }
    out.push(c);
    if (!/\s/.test(c)) last = /[\w$]/.test(c) ? 'x' : c;
    i++;
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const NOT_MEMBER = '(?<![\\w$.])';
const JS_IMPORT_FROM = new RegExp(`${NOT_MEMBER}import\\s+(?:type\\s+)?([\\w$*{}\\s,]+?)\\s*\\bfrom\\s*(['"])( *)\\2`, 'dg');
const JS_IMPORT_BARE = new RegExp(`${NOT_MEMBER}import\\s*(['"])( *)\\1`, 'dg');
const JS_EXPORT_FROM = new RegExp(`${NOT_MEMBER}export\\s+(?:type\\s+)?(\\*(?:\\s*as\\s+[\\w$]+)?|\\{[^}]*\\})\\s*from\\s*(['"])( *)\\2`, 'dg');
const JS_REQUIRE = new RegExp(`${NOT_MEMBER}require\\s*\\(\\s*(['"])( *)\\1\\s*\\)`, 'dg');
const JS_DYNAMIC = new RegExp(`${NOT_MEMBER}import\\s*\\(\\s*(['"\`])( *)\\1\\s*\\)`, 'dg');

/** Source names of an import clause (`D, { a, b as c }` → default, a, b; `* as ns` → *). */
function clauseNames(clause: string): string[] {
  const names: string[] = [];
  const braced = /\{([^}]*)\}/.exec(clause);
  const outside = braced ? clause.replace(braced[0], ' ') : clause;
  for (const part of outside.split(',')) {
    const t = part.trim();
    if (!t) continue;
    if (t.startsWith('*')) names.push('*');
    else if (/^[\w$]+$/.test(t) && t !== 'type') names.push('default');
  }
  if (braced) {
    for (const part of braced[1]!.split(',')) {
      const t = part.trim().replace(/^type\s+/, '');
      const name = t.split(/\s+as\s+/)[0]?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

function sliceGroup(text: string, m: RegExpExecArray, group: number): string {
  const at = m.indices?.[group];
  return at ? text.slice(at[0], at[1]) : '';
}

type Found = ImportSpec & { at: number };

function jsImports(text: string, masked: string): Found[] {
  const found: Found[] = [];
  const push = (m: RegExpExecArray, group: number, names?: string[]) => {
    const spec = sliceGroup(text, m, group);
    if (spec && !spec.includes('${')) found.push({ spec, at: m.index, ...(names && names.length > 0 ? { names } : {}) });
  };
  for (const m of masked.matchAll(JS_IMPORT_FROM)) push(m, 3, clauseNames(m[1]!));
  for (const m of masked.matchAll(JS_IMPORT_BARE)) push(m, 2);
  for (const m of masked.matchAll(JS_EXPORT_FROM)) push(m, 3, m[1]!.startsWith('*') ? ['*'] : clauseNames(m[1]!));
  for (const m of masked.matchAll(JS_REQUIRE)) push(m, 2);
  for (const m of masked.matchAll(JS_DYNAMIC)) push(m, 2);
  return found;
}

const PY_FROM = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)/gm;
const PY_IMPORT = /^[ \t]*import[ \t]+([^\n]+)/gm;

function pyImports(masked: string): Found[] {
  const found: Found[] = [];
  for (const m of masked.matchAll(PY_FROM)) {
    const names = m[2]!
      .replace(/[()]/g, ' ')
      .split(',')
      .map((p) => p.trim().split(/\s+as\s+/)[0]!.trim())
      .filter((p) => /^[\w*]+$/.test(p));
    found.push({ spec: m[1]!, at: m.index, ...(names.length > 0 ? { names } : {}) });
  }
  for (const m of masked.matchAll(PY_IMPORT)) {
    let off = 0;
    for (const part of m[1]!.split(',')) {
      const mod = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (/^[\w.]+$/.test(mod)) found.push({ spec: mod, at: m.index + off });
      off += part.length + 1;
    }
  }
  return found;
}

const GO_SINGLE = /(?<![\w.])import[ \t]+(?:[\w.]+[ \t]+)?"( *)"/dg;
const GO_GROUP = /(?<![\w.])import[ \t]*\(([^)]*)\)/dg;
const GO_PATH = /"( *)"/g;

function goImports(text: string, masked: string): Found[] {
  const found: Found[] = [];
  for (const m of masked.matchAll(GO_SINGLE)) {
    const spec = sliceGroup(text, m, 1);
    if (spec) found.push({ spec, at: m.index });
  }
  for (const m of masked.matchAll(GO_GROUP)) {
    const start = m.indices![1]![0];
    for (const p of m[1]!.matchAll(GO_PATH)) {
      const from = start + p.index + 1;
      const spec = text.slice(from, from + p[1]!.length);
      if (spec) found.push({ spec, at: from });
    }
  }
  return found;
}

/** The import specifiers of one file, in source order. */
export function extractImports(path: string, text: string): { specs: ImportSpec[] } {
  const lang = languageOf(path);
  if (!lang) return { specs: [] };
  const masked = maskSource(text, lang);
  const found = lang === 'js' ? jsImports(text, masked) : lang === 'py' ? pyImports(masked) : goImports(text, masked);
  found.sort((a, b) => a.at - b.at);
  return { specs: found.map(({ at: _at, ...s }) => s) };
}

const JS_EXPORT_DECL = new RegExp(
  `${NOT_MEMBER}export\\s+(?:declare\\s+)?(default\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\s*\\*?|class|const|let|var|interface|type|enum|namespace|module)\\s+([A-Za-z_$][\\w$]*)`,
  'g',
);
const JS_EXPORT_DEFAULT = new RegExp(`${NOT_MEMBER}export\\s+(?:default\\b|=)`, 'g');
const JS_EXPORT_LIST = new RegExp(`${NOT_MEMBER}export\\s+(?:type\\s+)?\\{([^}]*)\\}`, 'g');
const JS_EXPORT_STAR_AS = new RegExp(`${NOT_MEMBER}export\\s*\\*\\s*as\\s+([\\w$]+)`, 'g');
const CJS_EXPORT = new RegExp(`${NOT_MEMBER}(?:module\\.)?exports\\.([A-Za-z_$][\\w$]*)\\s*=(?!=)`, 'g');
const CJS_EXPORT_DEFAULT = new RegExp(`${NOT_MEMBER}module\\.exports\\s*=(?!=)`, 'g');

/** The names a TS/JS module exports, sorted (`default` for a default export). */
export function extractExports(text: string): string[] {
  const masked = maskSource(text, 'js');
  const names = new Set<string>();
  for (const m of masked.matchAll(JS_EXPORT_DECL)) names.add(m[1] ? 'default' : m[2]!);
  for (const _ of masked.matchAll(JS_EXPORT_DEFAULT)) names.add('default');
  for (const m of masked.matchAll(JS_EXPORT_LIST)) {
    for (const part of m[1]!.split(',')) {
      const t = part.trim().replace(/^type\s+/, '');
      if (!t) continue;
      const pieces = t.split(/\s+as\s+/);
      const name = (pieces[1] ?? pieces[0])!.trim();
      if (/^[\w$]+$/.test(name)) names.add(name);
    }
  }
  for (const m of masked.matchAll(JS_EXPORT_STAR_AS)) names.add(m[1]!);
  for (const m of masked.matchAll(CJS_EXPORT)) names.add(m[1]!);
  for (const _ of masked.matchAll(CJS_EXPORT_DEFAULT)) names.add('default');
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Joins `rel` onto directory `dir` (`''` or ending in `/`); null when it climbs above the root. */
function joinPath(dir: string, rel: string): string | null {
  const segs = dir.split('/').filter((s) => s !== '');
  for (const s of rel.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (segs.length === 0) return null;
      segs.pop();
    } else segs.push(s);
  }
  return segs.length === 0 ? null : segs.join('/');
}

const JS_SWAPS: Record<string, string[]> = { js: ['ts', 'tsx', 'mts', 'cts'], jsx: ['tsx'], mjs: ['mts'], cjs: ['cts'] };
const JS_KNOWN_EXT = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'css', 'scss', 'svg', 'wasm']);
const JS_TRY_EXT = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
const JS_INDEX = ['index.ts', 'index.tsx', 'index.d.ts', 'index.js', 'index.jsx', 'index.mjs'];

/**
 * Candidate repo paths for one import of `from`, in the order a resolver
 * would try them; empty for anything that is not resolved inside the repo
 * (bare packages, aliases, Go — see `goImportTarget`).
 */
export function resolveCandidates(from: string, spec: string, lang: SourceLanguage, names: readonly string[] = []): string[] {
  const dir = dirOf(from);
  if (lang === 'js') {
    if (!(spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../'))) return [];
    const p = joinPath(dir, spec);
    if (p === null) return [];
    if (spec.endsWith('/') || spec === '.' || spec === '..') return JS_INDEX.map((i) => `${p}/${i}`);
    const name = basename(p);
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1) : '';
    if (JS_SWAPS[ext]) return [p, ...JS_SWAPS[ext]!.map((e) => `${p.slice(0, p.length - ext.length)}${e}`)];
    if (JS_KNOWN_EXT.has(ext)) return [p];
    return [p, ...JS_TRY_EXT.map((e) => p + e), ...JS_INDEX.map((i) => `${p}/${i}`)];
  }
  if (lang === 'py') {
    const dots = /^\.*/.exec(spec)![0].length;
    const mod = spec.slice(dots).replace(/\./g, '/');
    const forms = (base: string) => [`${base}.py`, `${base}/__init__.py`];
    if (dots > 0) {
      let up = dir;
      for (let i = 1; i < dots; i++) {
        const parent = joinPath(up, '..');
        if (parent === null) return [];
        up = `${parent}/`;
      }
      if (mod) return forms(`${up}${mod}`);
      return [...names.filter((n) => n !== '*').flatMap((n) => forms(`${up}${n}`)), `${up}__init__.py`];
    }
    if (!mod) return [];
    const top = from.includes('/') ? `${from.slice(0, from.indexOf('/'))}/` : '';
    return [...new Set(['', 'src/', top])].flatMap((root) => forms(`${root}${mod}`));
  }
  return [];
}

/** The repo directory (trailing `/`) a Go import names inside module `module` rooted at `dir`; null outside it. */
export function goImportTarget(spec: string, mod: { module: string; dir: string }): string | null {
  if (spec === mod.module) return mod.dir === '' ? null : mod.dir;
  if (!spec.startsWith(`${mod.module}/`)) return null;
  return `${mod.dir}${spec.slice(mod.module.length + 1)}/`;
}

// ---------------------------------------------------------------------------
// Contract files
// ---------------------------------------------------------------------------

const MIGRATION_DIRS = new Set(['migrations', 'migrate']);

/**
 * The API family of a contract file, by path convention: the contract kind
 * and its directory, so two workspaces editing different files of one schema
 * set (two protos of a package, two migrations of one sequence) meet.
 * null for anything else.
 */
export function contractFamily(path: string): string | null {
  const name = basename(path).toLowerCase();
  const dir = dirOf(path);
  const parent = basename(dir.slice(0, -1)).toLowerCase();
  if (name.endsWith('.proto')) return `proto:${dir}`;
  if (name.endsWith('.thrift')) return `thrift:${dir}`;
  if (name.endsWith('.avsc')) return `avro:${dir}`;
  if (/^(?:openapi|swagger)(?:[-._][\w.-]*)?\.(?:ya?ml|json)$/.test(name)) return `openapi:${dir}`;
  if (/\.(?:graphql|graphqls|gql)$/.test(name)) return `graphql:${dir}`;
  if (name.endsWith('.schema.json')) return `jsonschema:${dir}`;
  if (name.endsWith('.d.ts')) return `dts:${dir}`;
  if (dir !== '' && MIGRATION_DIRS.has(parent)) return `migrations:${dir}`;
  return null;
}

// ---------------------------------------------------------------------------
// Bounded analysis over a git tree
// ---------------------------------------------------------------------------

export interface SemanticTreeEntry {
  name: string;
  mode: string;
  hash: string;
}

export type SemanticBlob = { bytes: Uint8Array } | { tooLarge: true } | null;

/** Reads trees and blobs by hash (Artifacts in the platform, memory in tests). */
export interface SemanticTreeSource {
  readTree(hash: string): Promise<SemanticTreeEntry[] | null>;
  readBlob(hash: string, maxBytes: number): Promise<SemanticBlob>;
}

export interface DependencyEdge {
  /** The imported repo path, or a Go package directory (trailing `/`). */
  target: string;
  depth: number;
  /** From a changed file through each imported module to `target`. */
  chain: string[];
  /** Names the last hop imports, where its syntax lists them. */
  names?: string[];
}

export interface ExportChange {
  path: string;
  added: string[];
  removed: string[];
}

export interface DependencyAnalysis {
  edges: DependencyEdge[];
  exportChanges: ExportChange[];
  contracts: Array<{ family: string; path: string }>;
  reads: { blobs: number; trees: number; bytes: number };
  truncated: boolean;
  reasons: string[];
}

export interface DependencyInput {
  headTree: string;
  /** The base tree, for export-surface comparison; omitted: no comparison. */
  baseTree?: string | null;
  /** Changed repo paths (the observed set before any prefix collapse). */
  changed: readonly string[];
  limits?: Partial<SemanticLimits>;
  clock?: () => number;
}

const TREE_MODE = /^0?40000$/;
const GITLINK = '160000';
const REASONS_MAX = 8;

class Walk {
  readonly reads = { blobs: 0, trees: 0, bytes: 0 };
  private readonly reasons = new Set<string>();
  private readonly dirs = new Map<string, Promise<Map<string, SemanticTreeEntry> | null>>();
  private readonly texts = new Map<string, Promise<string | null>>();
  private readonly started: number;
  stopped = false;

  constructor(
    private readonly source: SemanticTreeSource,
    readonly limits: SemanticLimits,
    private readonly clock: () => number,
  ) {
    this.started = clock();
  }

  note(reason: string): void {
    this.reasons.add(reason);
  }

  allReasons(): string[] {
    const all = [...this.reasons];
    if (all.length <= REASONS_MAX) return all;
    return [...all.slice(0, REASONS_MAX), `and ${all.length - REASONS_MAX} more`];
  }

  /** False (and records why) once any budget is spent; every later read is refused too. */
  private admit(kind: 'blob' | 'tree'): boolean {
    if (this.stopped) return false;
    const L = this.limits;
    if (this.clock() - this.started > L.timeMs) {
      this.stop(`time budget of ${L.timeMs} ms spent; dependencies beyond it are not reported`);
    } else if (kind === 'tree' && this.reads.trees >= L.treeReadsMax) {
      this.stop(`tree read budget of ${L.treeReadsMax} spent; dependencies beyond it are not reported`);
    } else if (kind === 'blob' && this.reads.blobs >= L.blobReadsMax) {
      this.stop(`blob read budget of ${L.blobReadsMax} spent; dependencies beyond it are not reported`);
    } else if (this.reads.bytes >= L.bytesMax) {
      this.stop(`byte budget of ${L.bytesMax} spent; dependencies beyond it are not reported`);
    }
    return !this.stopped;
  }

  private stop(reason: string): void {
    this.stopped = true;
    this.note(reason);
  }

  /** Entries of directory `dir` (`''` or ending in `/`) under `root`. */
  dir(root: string, dir: string): Promise<Map<string, SemanticTreeEntry> | null> {
    const key = `${root}\0${dir}`;
    let p = this.dirs.get(key);
    if (!p) {
      p = this.loadDir(root, dir);
      this.dirs.set(key, p);
    }
    return p;
  }

  private async loadDir(root: string, dir: string): Promise<Map<string, SemanticTreeEntry> | null> {
    let hash = root;
    if (dir !== '') {
      const parent = dirOf(dir.slice(0, -1));
      const entries = await this.dir(root, parent);
      const e = entries?.get(basename(dir.slice(0, -1)));
      if (!e || !TREE_MODE.test(e.mode)) return null;
      hash = e.hash;
    }
    if (!this.admit('tree')) return null;
    this.reads.trees++;
    const list = await this.source.readTree(hash);
    return list ? new Map(list.map((e) => [e.name, e])) : null;
  }

  async file(root: string, path: string): Promise<SemanticTreeEntry | null> {
    const e = (await this.dir(root, dirOf(path)))?.get(basename(path));
    return e && !TREE_MODE.test(e.mode) && e.mode !== GITLINK ? e : null;
  }

  /** The text of `path` under `root`; null when absent, binary, too large or past a budget. */
  text(root: string, path: string): Promise<string | null> {
    const key = `${root}\0${path}`;
    let p = this.texts.get(key);
    if (!p) {
      p = this.loadText(root, path);
      this.texts.set(key, p);
    }
    return p;
  }

  private async loadText(root: string, path: string): Promise<string | null> {
    const e = await this.file(root, path);
    if (!e || !this.admit('blob')) return null;
    this.reads.blobs++;
    const blob = await this.source.readBlob(e.hash, this.limits.fileBytesMax);
    if (!blob) return null;
    if ('tooLarge' in blob) {
      this.note(`${path} is larger than ${this.limits.fileBytesMax} bytes; it is not parsed`);
      return null;
    }
    this.reads.bytes += blob.bytes.length;
    if (blob.bytes.subarray(0, 8000).includes(0)) return null;
    return new TextDecoder('utf-8').decode(blob.bytes);
  }
}

/**
 * Import edges out of the changed files (up to `depthMax` hops, breadth
 * first, in path order so a truncated result is still deterministic), the
 * export-surface changes of changed TS/JS modules, and the changed contract
 * files. Reads run one at a time so the budgets cut at a stable point.
 */
export async function analyzeDependencies(source: SemanticTreeSource, input: DependencyInput): Promise<DependencyAnalysis> {
  const limits: SemanticLimits = { ...SEMANTIC_LIMITS, ...input.limits };
  const w = new Walk(source, limits, input.clock ?? Date.now);
  const changed = [...new Set(input.changed)].sort();

  const contracts: DependencyAnalysis['contracts'] = [];
  for (const path of changed) {
    const family = contractFamily(path);
    if (!family) continue;
    if (contracts.length >= limits.contractsMax) {
      w.note(`more than ${limits.contractsMax} changed contract files; the first ${limits.contractsMax} by path are recorded`);
      break;
    }
    contracts.push({ family, path });
  }

  let sources = changed.filter((p) => languageOf(p) !== null);
  if (sources.length > limits.sourceFilesMax) {
    w.note(`more than ${limits.sourceFilesMax} changed source files; the first ${limits.sourceFilesMax} by path are analyzed`);
    sources = sources.slice(0, limits.sourceFilesMax);
  }

  const goModules = new Map<string, Promise<{ module: string; dir: string } | null>>();
  const goModuleOf = (dir: string): Promise<{ module: string; dir: string } | null> => {
    let p = goModules.get(dir);
    if (!p) {
      p = (async () => {
        const text = (await w.dir(input.headTree, dir))?.has('go.mod') ? await w.text(input.headTree, `${dir}go.mod`) : null;
        const m = text ? /^\s*module\s+(\S+)/m.exec(text) : null;
        if (m) return { module: m[1]!.replace(/^"|"$/g, ''), dir };
        return dir === '' ? null : goModuleOf(dirOf(dir.slice(0, -1)));
      })();
      goModules.set(dir, p);
    }
    return p;
  };

  /** Resolved targets of `path`'s imports at head, with the names each hop imports. */
  const importsOf = async (path: string): Promise<Array<{ target: string; names?: string[] }>> => {
    const lang = languageOf(path);
    if (!lang) return [];
    const text = await w.text(input.headTree, path);
    if (text === null) return [];
    let specs = extractImports(path, text).specs;
    if (specs.length > limits.importsPerFileMax) {
      w.note(`more than ${limits.importsPerFileMax} imports in ${path}; the first ${limits.importsPerFileMax} are read`);
      specs = specs.slice(0, limits.importsPerFileMax);
    }
    const out: Array<{ target: string; names?: string[] }> = [];
    for (const s of specs) {
      if (w.stopped) break;
      let target: string | null = null;
      if (lang === 'go') {
        const mod = await goModuleOf(dirOf(path));
        target = mod ? goImportTarget(s.spec, mod) : null;
      } else {
        for (const c of resolveCandidates(path, s.spec, lang, s.names)) {
          if (await w.file(input.headTree, c)) {
            target = c;
            break;
          }
          if (w.stopped) break;
        }
      }
      if (target !== null && target !== path) out.push({ target, ...(s.names ? { names: s.names } : {}) });
    }
    return out;
  };

  const edges = new Map<string, DependencyEdge>();
  let edgesFull = false;
  let frontier: Array<{ path: string; chain: string[] }> = sources.map((p) => ({ path: p, chain: [p] }));
  const expanded = new Set<string>();
  for (let depth = 1; depth <= limits.depthMax && frontier.length > 0 && !w.stopped; depth++) {
    const next: typeof frontier = [];
    for (const f of frontier) {
      if (w.stopped) break;
      if (expanded.has(f.path) || f.path.endsWith('/')) continue;
      expanded.add(f.path);
      for (const imp of await importsOf(f.path)) {
        if (f.chain.includes(imp.target)) continue;
        if (edges.has(imp.target)) continue;
        if (edges.size >= limits.edgesMax) {
          edgesFull = true;
          continue;
        }
        const chain = [...f.chain, imp.target];
        edges.set(imp.target, { target: imp.target, depth, chain, ...(imp.names ? { names: imp.names } : {}) });
        next.push({ path: imp.target, chain });
      }
    }
    frontier = next;
  }
  if (edgesFull) w.note(`more than ${limits.edgesMax} dependency edges; the rest are not recorded`);

  const exportChanges: ExportChange[] = [];
  if (input.baseTree) {
    let compared = 0;
    for (const path of sources) {
      if (languageOf(path) !== 'js' || w.stopped) continue;
      if (compared >= limits.exportsCompareMax) {
        w.note(`more than ${limits.exportsCompareMax} changed modules; export surfaces beyond the first ${limits.exportsCompareMax} are not compared`);
        break;
      }
      const baseText = await w.text(input.baseTree, path);
      if (baseText === null) continue;
      compared++;
      // A module deleted at head removed every export; one present but unreadable is not compared.
      const present = await w.file(input.headTree, path);
      const headText = present ? await w.text(input.headTree, path) : '';
      if (w.stopped) break;
      if (headText === null) continue;
      const before = new Set(extractExports(baseText));
      const after = new Set(extractExports(headText));
      const added = [...after].filter((n) => !before.has(n)).slice(0, limits.exportNamesMax);
      const removed = [...before].filter((n) => !after.has(n)).slice(0, limits.exportNamesMax);
      if (added.length > 0 || removed.length > 0) exportChanges.push({ path, added, removed });
    }
  }

  const reasons = w.allReasons();
  return {
    edges: [...edges.values()],
    exportChanges,
    contracts,
    reads: { ...w.reads },
    truncated: reasons.length > 0,
    reasons,
  };
}
