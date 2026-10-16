import { env as cfEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELIM_PKT, FLUSH_PKT, concat, pktLine } from '@kvarm/gitops';
import { RepoMirror } from '../src/do/repoMirror';
import { recordConfirmedPush } from '../src/services/pushFreshness';
import { fakeArtifacts, infoRefsCalls, installFakeGitRemote, lsRefsCalls, restoreFetch } from './helpers/fakeArtifacts';
import { ORIGIN, send } from './helpers/http';
import { seedRepoWithCommit } from './helpers/seed';

const baseEnv = { ...(cfEnv as unknown as Env), ARTIFACTS: fakeArtifacts } as Env;
const OWNER = 'repo-mirror';

async function withFakeArtifacts<T>(id: string, run: (mirror: RepoMirror) => Promise<T>): Promise<T> {
  const stub = baseEnv.REPO_MIRROR.get(baseEnv.REPO_MIRROR.idFromName(id));
  return runInDurableObject(stub, async (object) => {
    (object as unknown as { env: Env }).env = { ...(object as unknown as { env: Env }).env, ARTIFACTS: fakeArtifacts };
    return run(object as RepoMirror);
  });
}

function lsRefsBody(args: string[] = ['peel', 'symrefs', 'ref-prefix refs/heads/']): Uint8Array {
  return concat(
    pktLine('command=ls-refs\n'),
    pktLine('agent=git/2.34.1\n'),
    pktLine('object-format=sha1\n'),
    DELIM_PKT,
    ...args.map((arg) => pktLine(`${arg}\n`)),
    FLUSH_PKT,
  );
}

