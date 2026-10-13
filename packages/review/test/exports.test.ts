import { describe, expect, it } from 'vitest';
import { diffExports, extractExports } from '../src/exports';

describe('export signatures', () => {
  it('extracts top-level declarations, re-exports, defaults and namespaces', () => {
    const result = extractExports(
      'src/api.ts',
      `
// export const commented = 1;
const text = "export const hidden = 1";
export async function run<T>(value: T): Promise<T> { return value; }
export class Client extends Base<string> { method() {} }
export const answer: number = 42;
export let current: string;
export var legacy = 1;
export type Shape = { x: number };
export interface Info { id: string; }
export enum Mode { Open, Closed }
export namespace API { export const nested = true; }
export { local as renamed, other };
export * as ns from './other';
export * from './all';
export default function main(value: string): number { return 1; }
`,
    );

    expect(result.exports.map(({ name, kind }) => [name, kind])).toEqual([
      ['run', 'function'],
      ['Client', 'class'],
      ['answer', 'const'],
      ['current', 'let'],
      ['legacy', 'var'],
      ['Shape', 'type'],
      ['Info', 'interface'],
      ['Mode', 'enum'],
      ['API', 'namespace'],
      ['renamed', 'reexport'],
      ['other', 'reexport'],
      ['ns', 'namespace'],
      ['*', 'reexport'],
      ['default', 'default'],
    ]);
    expect(result.exports[0]?.signature).toBe('export async function run<T>(value: T): Promise<T>');
    expect(result.exports[1]?.signature).toBe('export class Client extends Base<string>');
    expect(result.exports[5]?.signature).toBe('export type Shape = { x: number }');
    expect(result.exports[6]?.signature).toBe('export interface Info { id: string; }');
    expect(result.exports[12]?.signature).toBe("export * from './all'");
    expect(result.exports[0]?.line).toBe(4);
  });

  it('handles ambient declarations in declaration files and masks comments and templates', () => {
    const result = extractExports(
      'src/api.d.ts',
      `
/* export declare const hidden: string; */
export declare function lookup(id: string): Item;
export declare const VERSION: string;
export declare class Client<T> extends Base<T>;
export declare type Key = string;
export declare interface Item { id: Key }
export declare enum Mode { A, B }
export declare namespace API { function call(): void }
const sample = \`export declare const notExported: boolean\`;
`,
    );
    expect(result.exports.map(({ name, kind }) => [name, kind])).toEqual([
      ['lookup', 'function'],
      ['VERSION', 'const'],
      ['Client', 'class'],
      ['Key', 'type'],
      ['Item', 'interface'],
      ['Mode', 'enum'],
      ['API', 'namespace'],
    ]);
  });

  it('normalizes whitespace and drops trailing semicolons and commas', () => {
    const result = extractExports('api.ts', 'export type   Result<T> =\n  T | null;\nexport { value, };');
    expect(result.exports[0]?.signature).toBe('export type Result<T> = T | null');
    expect(result.exports[1]?.signature).toBe('export { value }');
  });

  it('caps declaration signatures at two kilobytes and the source at 512 KiB', () => {
    const declaration = `export interface Large { value: "${'x'.repeat(3000)}"; }`;
    const large = extractExports('api.ts', declaration);
    expect(large.exports[0]?.signature).toHaveLength(2048);
    expect(extractExports('api.ts', `${' '.repeat(512 * 1024 + 1)}export const missed = true;`)).toEqual({
      exports: [],
      truncated: true,
    });
  });

  it('reports removed, changed and added names deterministically', () => {
    const base = extractExports('api.ts', `
export function changed(value: string): string { return value; }
export const removed = 1;
export type retained = number;
`);
    const head = extractExports('api.ts', `
export function changed(value: number): string { return String(value); }
export type retained = number;
export interface added { id: string }
`);
    expect(diffExports(base, head)).toEqual([
      { name: 'added', change: 'added', after: 'export interface added { id: string }' },
      {
        name: 'changed',
        change: 'changed',
        before: 'export function changed(value: string): string',
        after: 'export function changed(value: number): string',
      },
      { name: 'removed', change: 'removed', before: 'export const removed = 1' },
    ]);
  });
});
