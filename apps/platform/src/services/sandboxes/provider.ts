import type { AgentSandboxStart } from '../../containers/agentSandbox';
import type { EnvironmentBuildContainerRequest } from '../../containers/environmentBuilder';
import type { EnvironmentBuildRequest } from '../environments';

export interface SandboxProvider {
  readonly os: 'linux';
  startEnvironmentBuild(env: Env, buildId: string, params: EnvironmentBuildRequest): Promise<void>;
  environmentBuilder(env: Env, environmentId: string): {
    build(request: EnvironmentBuildContainerRequest): Promise<unknown>;
  };
  agentSandbox(env: Env, sandboxId: string): {
    start(request: AgentSandboxStart): Promise<unknown>;
    sleep(): Promise<unknown>;
    discard(): Promise<unknown>;
    exec(request: { command: string; cwd: string; timeoutSeconds: number }): Promise<unknown>;
    readFile(request: { path: string }): Promise<unknown>;
    writeFile(request: { path: string; content: string }): Promise<unknown>;
    egressCredential(): Promise<string | null>;
  };
}

const cloudflareLinux: SandboxProvider = {
  os: 'linux',
  startEnvironmentBuild: async (env, buildId, params) => {
    await env.ENVIRONMENT_BUILD.create({ id: buildId, params });
  },
  environmentBuilder: (env, environmentId) => env.ENV_BUILDER.getByName(environmentId),
  agentSandbox: (env, sandboxId) => env.AGENT_SANDBOX.getByName(sandboxId),
};

export const SANDBOX_PROVIDERS: Record<string, SandboxProvider> = {
  linux: cloudflareLinux,
};

export function sandboxProvider(os: string): SandboxProvider | null {
  return SANDBOX_PROVIDERS[os] ?? null;
}
