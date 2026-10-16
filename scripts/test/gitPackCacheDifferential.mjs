import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '../..');
const fixturePath = join(root, 'apps/platform/test/gitPackCacheDifferential.fixture.ts');
const originalFixture = readFileSync(fixturePath, 'utf8');
const temp = mkdtempSync(join(tmpdir(), 'kvarm-pack-cache-'));
const source = join(root, '.git');
const bare = join(temp, 'source.git');
const execFileAsync = promisify(execFile);
const modes = [
  { name: 'full', args: [] },
  { name: 'shallow', args: ['--depth=1'] },
  { name: 'blobless', args: ['--filter=blob:none'] },
];

function git(args, options = {}) {
  return execFileSync('git', args, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function gitAsync(args, options = {}) {
  const { env, ...execOptions } = options;
  return execFileAsync('git', args, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    maxBuffer: 64 * 1024 * 1024,
    ...execOptions,
  });
}

function packBody(body) {
  return body.toString('base64');
}

function hasPktLine(body, expected) {
  for (let offset = 0; offset + 4 <= body.length;) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/i.test(header)) return false;
    const length = Number.parseInt(header, 16);
    if (length < 4) {
      offset += 4;
      continue;
    }
    if (offset + length > body.length) return false;
    const line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    if (line === expected) return true;
    offset += length;
  }
  return false;
}

const state = { captures: [], replay: false, replayResponse: null };
const server = createServer((request, response) => {
  const chunks = [];
  let handled = false;
  request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const handle = () => {
    if (handled) return;
    handled = true;
    try {
      const raw = Buffer.concat(chunks);
      const contentEncoding = String(request.headers['content-encoding'] ?? '').toLowerCase();
      const body = contentEncoding === 'gzip' ? gunzipSync(raw) : raw;
      const protocol = request.headers['git-protocol'];
      const childEnv = { ...process.env, ...(protocol ? { GIT_PROTOCOL: protocol } : {}) };
      const isAdvertisement = request.method === 'GET';
      const isFetch = body.includes(Buffer.from('command=fetch'));
      let result;
      if (state.replay && isFetch && state.replayResponse) {
        result = state.replayResponse;
      } else {
        result = git(
          ['upload-pack', '--stateless-rpc', ...(isAdvertisement ? ['--advertise-refs'] : []), bare],
          { env: childEnv, input: isAdvertisement ? undefined : body, stdio: ['pipe', 'pipe', 'pipe'] },
        );
      }
      if (!isAdvertisement && isFetch && result.includes(Buffer.from('packfile\n'))) {
        state.captures.push({ request: body, response: result });
      }
      response.writeHead(200, {
        'content-type': isAdvertisement
          ? 'application/x-git-upload-pack-advertisement'
          : 'application/x-git-upload-pack-result',
        'cache-control': 'no-cache',
      });
      response.end(result);
    } catch (error) {
      response.writeHead(500);
      response.end(error instanceof Error ? error.message : String(error));
    }
  };
  request.on('end', handle);
  if (request.method === 'GET') handle();
  else request.resume();
});

try {
  git(['clone', '--bare', '--no-hardlinks', source, bare], { stdio: 'ignore' });
  git(['--git-dir', bare, 'config', 'uploadpack.allowfilter', 'true']);
  git(['--git-dir', bare, 'config', 'uploadpack.allowSidebandAll', 'true']);
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Git fixture server failed to bind');
  const remote = `http://127.0.0.1:${address.port}/owner/repo.git`;
  const fixture = { cases: [] };

  for (const mode of modes) {
    state.captures = [];
    state.replay = false;
    state.replayResponse = null;
    const direct = join(temp, `${mode.name}-direct`);
    await gitAsync(['-c', 'protocol.version=2', 'clone', '--quiet', '--no-checkout', ...mode.args, remote, direct]);
    const capture = state.captures.at(-1);
    if (!capture) throw new Error(`System Git did not produce a pack response for ${mode.name}`);
    if (!hasPktLine(capture.request, 'sideband-all')) {
      throw new Error(`System Git did not negotiate sideband-all for ${mode.name}`);
    }
    fixture.cases.push({
      name: mode.name,
      request: packBody(capture.request),
      response: packBody(capture.response),
    });

    state.replay = true;
    state.replayResponse = capture.response;
    const replay = join(temp, `${mode.name}-replay`);
    await gitAsync(['-c', 'protocol.version=2', 'clone', '--quiet', '--no-checkout', ...mode.args, remote, replay]);
    git(['-C', direct, 'fsck', '--full'], { stdio: ['ignore', 'pipe', 'pipe'] });
    git(['-C', replay, 'fsck', '--full'], { stdio: ['ignore', 'pipe', 'pipe'] });
    state.replay = false;
    const directObjects = (await gitAsync(['-C', direct, 'rev-list', '--objects', '--all'], { encoding: 'utf8' })).stdout.trim().split('\n').sort();
    const replayObjects = (await gitAsync(['-C', replay, 'rev-list', '--objects', '--all'], { encoding: 'utf8' })).stdout.trim().split('\n').sort();
    if (JSON.stringify(directObjects) !== JSON.stringify(replayObjects)) {
      throw new Error(`${mode.name} object list differs between direct and cached-response replay clones`);
    }
  }

  writeFileSync(
    fixturePath,
    `export interface GitPackCacheDifferentialCase {
  name: 'full' | 'shallow' | 'blobless';
  request: string;
  response: string;
}

export interface GitPackCacheDifferentialFixture {
  cases: GitPackCacheDifferentialCase[];
}

export const fixture: GitPackCacheDifferentialFixture | null = ${JSON.stringify(fixture)};
`,
  );
  execFileSync('npx', ['vitest', 'run', '--project', 'platform', 'apps/platform/test/gitPackCacheDifferential.test.ts'], {
    cwd: root,
    stdio: 'inherit',
  });
} finally {
  await new Promise((resolveClose) => server.close(() => resolveClose()));
  writeFileSync(fixturePath, originalFixture);
  rmSync(temp, { recursive: true, force: true });
}
