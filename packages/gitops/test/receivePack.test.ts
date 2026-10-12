/**
 * Smart-HTTP receive-pack client. A fetch bridge runs real `git http-backend`
 * (CGI) over a local bare repo, so advertisement, pack, command framing and
 * report-status all go through git itself. Hand-written replies cover the
 * framings git does not produce on demand (Artifacts' `stale ref`, truncated
 * and fatal replies, transport failures).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  advertiseReceivePack,
  buildBlob,
  buildCommit,
  buildReportStatus,
  buildTree,
  concat,
  EMPTY_PACK,
  encode,
  isStaleRefReason,
  pktLine,
  pushRefs,
  readPktLines,
  ReceivePackError,
  updateRef,
  writePack,
  ZERO_OID,
  type FetchLike,
  type GitObject,
  type ReceivePackRemote,
} from '../src/index';

const AUTH = 'Basic ' + Buffer.from('kvarm:test-token').toString('base64');

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gitops-receive-pack-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(args: string[]): string {
  const r = spawnSync('git', args, { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function refsOf(bare: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of git(['-C', bare, 'for-each-ref', '--format=%(refname) %(objectname)']).split('\n')) {
    if (!line) continue;
    const [name, oid] = line.split(' ');
    out[name!] = oid!;
  }
  return out;
}

async function bodyBytes(body: RequestInit['body']): Promise<Uint8Array> {
  if (body == null) return new Uint8Array(0);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** A fetch that serves `<root>/<name>.git` through `git http-backend`, requiring AUTH. */
function httpBackend(requests?: { url: string; init: RequestInit; body: Uint8Array }[]): FetchLike {
  return async (input, init = {}) => {
    const url = new URL(input);
    const body = await bodyBytes(init.body);
    requests?.push({ url: input, init, body });
    const headers = new Headers(init.headers);
    if (headers.get('authorization') !== AUTH) return new Response('auth required\n', { status: 401 });
    const r = spawnSync('git', ['http-backend'], {
      input: body,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        REMOTE_USER: 'kvarm',
        REQUEST_METHOD: init.method ?? 'GET',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: headers.get('content-type') ?? '',
        CONTENT_LENGTH: String(body.length),
      },
    });
    const out = new Uint8Array(r.stdout);
    const sep = Buffer.from(out).indexOf('\r\n\r\n');
    const head = Buffer.from(out.subarray(0, sep)).toString();
    const resHeaders = new Headers();
    let status = 200;
    for (const line of head.split('\r\n')) {
      const i = line.indexOf(':');
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k.toLowerCase() === 'status') status = parseInt(v, 10);
      else resHeaders.append(k, v);
    }
    return new Response(status === 204 ? null : out.subarray(sep + 4), { status, headers: resHeaders });
  };
}

function freshBare(name: string, config: [string, string][] = []): { bare: string; remote: ReceivePackRemote } {
  const bare = join(root, `${name}.git`);
  git(['init', '-q', '--bare', '-b', 'main', bare]);
  for (const [k, v] of config) git(['-C', bare, 'config', k, v]);
  return { bare, remote: { url: `http://git.test/${name}.git`, authorization: AUTH, fetch: httpBackend() } };
}

let tick = 0;
async function commit(parents: string[], file: string): Promise<{ commit: GitObject; objects: GitObject[] }> {
  const blob = await buildBlob(encode(file));
  const tree = await buildTree([{ mode: '100644', name: 'file.txt', hash: blob.hash }]);
  const ident = { name: 'Kvarm', email: 'kvarm@kvarm.invalid', time: 1_790_000_000 + tick++ };
  const c = await buildCommit({ tree: tree.hash, parents, author: ident, committer: ident, message: file });
  return { commit: c, objects: [c, tree, blob] };
}

