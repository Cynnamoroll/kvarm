import { env as cfEnv } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { concat, DELIM_PKT, FLUSH_PKT, pktLine, ZERO_OID } from '@kvarm/gitops';
import { mintPAT, type Scope } from '../src/auth/pat';
import { parseCostHeader } from '../src/cost/meter';
import { ORIGIN, send } from './helpers/http';
import { commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';
import { seedRepoWithCommit, seedUser } from './helpers/seed';

const env = { ...(cfEnv as unknown as Env), ARTIFACTS: fakeArtifacts } as Env;
const OWNER = 'git-path-cost';
const FULL: Scope[] = ['read', 'write', 'api'];
let token = '';

const call = (path: string, init: RequestInit = {}) => send(env, new Request(`${ORIGIN}${path}`, init));

function basic(): Record<string, string> {
  return { Authorization: `Basic ${btoa(`x:${token}`)}` };
}

function uploadPackRequest(): Uint8Array {
  return concat(
    pktLine('command=ls-refs\n'),
    pktLine('agent=git/2.34.1\n'),
    pktLine('object-format=sha1\n'),
    DELIM_PKT,
    pktLine('peel\n'),
    pktLine('ref-prefix refs/heads/\n'),
    FLUSH_PKT,
  );
}

function receivePackRequest(oldOid: string, newOid: string, ref: string): Uint8Array {
  return concat(pktLine(`${oldOid} ${newOid} ${ref}\0report-status agent=git/2.34.1\n`), FLUSH_PKT);
}

async function cost(label: string, path: string, init: RequestInit = {}) {
  const res = await call(path, init);
  const status = res.status;
  const counters = parseCostHeader(res.headers.get('x-kvarm-cost'));
  expect(counters, label).not.toBeNull();
  return { label, status, ...counters! };
}

beforeAll(async () => {
  const userId = await seedUser(env, OWNER);
  token = (await mintPAT(env, userId, 'git-path-cost', FULL)).token;
  const pub = await seedRepoWithCommit(env, 'public', { owner: OWNER, visibility: 'public' });
  const priv = await seedRepoWithCommit(env, 'private', { owner: OWNER, visibility: 'private' });
  await commit(pub.repo, { 'README.md': 'updated\n' }, [pub.main]);
  installFakeGitRemote();
  // The private repo is seeded too so both advertisement paths exercise the same upstream.
  expect(priv.repo.refs.get('refs/heads/main')).toBeTruthy();
});

afterAll(() => restoreFetch());

describe('git-path cost baseline', () => {
  it('snapshots cold and warm costs for read, ls-refs, advertisement, and receive-pack paths', async () => {
    const rows: Array<Record<string, unknown>> = [];
    for (const label of ['public anon cold', 'public anon warm']) {
      rows.push(await cost(label, `/${OWNER}/public.git/info/refs?service=git-upload-pack`));
    }
    for (const label of ['private PAT cold', 'private PAT warm']) {
      rows.push(await cost(label, `/${OWNER}/private.git/info/refs?service=git-upload-pack`, { headers: basic() }));
    }
    for (const label of ['upload-pack cold', 'upload-pack warm']) {
      rows.push(
        await cost(label, `/${OWNER}/public.git/git-upload-pack`, {
          method: 'POST',
          headers: { 'Git-Protocol': 'version=2', 'content-type': 'application/x-git-upload-pack-request' },
          body: uploadPackRequest(),
        }),
      );
    }
    for (const label of ['receive advertisement cold', 'receive advertisement warm']) {
      rows.push(await cost(label, `/${OWNER}/public.git/info/refs?service=git-receive-pack`, { headers: basic() }));
    }
    const repo = await env.DB.prepare('SELECT artifacts_name FROM repos WHERE owner_login = ? AND name = ?')
      .bind(OWNER, 'public')
      .first<{ artifacts_name: string }>();
    const fake = fakeRepos.get(repo!.artifacts_name)!;
    const oldOid = fake.refs.get('refs/heads/main')!;
    const createCold = await commit(fake, { 'README.md': 'create cold\n' }, [oldOid]);
    const createWarm = await commit(fake, { 'README.md': 'create warm\n' }, [oldOid]);
    for (const [label, to, ref] of [
      ['receive-pack create cold', createCold.sha, 'refs/heads/cost-create-cold'],
      ['receive-pack create warm', createWarm.sha, 'refs/heads/cost-create-warm'],
    ] as const) {
      rows.push(
        await cost(label, `/${OWNER}/public.git/git-receive-pack`, {
          method: 'POST',
          headers: { ...basic(), 'content-type': 'application/x-git-receive-pack-request' },
          body: receivePackRequest(ZERO_OID, to, ref),
        }),
      );
    }
    const updateCold = await commit(fake, { 'README.md': 'update cold\n' }, [oldOid]);
    const updateWarm = await commit(fake, { 'README.md': 'update warm\n' }, [oldOid]);
    fake.refs.set('refs/heads/cost-update-cold', oldOid);
    fake.refs.set('refs/heads/cost-update-warm', oldOid);
    for (const [label, to, ref] of [
      ['receive-pack update cold', updateCold.sha, 'refs/heads/cost-update-cold'],
      ['receive-pack update warm', updateWarm.sha, 'refs/heads/cost-update-warm'],
    ] as const) {
      rows.push(
        await cost(label, `/${OWNER}/public.git/git-receive-pack`, {
          method: 'POST',
          headers: { ...basic(), 'content-type': 'application/x-git-receive-pack-request' },
          body: receivePackRequest(oldOid, to, ref),
        }),
      );
    }
    expect(rows.every((row) => row.status === 200)).toBe(true);
    expect(rows).toMatchInlineSnapshot(`
      [
        {
          "art": 2,
          "cache": "miss",
          "d1": 1,
          "do": 0,
          "label": "public anon cold",
          "q": 0,
          "r2a": 0,
          "r2b": 0,
          "rr": 1,
          "rw": 0,
          "status": 200,
          "sub": 1,
        },
        {
          "art": 0,
          "cache": "hit",
          "d1": 1,
          "do": 0,
          "label": "public anon warm",
          "q": 0,
          "r2a": 0,
          "r2b": 0,
          "rr": 1,
          "rw": 0,
          "status": 200,
          "sub": 0,
        },
        {
          "art": 2,
          "cache": "none",
          "d1": 1,
          "do": 0,
          "label": "private PAT cold",
          "q": 0,
          "r2a": 0,
          "r2b": 0,
          "rr": 6,
          "rw": 1,
          "status": 200,
          "sub": 1,
        },
        {
          "art": 0,
          "cache": "none",
          "d1": 1,
          "do": 0,
          "label": "private PAT warm",
          "q": 0,
          "r2a": 0,
          "r2b": 0,
          "rr": 4,
          "rw": 0,
          "status": 200,
          "sub": 1,
        },
        {
          "art": 0,
          "cache": "none",
          "d1": 1,
          "do": 0,
          "label": "upload-pack cold",
          "q": 0,
          "r2a": 0,
          "r2b": 0,
          "rr": 1,
          "rw": 0,
          "status": 200,
          "sub": 1,
        },
        {
          "art": 0,
          "cache": "none",
          "d1": 1,
          "do": 0,
          "label": "upload-pack warm",
          "q": 0,
          "r2a": 0,
          "r2b": 0,
          "rr": 1,
          "rw": 0,
          "status": 200,
          "sub": 1,
        },
        {
          "art": 2,
          "cache": "none",
          "d1": 1,
          "do": 0,
          "label": "receive advertisement cold",
          "q": 0,
          "r2a": 0,
          "r2b": 0,
          "rr": 4,
          "rw": 0,
          "status": 200,
          "sub": 1,
        },
        {
          "art": 0,
          "cache": "none",
          "d1": 1,
          "do": 0,
          "label": "receive advertisement warm",
          "q": 0,
          "r2a": 0,
          "r2b": 0,
          "rr": 4,
          "rw": 0,
          "status": 200,
          "sub": 1,
        },
        {
          "art": 0,
          "cache": "none",
          "d1": 1,
          "do": 0,
          "label": "receive-pack create cold",
          "q": 0,
          "r2a": 0,
          "r2b": 0,
          "rr": 5,
          "rw": 0,
          "status": 200,
          "sub": 1,
        },
        {
          "art": 0,
          "cache": "none",
          "d1": 1,
          "do": 0,
          "label": "receive-pack create warm",
          "q": 0,
          "r2a": 0,
          "r2b": 0,
          "rr": 5,
          "rw": 0,
          "status": 200,
          "sub": 1,
        },
        {
          "art": 0,
          "cache": "none",
          "d1": 1,
          "do": 0,
          "label": "receive-pack update cold",
          "q": 0,
          "r2a": 0,
          "r2b": 0,
          "rr": 5,
          "rw": 0,
          "status": 200,
          "sub": 1,
        },
        {
          "art": 0,
          "cache": "none",
          "d1": 1,
          "do": 0,
          "label": "receive-pack update warm",
          "q": 0,
          "r2a": 0,
          "r2b": 0,
          "rr": 5,
          "rw": 0,
          "status": 200,
          "sub": 1,
        },
      ]
    `);
  });
});
