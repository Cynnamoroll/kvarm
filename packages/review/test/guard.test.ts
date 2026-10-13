import { describe, expect, it } from 'vitest';
import { GUARD_LIMITS, addedLines, guard, guardWants, typosquatOf, type GuardChange, type GuardContent } from '../src/index';

// Fake credentials, assembled so no literal token sits in the source.
const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';
const KVARM_PAT = 'kvarm_pat_' + '0123456789abcdef'.repeat(4);
const GITHUB_TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const STRIPE_KEY = 'sk_live_' + '4eC39HqLyjWDarjtT1zdp7dc';
const SLACK_TOKEN = 'xoxb-' + '123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx';
const PRIVATE_KEY_HEADER = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
const HIGH_ENTROPY = 'Zx9' + 'Qm2Lp7Rt4Vw8Ny3Kb6Hs1Jd5';

function run(changes: GuardChange[], contents: Record<string, GuardContent>) {
  return guard(changes, new Map(Object.entries(contents)));
}

function added(path: string, text: string) {
  return run([{ path, status: 'added' }], { [path]: { new: text } });
}

function modified(path: string, oldText: string, newText: string) {
  return run([{ path, status: 'modified' }], { [path]: { old: oldText, new: newText } });
}

function rules(result: ReturnType<typeof guard>): string[] {
  return result.findings.map((f) => f.rule);
}

describe('guard: secrets', () => {
  it('flags the planted AWS key and kvarm PAT with path, line, rule and message, never the value', () => {
    const r = added('secrets.txt', `# config\naws_key=${AWS_KEY}\nkvarm_token=${KVARM_PAT}\n`);
    expect(r.conclusion).toBe('failure');
    expect(r.findings).toEqual([
      expect.objectContaining({ rule: 'secret/aws-access-key', path: 'secrets.txt', line: 2, severity: 'failure', message: expect.any(String) }),
      expect.objectContaining({ rule: 'secret/kvarm-token', path: 'secrets.txt', line: 3, severity: 'failure', message: expect.any(String) }),
    ]);
    const json = JSON.stringify(r);
    expect(json).not.toContain(AWS_KEY);
    expect(json).not.toContain(KVARM_PAT);
    expect(json).not.toContain('0123456789abcdef');
  });

  it.each([
    ['secret/github-token', `token: ${GITHUB_TOKEN}`, GITHUB_TOKEN],
    ['secret/stripe-key', `STRIPE=${STRIPE_KEY}`, STRIPE_KEY],
    ['secret/slack-token', `slack = "${SLACK_TOKEN}"`, SLACK_TOKEN],
    ['secret/private-key', PRIVATE_KEY_HEADER, 'PRIVATE KEY-----'],
    ['secret/high-entropy', `const apiKey = "${HIGH_ENTROPY}";`, HIGH_ENTROPY],
    ['secret/kvarm-token', `AGENT=${'kvarm_agt_' + 'f'.repeat(64)}`, 'f'.repeat(64)],
  ])('%s is detected and redacted', (rule, line, value) => {
    const r = added('src/config.ts', `export {};\n${line}\n`);
    expect(r.conclusion).toBe('failure');
    expect(rules(r)).toEqual([rule]);
    expect(r.findings[0]).toMatchObject({ path: 'src/config.ts', line: 2 });
    expect(JSON.stringify(r)).not.toContain(value);
  });

  it('only scans added lines: a secret already on the base side is not reported again', () => {
    const before = `aws_key=${AWS_KEY}\nname=a\n`;
    const r = modified('secrets.txt', before, `${before}name=b\n`);
    expect(r).toEqual({ conclusion: 'success', findings: [], complete: true });
  });

  it('ignores placeholders and low-entropy assignments', () => {
    const text = [
      'password = "changeme"',
      'token: ${{ secrets.KVARM_TOKEN }}',
      'const apiKey = process.env.API_KEY;',
      'secret = "xxxxxxxxxxxxxxxxxxxxxxxxxxxx"',
      'api_key = "<your-api-key-goes-here-123>"',
    ].join('\n');
    expect(added('README.md', `${text}\n`)).toEqual({ conclusion: 'success', findings: [], complete: true });
  });

  it('reports one finding per line even when several rules match it', () => {
    const r = added('a.env', `KVARM_SECRET_TOKEN=${KVARM_PAT}\n`);
    expect(rules(r)).toEqual(['secret/kvarm-token']);
  });
});

