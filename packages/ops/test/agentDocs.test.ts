/**
 * docs/agents guides may only name MCP tools that exist in the operation
 * registry, and must never carry a real token (upstream issue: "workflow guide
 * uses only tool names that exist in packages/ops", "placeholders for tokens").
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPERATIONS } from '@kvarm/ops';

const DIR = fileURLToPath(new URL('../../../docs/agents/', import.meta.url));
const pages = readdirSync(DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => ({ file: f, text: readFileSync(`${DIR}${f}`, 'utf8') }));

const TOOLS = new Set(OPERATIONS.map((op) => op.name));

// Backticked snake_case words that are client config keys, not Kvarm tools.
const NOT_TOOLS = new Set(['bearer_token_env_var', 'env_http_headers']);

/**
 * Tool references: inline `snake_case` spans outside fenced code blocks, plus
 * the tool in `"params": {"name": "<tool>"}` JSON-RPC calls and `mcp-agent.mjs call <tool>`
 * commands inside fences. Single-word tools (`forecast`) are covered by the
 * explicit step list below.
 */
function toolReferences(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, '');
  const inline = [...prose.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((m) => m[1] as string);
  const rpc = [...text.matchAll(/"params"\s*:\s*\{\s*"name"\s*:\s*"([a-z][a-z0-9_]*)"/g)].map((m) => m[1] as string);
  const cli = [...text.matchAll(/mcp-agent\.mjs call ([a-z][a-z0-9_]*)/g)].map((m) => m[1] as string);
  return [...inline, ...rpc, ...cli];
}

describe('docs/agents', () => {
  it('has the index, the workflow, the template and the client pages', () => {
    const names = pages.map((p) => p.file);
    for (const f of ['README.md', 'workflow.md', 'AGENTS.template.md', 'claude-code.md', 'codex.md', 'cursor.md', 'generic.md']) {
      expect(names).toContain(f);
    }
  });

  it.each(pages.map((p) => [p.file, p] as const))('%s names only tools that exist in packages/ops', (_file, page) => {
    const unknown = toolReferences(page.text).filter((n) => !TOOLS.has(n) && !NOT_TOOLS.has(n));
    expect(unknown).toEqual([]);
  });

  it('workflow.md covers every step with a real tool', () => {
    const workflow = pages.find((p) => p.file === 'workflow.md')?.text ?? '';
    const steps = ['get_context', 'create_workspace', 'set_intent', 'forecast', 'get_overlap', 'create_change_set', 'enqueue_change', 'list_tasks', 'claim_task', 'complete_task', 'record_decision'];
    for (const name of steps) {
      expect(TOOLS.has(name), `${name} is in the registry`).toBe(true);
      expect(workflow).toContain(`\`${name}\``);
    }
  });

  it('uses placeholders only, never a real token', () => {
    for (const p of pages) expect(p.text, p.file).not.toMatch(/kvarm_(pat|agt)_[0-9a-f]{16,}/);
  });
});
