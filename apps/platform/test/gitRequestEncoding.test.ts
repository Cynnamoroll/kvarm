/**
 * Request body encodings at the git proxy.
 *
 * git gzips upload-pack request bodies larger than 1024 bytes (a fetch or
 * clone naming many refs) and labels them `Content-Encoding: gzip`. Artifacts
 * only reads plain pkt-lines, so the proxy hands upstream the decoded body;
 * forwarding the compressed bytes unlabeled made every such clone fail with
 * HTTP 500.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { internalKey, writeCachedJson } from '../src/cache/internal';
import worker from '../src/index';

const env = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const OWNER = 'enc-owner';
const REPO = 'many-refs';
const ARTIFACTS_NAME = `${OWNER}--${REPO}`;
const REMOTE = `https://artifacts.invalid/git/default/${ARTIFACTS_NAME}.git`;
const FULL: Scope[] = ['read', 'write', 'api'];
const enc = new TextEncoder();
const dec = new TextDecoder();
const originalFetch = globalThis.fetch;
let token = '';

interface Upstream {
  path: string;
  headers: Headers;
  body: string;
}
let upstream: Upstream[] = [];

function pkt(line: string): string {
  return (line.length + 4).toString(16).padStart(4, '0') + line;
}

/** A protocol-v2 fetch request naming `wants` objects: > 1024 bytes for 25. */
function fetchRequest(wants: number): string {
  const lines = ['command=fetch\n', 'agent=git/2.54.0\n', 'object-format=sha1\n'].map(pkt).join('');
  let args = ['thin-pack\n', 'no-progress\n', 'ofs-delta\n'].map(pkt).join('');
  for (let i = 0; i < wants; i++) args += pkt(`want ${i.toString(16).padStart(40, '0')}\n`);
  return `${lines}0001${args}${pkt('done\n')}0000`;
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Response(enc.encode(text)).body!.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function uploadPack(body: BodyInit, encoding?: string): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {
    Authorization: `Basic ${btoa(`x:${token}`)}`,
    'content-type': 'application/x-git-upload-pack-request',
    accept: 'application/x-git-upload-pack-result',
    'git-protocol': 'version=2',
  };
  if (encoding) headers['content-encoding'] = encoding;
  const ctx = createExecutionContext();
  const req = new Request(`${ORIGIN}/${OWNER}/${REPO}.git/git-upload-pack`, { method: 'POST', headers, body });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const text = dec.decode(await res.arrayBuffer());
  await waitOnExecutionContext(ctx);
  return { status: res.status, text };
}

beforeAll(async () => {
  const userId = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  )
    .bind(userId, `test:${OWNER}`, OWNER, `${OWNER}@kvarm.invalid`, OWNER, Date.now())
    .run();
  token = (await mintPAT(env, userId, 'enc', FULL)).token;
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility,
       default_branch, created_at) VALUES (?, ?, ?, ?, ?, 'private', 'main', ?)`,
  )
    .bind(crypto.randomUUID(), OWNER, REPO, ARTIFACTS_NAME, REMOTE, Date.now())
    .run();
  await writeCachedJson(internalKey('gittoken', ARTIFACTS_NAME, 'read'), { token: 'fake', expiresAt: Date.now() + 86_400_000 }, 86_400);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'artifacts.invalid') return originalFetch(input, init);
    const body = init?.body ? dec.decode(await new Response(init.body).arrayBuffer()) : '';
    upstream.push({ path: url.pathname, headers: new Headers(init?.headers), body });
    // Like Artifacts: anything but plain pkt-lines is an internal error.
    if (!/^[0-9a-f]{4}command=/.test(body)) return new Response('Internal Server Error', { status: 500 });
    return new Response(`${pkt('packfile\n')}0000`, {
      headers: { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' },
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  upstream = [];
});

describe('git upload-pack request encodings', () => {
  it('decodes a gzip request body before it reaches upstream', async () => {
    const plain = fetchRequest(25);
    expect(plain.length).toBeGreaterThan(1024);
    const res = await uploadPack(await gzip(plain), 'gzip');
    expect(res.status, res.text).toBe(200);
    expect(res.text).toContain('packfile');
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.body).toBe(plain);
    expect(upstream[0]!.headers.get('content-encoding')).toBeNull();
  });

  it('relays a plain request body unchanged', async () => {
    const plain = fetchRequest(2);
    const res = await uploadPack(plain);
    expect(res.status, res.text).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.body).toBe(plain);
  });

  it('refuses an encoding it cannot decode without calling upstream', async () => {
    const res = await uploadPack(fetchRequest(2), 'br');
    expect(res.status).toBe(415);
    expect(upstream).toHaveLength(0);
  });
});
