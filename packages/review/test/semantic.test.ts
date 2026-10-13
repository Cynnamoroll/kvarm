import { describe, expect, it } from 'vitest';
import {
  SEMANTIC_LIMITS,
  analyzeDependencies,
  contractFamily,
  extractSemanticExports,
  extractSemanticImports,
  goImportTarget,
  resolveCandidates,
  type SemanticBlob,
  type SemanticTreeEntry,
  type SemanticTreeSource,
} from '../src/index';

const enc = new TextEncoder();

/** An in-memory tree store: paths → content, hashed by path so reads are countable. */
function memoryTree(files: Record<string, string>, ns = ''): { source: SemanticTreeSource; root: string; calls: string[] } {
  const trees = new Map<string, SemanticTreeEntry[]>();
  const blobs = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const dirs = new Map<string, Map<string, SemanticTreeEntry>>([['', new Map()]]);
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!dirs.has(dir)) dirs.set(dir, new Map());
      const parent = parts.slice(0, i - 1).join('/');
      dirs.get(parent)!.set(parts[i - 1]!, { name: parts[i - 1]!, mode: '40000', hash: `${ns}tree:${dir}` });
    }
    const parent = parts.slice(0, -1).join('/');
    dirs.get(parent)!.set(parts[parts.length - 1]!, { name: parts[parts.length - 1]!, mode: '100644', hash: `${ns}blob:${path}` });
    blobs.set(`${ns}blob:${path}`, enc.encode(text));
  }
  for (const [dir, entries] of dirs) trees.set(`${ns}tree:${dir}`, [...entries.values()]);
  const source: SemanticTreeSource = {
    async readTree(hash) {
      calls.push(hash);
      return trees.get(hash) ?? null;
    },
    async readBlob(hash, maxBytes): Promise<SemanticBlob> {
      calls.push(hash);
      const b = blobs.get(hash);
      if (!b) return null;
      if (b.length > maxBytes) return { tooLarge: true };
      return { bytes: b };
    },
  };
  return { source, root: `${ns}tree:`, calls };
}

describe('import extraction (TS/JS)', () => {
  it('finds ESM imports, export-from, require and literal dynamic imports, ignoring comments and strings', () => {
    const text = `
import { a, b as c } from './util';
import type { T } from "../types";
import Def, * as ns from './def.js';
import './side-effect';
export { x } from './reexport';
export * from './star';
const r = require('./req');
const lazy = await import('./lazy');
const tpl = import(\`./tpl\`);
const notLiteral = import(name);
// import { gone } from './commented';
/* require('./block') */
const s = "import { z } from './in-string'";
foo.require('./method');
`;
    const specs = extractSemanticImports('src/app.ts', text).specs;
    expect(specs.map((s) => s.spec)).toEqual(['./util', '../types', './def.js', './side-effect', './reexport', './star', './req', './lazy', './tpl']);
    expect(specs[0]!.names).toEqual(['a', 'b']);
    expect(specs[2]!.names).toEqual(['default', '*']);
  });

  it('extracts exported names', () => {
    const text = `
export function f() {}
export async function g() {}
export const k = 1, unused = 2;
export class C {}
export interface I {}
export type Ty = string;
export enum E { A }
export default function () {}
export { a, b as bee };
export * as ns from './x';
module.exports.legacy = 1;
// export const commented = 1;
`;
    expect(extractSemanticExports(text)).toEqual(['C', 'E', 'I', 'Ty', 'a', 'bee', 'default', 'f', 'g', 'k', 'legacy', 'ns']);
  });

  it('names a const enum by its name, not the enum keyword', () => {
    expect(extractSemanticExports('export const enum Direction { Up }\nexport declare const enum Mode { A }\n')).toEqual(['Direction', 'Mode']);
  });

  it('names generator exports and masks a regex literal after a keyword', () => {
    expect(extractSemanticExports('export function *gen() {}\nexport async function* agen() {}\n')).toEqual(['agen', 'gen']);
    const text = "function f(s) {\n  return /`/.test(s);\n}\nconst lazy = import('./after');\nconst q = a / b / c;\nrequire('./also');\n";
    expect(extractSemanticImports('src/x.ts', text).specs.map((s) => s.spec)).toEqual(['./after', './also']);
  });
});

