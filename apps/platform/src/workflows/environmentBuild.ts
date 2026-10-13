import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { withLazyRepo } from '../artifacts/repo';
import type { RepoRow } from '../db/repos';
import {
  demandSnapshot,
  isReady,
  readSnapshot,
} from '../services/snapshots';
import { lsRefs, type ResolveContext } from '../services/refs';
import {
  requestEnvironmentBuild,
  type EnvironmentBuildRequest,
  type EnvironmentBuildRow,
  type EnvironmentRow,
} from '../services/environments';
import type { EnvironmentBuilderResult } from '../containers/environmentBuilder';

const RETRY = { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '30 minutes' } as const;
const SNAPSHOT_POLLS = 30;

async function refSha(env: Env, repo: RepoRow, baseRef: string): Promise<string | null> {
  if (/^[0-9a-f]{40}$/.test(baseRef)) return baseRef;
  const ref = baseRef.startsWith('refs/') ? baseRef : `refs/heads/${baseRef}`;
  return withLazyRepo(env, repo.artifacts_name, (artifacts) => {
    const context: ResolveContext = { env, repo, artifacts, bypass: true, waitUntil: () => undefined };
    return lsRefs(context, [ref]).then((refs) => refs.get(ref) ?? null);
  });
}

async function failedBuild(env: Env, buildId: string, error: string, outputTail = ''): Promise<void> {
  await env.DB.prepare(
    `UPDATE environment_builds SET status = 'failed', error = ?2, output_tail = ?3, finished_at = ?4
      WHERE id = ?1 AND status IN ('queued','building','validating')`,
  )
    .bind(buildId, error.slice(0, 4096), outputTail.slice(-65_536), Date.now())
    .run();
}