describe('receive-pack client against git http-backend', () => {
  it('advertises an empty repository with its capabilities', async () => {
    const { remote } = freshBare('empty');
    const adv = await advertiseReceivePack(remote);
    expect(adv.refs.size).toBe(0);
    expect(adv.capabilities).toEqual(expect.arrayContaining(['report-status', 'delete-refs']));
  });

  it('creates, fast-forwards and deletes refs, confirmed by report-status and the repo', async () => {
    const { bare, remote } = freshBare('lifecycle');
    const c0 = await commit([], 'zero\n');
    const created = await updateRef(remote, { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: c0.commit.hash }, await writePack(c0.objects));
    expect(created).toMatchObject({ status: 'ok', httpStatus: 200 });
    expect(refsOf(bare)).toEqual({ 'refs/heads/main': c0.commit.hash });

    // A pure ref move to an existing commit sends the empty pack.
    const scratch = await updateRef(remote, { ref: 'refs/heads/scratch/a', oldOid: ZERO_OID, newOid: c0.commit.hash });
    expect(scratch.status).toBe('ok');

    const c1 = await commit([c0.commit.hash], 'one\n');
    const ff = await updateRef(remote, { ref: 'refs/heads/main', oldOid: c0.commit.hash, newOid: c1.commit.hash }, await writePack(c1.objects));
    expect(ff.status).toBe('ok');

    const adv = await advertiseReceivePack(remote);
    expect(Object.fromEntries(adv.refs)).toEqual({ 'refs/heads/main': c1.commit.hash, 'refs/heads/scratch/a': c0.commit.hash });

    const deleted = await updateRef(remote, { ref: 'refs/heads/scratch/a', oldOid: c0.commit.hash, newOid: ZERO_OID });
    expect(deleted.status).toBe('ok');
    expect(refsOf(bare)).toEqual({ 'refs/heads/main': c1.commit.hash });
    expect(git(['-C', bare, 'fsck', '--strict', '--no-dangling'])).toBe('');
  });

  it('treats ng on HTTP 200 as failure: a stale old OID is a CAS conflict and the ref stays put', async () => {
    const { bare, remote } = freshBare('stale');
    const c0 = await commit([], 'a\n');
    const c1 = await commit([c0.commit.hash], 'b\n');
    await updateRef(remote, { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: c0.commit.hash }, await writePack(c0.objects));
    await updateRef(remote, { ref: 'refs/heads/side', oldOid: ZERO_OID, newOid: c0.commit.hash });

    const stale = await updateRef(remote, { ref: 'refs/heads/main', oldOid: c1.commit.hash, newOid: c0.commit.hash });
    expect(stale).toMatchObject({ status: 'stale', httpStatus: 200, reason: 'incorrect old value provided' });

    const createOnExisting = await updateRef(remote, { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: c1.commit.hash }, await writePack(c1.objects));
    expect(createOnExisting).toMatchObject({ status: 'stale', httpStatus: 200, reason: 'reference already exists' });

    const staleDelete = await updateRef(remote, { ref: 'refs/heads/side', oldOid: c1.commit.hash, newOid: ZERO_OID });
    expect(staleDelete).toMatchObject({ status: 'stale', httpStatus: 200 });

    expect(refsOf(bare)).toEqual({ 'refs/heads/main': c0.commit.hash, 'refs/heads/side': c0.commit.hash });
  });

  it('surfaces non-stale ng reasons as rejected', async () => {
    const { bare, remote } = freshBare('nonff', [['receive.denyNonFastForwards', 'true']]);
    const c0 = await commit([], 'a\n');
    const sibling = await commit([], 'b\n');
    await updateRef(remote, { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: c0.commit.hash }, await writePack(c0.objects));
    for (const sideband of [true, false]) {
      const r = await updateRef(
        remote,
        { ref: 'refs/heads/main', oldOid: c0.commit.hash, newOid: sibling.commit.hash },
        await writePack(sibling.objects),
        { sideband },
      );
      expect(r).toMatchObject({ status: 'rejected', httpStatus: 200, reason: 'non-fast-forward' });
    }
    expect(refsOf(bare)['refs/heads/main']).toBe(c0.commit.hash);
  });

  it('reports each ref of a multi-ref push separately and never implies atomicity', async () => {
    const { bare, remote } = freshBare('multi');
    const c0 = await commit([], 'a\n');
    const c1 = await commit([c0.commit.hash], 'b\n');
    await updateRef(remote, { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: c0.commit.hash }, await writePack(c0.objects));
    const r = await pushRefs(remote, {
      commands: [
        { ref: 'refs/heads/new', oldOid: ZERO_OID, newOid: c0.commit.hash },
        { ref: 'refs/heads/main', oldOid: c1.commit.hash, newOid: c0.commit.hash },
      ],
      pack: await writePack(c1.objects),
    });
    expect(r.ok).toBe(false);
    expect(r.refs.map((x) => [x.ref, x.status])).toEqual([
      ['refs/heads/new', 'ok'],
      ['refs/heads/main', 'stale'],
    ]);
    // git's own receive-pack is non-atomic by default: the good ref landed.
    expect(refsOf(bare)['refs/heads/new']).toBe(c0.commit.hash);
  });

  it('fails cleanly without credentials', async () => {
    const { remote } = freshBare('auth');
    const anon = { ...remote, authorization: undefined };
    await expect(advertiseReceivePack(anon)).rejects.toMatchObject({ name: 'ReceivePackError', httpStatus: 401 });
    const c0 = await commit([], 'a\n');
    const r = await updateRef(anon, { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: c0.commit.hash }, await writePack(c0.objects));
    expect(r).toMatchObject({ status: 'rejected', httpStatus: 401 });
  });
});