describe('import extraction (Python, Go)', () => {
  it('reads Python import and from-import, relative and absolute, with parenthesized names', () => {
    const text = `
import os, pkg.mod as m
from . import sibling
from ..parent.thing import (
    One,
    Two,
)
from pkg.api import handler  # trailing comment
# import commented
`;
    const specs = extractSemanticImports('app/svc/main.py', text).specs;
    expect(specs.map((s) => s.spec)).toEqual(['os', 'pkg.mod', '.', '..parent.thing', 'pkg.api']);
    expect(specs[2]!.names).toEqual(['sibling']);
    expect(specs[3]!.names).toEqual(['One', 'Two']);
  });

  it('reads Go single and grouped imports', () => {
    const text = `package main
import "fmt"
import (
  "example.com/m/pkg/api"
  alias "example.com/m/internal/db"
  // "example.com/m/commented"
)
`;
    expect(extractSemanticImports('cmd/main.go', text).specs.map((s) => s.spec)).toEqual(['fmt', 'example.com/m/pkg/api', 'example.com/m/internal/db']);
    expect(goImportTarget('example.com/m/pkg/api', { module: 'example.com/m', dir: '' })).toBe('pkg/api/');
    expect(goImportTarget('example.com/m/pkg/api', { module: 'example.com/m', dir: 'svc/' })).toBe('svc/pkg/api/');
    expect(goImportTarget('fmt', { module: 'example.com/m', dir: '' })).toBeNull();
  });
});

describe('resolution and contract families', () => {
  it('resolves relative TS/JS specifiers to repo-path candidates, including .js → .ts', () => {
    expect(resolveCandidates('src/a/b.ts', './c', 'js').slice(0, 3)).toEqual(['src/a/c', 'src/a/c.ts', 'src/a/c.tsx']);
    expect(resolveCandidates('src/a/b.ts', '../x.js', 'js')).toEqual(['src/x.js', 'src/x.ts', 'src/x.tsx', 'src/x.mts', 'src/x.cts']);
    expect(resolveCandidates('src/a/b.ts', './dir', 'js')).toContain('src/a/dir/index.ts');
    expect(resolveCandidates('src/a.ts', 'react', 'js')).toEqual([]);
    expect(resolveCandidates('a.ts', '../../escape', 'js')).toEqual([]);
    // Climbing to the root is allowed; climbing above it is not.
    expect(resolveCandidates('lib/a.ts', '..', 'js')).toContain('index.ts');
    expect(resolveCandidates('lib/a.ts', '../root', 'js')[0]).toBe('root');
    expect(resolveCandidates('pkg/mod.py', '..', 'py', ['shared'])).toEqual(['shared.py', 'shared/__init__.py', '__init__.py']);
    expect(resolveCandidates('pkg/mod.py', '...', 'py', ['x'])).toEqual([]);
  });

  it('resolves Python relative and absolute modules', () => {
    expect(resolveCandidates('app/svc/main.py', '..parent.thing', 'py')).toEqual(['app/parent/thing.py', 'app/parent/thing/__init__.py']);
    expect(resolveCandidates('app/svc/main.py', '.', 'py', ['sibling'])).toEqual(['app/svc/sibling.py', 'app/svc/sibling/__init__.py', 'app/svc/__init__.py']);
    expect(resolveCandidates('app/svc/main.py', 'pkg.api', 'py')).toEqual(['pkg/api.py', 'pkg/api/__init__.py', 'src/pkg/api.py', 'src/pkg/api/__init__.py', 'app/pkg/api.py', 'app/pkg/api/__init__.py']);
  });

  it('classifies contract files into API families by convention', () => {
    expect(contractFamily('api/v1/user.proto')).toBe('proto:api/v1/');
    expect(contractFamily('api/v1/order.proto')).toBe('proto:api/v1/');
    expect(contractFamily('openapi.yaml')).toBe('openapi:');
    expect(contractFamily('svc/openapi-v2.json')).toBe('openapi:svc/');
    expect(contractFamily('svc/swagger.yml')).toBe('openapi:svc/');
    expect(contractFamily('schema/user.graphql')).toBe('graphql:schema/');
    expect(contractFamily('types/index.d.ts')).toBe('dts:types/');
    expect(contractFamily('apps/platform/migrations/0029_x.sql')).toBe('migrations:apps/platform/migrations/');
    expect(contractFamily('db/migrate/20240101_add.rb')).toBe('migrations:db/migrate/');
    expect(contractFamily('src/app.ts')).toBeNull();
    expect(contractFamily('docs/readme.md')).toBeNull();
  });
});

