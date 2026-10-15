export type CommandPolicy = { deny: string[]; approve: string[] };

export interface BuildProcessLike {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exitCode: Promise<number>;
}

export interface BuildContainerLike {
  exec(
    command: string[],
    options?: { cwd?: string; env?: Record<string, string>; stdin?: ReadableStream },
  ): Promise<BuildProcessLike>;
  snapshotContainer(): Promise<{ id: string; size: number }>;
}

export interface EnvironmentBuildInput {
  snapshotTar: ReadableStream<Uint8Array>;
  snapshotEncoding?: 'identity' | 'zstd';
  repoDirectory: string;
  setupScript: string;
  validateScript: string;
  envVars: Record<string, string>;
  onPhase?: (phase: 'building' | 'validating') => Promise<void> | void;
}

export interface EnvironmentBuildResult {
  ok: boolean;
  snapshot?: { id: string; size: number };
  phases: Record<string, number>;
  outputTail: string;
  error?: string;
}

const OUTPUT_LIMIT = 64 * 1024;

function globRegex(glob: string): RegExp {
  let source = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === '*') {
      // `*` matches any span, separators included: these globs have no
      // recursive/non-recursive wildcard split, so `**` is the same match
      // written with a second star.
      source += '.*';
      if (glob[i + 1] === '*') i += 1;
    } else if (char === '?') {
      source += '.';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

function matchesAny(value: string, globs: string[]): boolean {
  return globs.some((glob) => globRegex(glob).test(value));
}

export function matchesAnyGlob(value: string, globs: string[]): boolean {
  return matchesAny(value, globs);
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

export function isAllowedEgressHost(host: string, allowedHosts: string[], platformOrigin: string): boolean {
  const normalized = normalizeHost(host);
  let platformHost: string;
  try {
    platformHost = normalizeHost(new URL(platformOrigin).host);
  } catch {
    return false;
  }
  return normalized === platformHost || matchesAny(normalized, allowedHosts.map(normalizeHost));
}

export function matchCommandPolicy(command: string, policy: CommandPolicy): 'denied' | 'approved' | 'allowed' {
  if (matchesAny(command, policy.deny)) return 'denied';
  if (matchesAny(command, policy.approve)) return 'approved';
  return 'allowed';
}

export function tailText(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = new TextEncoder().encode(text);
  let start = Math.max(0, bytes.byteLength - maxBytes);
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return new TextDecoder().decode(bytes.subarray(start));
}

async function streamTail(stream: ReadableStream<Uint8Array> | null, maxBytes = OUTPUT_LIMIT): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output = tailText(output + decoder.decode(value, { stream: true }), maxBytes);
    }
    output = tailText(output + decoder.decode(), maxBytes);
    return output;
  } finally {
    reader.releaseLock();
  }
}

async function execute(
  container: BuildContainerLike,
  command: string[],
  options?: { cwd?: string; env?: Record<string, string>; stdin?: ReadableStream },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = await container.exec(command, options);
  const [stdout, stderr, exitCode] = await Promise.all([
    streamTail(process.stdout),
    streamTail(process.stderr),
    process.exitCode,
  ]);
  return { exitCode, stdout, stderr };
}

export async function runEnvironmentBuild(
  container: BuildContainerLike,
  input: EnvironmentBuildInput,
): Promise<EnvironmentBuildResult> {
  const phases: Record<string, number> = {};
  let outputTail = '';
  const run = async (
    name: string,
    command: string[],
    options?: { cwd?: string; env?: Record<string, string>; stdin?: ReadableStream },
  ) => {
    const startedAt = Date.now();
    const result = await execute(container, command, options);
    phases[name] = Date.now() - startedAt;
    outputTail = tailText(`${outputTail}${result.stdout}${result.stderr}`, OUTPUT_LIMIT);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `${name} failed with exit code ${result.exitCode}`);
    }
    return result;
  };

  try {
    await input.onPhase?.('building');
    await run('caTrust', [
      'cp',
      '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
      '/usr/local/share/ca-certificates/cloudflare-containers-ca.crt',
    ]);
    await run('caTrust', ['update-ca-certificates']);
    await run('extract', ['mkdir', '-p', input.repoDirectory]);
    await run(
      'extract',
      input.snapshotEncoding === 'zstd'
        ? ['tar', '--zstd', '-xf', '-', '-C', input.repoDirectory]
        : ['tar', '-xf', '-', '-C', input.repoDirectory],
      { stdin: input.snapshotTar },
    );
    await run('gitInit', ['git', 'init'], { cwd: input.repoDirectory });
    await run(
      'gitConfig',
      ['git', 'config', 'http.sslCAInfo', '/etc/cloudflare/certs/cloudflare-containers-ca.crt'],
      { cwd: input.repoDirectory },
    );

    if (input.setupScript) {
      await run(
        'setup',
        ['bash', '-euo', 'pipefail', '-c', input.setupScript],
        { cwd: input.repoDirectory, env: input.envVars },
      );
    }
    if (input.validateScript) {
      await input.onPhase?.('validating');
      await run(
        'validate',
        ['bash', '-euo', 'pipefail', '-c', input.validateScript],
        { cwd: input.repoDirectory, env: input.envVars },
      );
    }

    const snapshotStartedAt = Date.now();
    const snapshot = await container.snapshotContainer();
    phases.snapshot = Date.now() - snapshotStartedAt;
    return { ok: true, snapshot, phases, outputTail };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, phases, outputTail, error: tailText(message, 4096) };
  }
}

export interface SandboxCommandContainerLike {
  exec(
    command: string[],
    options?: { cwd?: string },
  ): Promise<BuildProcessLike>;
}

export async function runSandboxCommand(
  container: SandboxCommandContainerLike,
  input: { command: string; cwd: string; timeoutSeconds: number },
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  const startedAt = Date.now();
  const process = await container.exec(
    ['timeout', '--kill-after=5', String(input.timeoutSeconds), 'bash', '-lc', input.command],
    { cwd: input.cwd },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    streamTail(process.stdout, 32 * 1024),
    streamTail(process.stderr, 32 * 1024),
    process.exitCode,
  ]);
  return { exitCode, stdout, stderr, durationMs: Date.now() - startedAt };
}

export function sandboxPath(repoDirectory: string, path: string): string | null {
  if (path.length === 0 || path.includes('\0') || !repoDirectory.startsWith('/workspace/')) return null;
  const input = path.startsWith('/') ? path : `${repoDirectory}/${path}`;
  if (!input.startsWith('/workspace/')) return null;
  const segments: string[] = [];
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  const normalized = `/${segments.join('/')}`;
  return normalized.startsWith('/workspace/') ? normalized : null;
}
