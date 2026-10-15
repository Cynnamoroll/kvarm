/**
 * The built `kvarm` CLI for live drivers: `go build` once per process into
 * a temporary directory, then hand every caller the same binary. The CLI is a
 * Go module (apps/cli); drivers spawn it directly, with credentials in the
 * child's environment like every other child.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let bin;

/** @returns {string} the path of the freshly built kvarm binary */
export function kvarmBin() {
  if (bin) return bin;
  const dir = mkdtempSync(join(tmpdir(), 'kvarm-cli-'));
  const target = join(dir, 'kvarm');
  const built = spawnSync('go', ['build', '-o', target, './cmd/kvarm'], { cwd: join(ROOT, 'apps/cli'), encoding: 'utf8' });
  if (built.status !== 0) {
    throw new Error(`building the kvarm CLI (go build ./cmd/kvarm in apps/cli) failed:\n${built.stderr}${built.stdout}`);
  }
  bin = target;
  return bin;
}