describe('guard: CI gaming', () => {
  const ci = JSON.stringify({ jobs: [{ name: 'test', run: 'npm test' }] }, null, 2) + '\n';

  it('flags `|| true` added to a ci.json job (and nothing else)', () => {
    const r = modified('.kvarm/ci.json', ci, ci.replace('npm test', 'npm test || true'));
    expect(r.conclusion).toBe('failure');
    expect(r.findings).toEqual([expect.objectContaining({ rule: 'ci-gaming/or-true', path: '.kvarm/ci.json', line: 5, severity: 'failure' })]);
  });

  it('flags continue-on-error and exit 0 added to a workflow', () => {
    const before = 'jobs:\n  test:\n    steps:\n      - run: npm test\n';
    const after = 'jobs:\n  test:\n    continue-on-error: true\n    steps:\n      - run: npm test; exit 0\n';
    const r = modified('.github/workflows/ci.yml', before, after);
    expect(r.conclusion).toBe('failure');
    expect(rules(r)).toEqual(['ci-gaming/continue-on-error', 'ci-gaming/exit-zero']);
    expect(r.findings.map((f) => f.line)).toEqual([3, 5]);
  });

  it('flags a package.json test script that cannot fail, but not `|| true` in ordinary source', () => {
    const pkg = (test: string) => `{\n  "scripts": {\n    "test": "${test}"\n  }\n}\n`;
    expect(rules(modified('package.json', pkg('vitest run'), pkg('vitest run || true')))).toEqual(['ci-gaming/or-true']);
    expect(added('src/run.sh', 'rm -f out || true\nexit 0\n')).toEqual({ conclusion: 'success', findings: [], complete: true });
  });

  it('does not flag lines that were already present', () => {
    const before = 'steps:\n  - run: make lint || true\n';
    expect(modified('.github/workflows/ci.yml', before, `${before}  - run: make test\n`).conclusion).toBe('success');
  });

  it('flags a deleted test file without reading it', () => {
    const r = run([{ path: 'tests/app.test.js', status: 'removed' }], {});
    expect(r.conclusion).toBe('failure');
    expect(r.findings).toEqual([expect.objectContaining({ rule: 'ci-gaming/test-deleted', path: 'tests/app.test.js', severity: 'failure' })]);
    expect(guardWants({ path: 'tests/app.test.js', status: 'removed' })).toEqual({ old: false, new: false });
  });

  it('flags a test file renamed to a non-test path, not one renamed between test paths', () => {
    expect(rules(run([{ path: 'lib/app.js', oldPath: 'tests/app.test.js', status: 'renamed' }], { 'lib/app.js': { old: 'x\n', new: 'x\n' } }))).toEqual([
      'ci-gaming/test-deleted',
    ]);
    expect(run([{ path: 'test/b.test.js', oldPath: 'test/a.test.js', status: 'renamed' }], { 'test/b.test.js': { old: 'x\n', new: 'x\n' } }).conclusion).toBe(
      'success',
    );
  });

  it('flags an emptied test file and newly skipped tests', () => {
    const before = "it('works', () => {});\nit('also works', () => {});\n";
    expect(rules(modified('src/app.test.ts', before, '// nothing\n'))).toEqual(['ci-gaming/test-emptied']);
    const skipped = modified('src/app.test.ts', before, "it.skip('works', () => {});\nit('also works', () => {});\n");
    expect(skipped.findings).toEqual([expect.objectContaining({ rule: 'ci-gaming/test-skipped', line: 1 })]);
  });
});