describe('receive-pack request framing', () => {
  async function capture(commands: Parameters<typeof pushRefs>[1]) {
    const seen: { url: string; init: RequestInit; body: Uint8Array }[] = [];
    const fetch: FetchLike = async (url, init = {}) => {
      seen.push({ url, init, body: await bodyBytes(init.body) });
      return new Response(buildReportStatus([], 'none') as Uint8Array<ArrayBuffer>, { status: 200 });
    };
    await pushRefs({ url: 'https://h/r.git', authorization: AUTH, fetch }, commands);
    return seen[0]!;
  }

  it('sends one command line with capabilities, a flush and the pack, with auth and content type', async () => {
    const oid = 'a'.repeat(40);
    const req = await capture({ commands: [{ ref: 'refs/heads/x', oldOid: ZERO_OID, newOid: oid }] });
    expect(req.url).toBe('https://h/r.git/git-receive-pack');
    expect(req.init.method).toBe('POST');
    const h = new Headers(req.init.headers);
    expect(h.get('authorization')).toBe(AUTH);
    expect(h.get('content-type')).toBe('application/x-git-receive-pack-request');
    expect(h.get('accept')).toBe('application/x-git-receive-pack-result');
    const pkts = readPktLines(req.body.subarray(0, req.body.length - EMPTY_PACK.length));
    expect(new TextDecoder().decode(pkts[0]!.data)).toBe(`${ZERO_OID} ${oid} refs/heads/x\0report-status side-band-64k agent=kvarm-gitops\n`);
    expect(pkts[1]!.flush).toBe(true);
    expect(req.body.subarray(req.body.length - EMPTY_PACK.length)).toEqual(EMPTY_PACK);
  });

  it('sends no pack for delete-only pushes', async () => {
    const oid = 'b'.repeat(40);
    const req = await capture({ commands: [{ ref: 'refs/heads/x', oldOid: oid, newOid: ZERO_OID }], sideband: false });
    expect(req.body).toEqual(concat(pktLine(`${oid} ${ZERO_OID} refs/heads/x\0report-status agent=kvarm-gitops\n`), encode('0000')));
  });

  it('refuses malformed commands before any request', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('must not be called');
    };
    const remote = { url: 'https://h/r.git', fetch };
    const good = 'c'.repeat(40);
    for (const commands of [
      [],
      [{ ref: 'refs/heads/x', oldOid: 'zz', newOid: good }],
      [{ ref: 'HEAD', oldOid: ZERO_OID, newOid: good }],
      [{ ref: 'refs/heads/a b', oldOid: ZERO_OID, newOid: good }],
      [
        { ref: 'refs/heads/x', oldOid: ZERO_OID, newOid: good },
        { ref: 'refs/heads/x', oldOid: ZERO_OID, newOid: good },
      ],
    ]) {
      await expect(pushRefs(remote, { commands })).rejects.toBeInstanceOf(TypeError);
    }
  });
});

