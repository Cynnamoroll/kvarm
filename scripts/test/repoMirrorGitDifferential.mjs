import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fixturePath = join(root, 'apps/platform/test/repoMirrorGitDifferential.fixture.ts');
const testPath = 'apps/platform/test/repoMirrorGitDifferential.test.ts';
const zero = '0'.repeat(40);
const optionSets = [
  [],
  ['peel'],
  ['symrefs'],
  ['ref-prefix refs/heads/'],
  ['peel', 'symrefs', 'ref-prefix refs/tags/'],
];

function git(cwd, args, { input, protocol } = {}) {
  return execFileSync('git', args, {
    cwd,
    env: protocol ? { ...process.env, GIT_PROTOCOL: protocol } : process.env,
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function gitText(cwd, args) {
  return git(cwd, args).toString('utf8').trim();
}

function pktLine(body) {
  const text = Buffer.from(body);
  return Buffer.concat([Buffer.from((text.length + 4).toString(16).padStart(4, '0')), text]);
}

function lsRefsRequest(options) {
  return Buffer.concat([
    pktLine('command=ls-refs\n'),
    pktLine('agent=git/2.34.1\n'),
    pktLine('object-format=sha1\n'),
    Buffer.from('0001'),
    ...options.map((option) => pktLine(`${option}\n`)),
    Buffer.from('0000'),
  ]);
}

function advertise(repoPath, protocol) {
  return git(repoPath, ['upload-pack', '--advertise-refs', '--stateless-rpc', repoPath], { protocol });
}

function lsRefs(repoPath, options) {
  return git(repoPath, ['upload-pack', '--stateless-rpc', repoPath], {
    input: lsRefsRequest(options),
    protocol: 'version=2',
  });
}

function encode(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function state(repoPath) {
  return {
    v0: encode(advertise(repoPath)),
    v2: encode(advertise(repoPath, 'version=2')),
    lsRefs: optionSets.map((options) => encode(lsRefs(repoPath, options))),
  };
}

function makeRepositories(rootPath) {
  const emptyPath = join(rootPath, 'empty.git');
  const fullPath = join(rootPath, 'full.git');
  const workPath = join(rootPath, 'work');
  git(rootPath, ['init', '--bare', '--initial-branch=main', emptyPath]);
  git(rootPath, ['init', '--bare', '--initial-branch=main', fullPath]);
  git(rootPath, ['init', '--initial-branch=main', workPath]);
  git(workPath, ['remote', 'add', 'origin', fullPath]);

  writeFileSync(join(workPath, 'README.md'), 'seed\n');
  git(workPath, ['add', 'README.md']);
  git(workPath, ['commit', '-m', 'seed']);
  git(workPath, ['push', 'origin', 'main']);
  git(workPath, ['branch', 'release']);
  git(workPath, ['push', 'origin', 'release']);
  git(workPath, ['branch', 'discard-me']);
  git(workPath, ['push', 'origin', 'discard-me']);
  git(workPath, ['push', 'origin', ':refs/heads/discard-me']);
  git(workPath, ['tag', 'lightweight']);
  git(workPath, ['tag', '-a', 'annotated', '-m', 'annotated']);
  git(workPath, ['push', 'origin', 'refs/tags/lightweight', 'refs/tags/annotated']);
  git(fullPath, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

  const fullStates = [state(fullPath)];
  const updates = [];

  const featureRef = 'refs/heads/feature/one';
  const featureOid = gitText(workPath, ['rev-parse', 'refs/heads/main']);
  git(workPath, ['branch', 'feature/one']);
  git(workPath, ['push', 'origin', 'refs/heads/feature/one:refs/heads/feature/one']);
  updates.push({ ref: featureRef, oldOid: zero, newOid: featureOid });
  fullStates.push(state(fullPath));

  const oldMain = gitText(fullPath, ['rev-parse', 'refs/heads/main']);
  writeFileSync(join(workPath, 'README.md'), 'advance\n');
  git(workPath, ['add', 'README.md']);
  git(workPath, ['commit', '-m', 'advance']);
  git(workPath, ['push', 'origin', 'main']);
  const newMain = gitText(fullPath, ['rev-parse', 'refs/heads/main']);
  updates.push({ ref: 'refs/heads/main', oldOid: oldMain, newOid: newMain });
  fullStates.push(state(fullPath));

  git(workPath, ['push', 'origin', ':refs/heads/feature/one']);
  updates.push({ ref: featureRef, oldOid: featureOid, newOid: zero });
  fullStates.push(state(fullPath));

  return { empty: state(emptyPath), full: fullStates, updates };
}

const rootPath = mkdtempSync(join(tmpdir(), 'kvarm-repo-mirror-git-'));
const original = readFileSync(fixturePath, 'utf8');
try {
  const prefix = original.slice(0, original.indexOf('export const fixture'));
  const fixture = makeRepositories(rootPath);
  writeFileSync(fixturePath, `${prefix}export const fixture: GitDifferentialFixture = ${JSON.stringify(fixture)};\n`);
  execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--project', 'platform', testPath], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
} finally {
  writeFileSync(fixturePath, original);
  rmSync(rootPath, { recursive: true, force: true });
}
