import { DurableObject } from 'cloudflare:workers';
import { runEnvironmentBuild, type EnvironmentBuildResult } from './fleetJob';

const IMAGE = 'cloudflare/debian-trixie';
const ENTRYPOINT = ['sleep', 'infinity'];
const CA_PATH = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';

export interface EnvironmentBuildContainerRequest {
  environmentId: string;
  buildId: string;
  snapshotKey: string;
  snapshotEncoding: 'identity' | 'zstd';
  instance: string;
  repoDirectory: string;
  setupScript: string;
  validateScript: string;
  envVars: Record<string, string>;
  allowedHosts: string[];
}

export type EnvironmentBuilderResult =
  | { ok: true; snapshot: { id: string; size: number }; phases: Record<string, number>; outputTail: string }
  | { ok: false; status: number; code: string; error: string; phases?: Record<string, number>; outputTail?: string };

function containerInstance(instance: string): 'standard-1' | 'standard-2' | 'standard-3' | 'standard-4' {
  return instance === 'basic' ? 'standard-1' : (instance as 'standard-1' | 'standard-2' | 'standard-3' | 'standard-4');
}

export class EnvironmentBuilder extends DurableObject<Env> {
  private busy = false;

  async build(request: EnvironmentBuildContainerRequest): Promise<EnvironmentBuilderResult> {
    const container = this.ctx.container;
    if (!container) {
      return {
        ok: false,
        status: 503,
        code: 'CONTAINER_UNAVAILABLE',
        error: 'no container runtime is bound to EnvironmentBuilder in this deployment',
      };
    }
    if (this.busy) return { ok: false, status: 409, code: 'BUILD_IN_PROGRESS', error: 'an environment build is already running' };
    this.busy = true;
    let result: EnvironmentBuildResult | null = null;
    try {
      if (container.running) await container.destroy();
      container.start({
        image: IMAGE,
        instance: containerInstance(request.instance),
        entrypoint: ENTRYPOINT,
        enableInternet: false,
      });
      const egress = this.ctx.exports.SandboxEgress({
        props: { environmentId: request.environmentId, allowedHosts: request.allowedHosts, mode: 'build' },
      });
      await container.interceptOutboundHttp('*', egress);
      await container.interceptOutboundHttps('*', egress);
      const snapshot = await this.env.SNAPSHOTS.get(request.snapshotKey);
      if (!snapshot?.body) {
        return { ok: false, status: 409, code: 'SNAPSHOT_MISSING', error: 'source snapshot bytes are unavailable' };
      }
      result = await runEnvironmentBuild(container, {
        snapshotTar: snapshot.body,
        snapshotEncoding: request.snapshotEncoding,
        repoDirectory: request.repoDirectory,
        setupScript: request.setupScript,
        validateScript: request.validateScript,
        envVars: request.envVars,
        onPhase: async (phase) => {
          await this.env.DB.prepare(
            `UPDATE environment_builds SET status = ?2, started_at = COALESCE(started_at, ?3)
              WHERE id = ?1 AND status IN ('queued','building','validating')`,
          )
            .bind(request.buildId, phase, Date.now())
            .run();
        },
      });
      if (!result.ok || !result.snapshot) {
        return {
          ok: false,
          status: 422,
          code: 'ENVIRONMENT_BUILD_FAILED',
          error: result.error ?? 'environment build did not create a snapshot',
          phases: result.phases,
          outputTail: result.outputTail,
        };
      }
      await this.env.DB.prepare('UPDATE environment_builds SET phases = ?2, output_tail = ?3 WHERE id = ?1')
        .bind(request.buildId, JSON.stringify(result.phases), result.outputTail)
        .run();
      return { ok: true, snapshot: result.snapshot, phases: result.phases, outputTail: result.outputTail };
    } catch (error) {
      return {
        ok: false,
        status: 502,
        code: 'ENVIRONMENT_BUILD_FAILED',
        error: String(error instanceof Error ? error.message : error).slice(0, 4096),
        phases: result?.phases,
        outputTail: result?.outputTail,
      };
    } finally {
      try {
        if (container.running) await container.destroy();
      } finally {
        this.busy = false;
      }
    }
  }
}

export { CA_PATH };
