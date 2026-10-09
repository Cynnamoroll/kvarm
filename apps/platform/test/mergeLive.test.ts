/**
 * Opt-in live check of merge publication: services/merge.ts prepares a
 * fast-forward and a three-way merge and publishes each to its own scratch
 * ref on a real Artifacts repo through the Worker-side GitPusher. Skipped
 * unless LIVE_MERGE=1 and LIVE_GITWRITE_REMOTE, LIVE_GITWRITE_NAME and
 * LIVE_GITWRITE_TOKEN (a repo-scoped write token) are set; the driver is
 * scripts/merge-live-e2e.mjs, which verifies the result with git clone.
 *
 * The history is built in memory and pushed first, so the merge reads it
 * from the same in-memory store (the workerd pool has no remote Artifacts
 * binding). Expects an empty repo; prints the commit ids, never the token.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ZERO_OID } from '@forge/gitops';
import { internalKey, writeCachedJson } from '../src/cache/internal';
import { defaultChecksGate } from '../src/services/checksGate';
import { artifactsPusher } from '../src/services/gitwrite';
import { FORGE_COMMITTER, prepareMerge, publishMerge } from '../src/services/merge';
import { MemGit } from './helpers/memGit';

const env = cfEnv as unknown as Env & { LIVE_MERGE: string; LIVE_GITWRITE_REMOTE: string; LIVE_GITWRITE_NAME: string; LIVE_GITWRITE_TOKEN: string };
const live = env.LIVE_MERGE === '1' && Boolean(env.LIVE_GITWRITE_REMOTE && env.LIVE_GITWRITE_NAME && env.LIVE_GITWRITE_TOKEN);

const app = (lines: Record<number, string>) =>
  Array.from({ length: 10 }, (_, i) => lines[i + 1] ?? `line ${i + 1}`)
    .map((l) => `${l}\n`)
    .join('');

describe.skipIf(!live)('live: merge publication through GitPusher', () => {
  it('publishes a fast-forward and a three-way merge commit to scratch refs', { timeout: 90_000 }, async () => {
    await writeCachedJson(
      internalKey('gittoken', env.LIVE_GITWRITE_NAME, 'write'),
      { token: env.LIVE_GITWRITE_TOKEN, expiresAt: Date.now() + 21_600_000 },
      3_000,
    );
    const repo = { id: crypto.randomUUID(), artifacts_name: env.LIVE_GITWRITE_NAME, artifacts_remote: env.LIVE_GITWRITE_REMOTE };
    const pusher = artifactsPusher(env, repo);
    const gate = defaultChecksGate(env);
    const steps: Record<string, unknown> = {};
    const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      const t0 = Date.now();
      const r = await run();
      const value = (r as { value?: { objects?: unknown[] } }).value;
      steps[name] = { ...(r as object), ...(value?.objects ? { value: { ...value, objects: value.objects.length } } : {}), ms: Date.now() - t0 };
      return r;
    };

    const git = new MemGit(Math.floor(Date.now() / 1000) - 100);
    const c0Files = { 'README.md': 'merge live\n', 'src/app.ts': app({}), 'docs/guide.md': 'guide\n', 'docs/old-name.md': 'renamed on feature\n' };
    const c0 = await git.commit([], c0Files, 'C0');
    const c1Files = { ...c0Files, 'README.md': 'merge live (main)\n', 'src/app.ts': app({ 9: 'main edits line 9' }), 'main-only.txt': 'main\n' };
    const c1 = await git.commit([c0], c1Files, 'C1 on main');
    const { 'docs/old-name.md': moved, ...rest } = c0Files;
    const f1 = await git.commit([c0], { ...rest, 'docs/new-name.md': moved, 'src/app.ts': app({ 2: 'feature edits line 2' }), 'feature/new.txt': 'feature\n' }, 'F1 on feature');
    const ff1 = await git.commit([c1], { ...c1Files, 'README.md': 'merge live (ff)\n' }, 'FF1 ahead of main');

    expect(Object.fromEntries(await pusher.listRefs())).toEqual({});
    const all = () => [...git.objects.values()];
    expect(await step('pushMain', () => pusher.updateRef({ ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: c1 }, all()))).toMatchObject({ status: 'ok' });
    expect(await step('pushFeature', () => pusher.updateRef({ ref: 'refs/heads/feature', oldOid: ZERO_OID, newOid: f1 }, all()))).toMatchObject({ status: 'ok' });
    expect(await step('pushFfHead', () => pusher.updateRef({ ref: 'refs/heads/ff-head', oldOid: ZERO_OID, newOid: ff1 }, all()))).toMatchObject({ status: 'ok' });

    const stamp = Date.now();
    const scratchMerge = `refs/heads/scratch/merge-${stamp}`;
    const scratchFf = `refs/heads/scratch/ff-${stamp}`;
    for (const ref of [scratchMerge, scratchFf]) {
      expect(await pusher.updateRef({ ref, oldOid: ZERO_OID, newOid: c1 })).toMatchObject({ status: 'ok' });
    }

    const threeWay = await step('prepareThreeWay', () =>
      prepareMerge(git, { targetSha: c1, headSha: f1, message: 'Merge feature into scratch', author: { name: 'Cynthia', email: 'cynthia@forge.invalid' } }),
    );
    if (!threeWay.ok) throw new Error(`prepare failed: ${threeWay.code} ${threeWay.error}`);
    expect(threeWay.value.kind).toBe('merge');
    const merged = await step('publishThreeWay', () => publishMerge({ pusher, gate }, { repo, ref: scratchMerge }, threeWay.value));
    expect(merged).toMatchObject({ ok: true, value: { kind: 'merge', previous: c1, mergeCommit: threeWay.value.mergeCommit } });

    const ff = await step('prepareFastForward', () => prepareMerge(git, { targetSha: c1, headSha: ff1, message: 'unused for a fast-forward' }));
    if (!ff.ok) throw new Error(`prepare failed: ${ff.code} ${ff.error}`);
    const ffDone = await step('publishFastForward', () => publishMerge({ pusher, gate }, { repo, ref: scratchFf }, ff.value));
    expect(ffDone).toEqual({ ok: true, value: { kind: 'fast-forward', ref: scratchFf, mergeCommit: ff1, treeSha: ff.value.treeSha, previous: c1 } });

    // The scratch merge ref moved, so re-publishing the same prepared merge is stale (server-side CAS).
    const stale = await step('republishStale', () => publishMerge({ pusher, gate }, { repo, ref: scratchMerge }, threeWay.value));
    expect(stale).toMatchObject({ ok: false, status: 409, code: 'STALE_TARGET' });

    const refs = Object.fromEntries(await pusher.listRefs());
    expect(refs).toMatchObject({ 'refs/heads/main': c1, 'refs/heads/feature': f1, [scratchMerge]: threeWay.value.mergeCommit, [scratchFf]: ff1 });

    console.log(
      JSON.stringify({
        mergeLive: {
          c0,
          c1,
          f1,
          ff1,
          scratchMerge,
          scratchFf,
          mergeCommit: threeWay.value.mergeCommit,
          mergeTree: threeWay.value.treeSha,
          mergeObjects: threeWay.value.objects.length,
          committer: `${FORGE_COMMITTER.name} <${FORGE_COMMITTER.email}>`,
          work: threeWay.value.work,
          steps,
        },
      }),
    );
  });
});
