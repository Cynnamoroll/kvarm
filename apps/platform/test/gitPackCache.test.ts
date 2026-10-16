import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { concat, DELIM_PKT, FLUSH_PKT, pktLine } from '@kvarm/gitops';
import { mintPAT, type Scope } from '../src/auth/pat';
import { recordConfirmedPush } from '../src/services/pushFreshness';
import worker from '../src/index';
import { classifyUploadPackRequest, derivePackCacheKey } from '../src/git/packCache';
import { ORIGIN, send } from './helpers/http';
import { fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';
import { seedRepoWithCommit, seedUser } from './helpers/seed';

const env = { ...(cfEnv as unknown as Env), ARTIFACTS: fakeArtifacts, GIT_MIRROR_MODE: 'off', GIT_PACK_CACHE: 'on' } as Env;
const OWNER = 'git-pack-cache';
const FULL: Scope[] = ['read', 'write', 'api'];
const OID = 'a'.repeat(40);
let token = '';
let userId = '';

interface Fixture {
  id: string;
  name: string;
  repo: ReturnType<typeof fakeRepos.get> & {};
  artifactsName: string;
  upstreamCalls: number;
}

function fetchRequest(oid = OID, have?: string): Uint8Array {
  return concat(
    pktLine('command=fetch\n'),
    pktLine('agent=git/2.34.1\n'),
    pktLine('object-format=sha1\n'),
    DELIM_PKT,
    pktLine(`want ${oid}\n`),
    ...(have ? [pktLine(`have ${have}\n`)] : []),
    pktLine('done\n'),
    FLUSH_PKT,
  );
}

function packResponse(): Uint8Array {
  return concat(
    pktLine('acknowledgments\n'),
    DELIM_PKT,
    pktLine('packfile\n'),
    pktLine(new Uint8Array([1, 80, 65, 67, 75, 1, 2, 3])),
    FLUSH_PKT,
  );
}

async function createFixture(name: string, visibility: 'public' | 'private' = 'public'): Promise<Fixture> {
  const repoName = `${name}-${crypto.randomUUID().slice(0, 8)}`;
  const seeded = await seedRepoWithCommit(env, repoName, { owner: OWNER, visibility });
  let artifactsName = '';
  const row = await env.DB.prepare('SELECT artifacts_name FROM repos WHERE id = ?').bind(seeded.id).first<{ artifacts_name: string }>();
  artifactsName = row!.artifacts_name;
  const fixture = { id: seeded.id, name: repoName, repo: seeded.repo, artifactsName, upstreamCalls: 0 };
  seeded.repo.gitRemoteHandler = (url, request) => {
    if (request.method === 'GET') return new Response('unexpected info/refs', { status: 500 });
    fixture.upstreamCalls++;
    return new Response(packResponse(), {
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
    });
  };
  return fixture;
}

async function upload(fixture: Fixture, body = fetchRequest(), auth?: string, requestEnv = env) {
  return send(
    requestEnv,
    new Request(`${ORIGIN}/${OWNER}/${fixture.name}.git/git-upload-pack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-git-upload-pack-request',
        'Git-Protocol': 'version=2',
        ...(auth ? { Authorization: `Basic ${btoa(`x:${auth}`)}` } : {}),
      },
      body,
    }),
  );
}

beforeAll(async () => {
  userId = await seedUser(env, OWNER);
  token = (await mintPAT(env, userId, 'git-pack-cache', FULL)).token;
  installFakeGitRemote();
});

afterAll(() => restoreFetch());

describe('upload-pack response cache', () => {
  it('serves a second identical clone request from Cache API with no Artifacts call', async () => {
    const fixture = await createFixture('cache-hit');
    const first = await upload(fixture);
    const second = await upload(fixture);

    expect(first.status).toBe(200);
    expect(first.cost.cache).toBe('miss');
    expect(second.status).toBe(200);
    expect(second.cost.cache).toBe('hit');
    expect(second.cost.art).toBe(0);
    expect(second.headers.get('content-type')).toBe('application/x-git-upload-pack-result');
    expect(second.bytes).toEqual(first.bytes);
    expect(fixture.upstreamCalls).toBe(1);
  });

  it('uses ref_seq in the cache key so a confirmed push causes a miss', async () => {
    const fixture = await createFixture('ref-seq');
    expect((await upload(fixture)).cost.cache).toBe('miss');
    await recordConfirmedPush(env, fixture.id, [{
      ref: 'refs/heads/main',
      oldOid: '0'.repeat(40),
      newOid: '1'.repeat(40),
    }]);

    const response = await upload(fixture);
    expect(response.cost.cache).toBe('miss');
    expect(fixture.upstreamCalls).toBe(2);
  });

  it('authorizes a private repository before serving a cached hit', async () => {
    const fixture = await createFixture('private-auth', 'private');
    expect((await upload(fixture, fetchRequest(), token)).status).toBe(200);

    const denied = await upload(fixture);
    expect(denied.status).toBe(401);
    expect(fixture.upstreamCalls).toBe(1);
  });

  it('does not cache an upstream stream that errors before completion', async () => {
    const fixture = await createFixture('truncated');
    fixture.repo.gitRemoteHandler = () => {
      fixture.upstreamCalls++;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(concat(pktLine('acknowledgments\n'), DELIM_PKT, pktLine('packfile\n')));
          controller.error(new Error('simulated truncated upload-pack'));
        },
      }), { headers: { 'content-type': 'application/x-git-upload-pack-result' } });
    };

    const ctx = createExecutionContext();
    const response = await worker.fetch!(
      new Request(`${ORIGIN}/${OWNER}/${fixture.name}.git/git-upload-pack`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-git-upload-pack-request', 'Git-Protocol': 'version=2' },
        body: fetchRequest(),
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      ctx,
    );
    await expect(response.arrayBuffer()).rejects.toThrow();
    await waitOnExecutionContext(ctx);

    fixture.repo.gitRemoteHandler = () => {
      fixture.upstreamCalls++;
      return new Response(packResponse(), { headers: { 'content-type': 'application/x-git-upload-pack-result' } });
    };
    const next = await upload(fixture);
    expect(next.cost.cache).toBe('miss');
    expect(fixture.upstreamCalls).toBe(2);
  });

  it('does not cache an ERR pkt-line response', async () => {
    const fixture = await createFixture('err-pkt');
    fixture.repo.gitRemoteHandler = () => {
      fixture.upstreamCalls++;
      return new Response(concat(pktLine('ERR repository unavailable\n'), FLUSH_PKT), {
        headers: { 'content-type': 'application/x-git-upload-pack-result' },
      });
    };
    const error = await upload(fixture);
    expect(error.text).toContain('ERR repository unavailable');
    expect(error.cost.cache).toBe('miss');

    fixture.repo.gitRemoteHandler = () => {
      fixture.upstreamCalls++;
      return new Response(packResponse(), { headers: { 'content-type': 'application/x-git-upload-pack-result' } });
    };
    expect((await upload(fixture)).cost.cache).toBe('miss');
    expect(fixture.upstreamCalls).toBe(2);
  });

  it('bypasses pack caching for protocol-v2 ls-refs requests', async () => {
    const fixture = await createFixture('ls-refs');
    const body = concat(
      pktLine('command=ls-refs\n'),
      DELIM_PKT,
      pktLine('peel\n'),
      pktLine('symrefs\n'),
      pktLine('ref-prefix refs/heads/\n'),
      FLUSH_PKT,
    );

    const response = await upload(fixture, body);

    expect(response.status).toBe(200);
    expect(response.cost.cache).toBe('bypass');
    expect(fixture.upstreamCalls).toBe(1);
  });

  it('reads clone-shaped requests from R2, backfills Cache API, and excludes haves from R2', async () => {
    const fixture = await createFixture('r2-tier');
    const request = fetchRequest();
    const first = await upload(fixture, request);
    const refSeq = 0;
    const parsedRequest = new TextDecoder().decode(request);
    expect(parsedRequest).toContain('command=fetch');
    const classification = classifyUploadPackRequest(request, 'v2');
    const hash = await derivePackCacheKey(fixture.id, refSeq, 'v2', classification.normalized!);
    const cacheUrl = `https://kvarm-git.internal/pack/${fixture.id}/${refSeq}/${hash}`;
    const r2key = `fetch/${fixture.id}/${hash}`;
    const stored = await env.SNAPSHOTS.head(r2key);
    expect(stored?.customMetadata).toEqual({ refSeq: '0', contentType: 'application/x-git-upload-pack-result' });
    expect(first.cost.cache).toBe('miss');
    expect(await caches.default.delete(cacheUrl)).toBe(true);

    const second = await upload(fixture, request);
    expect(second.cost.cache).toBe('r2');
    expect(second.cost.art).toBe(0);
    expect(second.cost.r2b).toBe(1);
    expect(fixture.upstreamCalls).toBe(1);
    expect(await caches.default.match(cacheUrl)).not.toBeNull();

    const incremental = await upload(fixture, fetchRequest(OID, 'b'.repeat(40)));
    expect(incremental.cost.cache).toBe('miss');
    expect(fixture.upstreamCalls).toBe(2);
  });

  it('does not share identical request bodies across repositories', async () => {
    const firstFixture = await createFixture('cross-repo-a');
    const secondFixture = await createFixture('cross-repo-b');
    expect((await upload(firstFixture)).cost.cache).toBe('miss');
    expect((await upload(secondFixture)).cost.cache).toBe('miss');
    expect(firstFixture.id).not.toBe(secondFixture.id);
    expect(firstFixture.upstreamCalls).toBe(1);
    expect(secondFixture.upstreamCalls).toBe(1);
  });

  it('replays an upload-pack body larger than the parsing limit unchanged', async () => {
    const fixture = await createFixture('oversized-request');
    const original = new Uint8Array(1024 * 1024 + 17).fill(0x5a);
    let received: Uint8Array | null = null;
    fixture.repo.gitRemoteHandler = async (_url, request) => {
      fixture.upstreamCalls++;
      received = new Uint8Array(await request.arrayBuffer());
      return new Response(packResponse(), { headers: { 'content-type': 'application/x-git-upload-pack-result' } });
    };

    const response = await upload(fixture, original);
    expect(response.cost.cache).toBe('bypass');
    expect(received).toEqual(original);
  });

  it('does not cache when the flag is unset', async () => {
    const fixture = await createFixture('flag-off');
    const offEnv = { ...env, GIT_PACK_CACHE: undefined } as Env;
    expect((await upload(fixture, fetchRequest(), undefined, offEnv)).cost.cache).toBe('none');
    expect((await upload(fixture, fetchRequest(), undefined, offEnv)).cost.cache).toBe('none');
    expect(fixture.upstreamCalls).toBe(2);
  });
});
