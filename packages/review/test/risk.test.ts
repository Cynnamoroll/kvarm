import { describe, expect, it } from 'vitest';
import {
  LARGE_CHANGE_LINES,
  classifyFile,
  countTestCases,
  dependencyNames,
  hasGeneratedMarker,
  isWhitespaceOnlyChange,
  needsContent,
  rateChange,
  type RiskChange,
  type RiskContent,
} from '../src/index';

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);

function change(path: string, over: Partial<RiskChange> = {}): RiskChange {
  return {
    path,
    status: 'modified',
    oldHash: H1,
    newHash: H2,
    oldMode: '100644',
    newMode: '100644',
    additions: 1,
    deletions: 1,
    ...over,
  };
}

const tags = (c: RiskChange, content?: RiskContent) => classifyFile(c, content).tags;

describe('classifyFile tags', () => {
  it('tags CI configuration paths', () => {
    for (const p of [
      '.forge/ci.json',
      '.github/workflows/test.yml',
      '.gitlab-ci.yml',
      '.circleci/config.yml',
      'Jenkinsfile',
      'Dockerfile',
      'docker/Dockerfile.prod',
      'Makefile',
      'azure-pipelines.yml',
    ]) {
      expect(tags(change(p)), p).toContain('ci-config');
    }
    expect(tags(change('src/ci.ts'))).not.toContain('ci-config');
    expect(tags(change('docs/github.md'))).not.toContain('ci-config');
  });

  it('tags a removed test file as test-deletion', () => {
    for (const p of ['test/app.test.ts', 'src/__tests__/x.js', 'pkg/foo_test.go', 'tests/test_api.py', 'spec/model_spec.rb']) {
      expect(tags(change(p, { status: 'removed', newHash: null, newMode: null, additions: 0, deletions: 10 })), p).toContain(
        'test-deletion',
      );
    }
    expect(tags(change('src/app.ts', { status: 'removed', newHash: null, newMode: null }))).not.toContain('test-deletion');
  });

  it('tags removed or emptied test cases inside a modified test file', () => {
    const before = "describe('x', () => {\n  it('a', () => {});\n  it('b', () => {});\n  test('c', () => {});\n});\n";
    const fewer = "describe('x', () => {\n  it('a', () => {});\n});\n";
    const skipped = "describe('x', () => {\n  it('a', () => {});\n  it.skip('b', () => {});\n  test('c', () => {});\n});\n";
    const more = `${before}it('d', () => {});\n`;
    const c = change('test/app.test.ts');
    expect(tags(c, { oldText: before, newText: fewer })).toContain('test-deletion');
    expect(tags(c, { oldText: before, newText: '' })).toContain('test-deletion');
    expect(tags(c, { oldText: before, newText: skipped })).toContain('test-deletion');
    expect(tags(c, { oldText: before, newText: more })).not.toContain('test-deletion');
    // No content: a modified test file is not assumed to lose tests.
    expect(tags(c)).not.toContain('test-deletion');
  });

  it('counts test cases across common frameworks', () => {
    expect(countTestCases("it('a', f)\ntest.only('b', f)\n  specify('c', f)\nit.skip('d', f)\n")).toEqual({ cases: 4, skipped: 1 });
    expect(countTestCases('def test_a():\n    pass\nasync def test_b():\n    pass\n@pytest.mark.skip\ndef helper(): pass\n')).toEqual({
      cases: 2,
      skipped: 1,
    });
    expect(countTestCases('func TestA(t *testing.T) {}\nfunc TestB(t *testing.T) { t.Skip() }\n')).toEqual({ cases: 2, skipped: 1 });
    expect(countTestCases('#[test]\nfn a() {}\n#[tokio::test]\nasync fn b() {}\n#[ignore]\n')).toEqual({ cases: 2, skipped: 1 });
    expect(countTestCases('@Test\nvoid a() {}\n@Disabled\n@Test\nvoid b() {}\n')).toEqual({ cases: 2, skipped: 1 });
  });

  it('tags lockfiles by name', () => {
    for (const p of ['package-lock.json', 'web/yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum', 'poetry.lock', 'uv.lock']) {
      expect(tags(change(p, { additions: 400, deletions: 300 })), p).toContain('lockfile');
    }
    expect(tags(change('package-lock.json', { additions: 5000, deletions: 0 }))).not.toContain('large');
    expect(tags(change('package-lock.json'))).not.toContain('semantic');
  });

  it('tags manifests that add dependencies, and only those', () => {
    const oldPkg = JSON.stringify({ name: 'x', dependencies: { hono: '^4' }, devDependencies: { vitest: '^4' } }, null, 2);
    const added = JSON.stringify({ name: 'x', dependencies: { hono: '^4', 'left-pad': '1.3.0' }, devDependencies: { vitest: '^4' } }, null, 2);
    const bumped = JSON.stringify({ name: 'x', dependencies: { hono: '^5' }, devDependencies: { vitest: '^4' } }, null, 2);
    const c = change('package.json');
    expect(tags(c, { oldText: oldPkg, newText: added })).toContain('new-dependency');
    expect(classifyFile(c, { oldText: oldPkg, newText: added }).evidence?.newDependencies).toEqual(['left-pad']);
    expect(tags(c, { oldText: oldPkg, newText: bumped })).not.toContain('new-dependency');
    expect(tags(c)).not.toContain('new-dependency');
    // A new manifest adds everything it declares.
    expect(tags(change('package.json', { status: 'added', oldHash: null, oldMode: null }), { newText: added })).toContain('new-dependency');
  });

  it('extracts dependency names from the supported manifests', () => {
    expect(dependencyNames('requirements.txt', '# c\nrequests==2.0\nDjango>=4 ; python_version>"3"\n-r base.txt\nfoo_bar[x]\n')).toEqual([
      'django',
      'foo-bar',
      'requests',
    ]);
    expect(dependencyNames('go.mod', 'module m\n\ngo 1.22\n\nrequire github.com/a/b v1.0.0\nrequire (\n\tgithub.com/c/d v0.1.0 // indirect\n\tgolang.org/x/e v0.2.0\n)\n')).toEqual([
      'github.com/a/b',
      'github.com/c/d',
      'golang.org/x/e',
    ]);
    expect(
      dependencyNames(
        'Cargo.toml',
        '[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\ntokio = { version = "1", features = ["full"] }\n\n[dev-dependencies]\ninsta = "1"\n\n[dependencies.rand]\nversion = "0.8"\n',
      ),
    ).toEqual(['insta', 'rand', 'serde', 'tokio']);
    expect(
      dependencyNames(
        'pyproject.toml',
        '[project]\nname = "x"\ndependencies = [\n  "httpx>=0.27",\n  "pydantic",\n]\n\n[project.optional-dependencies]\ndev = ["pytest"]\n\n[tool.poetry.dependencies]\npython = "^3.11"\nrich = "^13"\n',
      ),
    ).toEqual(['httpx', 'pydantic', 'pytest', 'rich']);
    expect(dependencyNames('package.json', '{not json')).toEqual([]);
    expect(dependencyNames('README.md', 'anything')).toBeNull();
  });

  it('keeps reading a pyproject dependency array past quoted extras', () => {
    const multiline = '[project]\nname = "x"\ndependencies = [\n  "requests[socks]>=2",\n  "httpx>=0.27",\n]\n';
    expect(dependencyNames('pyproject.toml', multiline)).toEqual(['httpx', 'requests']);
    const opening = '[project]\ndependencies = ["requests[socks,security]>=2",\n  \'uvicorn[standard]\',\n  "httpx>=0.27",\n]\n';
    expect(dependencyNames('pyproject.toml', opening)).toEqual(['httpx', 'requests', 'uvicorn']);
    const oneLine = '[project]\ndependencies = ["requests[socks]>=2", "httpx"]\nname = "x"\n';
    expect(dependencyNames('pyproject.toml', oneLine)).toEqual(['httpx', 'requests']);
    const optional =
      '[project.optional-dependencies]\nserver = [\n  "uvicorn[standard]>=0.30",\n  "gunicorn",\n]\ncli = ["typer[all]", "rich"]\n\n[tool.other]\nfake = ["not-a-dep"]\n';
    expect(dependencyNames('pyproject.toml', optional)).toEqual(['gunicorn', 'rich', 'typer', 'uvicorn']);
    // A ] inside a comment or a quoted string never ends the array early, and the real terminator still does.
    const tricky = '[project]\ndependencies = [\n  "a[x]",  # trailing ] comment\n  "b ; extra == \'y]\'",\n  "c",\n]\nversion = "1"\n';
    expect(dependencyNames('pyproject.toml', tricky)).toEqual(['a', 'b', 'c']);
  });

  it('tags a dependency added after a requirement with extras as new-dependency', () => {
    const c = change('pyproject.toml');
    const before = '[project]\nname = "x"\ndependencies = [\n  "requests[socks]>=2",\n]\n';
    const after = '[project]\nname = "x"\ndependencies = [\n  "requests[socks]>=2",\n  "httpx>=0.27",\n]\n';
    expect(tags(c, { oldText: before, newText: after })).toContain('new-dependency');
    expect(classifyFile(c, { oldText: before, newText: after }).evidence?.newDependencies).toEqual(['httpx']);

    const openBefore = '[project]\ndependencies = ["requests[socks]>=2",\n]\n';
    const openAfter = '[project]\ndependencies = ["requests[socks]>=2",\n  "httpx>=0.27",\n]\n';
    expect(classifyFile(c, { oldText: openBefore, newText: openAfter }).evidence?.newDependencies).toEqual(['httpx']);

    const optBefore = '[project.optional-dependencies]\nserver = [\n  "uvicorn[standard]",\n]\n';
    const optAfter = '[project.optional-dependencies]\nserver = [\n  "uvicorn[standard]",\n  "gunicorn",\n]\n';
    expect(classifyFile(c, { oldText: optBefore, newText: optAfter }).evidence?.newDependencies).toEqual(['gunicorn']);
  });

  it('tags exact renames, mode-only and whitespace-only edits as mechanical', () => {
    expect(tags(change('y.md', { status: 'renamed', oldPath: 'x.md', oldHash: H1, newHash: H1, additions: 0, deletions: 0 }))).toEqual(['mechanical']);
    expect(tags(change('run.sh', { status: 'typechange', oldHash: H1, newHash: H1, newMode: '100755', additions: 0, deletions: 0 }))).toContain(
      'mechanical',
    );
    const ws = tags(change('ws.txt'), { oldText: 'a b\nc\n', newText: 'a  b\n\tc\n' });
    expect(ws).toContain('mechanical');
    expect(tags(change('src/a.ts'), { whitespaceOnly: true })).toContain('mechanical');
    expect(tags(change('src/a.ts'), { whitespaceOnly: true })).not.toContain('semantic');
  });

  it('detects whitespace-only changes and generated markers', () => {
    expect(isWhitespaceOnlyChange('a b\n', 'a  b\n')).toBe(true);
    expect(isWhitespaceOnlyChange('a b\n', 'a b\n\n\n')).toBe(true);
    expect(isWhitespaceOnlyChange('a b\n', 'a b\n')).toBe(false);
    expect(isWhitespaceOnlyChange('ab\n', 'a c\n')).toBe(false);
    expect(hasGeneratedMarker('// Code generated by protoc. DO NOT EDIT.\npackage x\n')).toBe(true);
    expect(hasGeneratedMarker('/* @generated */\n')).toBe(true);
    expect(hasGeneratedMarker(`${'x\n'.repeat(5000)}// Code generated\n`)).toBe(false);
    expect(hasGeneratedMarker('export const a = 1;\n')).toBe(false);
  });

  it('tags logic changes in code as semantic but not prose', () => {
    expect(tags(change('src/billing.ts'), { oldText: 'a = 1\n', newText: 'a = 2\n' })).toContain('semantic');
    expect(tags(change('src/billing.ts'))).toContain('semantic');
    expect(tags(change('lib/x.py', { status: 'added', oldHash: null, oldMode: null }))).toContain('semantic');
    expect(tags(change('README.md'))).toEqual([]);
    expect(tags(change('docs/guide.txt'))).toEqual([]);
  });

  it('tags generated files by path or by marker, without semantic', () => {
    expect(tags(change('src/generated/api.gen.ts'))).toContain('generated');
    expect(tags(change('src/generated/api.gen.ts'))).not.toContain('semantic');
    expect(tags(change('proto/x.pb.go'))).toContain('generated');
    expect(tags(change('src/client.ts'), { generatedMarker: true })).toContain('generated');
    expect(tags(change('src/client.ts'), { newText: '// Code generated by tool. DO NOT EDIT.\nexport {}\n', oldText: '' })).toContain(
      'generated',
    );
  });

  it('tags security-sensitive paths', () => {
    for (const p of ['src/auth/session.ts', 'lib/crypto.go', 'app/secrets/vault.py', 'src/authMiddleware.ts', '.env.production', 'certs/server.pem']) {
      expect(tags(change(p)), p).toContain('security-sensitive');
    }
    for (const p of ['src/author.ts', 'src/tokenizer.ts', 'docs/monkeys.md']) {
      expect(tags(change(p)), p).not.toContain('security-sensitive');
    }
  });

  it('tags large changes at the documented line threshold, or over-size files', () => {
    expect(tags(change('big.ts', { status: 'added', additions: LARGE_CHANGE_LINES, deletions: 0 }))).toContain('large');
    expect(tags(change('big.ts', { additions: LARGE_CHANGE_LINES - 1, deletions: 0 }))).not.toContain('large');
    expect(tags(change('huge.txt', { additions: undefined, deletions: undefined, tooLarge: true }))).toContain('large');
  });
});

