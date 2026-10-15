/**
 * The Go CLI's embedded operation registry
 * (apps/cli/internal/registry/operations.json) is generated from the shared
 * registry in packages/ops, so the CLI's commands, the REST API and the MCP
 * tools stay one registry. This fails when the committed JSON is stale.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OUTPUT, renderRegistry } from '../../../scripts/gen-cli-registry.mjs';

describe('the Go CLI registry', () => {
  it('operations.json matches packages/ops (run scripts/gen-cli-registry.mjs)', () => {
    expect(readFileSync(fileURLToPath(OUTPUT), 'utf8')).toBe(renderRegistry());
  });
});