describe('guard: dependencies', () => {
  const pkg = (deps: Record<string, string>) => JSON.stringify({ name: 'app', dependencies: deps }, null, 2) + '\n';

  it('flags a typosquat of a popular package with the manifest path and name', () => {
    const r = modified('package.json', pkg({ lodash: '^4.17.21' }), pkg({ lodash: '^4.17.21', lodahs: '^1.0.0' }));
    expect(r.findings).toEqual([
      expect.objectContaining({ rule: 'dependency/typosquat', path: 'package.json', line: 5, message: expect.stringContaining('lodahs') }),
    ]);
    expect(r.findings[0]!.message).toContain('lodash');
    expect(['failure', 'neutral']).toContain(r.conclusion);
  });

  it('flags non-registry sources', () => {
    const r = modified('package.json', pkg({}), pkg({ helper: 'git+https://example.com/x/helper.git', other: 'github:someone/other' }));
    expect(rules(r)).toEqual(['dependency/non-registry', 'dependency/non-registry']);
    const py = modified('requirements.txt', 'requests==2.31.0\n', 'requests==2.31.0\nmylib @ https://example.com/mylib.tar.gz\n');
    expect(rules(py)).toEqual(['dependency/non-registry']);
  });

  it('accepts popular packages, their known neighbours and unrelated new names', () => {
    const r = modified('package.json', pkg({}), pkg({ react: '^18.0.0', preact: '^10.0.0', zod: '^3.0.0', 'my-internal-tool': '^1.0.0' }));
    expect(r).toEqual({ conclusion: 'success', findings: [], complete: true });
  });

  it('typosquatOf measures transpositions and separator games', () => {
    expect(typosquatOf('lodahs', 'npm')).toBe('lodash');
    expect(typosquatOf('expresss', 'npm')).toBe('express');
    expect(typosquatOf('lo-dash', 'npm')).toBe('lodash');
    expect(typosquatOf('reqeusts', 'requirements')).toBe('requests');
    expect(typosquatOf('lodash', 'npm')).toBeNull();
    expect(typosquatOf('ws', 'npm')).toBeNull();
  });
});

describe('guard: shape and bounds', () => {
  it('a README-only edit is a clean success', () => {
    expect(modified('README.md', '# App\n', '# App\n\nNow with more words.\n')).toEqual({ conclusion: 'success', findings: [], complete: true });
  });

  it('wants contents only for text it scans', () => {
    expect(guardWants({ path: 'a.txt', status: 'added' })).toEqual({ old: false, new: true });
    expect(guardWants({ path: 'a.txt', status: 'modified' })).toEqual({ old: true, new: true });
    expect(guardWants({ path: 'a.png', status: 'modified', binary: true })).toEqual({ old: false, new: false });
    expect(guardWants({ path: 'a.txt', status: 'removed' })).toEqual({ old: false, new: false });
    expect(guardWants({ path: 'web/package-lock.json', status: 'modified' })).toEqual({ old: false, new: false });
  });

  it('a truncated file list is neutral, never a clean success', () => {
    const r = guard([], new Map(), { listTruncated: true });
    expect(r.conclusion).toBe('neutral');
    expect(rules(r)).toEqual(['guard/incomplete']);
  });

  it('reports unscanned files as a neutral finding instead of claiming success', () => {
    const r = run([{ path: 'big.txt', status: 'added' }], { 'big.txt': { unavailable: true } });
    expect(r.conclusion).toBe('neutral');
    expect(r.findings).toEqual([expect.objectContaining({ rule: 'guard/incomplete', path: 'big.txt', severity: 'neutral' })]);
  });

  it('scans the read prefix of an oversized file and says the rest went unscanned', () => {
    const clean = run([{ path: 'big.txt', status: 'added' }], { 'big.txt': { new: 'hello\n', truncated: true } });
    expect(clean.conclusion).toBe('neutral');
    expect(clean.findings).toEqual([expect.objectContaining({ rule: 'guard/incomplete', path: 'big.txt', severity: 'neutral' })]);
    const leaked = run([{ path: 'big.txt', status: 'added' }], { 'big.txt': { new: `aws=${AWS_KEY}\n`, truncated: true } });
    expect(leaked.conclusion).toBe('failure');
    expect(rules(leaked)).toEqual(['secret/aws-access-key', 'guard/incomplete']);
  });

  it('caps findings and keeps the failure', () => {
    const text = Array.from({ length: GUARD_LIMITS.maxFindings + 10 }, () => `aws=${AWS_KEY}`).join('\n');
    const r = added('many.txt', text);
    expect(r.conclusion).toBe('failure');
    expect(r.findings).toHaveLength(GUARD_LIMITS.maxFindings);
    expect(r.omitted).toBe(10);
  });

  it('addedLines matches lines as a multiset and numbers them on the new side', () => {
    expect(addedLines('a\nb\nb\n', 'b\na\nb\nb\nc\n')).toEqual([
      { line: 4, text: 'b' },
      { line: 5, text: 'c' },
    ]);
    expect(addedLines(null, 'x\ny')).toEqual([
      { line: 1, text: 'x' },
      { line: 2, text: 'y' },
    ]);
  });
});

