#!/usr/bin/env node
/**
 * Regenerates apps/cli/internal/registry/operations.json from the shared
 * operation registry (@kvarm/ops): the Go CLI embeds that file, so the CLI's
 * commands, the REST API and the MCP tools stay one registry — this repo's
 * core invariant — with the JS registry in packages/ops as the source of
 * record. A drift test (scripts/test/cliRegistry.test.ts) fails when the
 * committed JSON is stale.
 *
 *   node scripts/gen-cli-registry.mjs          write the JSON
 *   node scripts/gen-cli-registry.mjs --check  exit 1 when stale
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OPERATIONS } from '@kvarm/ops';

export const OUTPUT = new URL('../apps/cli/internal/registry/operations.json', import.meta.url);

/** One-line blurbs for the root help; every group must have one. */
export const GROUP_BLURBS = {
  user: 'your account',
  repo: 'create, list, fork, update and delete repositories',
  tree: 'list a directory of a repository at a ref',
  file: 'read one file at a ref',
  event: 'push events recorded for a repository',
  events: 'live repository state events after a sequence cursor',
  snapshot: 'snapshot metadata for a ref (and build demands)',
  compare: 'changed files between two commit-ishes',
  commit: "one commit's diff",
  workspace: 'agent workspaces',
  deps: 'pinned dependencies between workspaces',
  change: 'change sets: open, review, update and merge',
  queue: 'the merge queue',
  train: 'the integration train',
  review: 'reviews, approvals, escalations, guides and findings',
  finding: 'review findings tied to a change head and its coverage units',
  'review-policy': 'the repository review policy',
  task: 'agent tasks and their claim leases',
  intent: 'workspace intent declarations',
  nexus: 'the overlap forecast between workspaces',
  candidates: 'compare and compose candidate workspaces',
  composition: 'recorded compositions',
  arena: 'candidate arenas',
  org: 'organizations, members and their repositories',
  grant: 'explicit repository grants',
  agent: 'agent principals and their tokens',
  attribution: 'commit attribution notes',
  decision: 'recorded decisions and their context',
  issue: 'issues and their dispatch to agents',
  audit: 'audit export of a repository',
  'provenance-key': 'trusted execution keys',
  'branch-rule': 'branch protection rules',
  environment: 'reusable Linux build environments',
  sandbox: 'agent sandboxes',
  ci: 'CI jobs, flakes and hosted execution',
  webhook: 'outbound webhooks and their deliveries',
  revert: 'revert commits and change sets',
  incident: 'the incident webhook',
};

/**
 * @param {import('@kvarm/ops').Param} p
 */
function param(p) {
  const out = { name: p.name, type: p.type, in: p.in, description: p.description };
  if (p.required) out.required = true;
  if (p.positional) out.positional = true;
  if (p.enum) out.enum = [...p.enum];
  if (p.format) out.format = p.format;
  if (p.literal) out.literal = true;
  if (p.nullable) out.nullable = true;
  return out;
}

/** Groups in first-appearance order, every one with a blurb. */
export function renderRegistry() {
  /** @type {string[]} */
  const groups = [];
  for (const op of OPERATIONS) {
    if (!groups.includes(op.command[0])) groups.push(op.command[0]);
  }
  for (const name of groups) {
    if (!GROUP_BLURBS[name]) throw new Error(`group "${name}" has no blurb in scripts/gen-cli-registry.mjs`);
  }
  const data = {
    version: 1,
    groups: groups.map((name) => ({ name, blurb: GROUP_BLURBS[name] })),
    operations: OPERATIONS.map((op) => ({
      name: op.name,
      command: [...op.command],
      family: op.family,
      description: op.description,
      method: op.method,
      path: op.path,
      params: op.params.map(param),
      readOnly: op.readOnly,
      ...(op.destructive ? { destructive: true } : {}),
    })),
  };
  return `${JSON.stringify(data, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = renderRegistry();
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUTPUT, 'utf8');
    } catch {}
    if (current !== next) {
      console.error(`${fileURLToPath(OUTPUT)} is stale; run node scripts/gen-cli-registry.mjs`);
      process.exit(1);
    }
    console.log('operations.json is current');
  } else {
    writeFileSync(OUTPUT, next);
    console.log(`wrote ${fileURLToPath(OUTPUT)}`);
  }
}
