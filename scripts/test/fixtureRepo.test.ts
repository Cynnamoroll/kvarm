/**
 * The live fixture drivers must never delete a repository they did not
 * create in the same run (protected bootstrap data such as cynthia/forge-e2e
 * included). Exercised against a fake REST API that records every call.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkIsolatedName, withFixtureRepo, type FixtureHttp } from '../lib/fixture-repo.mjs';

interface Call {
  method: string;
  path: string;
}

function fakeApi(existing: Set<string>, { createStatus = 201 } = {}): { http: FixtureHttp; calls: Call[] } {
  const calls: Call[] = [];
  const http: FixtureHttp = async (path, { method = 'GET', json } = {}) => {
    calls.push({ method, path });
    const name = path.split('/').pop() ?? '';
    if (method === 'GET') return { status: existing.has(name) ? 200 : 404 };
    if (method === 'POST') {
      if (createStatus === 201) existing.add((json as { name: string }).name);
      return { status: createStatus };
    }
    if (method === 'DELETE') return { status: existing.delete(name) ? 204 : 404 };
    return { status: 405 };
  };
  return { http, calls };
}

const OPTS = { owner: 'cynthia', prefix: 'm3-risk-engine' };
const deletes = (calls: Call[]) => calls.filter((c) => c.method === 'DELETE');

describe('checkIsolatedName', () => {
  it('accepts only <prefix>-<purpose>-<timestamp> names and never protected repos', () => {
    expect(checkIsolatedName('m3-risk-engine-fixture-1791400000000', 'm3-risk-engine')).toBeNull();
    for (const bad of ['forge-e2e', 'fixture-1m', 'm3-risk-engine-fixture', 'm3-risk-engine-1791400000000', 'other-fixture-1791400000000', '../forge-e2e']) {
      expect(checkIsolatedName(bad, 'm3-risk-engine'), bad).toMatch(/\S/);
    }
  });
});

describe('withFixtureRepo', () => {
  it('rejects a protected --repo target before any request, push or delete', async () => {
    const { http, calls } = fakeApi(new Set(['forge-e2e']));
    let ran = false;
    const out = await withFixtureRepo({ ...OPTS, repo: 'forge-e2e', http }, async () => {
      ran = true;
    });
    expect(out.ok).toBe(false);
    expect(ran).toBe(false);
    expect(calls).toEqual([]);
  });

  it('rejects an existing isolated-looking repo instead of reusing it, and never deletes it', async () => {
    const name = 'm3-risk-engine-fixture-1791400000000';
    const existing = new Set([name]);
    const { http, calls } = fakeApi(existing);
    let ran = false;
    const out = await withFixtureRepo({ ...OPTS, repo: name, http }, async () => {
      ran = true;
    });
    expect(out.ok).toBe(false);
    expect(out.ok ? '' : out.reason).toMatch(/already exists/);
    expect(ran).toBe(false);
    expect(deletes(calls)).toEqual([]);
    expect(existing.has(name)).toBe(true);
  });

  it('does not delete anything when creation fails', async () => {
    const { http, calls } = fakeApi(new Set(), { createStatus: 500 });
    let ran = false;
    const out = await withFixtureRepo({ ...OPTS, repo: 'm3-risk-engine-fixture-1791400000001', http }, async () => {
      ran = true;
    });
    expect(out.ok).toBe(false);
    expect(ran).toBe(false);
    expect(deletes(calls)).toEqual([]);
  });

  it('deletes the repo it created when the run fails, and only that repo', async () => {
    const name = 'm3-risk-engine-fixture-1791400000002';
    const existing = new Set(['forge-e2e']);
    const { http, calls } = fakeApi(existing);
    await expect(
      withFixtureRepo({ ...OPTS, repo: name, http }, async () => {
        throw new Error('push failed');
      }),
    ).rejects.toThrow('push failed');
    expect(deletes(calls)).toEqual([{ method: 'DELETE', path: `/api/v1/repos/cynthia/${name}` }]);
    expect(existing.has('forge-e2e')).toBe(true);
  });

  it('deletes the created repo after success unless kept', async () => {
    const { http, calls } = fakeApi(new Set());
    const out = await withFixtureRepo({ ...OPTS, repo: 'm3-risk-engine-fixture-1791400000003', http }, async () => 'done');
    expect(out).toMatchObject({ ok: true, created: true, value: 'done' });
    expect(deletes(calls)).toHaveLength(1);

    const kept = fakeApi(new Set());
    await withFixtureRepo({ ...OPTS, repo: 'm3-risk-engine-fixture-1791400000004', http: kept.http, keep: true }, async () => 'done');
    expect(deletes(kept.calls)).toEqual([]);
  });
});

describe('scripts/risk-fixture.mjs against a fake worker', () => {
  async function runDriver(repoArg: string): Promise<{ code: number | null; calls: Call[]; out: string }> {
    const calls: Call[] = [];
    const server = createServer((req, res) => {
      calls.push({ method: req.method ?? 'GET', path: req.url ?? '' });
      // Every repo "exists", so any create/push/delete would be a reuse.
      res.writeHead(req.method === 'GET' ? 200 : 403, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../risk-fixture.mjs', import.meta.url)), `--repo=${repoArg}`], {
        env: { ...process.env, KVARM_BASE_URL: `http://127.0.0.1:${port}`, KVARM_PAT: 'not-a-real-token' },
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
      return { code, calls, out };
    } finally {
      server.close();
    }
  }

  it('refuses the protected forge-e2e repo without any request, push or delete', async () => {
    const { code, calls, out } = await runDriver('forge-e2e');
    expect(code).toBe(1);
    expect(out).toMatch(/refusing to run: forge-e2e is protected/);
    expect(calls).toEqual([]);
  });

  it('refuses a pre-existing isolated-looking repo: no create, push or delete', async () => {
    const { code, calls, out } = await runDriver('m3-risk-engine-fixture-1791400000009');
    expect(code).toBe(1);
    expect(out).toMatch(/already exists/);
    expect(calls).toEqual([{ method: 'GET', path: '/api/v1/repos/cynthia/m3-risk-engine-fixture-1791400000009' }]);
  });
});