describe('RepoMirror', () => {
  beforeAll(() => installFakeGitRemote());
  afterAll(() => restoreFetch());
  beforeEach(() => { infoRefsCalls.length = 0; });

  it('renders captured v0/v2 and ls-refs bytes, then applies a push without reseeding', async () => {
    const name = `mirror-${crypto.randomUUID().slice(0, 8)}`;
    const { id, main } = await seedRepoWithCommit(baseEnv, name, { owner: OWNER, visibility: 'public' });
    await withFakeArtifacts(id, async () => undefined);
    const off = { ...baseEnv, GIT_MIRROR_MODE: 'off' } as Env;
    const on = { ...baseEnv, GIT_MIRROR_MODE: 'on' } as Env;
    const path = `/${OWNER}/${name}.git/info/refs?service=git-upload-pack`;
    const captured = await send(off, new Request(`${ORIGIN}${path}`));
    const mirrored = await send(on, new Request(`${ORIGIN}${path}`));
    expect(mirrored.status).toBe(200);
    expect(mirrored.bytes).toEqual(captured.bytes);

    const v2Path = `/${OWNER}/${name}.git/info/refs?service=git-upload-pack`;
    const v2 = await send(off, new Request(`${ORIGIN}${v2Path}`, { headers: { 'Git-Protocol': 'version=2' } }));
    const v2Mirror = await send(on, new Request(`${ORIGIN}${v2Path}`, { headers: { 'Git-Protocol': 'version=2' } }));
    expect(v2Mirror.bytes).toEqual(v2.bytes);
    const v1 = await send(off, new Request(`${ORIGIN}${v2Path}`, { headers: { 'Git-Protocol': 'version=1' } }));
    const v1Mirror = await send(on, new Request(`${ORIGIN}${v2Path}`, { headers: { 'Git-Protocol': 'version=1' } }));
    expect(v1Mirror.bytes).toEqual(v1.bytes);

    const lsPath = `/${OWNER}/${name}.git/git-upload-pack`;
    const ls = await send(off, new Request(`${ORIGIN}${lsPath}`, { method: 'POST', headers: { 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' }, body: lsRefsBody() }));
    const lsMirror = await send(on, new Request(`${ORIGIN}${lsPath}`, { method: 'POST', headers: { 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' }, body: lsRefsBody() }));
    expect(lsMirror.bytes).toEqual(ls.bytes);

    const next = '1'.repeat(40);
    const artifactsName = `${OWNER}--${name}`;
    const remote = `https://artifacts.invalid/git/default/${artifactsName}.git`;
    const beforeApply = infoRefsCalls.length;
    const applied = await withFakeArtifacts(id, async (mirror) => {
      await mirror.apply(1, [{ ref: 'refs/heads/main', oldOid: main, newOid: next }], id);
      return mirror.read(1, artifactsName, remote, { kind: 'ls-refs', options: { prefixes: ['refs/heads/'], symrefs: false, peel: false } }, id);
    });
    expect(new TextDecoder().decode(applied!.bytes)).toContain(next);
    expect(infoRefsCalls).toHaveLength(beforeApply);
  });

  it('single-flights v0/v2 seeds and fences stale applies', async () => {
    const name = `flight-${crypto.randomUUID().slice(0, 8)}`;
    const { id } = await seedRepoWithCommit(baseEnv, name, { owner: OWNER, visibility: 'public' });
    const artifactsName = `${OWNER}--${name}`;
    const remote = `https://artifacts.invalid/git/default/${artifactsName}.git`;
    await withFakeArtifacts(id, async (mirror) => {
      await Promise.all(Array.from({ length: 20 }, () => mirror.read(0, artifactsName, remote, { kind: 'v0' }, id)));
    });
    expect(infoRefsCalls.filter((x) => x.endsWith(':v0'))).toHaveLength(1);
    expect(infoRefsCalls.filter((x) => x.endsWith(':v2'))).toHaveLength(1);
    const beforeReseed = infoRefsCalls.length;
    const row = await withFakeArtifacts(id, async (mirror) => {
      await mirror.apply(3, [], id);
      return mirror.read(0, artifactsName, remote, { kind: 'v0' }, id);
    });
    expect(row).not.toBeNull();
    expect(infoRefsCalls.length - beforeReseed).toBe(2);
    const destroyed = await withFakeArtifacts(id, async (mirror) => {
      await mirror.destroy(id);
      await mirror.apply(4, [], id);
      return mirror.read(4, artifactsName, remote, { kind: 'v0' }, id);
    });
    expect(destroyed).toBeNull();
  });

  it('discards a seed overlapped by an apply and never resurrects after destroy', async () => {
    const name = `race-${crypto.randomUUID().slice(0, 8)}`;
    const { id, repo, main } = await seedRepoWithCommit(baseEnv, name, { owner: OWNER, visibility: 'public' });
    const artifactsName = `${OWNER}--${name}`;
    const remote = `https://artifacts.invalid/git/default/${artifactsName}.git`;
    let entered!: () => void;
    const fetching = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    repo.hook = async (call) => {
      if (call.startsWith('infoRefs:')) {
        entered();
        await blocked;
      }
    };
    const result = await withFakeArtifacts(id, async (mirror) => {
      const reading = mirror.read(0, artifactsName, remote, { kind: 'v0' }, id);
      await fetching;
      await mirror.apply(1, [{ ref: 'refs/heads/main', oldOid: main, newOid: 'd'.repeat(40) }], id);
      release();
      return reading;
    });
    repo.hook = null;
    expect(result).toBeNull();

    let destroyEntered!: () => void;
    const destroyFetching = new Promise<void>((resolve) => { destroyEntered = resolve; });
    let destroyRelease!: () => void;
    const destroyBlocked = new Promise<void>((resolve) => { destroyRelease = resolve; });
    repo.hook = async (call) => {
      if (call.startsWith('infoRefs:')) {
        destroyEntered();
        await destroyBlocked;
      }
    };
    const late = await withFakeArtifacts(id, async (mirror) => {
      const reading = mirror.read(0, artifactsName, remote, { kind: 'v0' }, id);
      await destroyFetching;
      await mirror.destroy(id);
      destroyRelease();
      return reading;
    });
    repo.hook = null;
    expect(late).toBeNull();
    const afterDestroy = await withFakeArtifacts(id, (mirror) => mirror.read(0, artifactsName, remote, { kind: 'v0' }, id));
    expect(afterDestroy).toBeNull();
  });

  it('reconciles event ring hits and dirties on a miss', async () => {
    const name = `events-${crypto.randomUUID().slice(0, 8)}`;
    const { id, main } = await seedRepoWithCommit(baseEnv, name, { owner: OWNER, visibility: 'public' });
    const artifactsName = `${OWNER}--${name}`;
    const remote = `https://artifacts.invalid/git/default/${artifactsName}.git`;
    await withFakeArtifacts(id, async (mirror) => mirror.read(0, artifactsName, remote, { kind: 'v0' }, id));
    const first = 'e'.repeat(40);
    const second = 'f'.repeat(40);
    const before = infoRefsCalls.length;
    await withFakeArtifacts(id, async (mirror) => {
      await mirror.apply(1, [{ ref: 'refs/heads/main', oldOid: main, newOid: first }], id);
      await mirror.apply(2, [{ ref: 'refs/heads/main', oldOid: first, newOid: second }], id);
      await mirror.reconcile('refs/heads/main', first, id);
      await mirror.read(2, artifactsName, remote, { kind: 'v0' }, id);
    });
    expect(infoRefsCalls).toHaveLength(before);
    await withFakeArtifacts(id, async (mirror) => {
      await mirror.reconcile('refs/heads/main', '9'.repeat(40), id);
      await mirror.read(2, artifactsName, remote, { kind: 'v0' }, id);
    });
    expect(infoRefsCalls.length - before).toBe(2);
  });

  it('marks the mirror dirty when the D1 sequence increment fails', async () => {
    const name = `d1-fail-${crypto.randomUUID().slice(0, 8)}`;
    const { id, repo } = await seedRepoWithCommit(baseEnv, name, { owner: OWNER, visibility: 'public' });
    const artifactsName = `${OWNER}--${name}`;
    const remote = `https://artifacts.invalid/git/default/${artifactsName}.git`;
    await withFakeArtifacts(id, async (mirror) => mirror.read(0, artifactsName, remote, { kind: 'v0' }, id));
    const before = infoRefsCalls.length;
    const brokenDb = new Proxy(baseEnv.DB, {
      get(target, property, receiver) {
        if (property === 'prepare') {
          return (sql: string) => sql.startsWith('UPDATE repos SET pushed_at')
            ? { bind: () => ({ all: async () => { throw new Error('simulated D1 outage'); } }) }
            : Reflect.get(target, property, receiver).bind(target)(sql);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(recordConfirmedPush({ ...baseEnv, DB: brokenDb } as Env, id, [{
      ref: 'refs/heads/main', oldOid: repo.refs.get('refs/heads/main')!, newOid: '8'.repeat(40),
    }])).rejects.toThrow('simulated D1 outage');
    await withFakeArtifacts(id, async (mirror) => mirror.read(0, artifactsName, remote, { kind: 'v0' }, id));
    expect(infoRefsCalls.length - before).toBe(2);
  });

  it('is byte-identical for empty refs, sorted branches, peeled tags, non-main HEAD, and ls-refs options', async () => {
    const emptyName = `empty-${crypto.randomUUID().slice(0, 8)}`;
    const empty = await seedRepoWithCommit(baseEnv, emptyName, { owner: OWNER, visibility: 'public' });
    empty.repo.refs.clear();
    await withFakeArtifacts(empty.id, async () => undefined);
    const emptyPath = `/${OWNER}/${emptyName}.git/info/refs?service=git-upload-pack`;
    const emptyOff = await send({ ...baseEnv, GIT_MIRROR_MODE: 'off' } as Env, new Request(`${ORIGIN}${emptyPath}`));
    const emptyOn = await send({ ...baseEnv, GIT_MIRROR_MODE: 'on' } as Env, new Request(`${ORIGIN}${emptyPath}`));
    expect(emptyOn.bytes).toEqual(emptyOff.bytes);
    const emptyLsPath = `/${OWNER}/${emptyName}.git/git-upload-pack`;
    const unbornRequest = { method: 'POST', headers: { 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' }, body: lsRefsBody(['unborn', 'symrefs', 'ref-prefix HEAD']) };
    const emptyLsOff = await send({ ...baseEnv, GIT_MIRROR_MODE: 'off' } as Env, new Request(`${ORIGIN}${emptyLsPath}`, unbornRequest));
    const emptyLsOn = await send({ ...baseEnv, GIT_MIRROR_MODE: 'on' } as Env, new Request(`${ORIGIN}${emptyLsPath}`, unbornRequest));
    expect(emptyLsOn.bytes).toEqual(emptyLsOff.bytes);

    const name = `many-${crypto.randomUUID().slice(0, 8)}`;
    const { id, repo } = await seedRepoWithCommit(baseEnv, name, { owner: OWNER, visibility: 'public' });
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const c = 'c'.repeat(40);
    repo.refs.set('refs/heads/z-last', a);
    repo.refs.set('refs/heads/release', b);
    repo.refs.set('refs/tags/v1.0', c);
    repo.refs.set('refs/tags/v2.0', a);
    repo.peeled.set('refs/tags/v1.0', b);
    repo.headRef = 'refs/heads/release';
    await withFakeArtifacts(id, async () => undefined);
    const off = { ...baseEnv, GIT_MIRROR_MODE: 'off' } as Env;
    const on = { ...baseEnv, GIT_MIRROR_MODE: 'on' } as Env;
    const infoPath = `/${OWNER}/${name}.git/info/refs?service=git-upload-pack`;
    const original = await send(off, new Request(`${ORIGIN}${infoPath}`));
    const mirrored = await send(on, new Request(`${ORIGIN}${infoPath}`));
    expect(mirrored.bytes).toEqual(original.bytes);

    const lsPath = `/${OWNER}/${name}.git/git-upload-pack`;
    for (const args of [
      [],
      ['peel'],
      ['symrefs'],
      ['unborn'],
      ['ref-prefix refs/heads/'],
      ['ref-prefix refs/tags/', 'ref-prefix refs/heads/release'],
      ['peel', 'symrefs', 'ref-prefix refs/'],
    ]) {
      const init = { method: 'POST', headers: { 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' }, body: lsRefsBody(args) };
      const upstream = await send(off, new Request(`${ORIGIN}${lsPath}`, init));
      const rendered = await send(on, new Request(`${ORIGIN}${lsPath}`, init));
      expect(rendered.bytes, args.join(',')).toEqual(upstream.bytes);
    }
    const unknown = await send(on, new Request(`${ORIGIN}${lsPath}`, {
      method: 'POST',
      headers: { 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' },
      body: lsRefsBody(['unknown-option']),
    }));
    expect(unknown.status).toBe(200);
    expect(lsRefsCalls).toContain(`${OWNER}--${name}`);
    const beforeUnrecognized = lsRefsCalls.length;
    const trailingSpace = await send(on, new Request(`${ORIGIN}${lsPath}`, {
      method: 'POST',
      headers: { 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' },
      body: lsRefsBody(['ref-prefix refs/heads/ ']),
    }));
    expect(trailingSpace.status).toBe(200);
    expect(lsRefsCalls.length).toBe(beforeUnrecognized + 1);
  });

  it('keeps private repositories behind auth and serves public warm reads from L1', async () => {
    const privateName = `private-${crypto.randomUUID().slice(0, 8)}`;
    const privateRepo = await seedRepoWithCommit(baseEnv, privateName, { owner: OWNER, visibility: 'private' });
    await withFakeArtifacts(privateRepo.id, async () => undefined);
    const before = infoRefsCalls.length;
    const offDenied = await send({ ...baseEnv, GIT_MIRROR_MODE: 'off' } as Env, new Request(
      `${ORIGIN}/${OWNER}/${privateName}.git/info/refs?service=git-upload-pack`,
    ));
    const denied = await send({ ...baseEnv, GIT_MIRROR_MODE: 'on' } as Env, new Request(
      `${ORIGIN}/${OWNER}/${privateName}.git/info/refs?service=git-upload-pack`,
    ));
    expect(denied.status).toBe(offDenied.status);
    expect(denied.text).toBe(offDenied.text);
    expect(infoRefsCalls).toHaveLength(before);

    const name = `public-${crypto.randomUUID().slice(0, 8)}`;
    const publicRepo = await seedRepoWithCommit(baseEnv, name, { owner: OWNER, visibility: 'public' });
    await withFakeArtifacts(publicRepo.id, async () => undefined);
    const path = `/${OWNER}/${name}.git/info/refs?service=git-upload-pack`;
    const start = infoRefsCalls.length;
    const on = { ...baseEnv, GIT_MIRROR_MODE: 'on' } as Env;
    const cold = await send(on, new Request(`${ORIGIN}${path}`));
    expect(cold.headers.get('cache-control')).toBe('no-cache');
    const afterCold = infoRefsCalls.length;
    const warm = await send(on, new Request(`${ORIGIN}${path}`));
    expect(warm.headers.get('cache-control')).toBe('no-cache');
    expect(afterCold - start).toBe(2);
    expect(infoRefsCalls.length).toBe(afterCold);
    const oldOid = publicRepo.repo.refs.get('refs/heads/main')!;
    const newOid = '7'.repeat(40);
    publicRepo.repo.refs.set('refs/heads/main', newOid);
    await recordConfirmedPush(baseEnv, publicRepo.id, [{ ref: 'refs/heads/main', oldOid, newOid }]);
    const afterPush = await send(on, new Request(`${ORIGIN}${path}`));
    expect(new TextDecoder().decode(afterPush.bytes)).toContain(newOid);
    expect(infoRefsCalls.length).toBe(afterCold);
  });

  it('proxies upload-pack fetch requests instead of serving an advertisement', async () => {
    const name = `fetch-${crypto.randomUUID().slice(0, 8)}`;
    await seedRepoWithCommit(baseEnv, name, { owner: OWNER, visibility: 'public' });
    const path = `/${OWNER}/${name}.git/git-upload-pack`;
    const body = concat(
      pktLine('command=fetch\n'),
      pktLine('agent=git/2.54.0\n'),
      pktLine('object-format=sha1\n'),
      DELIM_PKT,
      pktLine(`want ${'1'.repeat(40)}\n`),
      pktLine('done\n'),
      FLUSH_PKT,
    );
    const beforeFetch = lsRefsCalls.length;
    const beforeSeed = infoRefsCalls.length;
    const response = await send({ ...baseEnv, GIT_MIRROR_MODE: 'on' } as Env, new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' },
      body,
    }));
    expect(response.status).toBe(200);
    expect(lsRefsCalls).toHaveLength(beforeFetch + 1);
    expect(infoRefsCalls).toHaveLength(beforeSeed);
  });

  it('runs shadow comparisons asynchronously and logs no ref data on mismatch', async () => {
    const name = `shadow-${crypto.randomUUID().slice(0, 8)}`;
    const { id, repo } = await seedRepoWithCommit(baseEnv, name, { owner: OWNER, visibility: 'public' });
    await withFakeArtifacts(id, async (mirror) => {
      await mirror.read(0, `${OWNER}--${name}`, `https://artifacts.invalid/git/default/${OWNER}--${name}.git`, { kind: 'v0' }, id);
    });
    repo.refs.set('refs/heads/main', 'a'.repeat(40));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const response = await send({ ...baseEnv, GIT_MIRROR_MODE: 'shadow' } as Env, new Request(
        `${ORIGIN}/${OWNER}/${name}.git/info/refs?service=git-upload-pack`,
      ));
      expect(response.status).toBe(200);
      const mismatch = warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .find((line) => 'gitMirrorMismatch' in line);
      expect(mismatch).toEqual({ gitMirrorMismatch: { repoId: id, kind: 'v0', seq: 0 } });
      expect(JSON.stringify(mismatch)).not.toContain('refs/');
    } finally {
      warn.mockRestore();
    }
  });

  it('handles zero-OID creates, CAS mismatch, and a reader whose row sequence is ahead', async () => {
    const name = `cas-${crypto.randomUUID().slice(0, 8)}`;
    const { id, repo, main } = await seedRepoWithCommit(baseEnv, name, { owner: OWNER, visibility: 'public' });
    const artifactsName = `${OWNER}--${name}`;
    const remote = `https://artifacts.invalid/git/default/${artifactsName}.git`;
    await withFakeArtifacts(id, async (mirror) => mirror.read(0, artifactsName, remote, { kind: 'v0' }, id));
    const first = '1'.repeat(40);
    const second = '2'.repeat(40);
    await withFakeArtifacts(id, async (mirror) => {
      await mirror.apply(1, [{ ref: 'refs/heads/new', oldOid: '0'.repeat(40), newOid: first }], id);
      const created = await mirror.read(1, artifactsName, remote, { kind: 'ls-refs', options: { prefixes: ['refs/heads/new'], peel: false, symrefs: false } }, id);
      expect(new TextDecoder().decode(created!.bytes)).toContain(first);
      await mirror.apply(2, [{ ref: 'refs/heads/main', oldOid: '3'.repeat(40), newOid: second }], id);
      const beforeMismatch = infoRefsCalls.length;
      expect(await mirror.read(2, artifactsName, remote, { kind: 'v0' }, id)).not.toBeNull();
      expect(infoRefsCalls.length - beforeMismatch).toBe(2);
    });
    const beforeLostApply = infoRefsCalls.length;
    await withFakeArtifacts(id, async (mirror) => mirror.read(3, artifactsName, remote, { kind: 'v0' }, id));
    expect(infoRefsCalls.length - beforeLostApply).toBe(2);
    expect(repo.refs.get('refs/heads/main')).toBe(main);
  });
});
