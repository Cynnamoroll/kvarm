import { runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DELIM_PKT, FLUSH_PKT, concat, decode, pktLine, readPktLines } from '@kvarm/gitops';
import { parseLsRefsRequest, RepoMirror } from '../src/do/repoMirror';
import { recordConfirmedPush } from '../src/services/pushFreshness';
import { fakeArtifacts, installFakeGitRemote, restoreFetch, type FakeRepo } from './helpers/fakeArtifacts';
import { ORIGIN, send } from './helpers/http';
import { seedRepoWithCommit } from './helpers/seed';
import { env as cfEnv } from 'cloudflare:workers';
import { fixture, type GitDifferentialState } from './repoMirrorGitDifferential.fixture';

const baseEnv = { ...(cfEnv as unknown as Env), ARTIFACTS: fakeArtifacts } as Env;
const OWNER = 'repo-mirror-git';
const LS_REFS_OPTIONS = [
  [],
  ['peel'],
  ['symrefs'],
  ['ref-prefix refs/heads/'],
  ['peel', 'symrefs', 'ref-prefix refs/tags/'],
];

function lsRefsRequest(options: string[]): Uint8Array {
  return concat(
    pktLine('command=ls-refs\n'),
    pktLine('agent=git/2.34.1\n'),
    pktLine('object-format=sha1\n'),
    DELIM_PKT,
    ...options.map((option) => pktLine(`${option}\n`)),
    FLUSH_PKT,
  );
}