describe('classifyFile scores', () => {
  it('returns integer scores in 0..100 with sorted, unique tags', () => {
    const r = classifyFile(change('.github/workflows/auth-secrets.yml', { status: 'removed', additions: 0, deletions: 5000 }));
    expect(Number.isInteger(r.score)).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.tags).toEqual([...new Set(r.tags)].sort());
  });

  it('ranks risky signals above mechanical and prose changes', () => {
    const ci = classifyFile(change('.forge/ci.json')).score;
    const testDel = classifyFile(change('test/app.test.ts', { status: 'removed', newHash: null, newMode: null, additions: 0, deletions: 12 })).score;
    const semantic = classifyFile(change('src/billing.ts')).score;
    const rename = classifyFile(change('y.md', { status: 'renamed', oldPath: 'x.md', newHash: H1, additions: 0, deletions: 0 })).score;
    const docs = classifyFile(change('README.md', { additions: 2, deletions: 1 })).score;
    expect(testDel).toBeGreaterThan(semantic);
    expect(ci).toBeGreaterThan(semantic);
    expect(semantic).toBeGreaterThan(docs);
    expect(docs).toBeGreaterThanOrEqual(rename);
    expect(rename).toBeLessThanOrEqual(10);
  });

  it('caps a mechanical change at 10 even on a sensitive path', () => {
    const r = classifyFile(change('src/auth/session.ts', { status: 'renamed', oldPath: 'src/auth/s.ts', newHash: H1 }));
    expect(r.tags).toContain('mechanical');
    expect(r.tags).toContain('security-sensitive');
    expect(r.score).toBeLessThanOrEqual(10);
  });
});

