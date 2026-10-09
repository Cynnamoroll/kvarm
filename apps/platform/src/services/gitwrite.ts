/**
 * Server-side git writes (architecture invariant 1).
 *
 * Artifacts has no write API on its binding, so every platform-initiated ref
 * move (merge commits, workspace refs, notes) goes through the smart-HTTP
 * receive-pack client against the repo's `artifacts_remote` with a
 * repo-scoped write token. Pushes carry exactly one ref: Artifacts checks
 * each command's old OID on the server (a mismatch is `ng <ref> stale ref`
 * on HTTP 200), allows correct-old non-fast-forward updates, and does not
 * advertise multi-ref atomicity. Fast-forward policy is therefore the
 * caller's job, and a `stale` outcome means "re-read and re-plan".
 *
 * A confirmed update moves the repo's view generation exactly like a
 * confirmed push through the git gate, so cached views of mutable refs miss.
 */

import {
  advertiseReceivePack,
  updateRef as pushOneRef,
  writePack,
  type FetchLike,
  type PackInput,
  type RefCommand,
  type RefUpdateResult,
} from '@forge/gitops';
import { getGitToken } from '../artifacts/tokens';
import type { RepoRow } from '../db/repos';
import { recordConfirmedPush } from './pushFreshness';
import { RefStoreUnavailable } from './refs';

export interface GitPusher {
  /** Every ref's current value, from the receive-pack advertisement. */
  listRefs(): Promise<Map<string, string>>;
  /**
   * Compare-and-swap one ref from `oldOid` to `newOid` (zero OIDs create or
   * delete). `objects` are the objects `newOid` needs that the store may not
   * have; omit them for a pure ref move.
   */
  updateRef(command: RefCommand, objects?: readonly PackInput[]): Promise<RefUpdateResult>;
}

export interface GitPusherOptions {
  /** Replaces global fetch (tests). */
  fetch?: FetchLike;
}

type PushTarget = Pick<RepoRow, 'id' | 'artifacts_name' | 'artifacts_remote'>;

export function artifactsPusher(env: Env, repo: PushTarget, opts: GitPusherOptions = {}): GitPusher {
  const remote = async () => {
    let token: string;
    try {
      token = await getGitToken(env, repo.artifacts_name, 'write');
    } catch (err) {
      throw new RefStoreUnavailable(`write token unavailable: ${String(err).slice(0, 200)}`);
    }
    return {
      url: repo.artifacts_remote,
      authorization: `Basic ${btoa(`forge:${token}`)}`,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    };
  };

  return {
    async listRefs() {
      const adv = await advertiseReceivePack(await remote()).catch((err: unknown) => {
        throw new RefStoreUnavailable(String(err).slice(0, 200));
      });
      return adv.refs;
    },

    async updateRef(command, objects) {
      const target = await remote();
      const pack = objects && objects.length > 0 ? await writePack(objects) : undefined;
      const result = await pushOneRef(target, command, pack);
      if (result.status === 'ok') {
        // The ref already moved; a failed freshness write must not turn it into a failure.
        await recordConfirmedPush(env, repo.id).catch((err: unknown) => {
          console.warn(JSON.stringify({ gitWriteFreshnessFailed: String(err).slice(0, 200) }));
        });
      }
      console.log(
        JSON.stringify({
          gitWrite: { repo: repo.artifacts_name, ref: command.ref, status: result.status, httpStatus: result.httpStatus, reason: result.reason },
        }),
      );
      return result;
    },
  };
}