async function promoteBuild(
  env: Env,
  build: EnvironmentBuildRow,
  snapshot: { id: string; size: number },
  phases: Record<string, number>,
  outputTail: string,
): Promise<boolean> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE environment_builds SET status = 'ready', snapshot_id = ?2, snapshot_size = ?3,
        phases = ?4, output_tail = ?5, finished_at = ?6
       WHERE id = ?1 AND status IN ('queued','building','validating')
         AND config_hash = (SELECT config_hash FROM environments WHERE id = environment_builds.environment_id AND archived_at IS NULL)`,
    ).bind(build.id, snapshot.id, snapshot.size, JSON.stringify(phases), outputTail, now),
    env.DB.prepare(
      `UPDATE environment_builds SET status = 'superseded', finished_at = ?2
        WHERE environment_id = ?1 AND id <> ?3 AND status = 'ready'
          AND EXISTS (SELECT 1 FROM environment_builds b WHERE b.id = ?3 AND b.status = 'ready')`,
    ).bind(build.environment_id, now, build.id),
    env.DB.prepare(
      `UPDATE environments SET ready_build_id = ?2, updated_at = ?3
        WHERE id = ?1 AND archived_at IS NULL
          AND EXISTS (SELECT 1 FROM environment_builds b WHERE b.id = ?2 AND b.status = 'ready')`,
    ).bind(build.environment_id, build.id, now),
  ]);
  const current = await env.DB.prepare('SELECT status FROM environment_builds WHERE id = ?1')
    .bind(build.id)
    .first<{ status: string }>();
  if (current?.status === 'ready') return true;
  await env.DB.prepare(
    `UPDATE environment_builds SET status = 'superseded', finished_at = ?2
      WHERE id = ?1 AND status IN ('queued','building','validating')`,
  )
    .bind(build.id, Date.now())
    .run();
  return false;
}

export class EnvironmentBuild extends WorkflowEntrypoint<Env, EnvironmentBuildRequest> {
  async run(event: WorkflowEvent<EnvironmentBuildRequest>, step: WorkflowStep) {
    const { environmentId, buildId } = event.payload;
    let outputTail = '';
    try {
      const source = await step.do('resolve-environment', RETRY, async () => {
        const [environment, build] = await Promise.all([
          this.env.DB.prepare('SELECT * FROM environments WHERE id = ?1 AND archived_at IS NULL')
            .bind(environmentId)
            .first<EnvironmentRow>(),
          this.env.DB.prepare('SELECT * FROM environment_builds WHERE id = ?1 AND environment_id = ?2')
            .bind(buildId, environmentId)
            .first<EnvironmentBuildRow>(),
        ]);
        if (!environment || !build) throw new Error('environment build no longer exists');
        const repo = await this.env.DB.prepare('SELECT * FROM repos WHERE id = ?1')
          .bind(environment.repo_id)
          .first<RepoRow>();
        if (!repo) throw new Error('environment repository no longer exists');
        const sha = await refSha(this.env, repo, environment.base_ref);
        if (!sha) throw new Error(`base ref not found: ${environment.base_ref}`);
        await this.env.DB.prepare(
          "UPDATE environment_builds SET base_sha = ?2, status = 'building', started_at = COALESCE(started_at, ?3) WHERE id = ?1",
        )
          .bind(buildId, sha, Date.now())
          .run();
        return { environment, build, repo, sha };
      });

      const requested = await step.do('request-source-snapshot', RETRY, async () => {
        const row = await readSnapshot(this.env, source.repo.id, source.sha);
        if (!row || row.state === 'failed') await demandSnapshot(this.env, source.repo.id, source.sha);
        return true;
      });
      void requested;
      let snapshotRow = null;
      for (let attempt = 0; attempt < SNAPSHOT_POLLS; attempt += 1) {
        snapshotRow = await step.do(`source-snapshot-state-${attempt}`, RETRY, () =>
          readSnapshot(this.env, source.repo.id, source.sha),
        );
        if (isReady(snapshotRow)) break;
        if (snapshotRow?.state === 'failed') {
          await step.do(`retry-source-snapshot-${attempt}`, RETRY, async () => {
            await demandSnapshot(this.env, source.repo.id, source.sha);
            return true;
          });
        }
        await step.sleep(`wait-source-snapshot-${attempt}`, '10 seconds');
      }
      if (!isReady(snapshotRow)) throw new Error('source snapshot did not become ready before the build deadline');

      const built = (await step.do('build-environment-container', RETRY, async () => {
        const provider = this.env.ENV_BUILDER.getByName(environmentId);
        const result = await provider.build({
          environmentId,
          buildId,
          snapshotKey: snapshotRow!.r2_key!,
          snapshotEncoding: snapshotRow!.encoding === 'zstd' ? 'zstd' : 'identity',
          instance: source.environment.instance,
          repoDirectory: `/workspace/${source.repo.name.replace(/[^A-Za-z0-9._-]/g, '-')}`,
          setupScript: source.environment.setup_script,
          validateScript: source.environment.validate_script,
          envVars: JSON.parse(source.environment.env_vars) as Record<string, string>,
        });
        if (!result.ok) {
          outputTail = result.outputTail ?? '';
          throw new Error(result.error);
        }
        return {
          ok: true,
          snapshot: result.snapshot,
          phases: result.phases,
          outputTail: result.outputTail,
        };
      })) as Extract<EnvironmentBuilderResult, { ok: true }>;
      outputTail = built.outputTail;
      const promoted = await step.do('promote-environment-build', RETRY, () =>
        promoteBuild(this.env, source.build, built.snapshot, built.phases, built.outputTail),
      );
      const pending = await this.env.DB.prepare(
        'UPDATE environments SET pending = 0 WHERE id = ?1 AND pending = 1 AND archived_at IS NULL RETURNING config_hash',
      )
        .bind(environmentId)
        .first<{ config_hash: string }>();
      if (pending) {
        const reason = pending.config_hash === source.build.config_hash ? 'manual' : 'config';
        await requestEnvironmentBuild(this.env, environmentId, reason);
      }
      return { status: promoted ? 'ready' : 'superseded', buildId, snapshotId: built.snapshot.id };
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 4096);
      await failedBuild(this.env, buildId, message, outputTail);
      const pending = await this.env.DB.prepare(
        'UPDATE environments SET pending = 0 WHERE id = ?1 AND pending = 1 AND archived_at IS NULL RETURNING config_hash',
      )
        .bind(environmentId)
        .first<{ config_hash: string }>();
      if (pending) {
        const current = await this.env.DB.prepare('SELECT config_hash FROM environment_builds WHERE id = ?1')
          .bind(buildId)
          .first<{ config_hash: string }>();
        await requestEnvironmentBuild(this.env, environmentId, current?.config_hash === pending.config_hash ? 'retry' : 'config');
      }
      throw error;
    }
  }
}
