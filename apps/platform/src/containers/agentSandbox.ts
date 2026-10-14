import { DurableObject } from 'cloudflare:workers';
import { revokeAgentTokenStatement, updateSandboxStatement } from '../db/sandboxes';
import { runSandboxCommand, sandboxPath, tailText } from './fleetJob';
import { instanceName } from './instances';

const ENTRYPOINT = ['sleep', 'infinity'];
const TOKEN_KEY = 'agent-token';
const STATE_KEY = 'sandbox-state';
const OUTPUT_MAX = 64 * 1024;

export interface AgentSandboxStart {
  sandboxId: string;
  environmentId: string;
  buildSnapshotId: string;
  sleepSnapshotId?: string | null;
  instance: string;
  idleMinutes: number;
  expiresAt: number;
  runExpiresAt: number;
  repoDirectory: string;
  repositoryUrl: string;
  allowedHosts: string[];
  workspaceRef: string;
  baseRef: string;
  token: string;
  tokenId: string;
}

interface SandboxState {
  sandboxId: string;
  environmentId: string;
  buildSnapshotId: string;
  sleepSnapshotId: string | null;
  instance: string;
  idleMinutes: number;
  expiresAt: number;
  runExpiresAt: number;
  repoDirectory: string;
  repositoryUrl: string;
  allowedHosts: string[];
  workspaceRef: string;
  baseRef: string;
  tokenId: string;
  initialized: boolean;
  lastActiveAt: number;
}

type SandboxResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; error: string };

function fail<T>(status: number, code: string, error: string): SandboxResult<T> {
  return { ok: false, status, code, error };
}

export class AgentSandbox extends DurableObject<Env> {
  /** Mutual exclusion over every mutating method: sleep/discard/readFile/writeFile too, so none can interleave with an in-flight start or exec. */
  private busy = false;

