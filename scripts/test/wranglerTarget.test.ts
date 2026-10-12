/**
 * Deployment-target overlay (scripts/wrangler-target.mjs): the committed
 * wrangler configs carry neutral defaults, and a deployer's own target comes
 * from the environment or a gitignored env file.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_D1_DATABASE_ID,
  parseEnvFile,
  parseJsonc,
  remoteD1Args,
  resolveSettings,
  targetConfig,
} from '../lib/wrangler-target.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const readConfig = (name: string) => parseJsonc(readFileSync(`${ROOT}apps/platform/${name}`, 'utf8'));
const ID = '0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';

type Config = {
  name: string;
  d1_databases: { binding: string; database_name: string; database_id: string }[];
  vars: Record<string, string>;
};

describe('parseJsonc', () => {
  it('drops line and block comments outside strings and keeps // inside strings', () => {
    const text = `{
      // a line comment
      "url": "https://example.com/a//b", /* block */
      "s": "not // a comment, \\"quoted\\" /* either */",
      "n": 1
    }`;
    expect(parseJsonc(text)).toEqual({ url: 'https://example.com/a//b', s: 'not // a comment, "quoted" /* either */', n: 1 });
  });

  it('accepts trailing commas', () => {
    expect(parseJsonc('{"a": [1, 2,], "b": {"c": 3,},}')).toEqual({ a: [1, 2], b: { c: 3 } });
  });

  it('keeps a comma inside a string that precedes a closing bracket', () => {
    expect(parseJsonc('{"a": ",}"}')).toEqual({ a: ',}' });
  });
});

describe('parseEnvFile', () => {
  it('reads KEY=VALUE lines, skipping comments and blanks, and unquotes values', () => {
    const text = '# comment\n\nA=1\nexport B="two words"\nC=\'single\'\nD = spaced \nnot a pair\n';
    expect(parseEnvFile(text)).toEqual({ A: '1', B: 'two words', C: 'single', D: 'spaced' });
  });
});

describe('resolveSettings', () => {
  it('lets the process environment override the env file', () => {
    const s = resolveSettings({ KVARM_APP_ORIGIN: 'https://env.example' }, { KVARM_APP_ORIGIN: 'https://file.example', KVARM_D1_DATABASE_ID: ID });
    expect(s).toMatchObject({ KVARM_APP_ORIGIN: 'https://env.example', KVARM_D1_DATABASE_ID: ID });
  });

  it('ignores empty process variables', () => {
    expect(resolveSettings({ KVARM_D1_DATABASE_ID: '' }, { KVARM_D1_DATABASE_ID: ID }).KVARM_D1_DATABASE_ID).toBe(ID);
  });
});

describe('targetConfig', () => {
  const base = readConfig('wrangler.jsonc') as Config;

  it('fills the D1 database id and APP_ORIGIN without mutating the committed config', () => {
    const before = JSON.stringify(base);
    const out = targetConfig(base, { KVARM_D1_DATABASE_ID: ID, KVARM_APP_ORIGIN: 'https://kvarm.example.com/' }, { requireOrigin: true }) as Config;
    expect(out.d1_databases[0]).toMatchObject({ binding: 'DB', database_name: base.d1_databases[0]!.database_name, database_id: ID });
    expect(out.vars.APP_ORIGIN).toBe('https://kvarm.example.com');
    expect(out.name).toBe(base.name);
    expect(JSON.stringify(base)).toBe(before);
  });

  it('renames the D1 database when KVARM_D1_DATABASE_NAME is set', () => {
    const out = targetConfig(base, { KVARM_D1_DATABASE_ID: ID, KVARM_D1_DATABASE_NAME: 'kvarm-db' }, { requireOrigin: false }) as Config;
    expect(out.d1_databases[0]!.database_name).toBe('kvarm-db');
  });

  it('keeps the template APP_ORIGIN when no origin is configured and none is required', () => {
    const out = targetConfig(base, { KVARM_D1_DATABASE_ID: ID }, { requireOrigin: false }) as Config;
    expect(out.vars.APP_ORIGIN).toBe(base.vars.APP_ORIGIN);
  });

  it('requires a real D1 database id', () => {
    expect(() => targetConfig(base, {}, { requireOrigin: false })).toThrow(/KVARM_D1_DATABASE_ID/);
    expect(() => targetConfig(base, { KVARM_D1_DATABASE_ID: PLACEHOLDER_D1_DATABASE_ID }, { requireOrigin: false })).toThrow(/KVARM_D1_DATABASE_ID/);
    expect(() => targetConfig(base, { KVARM_D1_DATABASE_ID: 'not-a-uuid' }, { requireOrigin: false })).toThrow(/KVARM_D1_DATABASE_ID/);
  });

  it('requires an http(s) origin for deploys', () => {
    expect(() => targetConfig(base, { KVARM_D1_DATABASE_ID: ID }, { requireOrigin: true })).toThrow(/KVARM_APP_ORIGIN/);
    expect(() => targetConfig(base, { KVARM_D1_DATABASE_ID: ID, KVARM_APP_ORIGIN: 'ftp://x.example' }, { requireOrigin: true })).toThrow(/KVARM_APP_ORIGIN/);
    expect(() => targetConfig(base, { KVARM_D1_DATABASE_ID: ID, KVARM_APP_ORIGIN: 'https://x.example/path' }, { requireOrigin: true })).toThrow(/KVARM_APP_ORIGIN/);
  });
});

describe('remoteD1Args', () => {
  it('routes a remote D1 statement through the target wrapper by binding name', () => {
    const args = remoteD1Args('SELECT 1');
    expect(args[0]).toBe(`${ROOT}scripts/wrangler-target.mjs`);
    expect(args.slice(1)).toEqual(['d1', 'execute', 'DB', '--remote', '--json', '--command', 'SELECT 1']);
  });
});

describe('committed configuration', () => {
  for (const file of ['wrangler.jsonc', 'wrangler.dev.jsonc']) {
    it(`${file} pins no deployment target`, () => {
      const c = readConfig(file) as Config;
      expect(c.d1_databases[0]!.database_id).toBe(PLACEHOLDER_D1_DATABASE_ID);
      expect(c.vars.APP_ORIGIN).toBe('http://localhost:8787');
    });
  }

  it('gitignores env files and the generated target config but not the examples', () => {
    const ignored = (path: string) => spawnSync('git', ['-C', ROOT, 'check-ignore', '-q', '--no-index', path]).status === 0;
    for (const p of ['.env', '.env.local', 'apps/platform/.env', 'apps/platform/.env.deploy', 'apps/platform/wrangler.target.json']) {
      expect(ignored(p), p).toBe(true);
    }
    expect(ignored('apps/platform/.env.deploy.example')).toBe(false);
  });
});
