import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RESERVED_LOGINS } from '../lib/reserved-logins.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = resolve(repoRoot, 'scripts/mint-pat.mjs');

describe('mint-pat reserved logins', () => {
  it('rejects every reserved login before creating a token file', () => {
    for (const login of RESERVED_LOGINS) {
      const dir = mkdtempSync(join(tmpdir(), 'kvarm-reserved-login-'));
      const tokenFile = join(dir, 'token.env');
      try {
        const result = spawnSync(
          process.execPath,
          [
            script,
            '--login',
            login,
            '--scopes',
            'read',
            '--name',
            't',
            '--key',
            'K',
            '--token-file',
            tokenFile,
          ],
          { cwd: repoRoot, encoding: 'utf8' },
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(login);
        expect(result.stderr).toContain('reserved');
        expect(existsSync(tokenFile)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('continues to reject a non-reserved login whose token file is not gitignored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kvarm-unignored-token-'));
    const tokenFile = join(dir, 'token.env');
    try {
      const result = spawnSync(
        process.execPath,
        [
          script,
          '--login',
          'ops-bot',
          '--scopes',
          'read',
          '--name',
          't',
          '--key',
          'K',
          '--token-file',
          tokenFile,
        ],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('not gitignored');
      expect(existsSync(tokenFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