describe('guard completeness', () => {
  it('guard completeness: a fully scanned change is complete and lists nothing uninspected', () => {
    const r = added('README.md', 'hello\n');
    expect(r.complete).toBe(true);
    expect(r.uninspected).toBeUndefined();
  });

  it('guard completeness: an oversized file scanned only up to its prefix is incomplete (prefix-only)', () => {
    const r = run([{ path: 'big.txt', status: 'added' }], { 'big.txt': { new: 'hello\n', truncated: true } });
    expect(r.conclusion).toBe('neutral');
    expect(r.complete).toBe(false);
    expect(r.uninspected).toEqual({ count: 1, listTruncated: false, paths: [{ path: 'big.txt', reason: 'prefix-only' }] });
  });

  it('guard completeness: an unreadable blob or a missing read is incomplete (unavailable)', () => {
    const r = run(
      [
        { path: 'gone.txt', status: 'modified' },
        { path: 'never-read.txt', status: 'added' },
      ],
      { 'gone.txt': { unavailable: true } },
    );
    expect(r.complete).toBe(false);
    expect(r.uninspected).toEqual({
      count: 2,
      listTruncated: false,
      paths: [
        { path: 'gone.txt', reason: 'unavailable' },
        { path: 'never-read.txt', reason: 'unavailable' },
      ],
    });
  });

  it('guard completeness: files beyond the per-change file budget are incomplete (over-file-budget) and the list is bounded', () => {
    const n = GUARD_LIMITS.maxUninspectedPaths + 5;
    const changes: GuardChange[] = Array.from({ length: n + 1 }, (_, i) => ({ path: `f${String(i).padStart(3, '0')}.txt`, status: 'added' as const }));
    const contents: Record<string, GuardContent> = { 'f000.txt': { new: 'ok\n' } };
    for (const c of changes.slice(1)) contents[c.path] = { unavailable: true, overFileBudget: true };
    const r = run(changes, contents);
    expect(r.conclusion).toBe('neutral');
    expect(r.complete).toBe(false);
    expect(r.uninspected!.count).toBe(n);
    expect(r.uninspected!.paths).toHaveLength(GUARD_LIMITS.maxUninspectedPaths);
    expect(r.uninspected!.paths[0]).toEqual({ path: 'f001.txt', reason: 'over-file-budget' });
  });

  it('guard completeness: a truncated change list is incomplete even when every listed file was scanned', () => {
    const r = guard([{ path: 'a.txt', status: 'added' }], new Map([['a.txt', { new: 'ok\n' }]]), { listTruncated: true });
    expect(r.conclusion).toBe('neutral');
    expect(r.complete).toBe(false);
    expect(r.uninspected).toEqual({ count: 0, listTruncated: true, paths: [] });
  });

  it('guard completeness: a change with only advisory neutral findings stays complete', () => {
    const pkg = (extra: Record<string, string>) => JSON.stringify({ name: 'app', dependencies: { express: '^4.0.0', ...extra } }, null, 2) + '\n';
    const r = modified('package.json', pkg({}), pkg({ mylib: 'github:someone/mylib' }));
    expect(r.conclusion).toBe('neutral');
    expect(rules(r)).toEqual(['dependency/non-registry']);
    expect(r.complete).toBe(true);
    expect(r.uninspected).toBeUndefined();
  });

  it('guard completeness: an added line cut at the per-line scan limit makes the file incomplete (line-prefix)', () => {
    const long = 'x'.repeat(GUARD_LIMITS.maxLineChars + 100) + ` token=${KVARM_PAT}`;
    const r = added('bundle.js', `${long}\nshort\n`);
    expect(r.conclusion).toBe('neutral');
    expect(r.complete).toBe(false);
    expect(r.uninspected).toEqual({ count: 1, listTruncated: false, paths: [{ path: 'bundle.js', reason: 'line-prefix' }] });
    const exact = added('edge.js', 'y'.repeat(GUARD_LIMITS.maxLineChars) + '\n');
    expect(exact.complete).toBe(true);
  });

  it('guard completeness: a failure on a partially scanned change still reports what went uninspected', () => {
    const r = run([{ path: 'big.txt', status: 'added' }], { 'big.txt': { new: `aws=${AWS_KEY}\n`, truncated: true } });
    expect(r.conclusion).toBe('failure');
    expect(r.complete).toBe(false);
    expect(r.uninspected!.paths).toEqual([{ path: 'big.txt', reason: 'prefix-only' }]);
  });
});