describe('report-status outcomes from hand-written replies', () => {
  const cmd = { ref: 'refs/heads/main', oldOid: 'a'.repeat(40), newOid: 'b'.repeat(40) };
  const reply = (body: Uint8Array | string, status = 200): FetchLike => async () =>
    new Response((typeof body === 'string' ? encode(body) : body) as Uint8Array<ArrayBuffer>, { status });
  const run = (fetch: FetchLike) => updateRef({ url: 'https://h/r.git', fetch }, cmd);

  it('one-ref CAS: Artifacts `ng <ref> stale ref` on HTTP 200 is stale, not success', async () => {
    // Byte-for-byte the plain report Artifacts returned for a stale old OID.
    const body = concat(pktLine('unpack ok\n'), pktLine('ng refs/heads/main stale ref\n'), encode('0000'));
    expect(await run(reply(body))).toEqual({ status: 'stale', reason: 'stale ref', httpStatus: 200 });
    const banded = buildReportStatus([{ ref: 'refs/heads/main', ok: false, reason: 'stale ref' }], 'side-band-64k');
    expect(await run(reply(banded))).toEqual({ status: 'stale', reason: 'stale ref', httpStatus: 200 });
  });

  it('confirms ok only from a complete report', async () => {
    const ok = buildReportStatus([{ ref: 'refs/heads/main', ok: true }], 'side-band-64k');
    expect(await run(reply(ok))).toEqual({ status: 'ok', httpStatus: 200 });
    // Truncated: the outer flush never arrived.
    expect((await run(reply(ok.subarray(0, ok.length - 4)))).status).toBe('unknown');
  });

  it('an unpack failure rejects every ref even if an ok line follows', async () => {
    const body = concat(pktLine('unpack index-pack abnormal exit\n'), pktLine('ok refs/heads/main\n'), encode('0000'));
    expect(await run(reply(body))).toMatchObject({ status: 'rejected', reason: 'unpack failed: index-pack abnormal exit' });
  });

  it('a reply without a line for the ref is unknown', async () => {
    const body = buildReportStatus([{ ref: 'refs/heads/other', ok: true }], 'none');
    expect(await run(reply(body))).toMatchObject({ status: 'unknown' });
  });

  it('server errors, fatal band messages and transport failures are unknown, never ok', async () => {
    expect(await run(reply('boom', 500))).toMatchObject({ status: 'unknown', httpStatus: 500 });
    const fatal = concat(pktLine(concat(new Uint8Array([3]), encode('fatal: disk full\n'))), encode('0000'));
    expect(await run(reply(fatal))).toMatchObject({ status: 'unknown', httpStatus: 200 });
    expect(await run(reply('<html>proxy error</html>'))).toMatchObject({ status: 'unknown' });
    const broken: FetchLike = async () => {
      throw new Error('connection reset');
    };
    expect(await run(broken)).toEqual({ status: 'unknown', httpStatus: 0, error: 'Error: connection reset' });
  });

  it('advertisement errors are typed', async () => {
    const remote = (fetch: FetchLike) => ({ url: 'https://h/r.git', fetch });
    await expect(advertiseReceivePack(remote(reply('nope', 404)))).rejects.toBeInstanceOf(ReceivePackError);
    // A dumb-HTTP or HTML answer is not a smart advertisement.
    await expect(advertiseReceivePack(remote(reply('<html></html>')))).rejects.toMatchObject({ httpStatus: 200 });
  });
});

describe('isStaleRefReason', () => {
  it('recognises old-OID mismatch reasons from Artifacts and git', () => {
    for (const r of ['stale ref', 'incorrect old value provided', 'reference already exists', 'failed to lock', 'cannot lock ref']) {
      expect(isStaleRefReason(r), r).toBe(true);
    }
    for (const r of ['non-fast-forward', 'deny updating a hidden ref', 'pre-receive hook declined', 'atomic transaction aborted']) {
      expect(isStaleRefReason(r), r).toBe(false);
    }
  });
});
