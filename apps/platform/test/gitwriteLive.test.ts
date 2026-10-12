/**
 * Opt-in live check: the Worker-side GitPusher, running in workerd, writes to
 * a real Artifacts repo. Skipped unless LIVE_GITWRITE_REMOTE,
 * LIVE_GITWRITE_NAME and LIVE_GITWRITE_TOKEN (a repo-scoped write token) are
 * set; see `library/user-testing.md` for the driver. The token is seeded into
 * the write-token cache, so the production `getGitToken(env, name, 'write')`
 * path supplies it.
 *
 * Expects an empty repo. Leaves `refs/heads/main` at C0 for a clone
 * cross-check and prints the commit ids (never the token).
 */

import { env as cfEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { buildBlob, buildCommit, buildTree, encode, ZERO_OID, type GitObject } from '@kvarm/gitops';
import { internalKey, writeCachedJson } from '../src/cache/internal';
import { artifactsPusher } from '../src/services/gitwrite';

const env = cfEnv as unknown as Env & { LIVE_GITWRITE_REMOTE: string; LIVE_GITWRITE_NAME: string; LIVE_GITWRITE_TOKEN: string };
const live = Boolean(env.LIVE_GITWRITE_REMOTE && env.LIVE_GITWRITE_NAME && env.LIVE_GITWRITE_TOKEN);

let tick = 0;
async function commit(parents: string[], text: string): Promise<{ commit: GitObject; objects: GitObject[] }> {
  const blob = await buildBlob(encode(text));
  const tree = await buildTree([{ mode: '100644', name: 'README.md', hash: blob.hash }]);
  const ident = { name: 'Kvarm', email: 'kvarm@kvarm.invalid', time: Math.floor(Date.now() / 1000) + tick++ };
  const c = await buildCommit({ tree: tree.hash, parents, author: ident, committer: ident, message: text.trim() });
  return { commit: c, objects: [c, tree, blob] };
}

describe.skipIf(!live)('live: Worker-side GitPusher against Artifacts', () => {
  it('creates, CAS-rejects, fast-forwards, non-FF-updates and deletes a scratch ref', { timeout: 60_000 }, async () => {
    await writeCachedJson(
      internalKey('gittoken', env.LIVE_GITWRITE_NAME, 'write'),
      // getGitToken refreshes write tokens with under 1.5 h left; claim a fresh 6 h one.
      { token: env.LIVE_GITWRITE_TOKEN, expiresAt: Date.now() + 21_600_000 },
      3_000,
    );
    const pusher = artifactsPusher(env, { id: crypto.randomUUID(), artifacts_name: env.LIVE_GITWRITE_NAME, artifacts_remote: env.LIVE_GITWRITE_REMOTE });
    const scratch = `refs/heads/scratch/gitwrite-${Date.now()}`;
    const steps: Record<string, unknown> = {};
    const step = async (name: string, run: () => Promise<unknown>) => {
      const t0 = Date.now();
      const r = await run();
      steps[name] = { ...(r as object), ms: Date.now() - t0 };
      return r;
    };

    expect(Object.fromEntries(await pusher.listRefs())).toEqual({});

    const c0 = await commit([], 'gitwrite live C0\n');
    expect(await step('createMain', () => pusher.updateRef({ ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: c0.commit.hash }, c0.objects))).toMatchObject({
      status: 'ok',
      httpStatus: 200,
    });
    expect(await step('createScratch', () => pusher.updateRef({ ref: scratch, oldOid: ZERO_OID, newOid: c0.commit.hash }))).toMatchObject({ status: 'ok' });
    expect(Object.fromEntries(await pusher.listRefs())).toEqual({ 'refs/heads/main': c0.commit.hash, [scratch]: c0.commit.hash });

    const c1 = await commit([c0.commit.hash], 'gitwrite live C1\n');
    const c2 = await commit([c0.commit.hash], 'gitwrite live C2 (sibling of C1)\n');

    // Server-side old-OID CAS: HTTP 200 carrying ng is not success.
    expect(await step('createOnExisting', () => pusher.updateRef({ ref: scratch, oldOid: ZERO_OID, newOid: c1.commit.hash }, c1.objects))).toEqual({
      status: 'stale',
      reason: 'stale ref',
      httpStatus: 200,
    });
    expect(await step('staleOldUpdate', () => pusher.updateRef({ ref: scratch, oldOid: c2.commit.hash, newOid: c1.commit.hash }, c1.objects))).toEqual({
      status: 'stale',
      reason: 'stale ref',
      httpStatus: 200,
    });
    expect((await pusher.listRefs()).get(scratch)).toBe(c0.commit.hash);

    expect(await step('fastForward', () => pusher.updateRef({ ref: scratch, oldOid: c0.commit.hash, newOid: c1.commit.hash }, c1.objects))).toMatchObject({ status: 'ok' });
    // Correct-old non-fast-forward is accepted by Artifacts; FF policy is the caller's.
    expect(await step('nonFastForward', () => pusher.updateRef({ ref: scratch, oldOid: c1.commit.hash, newOid: c2.commit.hash }, c2.objects))).toMatchObject({ status: 'ok' });

    expect(await step('staleDelete', () => pusher.updateRef({ ref: scratch, oldOid: c1.commit.hash, newOid: ZERO_OID }))).toEqual({
      status: 'stale',
      reason: 'stale ref',
      httpStatus: 200,
    });
    expect(await step('delete', () => pusher.updateRef({ ref: scratch, oldOid: c2.commit.hash, newOid: ZERO_OID }))).toMatchObject({ status: 'ok' });
    expect(Object.fromEntries(await pusher.listRefs())).toEqual({ 'refs/heads/main': c0.commit.hash });

    console.log(JSON.stringify({ gitwriteLive: { scratch, c0: c0.commit.hash, c1: c1.commit.hash, c2: c2.commit.hash, steps } }));
  });
});