describe('needsContent', () => {
  it('asks for manifests and modified test files only', () => {
    expect(needsContent(change('package.json'))).toEqual({ old: true, new: true });
    expect(needsContent(change('package.json', { status: 'added', oldHash: null, oldMode: null }))).toEqual({ old: false, new: true });
    expect(needsContent(change('test/app.test.ts'))).toEqual({ old: true, new: true });
    expect(needsContent(change('test/app.test.ts', { status: 'removed', newHash: null, newMode: null }))).toEqual({ old: false, new: false });
    expect(needsContent(change('src/a.ts'))).toEqual({ old: false, new: false });
    expect(needsContent(change('package.json', { binary: true }))).toEqual({ old: false, new: false });
    expect(needsContent(change('y.md', { status: 'renamed', oldPath: 'x.md', newHash: H1 }))).toEqual({ old: false, new: false });
  });
});

describe('rateChange', () => {
  const risky = [
    { change: change('.forge/ci.json'), content: {} },
    { change: change('test/app.test.ts', { status: 'removed', newHash: null, newMode: null, additions: 0, deletions: 12 }), content: {} },
    { change: change('package-lock.json', { additions: 30, deletions: 2 }), content: {} },
    {
      change: change('package.json'),
      content: { oldText: '{"dependencies":{"a":"1"}}', newText: '{"dependencies":{"a":"1","left-pad":"1"}}' },
    },
    { change: change('y.md', { status: 'renamed', oldPath: 'x.md', newHash: H1, additions: 0, deletions: 0 }), content: {} },
    { change: change('ws.txt'), content: { whitespaceOnly: true } },
    { change: change('src/billing.ts', { additions: 3, deletions: 1 }), content: {} },
    { change: change('src/generated/api.gen.ts'), content: { generatedMarker: true } },
    { change: change('src/auth/session.ts'), content: {} },
    { change: change('big.ts', { status: 'added', oldHash: null, oldMode: null, additions: 5000, deletions: 0 }), content: {} },
  ];
  const rated = () => rateChange(risky.map(({ change: c, content }) => ({ change: c, risk: classifyFile(c, content) })));

  it('rates CI-config plus test deletion as high with reasons naming both', () => {
    const r = rated();
    expect(r.level).toBe('high');
    expect(Number.isInteger(r.score)).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(60);
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.reasons.join('\n')).toMatch(/\.forge\/ci\.json/);
    expect(r.reasons.join('\n')).toMatch(/test\/app\.test\.ts/);
    expect(r.reasons.join('\n')).toMatch(/left-pad/);
  });

  it('rates CI-config plus test deletion high even when nothing else changed', () => {
    const files = [risky[0]!, risky[1]!].map(({ change: c }) => ({ change: c, risk: classifyFile(c) }));
    expect(rateChange(files).level).toBe('high');
  });

  it('rates a docs-only change low, below the risky change', () => {
    const c = change('README.md', { additions: 3, deletions: 1 });
    const r = rateChange([{ change: c, risk: classifyFile(c) }]);
    expect(r.level).toBe('low');
    expect(r.score).toBeLessThan(rated().score);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('rates an empty change low with score 0', () => {
    expect(rateChange([])).toEqual({ score: 0, level: 'low', reasons: ['no files changed'] });
  });

  it('rates a single semantic change medium-or-lower and a security change medium', () => {
    const sem = change('src/billing.ts', { additions: 20, deletions: 5 });
    expect(rateChange([{ change: sem, risk: classifyFile(sem) }]).level).toBe('low');
    const sec = change('src/auth/session.ts', { additions: 20, deletions: 5 });
    expect(rateChange([{ change: sec, risk: classifyFile(sec) }]).level).toBe('medium');
  });

  it('notes truncated and stats-omitted comparisons in the reasons', () => {
    const c = change('README.md');
    const r = rateChange([{ change: c, risk: classifyFile(c) }], { truncated: true, statsOmitted: true });
    expect(r.reasons.some((x) => /truncated/.test(x))).toBe(true);
    expect(r.reasons.some((x) => /line stats/.test(x))).toBe(true);
  });

  it('is deterministic and independent of input order', () => {
    const a = rated();
    const reversed = rateChange([...risky].reverse().map(({ change: c, content }) => ({ change: c, risk: classifyFile(c, content) })));
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(a));
    expect(JSON.stringify(rated())).toBe(JSON.stringify(a));
  });

  it('lists at most three paths per reason', () => {
    const many = Array.from({ length: 6 }, (_, i) => change(`.github/workflows/w${i}.yml`));
    const r = rateChange(many.map((c) => ({ change: c, risk: classifyFile(c) })));
    const ci = r.reasons.find((x) => x.startsWith('CI configuration'))!;
    expect(ci).toMatch(/and 3 more/);
  });
});
