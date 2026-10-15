import { describe, expect, it } from 'vitest';
import { API_PREFIX, OPERATIONS } from '../src/index.js';
import { openApiDocument } from '../src/openapi.js';

const doc = openApiDocument({ origin: 'https://kvarm.example.com' });
const operations = Object.entries(doc.paths as Record<string, Record<string, { operationId: string; parameters?: Array<{ name: string; in: string }> }>>).flatMap(
  ([path, item]) => Object.entries(item).map(([method, op]) => ({ path, method, op })),
);

describe('openApiDocument', () => {
  it('is OpenAPI 3.1 served from the deployment origin', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers).toEqual([{ url: 'https://kvarm.example.com' }]);
  });

  it('describes every registry route exactly once, by its MCP tool name', () => {
    const routes = new Set(OPERATIONS.map((op) => `${op.method} ${op.path}`));
    expect(operations).toHaveLength(routes.size);
    const ids = new Set(operations.map((o) => o.op.operationId));
    expect(ids.size).toBe(operations.length);
    for (const id of ids) expect(OPERATIONS.some((op) => op.name === id)).toBe(true);
  });

  it('declares every path placeholder as a path parameter and never leaves {repo} in a path', () => {
    for (const { path, op } of operations) {
      expect(path.startsWith(API_PREFIX)).toBe(true);
      expect(path).not.toContain('{repo}');
      const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).sort();
      const declared = (op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name).sort();
      expect(declared, `${path}`).toEqual(placeholders);
    }
  });

  it('expands a repository into owner and name segments', () => {
    const getRepo = operations.find((o) => o.op.operationId === 'get_repo')!;
    expect(getRepo.path).toBe(`${API_PREFIX}/repos/{owner}/{name}`);
    expect(getRepo.method).toBe('get');
  });

  it('shares one error model', () => {
    expect(doc.components.schemas.Error.required).toEqual(['error']);
  });
});
