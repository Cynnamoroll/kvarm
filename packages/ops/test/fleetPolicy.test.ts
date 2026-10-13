import { describe, expect, it } from 'vitest';
import {
  isAllowedEgressHost,
  matchCommandPolicy,
  runEnvironmentBuild,
  tailText,
  type BuildContainerLike,
} from '../../../apps/platform/src/containers/fleetJob';

function readable(text: string): ReadableStream<Uint8Array> {
  return new Blob([text]).stream();
}

function fakeExec(exitCode = 0, stdout = '', stderr = '') {
  return {
    stdout: readable(stdout),
    stderr: readable(stderr),
    exitCode: Promise.resolve(exitCode),
  };
}

class FakeBuildContainer implements BuildContainerLike {
  calls: Array<{ cmd: string[]; env?: Record<string, string>; stdin?: ReadableStream }> = [];
  snapshotCalls = 0;
  validateFails = false;

  async exec(cmd: string[], options?: { cwd?: string; env?: Record<string, string>; stdin?: ReadableStream }) {
    this.calls.push({ cmd, env: options?.env, stdin: options?.stdin });
    const fail = this.validateFails && cmd.some((part) => part.includes('validate marker'));
    return fakeExec(fail ? 1 : 0, '', fail ? 'validation failed' : '');
  }

  async snapshotContainer() {
    this.snapshotCalls += 1;
    return { id: 'snapshot-1', size: 100 };
  }
}

describe('fleet policy helpers', () => {
  it('matches egress host globs and always allows the platform origin only', () => {
    const allowed = ['registry.npmjs.org', '*.pythonhosted.org', 'github.com'];
    expect(isAllowedEgressHost('registry.npmjs.org', allowed, 'https://kvarm.test')).toBe(true);
    expect(isAllowedEgressHost('files.pythonhosted.org', allowed, 'https://kvarm.test')).toBe(true);
    expect(isAllowedEgressHost('api.github.com', allowed, 'https://kvarm.test')).toBe(false);
    expect(isAllowedEgressHost('kvarm.test', allowed, 'https://kvarm.test')).toBe(true);
    expect(isAllowedEgressHost('evil.test', allowed, 'https://kvarm.test')).toBe(false);
  });

  it('matches command policy over the complete command and gives deny precedence', () => {
    expect(matchCommandPolicy('rm -rf /tmp/a', { deny: ['rm -rf *'], approve: ['rm *'] })).toBe('denied');
    expect(matchCommandPolicy('npm install', { deny: [], approve: ['npm *'] })).toBe('approved');
    expect(matchCommandPolicy('prefix npm install', { deny: [], approve: ['npm *'] })).toBe('allowed');
  });

  it('runs extraction, git bootstrap, setup, validation, then snapshots without credentials', async () => {
    const container = new FakeBuildContainer();
    const secret = 'kvarm_agt_secret-must-not-enter-container';
    const result = await runEnvironmentBuild(container, {
      snapshotTar: readable('snapshot tar'),
      repoDirectory: '/workspace/demo',
      setupScript: 'setup marker',
      validateScript: 'validate marker',
      envVars: { MODE: 'test' },
    });
    expect(result.ok).toBe(true);
    expect(container.calls.map((call) => call.cmd.join(' '))).toEqual([
      'cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cloudflare-containers-ca.crt',
      'update-ca-certificates',
      'mkdir -p /workspace/demo',
      'tar -xf - -C /workspace/demo',
      'git init',
      'git config http.sslCAInfo /etc/cloudflare/certs/cloudflare-containers-ca.crt',
      'bash -euo pipefail -c setup marker',
      'bash -euo pipefail -c validate marker',
    ]);
    expect(container.snapshotCalls).toBe(1);
    for (const call of container.calls) {
      expect(JSON.stringify(call.cmd)).not.toContain(secret);
      expect(JSON.stringify(call.env ?? {})).not.toContain(secret);
      if (call.stdin) {
        const streamText = await new Response(call.stdin).text();
        expect(streamText).not.toContain(secret);
      }
    }
  });

  it('fails validation without saving a snapshot', async () => {
    const container = new FakeBuildContainer();
    container.validateFails = true;
    const result = await runEnvironmentBuild(container, {
      snapshotTar: readable('snapshot tar'),
      repoDirectory: '/workspace/demo',
      setupScript: '',
      validateScript: 'validate marker',
      envVars: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('validation failed');
    expect(container.snapshotCalls).toBe(0);
  });

  it('bounds output by UTF-8 bytes', () => {
    expect(new TextEncoder().encode(tailText('0123456789', 5)).byteLength).toBeLessThanOrEqual(5);
    expect(tailText('0123456789', 5)).toBe('56789');
    expect(new TextEncoder().encode(tailText('a🙂b🙂c', 5)).byteLength).toBeLessThanOrEqual(5);
  });
});