  async start(request: AgentSandboxStart): Promise<SandboxResult<{ started: true; localDiverged: boolean }>> {
    if (this.busy) return fail(409, 'SANDBOX_BUSY', 'sandbox is already handling a request');
    this.busy = true;
    try {
      const container = this.ctx.container;
      if (!container) return fail(503, 'CONTAINER_UNAVAILABLE', 'no container runtime is bound to AgentSandbox in this deployment');
      if (container.running) await container.destroy();
      const state: SandboxState = {
        sandboxId: request.sandboxId,
        environmentId: request.environmentId,
        buildSnapshotId: request.buildSnapshotId,
        sleepSnapshotId: request.sleepSnapshotId ?? null,
        instance: request.instance,
        idleMinutes: request.idleMinutes,
        expiresAt: request.expiresAt,
        runExpiresAt: request.runExpiresAt,
        repoDirectory: request.repoDirectory,
        repositoryUrl: request.repositoryUrl,
        allowedHosts: request.allowedHosts,
        workspaceRef: request.workspaceRef,
        baseRef: request.baseRef,
        tokenId: request.tokenId,
        initialized: request.sleepSnapshotId !== null && request.sleepSnapshotId !== undefined,
        lastActiveAt: Date.now(),
      };
      await this.ctx.storage.put(STATE_KEY, state);
      await this.ctx.storage.put(TOKEN_KEY, request.token);
      const restored = await this.startContainer(container, state, state.sleepSnapshotId ?? state.buildSnapshotId);
      if (!restored.ok) return restored;
      if (!state.initialized) {
        const initialized = await this.initializeRepo(container, state);
        if (!initialized.ok) {
          await container.destroy();
          await this.ctx.storage.delete(TOKEN_KEY);
          return initialized;
        }
        state.initialized = true;
      }
      const localDiverged = state.sleepSnapshotId ? await this.syncWorkspace(container, state) : false;
      state.lastActiveAt = Date.now();
      await this.ctx.storage.put(STATE_KEY, state);
      await this.scheduleIdle(state);
      await updateSandboxStatement(this.env.DB, state.sandboxId, "status = 'running', last_active_at = ?2, error = NULL", [state.lastActiveAt], [
        'starting',
        'sleeping',
        'running',
      ]).run();
      return { ok: true, value: { started: true, localDiverged } };
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 4096);
      await this.ctx.storage.delete(TOKEN_KEY);
      return fail(502, 'SANDBOX_START_FAILED', message);
    } finally {
      this.busy = false;
    }
  }

  async sleep(): Promise<SandboxResult<{ sleeping: true; snapshotId: string }>> {
    if (this.busy) return fail(409, 'SANDBOX_BUSY', 'sandbox is already handling a request');
    this.busy = true;
    try {
      const state = await this.ctx.storage.get<SandboxState>(STATE_KEY);
      if (!state) return fail(404, 'SANDBOX_NOT_FOUND', 'sandbox state is unavailable');
      const container = this.ctx.container;
      const snapshotId = container?.running ? (await container.snapshotContainer()).id : state.sleepSnapshotId ?? state.buildSnapshotId;
      state.sleepSnapshotId = snapshotId;
      state.lastActiveAt = Date.now();
      await this.ctx.storage.put(STATE_KEY, state);
      if (container?.running) await container.destroy();
      await this.ctx.storage.delete(TOKEN_KEY);
      await this.env.DB.batch([
        revokeAgentTokenStatement(this.env.DB, state.tokenId, Date.now()),
        updateSandboxStatement(this.env.DB, state.sandboxId, "status = 'sleeping', sleep_snapshot_id = ?2, token_id = NULL", [snapshotId], ['running', 'starting']),
      ]);
      await this.ctx.storage.setAlarm(state.expiresAt);
      return { ok: true, value: { sleeping: true, snapshotId } };
    } catch (error) {
      return fail(502, 'SANDBOX_SLEEP_FAILED', String(error instanceof Error ? error.message : error).slice(0, 1000));
    } finally {
      this.busy = false;
    }
  }

  async discard(): Promise<SandboxResult<{ stopped: true }>> {
    if (this.busy) return fail(409, 'SANDBOX_BUSY', 'sandbox is already handling a request');
    this.busy = true;
    try {
      return await this.discardNow();
    } finally {
      this.busy = false;
    }
  }

  /** discard() with the caller already holding `busy` (the alarm path). */
  private async discardNow(): Promise<SandboxResult<{ stopped: true }>> {
    const state = await this.ctx.storage.get<SandboxState>(STATE_KEY);
    try {
      if (this.ctx.container?.running) await this.ctx.container.destroy();
      await this.ctx.storage.delete(TOKEN_KEY);
      await this.ctx.storage.delete(STATE_KEY);
      await this.ctx.storage.deleteAlarm();
      if (state) {
        await this.env.DB.batch([
          revokeAgentTokenStatement(this.env.DB, state.tokenId, Date.now()),
          updateSandboxStatement(this.env.DB, state.sandboxId, "status = 'stopped', token_id = NULL, sleep_snapshot_id = NULL, stopped_at = COALESCE(stopped_at, ?2)", [
            Date.now(),
          ]),
        ]);
      }
      return { ok: true, value: { stopped: true } };
    } catch (error) {
      return fail(502, 'SANDBOX_STOP_FAILED', String(error instanceof Error ? error.message : error).slice(0, 1000));
    }
  }

  async stop(): Promise<SandboxResult<{ stopped: true }>> {
    return this.discard();
  }

  async exec(request: { command: string; cwd: string; timeoutSeconds: number }): Promise<SandboxResult<{
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  }>> {
    if (this.busy) return fail(409, 'SANDBOX_BUSY', 'sandbox is already handling a request');
    this.busy = true;
    try {
      const active = await this.ensureActive();
      if (!active.ok) return active;
      try {
        const result = await runSandboxCommand(active.container, request);
        await this.touch(active.state);
        return {
          ok: true,
          value: {
            ...result,
            stdout: tailText(result.stdout, OUTPUT_MAX),
            stderr: tailText(result.stderr, OUTPUT_MAX),
          },
        };
      } catch (error) {
        await this.touch(active.state);
        return fail(502, 'SANDBOX_EXEC_FAILED', String(error instanceof Error ? error.message : error).slice(0, 1000));
      }
    } finally {
      this.busy = false;
    }
  }

  async readFile(request: { path: string }): Promise<SandboxResult<{ content: string; size: number }>> {
    if (this.busy) return fail(409, 'SANDBOX_BUSY', 'sandbox is already handling a request');
    this.busy = true;
    try {
      const active = await this.ensureActive();
      if (!active.ok) return active;
      const path = sandboxPath(active.state.repoDirectory, request.path);
      if (!path) return fail(422, 'INVALID_PATH', 'file path must stay within /workspace');
      const process = await active.container.exec(['head', '-c', '1048577', '--', path]);
      const output = await process.output();
      if (output.exitCode !== 0) return fail(404, 'FILE_NOT_FOUND', 'sandbox file could not be read');
      const bytes = new Uint8Array(output.stdout);
      if (bytes.byteLength > 1_048_576) return fail(413, 'FILE_TOO_LARGE', 'sandbox files are limited to 1 MiB');
      await this.touch(active.state);
      return { ok: true, value: { content: new TextDecoder().decode(bytes), size: bytes.byteLength } };
    } catch (error) {
      return fail(502, 'SANDBOX_READ_FAILED', String(error instanceof Error ? error.message : error).slice(0, 1000));
    } finally {
      this.busy = false;
    }
  }

  async writeFile(request: { path: string; content: string }): Promise<SandboxResult<{ written: number }>> {
    if (this.busy) return fail(409, 'SANDBOX_BUSY', 'sandbox is already handling a request');
    this.busy = true;
    try {
      const active = await this.ensureActive();
      if (!active.ok) return active;
      const path = sandboxPath(active.state.repoDirectory, request.path);
      if (!path) return fail(422, 'INVALID_PATH', 'file path must stay within /workspace');
      const bytes = new TextEncoder().encode(request.content);
      if (bytes.byteLength > 1_048_576) return fail(413, 'FILE_TOO_LARGE', 'sandbox files are limited to 1 MiB');
      const process = await active.container.exec(
        [
          'python3',
          '-c',
          'import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(sys.stdin.buffer.read())',
          path,
        ],
        { stdin: new Blob([bytes]).stream() },
      );
      const output = await process.output();
      if (output.exitCode !== 0) return fail(422, 'FILE_WRITE_FAILED', new TextDecoder().decode(output.stderr).slice(-1000));
      await this.touch(active.state);
      return { ok: true, value: { written: bytes.byteLength } };
    } catch (error) {
      return fail(502, 'SANDBOX_WRITE_FAILED', String(error instanceof Error ? error.message : error).slice(0, 1000));
    } finally {
      this.busy = false;
    }
  }

  async egressCredential(): Promise<string | null> {
    const [state, token] = await Promise.all([
      this.ctx.storage.get<SandboxState>(STATE_KEY),
      this.ctx.storage.get<string>(TOKEN_KEY),
    ]);
    if (!state || !token || state.runExpiresAt <= Date.now()) return null;
    return token;
  }

  async alarm(): Promise<void> {
    if (this.busy) {
      // A mutating call is in flight; retry shortly instead of interleaving
      // with it (e.g. sleeping a container start() is still initializing).
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      return;
    }
    this.busy = true;
    try {
      const state = await this.ctx.storage.get<SandboxState>(STATE_KEY);
      if (!state) return;
      if (state.expiresAt <= Date.now()) {
        await this.discardNow();
        await updateSandboxStatement(this.env.DB, state.sandboxId, "status = 'stopped', stopped_at = COALESCE(stopped_at, ?2)", [Date.now()], [
          'starting',
          'running',
          'sleeping',
        ]).run();
        return;
      }
      const idleAt = state.lastActiveAt + state.idleMinutes * 60_000;
      if (state.runExpiresAt > Date.now() && idleAt > Date.now()) {
        await this.ctx.storage.setAlarm(Math.min(idleAt, state.runExpiresAt, state.expiresAt));
        return;
      }
      const container = this.ctx.container;
      if (!container?.running) {
        state.sleepSnapshotId ??= state.buildSnapshotId;
        await this.ctx.storage.put(STATE_KEY, state);
        await this.ctx.storage.delete(TOKEN_KEY);
        await this.env.DB.batch([
          revokeAgentTokenStatement(this.env.DB, state.tokenId, Date.now()),
          updateSandboxStatement(this.env.DB, state.sandboxId, "status = 'sleeping', sleep_snapshot_id = ?2, token_id = NULL", [state.sleepSnapshotId], ['running']),
        ]);
        await this.ctx.storage.setAlarm(state.expiresAt);
        return;
      }
      try {
        const snapshot = await container.snapshotContainer();
        state.sleepSnapshotId = snapshot.id;
        await this.ctx.storage.put(STATE_KEY, state);
        await container.destroy();
        await this.ctx.storage.delete(TOKEN_KEY);
        await this.env.DB.batch([
          revokeAgentTokenStatement(this.env.DB, state.tokenId, Date.now()),
          updateSandboxStatement(this.env.DB, state.sandboxId, "status = 'sleeping', sleep_snapshot_id = ?2, token_id = NULL", [snapshot.id], ['running']),
        ]);
        await this.ctx.storage.setAlarm(state.expiresAt);
      } catch (error) {
        await updateSandboxStatement(this.env.DB, state.sandboxId, 'error = ?2', [String(error instanceof Error ? error.message : error).slice(0, 1000)], [
          'running',
        ]).run();
        await this.ctx.storage.setAlarm(Math.min(state.expiresAt, Date.now() + 60_000));
      }
    } finally {
      this.busy = false;
    }
  }

  private async startContainer(
    container: Container,
    state: SandboxState,
    snapshotId: string,
  ): Promise<SandboxResult<true>> {
    container.start({
      containerSnapshot: { id: snapshotId },
      instance: instanceName(state.instance),
      entrypoint: ENTRYPOINT,
      enableInternet: false,
    });
    const egress = this.ctx.exports.SandboxEgress({
      props: {
        sandboxId: state.sandboxId,
        environmentId: state.environmentId,
        allowedHosts: state.allowedHosts,
        mode: 'sandbox',
      },
    });
    await container.interceptOutboundHttp('*', egress);
    await container.interceptOutboundHttps('*', egress);
    await container.setInactivityTimeout(Math.min((state.idleMinutes + 15) * 60_000, 6 * 60 * 60_000));
    await container.exec([
      'cp',
      '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
      '/usr/local/share/ca-certificates/cloudflare-containers-ca.crt',
    ]);
    const trust = await container.exec(['update-ca-certificates']);
    if ((await trust.exitCode) !== 0) return fail(502, 'SANDBOX_CA_FAILED', 'could not trust the container egress certificate');
    return { ok: true, value: true };
  }

  private async initializeRepo(container: Container, state: SandboxState): Promise<SandboxResult<true>> {
    const git = async (args: string[]) => {
      const process = await container.exec(args, { cwd: state.repoDirectory });
      const result = await process.output();
      if (result.exitCode !== 0) {
        return fail<true>(502, 'SANDBOX_GIT_FAILED', new TextDecoder().decode(result.stderr).slice(-1000));
      }
      return null;
    };
    for (const args of [
      ['git', 'init'],
      ['git', 'config', 'http.sslCAInfo', '/etc/cloudflare/certs/cloudflare-containers-ca.crt'],
      ['git', 'remote', 'add', 'origin', state.repositoryUrl],
    ]) {
      const error = await git(args);
      if (error) return error;
    }
    const remoteRef = `refs/remotes/origin/${state.workspaceRef.replace(/^refs\/heads\//, '')}`;
    const localBranch = state.workspaceRef.replace(/^refs\/heads\//, '');
    const fetch = await git(['git', 'fetch', '--depth=1', 'origin', `${state.workspaceRef}:${remoteRef}`]);
    if (fetch) return fetch;
    for (const args of [
      ['git', 'checkout', '--force', '-B', localBranch, remoteRef],
      ['git', 'branch', '--set-upstream-to', `origin/${localBranch}`, localBranch],
      ['git', 'config', 'push.default', 'upstream'],
    ]) {
      const error = await git(args);
      if (error) return error;
    }
    return { ok: true, value: true };
  }

  private async syncWorkspace(container: Container, state: SandboxState): Promise<boolean> {
    const workspaceRemote = `refs/remotes/origin/${state.workspaceRef.replace(/^refs\/heads\//, '')}`;
    const baseName = state.baseRef.startsWith('refs/') ? state.baseRef : `refs/heads/${state.baseRef}`;
    const baseRemote = `refs/remotes/origin/${baseName.replace(/^refs\/heads\//, '')}`;
    for (const refspec of [`+${state.workspaceRef}:${workspaceRemote}`, `+${baseName}:${baseRemote}`]) {
      const result = await (await container.exec(['git', 'fetch', 'origin', refspec], { cwd: state.repoDirectory })).output();
      if (result.exitCode !== 0) return true;
    }
    const status = await (await container.exec(['git', 'status', '--porcelain'], { cwd: state.repoDirectory })).output();
    const ancestor = await container.exec(['git', 'merge-base', '--is-ancestor', 'HEAD', workspaceRemote], { cwd: state.repoDirectory });
    if (status.exitCode !== 0 || new Uint8Array(status.stdout).byteLength > 0 || (await ancestor.exitCode) !== 0) return true;
    const merged = await container.exec(['git', 'merge', '--ff-only', workspaceRemote], { cwd: state.repoDirectory });
    return (await merged.exitCode) !== 0;
  }

  private async ensureActive(): Promise<
    | { ok: true; container: Container; state: SandboxState }
    | { ok: false; status: number; code: string; error: string }
  > {
    const state = await this.ctx.storage.get<SandboxState>(STATE_KEY);
    if (!state || state.expiresAt <= Date.now()) {
      return { ok: false, status: 410, code: 'SANDBOX_STOPPED', error: 'sandbox is stopped or expired' };
    }
    if (!(await this.ctx.storage.get<string>(TOKEN_KEY))) {
      return { ok: false, status: 409, code: 'SANDBOX_SLEEPING', error: 'sandbox must be woken before use' };
    }
    const container = this.ctx.container;
    if (!container) return { ok: false, status: 503, code: 'CONTAINER_UNAVAILABLE', error: 'no container runtime is bound to AgentSandbox in this deployment' };
    if (!container.running) {
      const snapshotId = state.sleepSnapshotId ?? state.buildSnapshotId;
      const started = await this.startContainer(container, state, snapshotId);
      if (!started.ok) return { ok: false, status: started.status, code: started.code, error: started.error };
      if (!state.initialized) {
        const initialized = await this.initializeRepo(container, state);
        if (!initialized.ok) return { ok: false, status: initialized.status, code: initialized.code, error: initialized.error };
        state.initialized = true;
      } else if (state.sleepSnapshotId) {
        await this.syncWorkspace(container, state);
      }
    }
    return { ok: true, container, state };
  }

  private async touch(state: SandboxState): Promise<void> {
    state.lastActiveAt = Date.now();
    await this.ctx.storage.put(STATE_KEY, state);
    await this.scheduleIdle(state);
    await updateSandboxStatement(this.env.DB, state.sandboxId, "status = 'running', last_active_at = ?2", [state.lastActiveAt], ['running', 'sleeping']).run();
  }

  private async scheduleIdle(state: SandboxState): Promise<void> {
    const target = Math.min(state.expiresAt, state.runExpiresAt, state.lastActiveAt + state.idleMinutes * 60_000);
    await this.ctx.storage.setAlarm(target);
  }
}
