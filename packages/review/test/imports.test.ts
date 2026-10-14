import { describe, expect, it } from 'vitest';
import { extractReviewImports, resolveSpecifier } from '../src/imports';

describe('review import extraction', () => {
  it('finds static imports, re-exports, side effects, require and literal dynamic imports', () => {
    expect(extractReviewImports(`
import type { User, Thing as Alias } from './models';
import Client, * as ui from '@kvarm/ui';
import './side-effect';
export { User } from './re-export';
export type * from './types';
const cjs = require('./legacy');
const lazy = import('./lazy');
const ignored = import(moduleName);
// import { Hidden } from './comment';
const text = "import './string'";
`)).toEqual([
      { specifier: './models', line: 2, names: ['User', 'Thing'], typeOnly: true },
      { specifier: '@kvarm/ui', line: 3, names: ['default', '*'] },
      { specifier: './side-effect', line: 4 },
      { specifier: './re-export', line: 5, names: ['User'] },
      { specifier: './types', line: 6, names: ['*'], typeOnly: true },
      { specifier: './legacy', line: 7 },
      { specifier: './lazy', line: 8 },
    ]);
  });

  it('resolves exact paths, TypeScript extension substitutions, and index files', () => {
    const files = new Set(['src/exact.js', 'src/typed.ts', 'src/component/index.tsx', 'src/model.d.ts']);
    expect(resolveSpecifier('src/app.ts', './exact.js', files, new Map())).toBe('src/exact.js');
    expect(resolveSpecifier('src/app.ts', './typed.js', files, new Map())).toBe('src/typed.ts');
    expect(resolveSpecifier('src/app.ts', './component', files, new Map())).toBe('src/component/index.tsx');
    expect(resolveSpecifier('src/app.ts', './model', files, new Map())).toBe('src/model.d.ts');
  });

  it('resolves workspace packages and subpaths to their entry, leaving external packages unresolved', () => {
    const files = new Set(['packages/ui/src/index.ts']);
    const workspaces = new Map([['@kvarm/ui', 'packages/ui/src/index.ts']]);
    expect(resolveSpecifier('apps/web/src/page.ts', '@kvarm/ui', files, workspaces)).toBe('packages/ui/src/index.ts');
    expect(resolveSpecifier('apps/web/src/page.ts', '@kvarm/ui/components/button', files, workspaces)).toBe('packages/ui/src/index.ts');
    expect(resolveSpecifier('apps/web/src/page.ts', 'react', files, workspaces)).toBeNull();
    expect(resolveSpecifier('src/a.ts', '../../outside', files, workspaces)).toBeNull();
  });
});