function bytes(base64: string): Uint8Array {
  const raw = atob(base64);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function uploadResponse(body: Uint8Array, contentType: string): Response {
  return new Response(body, { headers: { 'content-type': contentType, 'cache-control': 'no-cache' } });
}

interface FixtureRemote {
  advance(): void;
}

function installFixtureRemote(repo: FakeRepo, states: GitDifferentialState[]): FixtureRemote {
  let state = 0;
  let lsRefs = 0;
  repo.gitRemoteHandler = async (url, request) => {
    const current = states[state]!;
    if (url.pathname.endsWith('/info/refs')) {
      const protocol = request.headers.get('git-protocol') === 'version=2' ? current.v2 : current.v0;
      return uploadResponse(bytes(protocol), 'application/x-git-upload-pack-advertisement');
    }
    if (url.pathname.endsWith('/git-upload-pack')) {
      return uploadResponse(bytes(current.lsRefs[lsRefs++]!), 'application/x-git-upload-pack-result');
    }
    return new Response('bad', { status: 404 });
  };
  return {
    advance() {
      state++;
      lsRefs = 0;
    },
  };
}

function v0Capabilities(body: Uint8Array): string | null {
  const packet = readPktLines(body).find((entry) => !entry.flush && decode(entry.data).includes('\0'));
  if (!packet || packet.flush) return null;
  const line = decode(packet.data);
  return line.slice(line.indexOf('\0') + 1).replace(/\n$/, '');
}

function withoutV0Capabilities(body: Uint8Array): string[] {
  return readPktLines(body).map((entry) => {
    if (entry.flush) return 'flush';
    const line = decode(entry.data);
    const nul = line.indexOf('\0');
    return nul < 0 ? line : `${line.slice(0, nul)}\0`;
  });
}

function expectV0Equivalent(expected: Uint8Array, actual: Uint8Array): void {
  const expectedCaps = v0Capabilities(expected);
  const actualCaps = v0Capabilities(actual);
  // The advertisement returned by system Git is also the Artifacts seed, so
  // this is the byte-for-byte check that the mirror preserves its capability line.
  expect(actualCaps).toBe(expectedCaps);
  expect(withoutV0Capabilities(actual)).toEqual(withoutV0Capabilities(expected));
}

async function compareState(
  name: string,
  state: GitDifferentialState,
): Promise<void> {
  const off = { ...baseEnv, GIT_MIRROR_MODE: 'off' } as Env;
  const on = { ...baseEnv, GIT_MIRROR_MODE: 'on' } as Env;
  const infoPath = `/${OWNER}/${name}.git/info/refs?service=git-upload-pack`;
  const expectedV0 = bytes(state.v0);
  const expectedV2 = bytes(state.v2);
  const v0 = await send(off, new Request(`${ORIGIN}${infoPath}`));
  const v0Mirror = await send(on, new Request(`${ORIGIN}${infoPath}`));
  expect(v0.bytes).toEqual(expectedV0);
  expectV0Equivalent(expectedV0, v0Mirror.bytes);

  const v2 = await send(off, new Request(`${ORIGIN}${infoPath}`, { headers: { 'Git-Protocol': 'version=2' } }));
  const v2Mirror = await send(on, new Request(`${ORIGIN}${infoPath}`, { headers: { 'Git-Protocol': 'version=2' } }));
  expect(v2.bytes).toEqual(expectedV2);
  expect(v2Mirror.bytes).toEqual(expectedV2);

  const uploadPath = `/${OWNER}/${name}.git/git-upload-pack`;
  for (const [index, options] of LS_REFS_OPTIONS.entries()) {
    const body = lsRefsRequest(options);
    const encoded = state.lsRefs[index]!;
    const upstream = await send(off, new Request(`${ORIGIN}${uploadPath}`, {
      method: 'POST',
      headers: { 'Git-Protocol': 'version=2', 'content-type': 'application/x-git-upload-pack-request' },
      body,
    }));
    const mirrored = await send(on, new Request(`${ORIGIN}${uploadPath}`, {
      method: 'POST',
      headers: { 'Git-Protocol': 'version=2', 'content-type': 'application/x-git-upload-pack-request' },
      body,
    }));
    expect(mirrored.status, `mirror ls-refs status for ${name} options ${options.join(',')}`).toBe(200);
    expect(mirrored.cost.do, `mirror DO calls for ${name} options ${options.join(',')}`).toBe(1);
    expect(upstream.bytes).toEqual(bytes(encoded));
    expect(new TextDecoder().decode(mirrored.bytes), `mirror ls-refs options ${options.join(',')}`)
      .toBe(new TextDecoder().decode(bytes(encoded)));
  }
}

async function withMirror<T>(id: string, run: (mirror: RepoMirror) => Promise<T>): Promise<T> {
  const stub = baseEnv.REPO_MIRROR.get(baseEnv.REPO_MIRROR.idFromName(id));
  return runInDurableObject(stub, async (object) => {
    (object as unknown as { env: Env }).env = { ...(object as unknown as { env: Env }).env, ARTIFACTS: fakeArtifacts };
    return run(object as RepoMirror);
  });
}

describe('RepoMirror against system Git', () => {
  beforeAll(() => installFakeGitRemote());
  afterAll(() => restoreFetch());

  it.skipIf(!fixture)('matches real Git for empty refs, tags, symrefs, and confirmed pushes', async () => {
    if (!fixture) throw new Error('run through npm run test:repo-mirror-git');
    expect(parseLsRefsRequest(lsRefsRequest([]))).toEqual({ prefixes: [] });

    const emptyName = `empty-${crypto.randomUUID().slice(0, 8)}`;
    const empty = await seedRepoWithCommit(baseEnv, emptyName, { owner: OWNER, visibility: 'public' });
    installFixtureRemote(empty.repo, [fixture.empty]);
    const emptyRemote = `https://artifacts.invalid/git/default/${OWNER}--${emptyName}.git`;
    const emptyRead = await withMirror(empty.id, (mirror) => mirror.read(
      0,
      `${OWNER}--${emptyName}`,
      emptyRemote,
      { kind: 'v0' },
      empty.id,
    ));
    expect(emptyRead).not.toBeNull();
    expect(emptyRead?.bytes).toEqual(bytes(fixture.empty.v0));
    await compareState(emptyName, fixture.empty);

    const fullName = `full-${crypto.randomUUID().slice(0, 8)}`;
    const full = await seedRepoWithCommit(baseEnv, fullName, { owner: OWNER, visibility: 'public' });
    const fullRemote = installFixtureRemote(full.repo, fixture.full);
    const fullRemoteUrl = `https://artifacts.invalid/git/default/${OWNER}--${fullName}.git`;
    const fullRead = await withMirror(full.id, (mirror) => mirror.read(
      0,
      `${OWNER}--${fullName}`,
      fullRemoteUrl,
      { kind: 'v0' },
      full.id,
    ));
    expect(fullRead).not.toBeNull();
    expect(fullRead?.bytes).toEqual(bytes(fixture.full[0]!.v0));
    const initialV0 = bytes(fixture.full[0]!.v0);
    expect(decode(initialV0)).toContain('refs/heads/release');
    expect(decode(initialV0)).toContain('refs/tags/lightweight');
    expect(decode(initialV0)).toContain('refs/tags/annotated');
    expect(decode(initialV0)).not.toContain('discard-me');
    // System Git 2.34 emits an agent capability; the mirror copies this line verbatim.
    expect(v0Capabilities(initialV0)).toMatch(/(?:agent|session-id)=/);
    await compareState(fullName, fixture.full[0]!);

    for (const [index, update] of fixture.updates.entries()) {
      await recordConfirmedPush(baseEnv, full.id, [update]);
      fullRemote.advance();
      await compareState(fullName, fixture.full[index + 1]!);
    }

  });
});
