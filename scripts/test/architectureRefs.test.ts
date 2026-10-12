/**
 * Architecture reference audit (scripts/check-architecture-refs.mjs): every
 * numbered "architecture §N" or "invariant N" citation in the tree resolves to
 * a numbered heading of docs/architecture.md, or of the document it names.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkCitations, collectSections, findCitations } from '../lib/architecture-refs.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('collectSections', () => {
  it('collects numbered headings at any level and ignores the rest', () => {
    const md = [
      '# Kvarm architecture',
      '## 0. Design decisions',
      '### 0.1 One owner per concern',
      '## 2. Invariants',
      '### 2.3 Content-addressed caching',
      '### 11.4 Bounded integration train',
      '## Overview',
      'Body text mentioning 4. and §9 is not a heading.',
      '```',
      '## 7. inside a code fence',
      '```',
    ].join('\n');
    const sections = collectSections(md);
    expect([...sections].sort()).toEqual(['0', '0.1', '11.4', '2', '2.3']);
  });
});

describe('findCitations', () => {
  it('finds section signs and numbered invariants on each line', () => {
    const text = [
      '-- Change requests (architecture §4 services/changes.ts, §6, invariant 5).',
      ' * services/queue.ts, §9, §11.4, STEER v2 §0.1/§0.3).',
      ' * Server-side git writes (architecture invariant 1).',
      'Ends a sentence at §11.',
    ].join('\n');
    expect(findCitations(text).map((c) => [c.line, c.section, c.target])).toEqual([
      [1, '4', 'docs/architecture.md'],
      [1, '6', 'docs/architecture.md'],
      [1, '2.5', 'docs/architecture.md'],
      [2, '9', 'docs/architecture.md'],
      [2, '11.4', 'docs/architecture.md'],
      [2, '0.1', 'docs/architecture.md'],
      [2, '0.3', 'docs/architecture.md'],
      [3, '2.1', 'docs/architecture.md'],
      [4, '11', 'docs/architecture.md'],
    ]);
  });

  it('targets the document a citation names', () => {
    const [c] = findCitations(' * Design (see planning/PLAN.md §3.1):');
    expect(c).toMatchObject({ section: '3.1', target: 'planning/PLAN.md' });
  });

  it('ignores lowercase invariants without a number', () => {
    expect(findCitations('the invariant holds; invariants 3 and 4 are prose')).toEqual([]);
  });
});

describe('checkCitations', () => {
  const docs = new Map([['docs/architecture.md', '## 4. Platform modules\n### 2.5 Merge policy\n']]);

  it('resolves citations to existing sections', () => {
    const report = checkCitations([{ path: 'a.ts', text: '// architecture §4, invariant 5' }], docs);
    expect(report.unresolved).toEqual([]);
    expect(report.resolved).toHaveLength(2);
  });

  it('reports missing sections and missing documents', () => {
    const report = checkCitations(
      [{ path: 'b.ts', text: '// architecture §12\n// see planning/MISSION.md §6' }],
      docs,
    );
    expect(report.unresolved.map((u) => [u.path, u.line, u.section, u.reason])).toEqual([
      ['b.ts', 1, '12', 'missing-section'],
      ['b.ts', 2, '6', 'missing-document'],
    ]);
  });
});

describe('repository', () => {
  it('has no unresolved architecture citations', () => {
    const run = spawnSync(process.execPath, ['scripts/check-architecture-refs.mjs', '--json'], { cwd: ROOT, encoding: 'utf8' });
    expect(run.stderr).toBe('');
    const report = JSON.parse(run.stdout) as { citations: number; unresolved: unknown[] };
    expect(report.unresolved).toEqual([]);
    expect(report.citations).toBeGreaterThanOrEqual(40);
    expect(run.status).toBe(0);
  });
});