describe('analyzeDependencies (bounded walk)', () => {
  const repo = {
    'packages/api/src/client.ts': 'export function fetchUser() {}\nexport const VERSION = 1;\n',
    'packages/api/src/index.ts': "export { fetchUser } from './client';\n",
    'apps/web/src/page.ts': "import { fetchUser } from '../../../packages/api/src/index';\nfetchUser();\n",
    'apps/web/src/other.ts': "import { page } from './page.js';\n",
    'apps/py/main.py': 'from .helpers import go\n',
    'apps/py/helpers.py': 'def go(): pass\n',
    'go.mod': 'module example.com/m\n\ngo 1.22\n',
    'cmd/tool/main.go': 'package main\nimport "example.com/m/pkg/api"\n',
    'pkg/api/api.go': 'package api\n',
    'api/v1/user.proto': 'syntax = "proto3";\n',
  };

  it('records depth-1 and depth-2 edges from changed files with their chains', async () => {
    const t = memoryTree(repo);
    const r = await analyzeDependencies(t.source, { headTree: t.root, changed: ['apps/web/src/other.ts', 'apps/py/main.py', 'cmd/tool/main.go', 'api/v1/user.proto'] });
    expect(r.truncated).toBe(false);
    const byTarget = new Map(r.edges.map((e) => [e.target, e]));
    expect(byTarget.get('apps/web/src/page.ts')).toEqual({ target: 'apps/web/src/page.ts', depth: 1, chain: ['apps/web/src/other.ts', 'apps/web/src/page.ts'], names: ['page'] });
    expect(byTarget.get('packages/api/src/index.ts')).toMatchObject({ depth: 2, chain: ['apps/web/src/other.ts', 'apps/web/src/page.ts', 'packages/api/src/index.ts'] });
    // Depth 3 (index.ts → client.ts) is beyond the default limit.
    expect(byTarget.has('packages/api/src/client.ts')).toBe(false);
    expect(byTarget.get('apps/py/helpers.py')).toMatchObject({ depth: 1 });
    expect(byTarget.get('pkg/api/')).toMatchObject({ depth: 1, chain: ['cmd/tool/main.go', 'pkg/api/'] });
    expect(r.contracts).toEqual([{ family: 'proto:api/v1/', path: 'api/v1/user.proto' }]);
  });

  it('resolves every module of a relative Python from-import, not just the first', async () => {
    const t = memoryTree({ 'pkg/__init__.py': '', 'pkg/api.py': 'from . import models, views\n', 'pkg/models.py': '', 'pkg/views.py': '' });
    const r = await analyzeDependencies(t.source, { headTree: t.root, changed: ['pkg/api.py'] });
    expect(r.edges.map((e) => [e.target, e.names])).toEqual([
      ['pkg/models.py', ['models']],
      ['pkg/views.py', ['views']],
    ]);
  });

  it('honors a smaller depth limit', async () => {
    const t = memoryTree(repo);
    const r = await analyzeDependencies(t.source, { headTree: t.root, changed: ['apps/web/src/other.ts'], limits: { depthMax: 1 } });
    expect(r.edges.map((e) => e.target)).toEqual(['apps/web/src/page.ts']);
  });

  it('reports export-surface changes between base and head, including deleted modules', async () => {
    const base = memoryTree(repo, 'base|');
    // Head renames an export of client.ts and deletes index.ts.
    const headFiles: Record<string, string> = { ...repo, 'packages/api/src/client.ts': 'export function fetchUserById() {}\nexport const VERSION = 1;\n' };
    delete headFiles['packages/api/src/index.ts'];
    const h = memoryTree(headFiles);
    const r = await analyzeDependencies(
      {
        readTree: (x) => (x.startsWith('base|') ? base.source.readTree(x) : h.source.readTree(x)),
        readBlob: (x, m) => (x.startsWith('base|') ? base.source.readBlob(x, m) : h.source.readBlob(x, m)),
      },
      { headTree: h.root, baseTree: base.root, changed: ['packages/api/src/client.ts', 'packages/api/src/index.ts'] },
    );
    expect(r.exportChanges).toEqual([
      { path: 'packages/api/src/client.ts', added: ['fetchUserById'], removed: ['fetchUser'] },
      { path: 'packages/api/src/index.ts', added: [], removed: ['fetchUser'] },
    ]);
  });

  it('compares export surfaces before the import walk can spend the shared budget', async () => {
    const files: Record<string, string> = { 'src/api.ts': 'export function a() {}\n' };
    for (let i = 0; i < 10; i++) files[`src/use${i}.ts`] = `import { a } from './api';\nimport { d } from './dep${i}';\n`;
    for (let i = 0; i < 10; i++) files[`src/dep${i}.ts`] = `export const d = 1;\n`;
    const base = memoryTree(files, 'base|');
    const h = memoryTree({ ...files, 'src/api.ts': 'export function b() {}\n' });
    const changed = ['src/api.ts', ...Array.from({ length: 10 }, (_, i) => `src/use${i}.ts`)];
    const r = await analyzeDependencies(
      { readTree: (x) => (x.startsWith('base|') ? base.source.readTree(x) : h.source.readTree(x)), readBlob: (x, m) => (x.startsWith('base|') ? base.source.readBlob(x, m) : h.source.readBlob(x, m)) },
      { headTree: h.root, baseTree: base.root, changed, limits: { blobReadsMax: 6 } },
    );
    expect(r.truncated).toBe(true);
    expect(r.exportChanges).toEqual([{ path: 'src/api.ts', added: ['b'], removed: ['a'] }]);
  });

  it('a too-large imported module shortens a chain without marking the record incomplete', async () => {
    const t = memoryTree({ 'src/a.ts': "import './big';\n", 'src/big.ts': `${'//'.padEnd(SEMANTIC_LIMITS.fileBytesMax + 10, 'x')}\n` });
    const r = await analyzeDependencies(t.source, { headTree: t.root, changed: ['src/a.ts'] });
    expect(r.edges.map((e) => e.target)).toEqual(['src/big.ts']);
    expect(r.truncated).toBe(false);
  });

  it('reports truncation with reasons instead of going silent when budgets bite', async () => {
    const files: Record<string, string> = {};
    const changed: string[] = [];
    for (let i = 0; i < 30; i++) {
      files[`src/f${i}.ts`] = `import { x } from './dep${i}';\n`;
      files[`src/dep${i}.ts`] = `import { y } from './leaf${i}';\nexport const x = 1;\n`;
      files[`src/leaf${i}.ts`] = 'export const y = 1;\n';
      changed.push(`src/f${i}.ts`);
    }
    files['src/big.ts'] = `import './f0';\n${'//'.padEnd(SEMANTIC_LIMITS.fileBytesMax + 10, 'x')}\n`;
    changed.push('src/big.ts');
    const t = memoryTree(files);
    const r = await analyzeDependencies(t.source, { headTree: t.root, changed, limits: { blobReadsMax: 20 } });
    expect(r.truncated).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/blob read budget/);
    expect(r.reads.blobs).toBeLessThanOrEqual(20);

    const few = await analyzeDependencies(t.source, { headTree: t.root, changed, limits: { sourceFilesMax: 5 } });
    expect(few.reasons.join(' ')).toMatch(/more than 5 changed source files/);

    const big = await analyzeDependencies(t.source, { headTree: t.root, changed: ['src/big.ts'] });
    expect(big.truncated).toBe(true);
    expect(big.reasons.join(' ')).toMatch(/larger than/);

    const edges = await analyzeDependencies(t.source, { headTree: t.root, changed, limits: { edgesMax: 3 } });
    expect(edges.edges).toHaveLength(3);
    expect(edges.reasons.join(' ')).toMatch(/more than 3 dependency edges/);

    let now = 0;
    const slow = await analyzeDependencies(t.source, { headTree: t.root, changed, limits: { timeMs: 5 }, clock: () => (now += 1) });
    expect(slow.truncated).toBe(true);
    expect(slow.reasons.join(' ')).toMatch(/time budget/);
  });

  it('is deterministic: identical input gives identical output', async () => {
    const t = memoryTree(repo);
    const input = { headTree: t.root, changed: ['cmd/tool/main.go', 'apps/web/src/other.ts', 'apps/py/main.py'] };
    expect(JSON.stringify(await analyzeDependencies(t.source, input))).toBe(JSON.stringify(await analyzeDependencies(t.source, { ...input, changed: [...input.changed].reverse() })));
  });
});
