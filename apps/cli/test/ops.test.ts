import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATIONS } from '@kvarm/ops';
import { main } from '../src/main.js';

const BIN = fileURLToPath(new URL('../bin/kvarm.js', import.meta.url));
const PAT = `kvarm_pat_${'ab'.repeat(32)}`;

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  contentType: string | undefined;
  body: string;
}

let server: Server;
let base = '';
const seen: Seen[] = [];
/** Next reply; reset to 200 {ok:true} after each request. */
let reply: { status: number; body: unknown } = { status: 200, body: { ok: true } };
/** Fixed replies by path (without the query), for commands that send several requests. */
const byPath = new Map<string, { status: number; body: unknown }>();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, contentType: req.headers['content-type'], body: await readBody(req) });
    const routed = byPath.get((req.url ?? '').split('?')[0]!);
    const r = routed ?? reply;
    if (!routed) reply = { status: 200, body: { ok: true } };
    res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function kvarm(argv: string[], env: Record<string, string | undefined> = { KVARM_BASE_URL: base, KVARM_PAT: PAT }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { env, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

const last = () => seen[seen.length - 1]!;

describe('kvarm help', () => {
  it('lists checkout and every registry command', async () => {
    const r = await kvarm(['--help'], {});
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/checkout <owner\/repo> <ref> <dir>/);
    for (const op of OPERATIONS) expect(r.stdout, op.name).toContain(op.command.join(' '));
  });

  it('prints usage, arguments and the REST/MCP mapping for every command', async () => {
    for (const op of OPERATIONS) {
      const r = await kvarm([...op.command, '--help'], {});
      expect(r.code, op.name).toBe(0);
      expect(r.stdout, op.name).toContain(`usage: kvarm ${op.command.join(' ')}`);
      expect(r.stdout, op.name).toContain(op.description);
      expect(r.stdout, op.name).toContain(`MCP tool: ${op.name}`);
      expect(r.stdout, op.name).toContain(`REST: ${op.method} /api/v1${op.path}`);
      for (const p of op.params) expect(r.stdout, `${op.name}.${p.name}`).toContain(p.description);
    }
    const help = await kvarm(['help', 'file', 'read'], {});
    expect(help.stdout).toContain('usage: kvarm file read <repo> <path> [--ref <string>]');
  });

  it('lists the verbs of a group given alone and exits 2', async () => {
    const r = await kvarm(['workspace'], {});
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('workspace create');
    expect(r.stderr).toContain('workspace change-set');
  });

  it('runs as the bin without a TTY', async () => {
    const r = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [BIN, '--help'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.on('close', (code) => resolve({ code, stdout }));
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('change merge');
  });
});

describe('kvarm operations', () => {
  it('maps positionals and flags onto the REST request and prints the JSON reply', async () => {
    reply = { status: 200, body: { ref: 'main', path: 'README.md', encoding: 'utf-8', content: 'hi\n' } };
    const r = await kvarm(['file', 'read', 'alice/demo', 'README.md', '--ref', 'main', '--json']);
    expect(r.code, r.stderr).toBe(0);
    expect(last()).toMatchObject({ method: 'GET', url: '/api/v1/repos/alice/demo/contents?path=README.md&ref=main', auth: `Bearer ${PAT}` });
    expect(r.stdout.split('\n')).toHaveLength(1);
    expect(JSON.parse(r.stdout)).toEqual({ ref: 'main', path: 'README.md', encoding: 'utf-8', content: 'hi\n' });
  });

  it('pretty-prints without --json and accepts --flag=value', async () => {
    reply = { status: 200, body: { files: [] } };
    const r = await kvarm(['compare', 'get', 'o/r', 'main', 'feature/x', '--order=risk']);
    expect(r.code).toBe(0);
    expect(last().url).toBe('/api/v1/repos/o/r/compare/main...feature%2Fx?order=risk');
    expect(JSON.parse(r.stdout)).toEqual({ files: [] });
    expect(r.stdout).toContain('\n');
  });

  it('sends body parameters as JSON with kebab-case flags, lists and JSON values', async () => {
    await kvarm(['workspace', 'create', 'o/r', '--task', 'fix it', '--agent', 'bot', '--intent', '{"paths":["a.ts"]}']);
    expect(last()).toMatchObject({ method: 'POST', url: '/api/v1/repos/o/r/workspaces', contentType: 'application/json' });
    expect(JSON.parse(last().body)).toEqual({ task: 'fix it', agent: 'bot', intent: { paths: ['a.ts'] } });
    await kvarm(['workspace', 'change-set', 'o/r', 'abcd', '--title', 't', '--merge-policy', 'review']);
    expect(JSON.parse(last().body)).toEqual({ title: 't', mergePolicy: 'review' });
    await kvarm(['intent', 'set', 'o/r', 'abcd', '--paths', 'a.ts', '--paths', 'src/', '--ttl-seconds', '120']);
    expect(JSON.parse(last().body)).toEqual({ paths: ['a.ts', 'src/'], ttlSeconds: 120 });
    await kvarm(['nexus', 'forecast', 'o/r', '--paths', 'a.ts,src/']);
    expect(last().url).toBe('/api/v1/repos/o/r/forecast?paths=a.ts%2Csrc%2F');
  });

  it('keeps commas inside decision paths: repeated flags, one literal path each', async () => {
    await kvarm(['decision', 'record', 'o/r', '--paths', 'src/a,b.ts', '--paths', 'c.md', '--chosen', 'ws-b', '--rejected', '[]', '--reason', 'r']);
    expect(last()).toMatchObject({ method: 'POST', url: '/api/v1/repos/o/r/decisions' });
    expect(JSON.parse(last().body)).toEqual({ paths: ['src/a,b.ts', 'c.md'], chosen: 'ws-b', rejected: [], reason: 'r' });
    await kvarm(['decision', 'context', 'o/r', '--path', 'src/a,b.ts', '--path=c.md']);
    expect(last().url).toBe('/api/v1/repos/o/r/context?path=src%2Fa%2Cb.ts&path=c.md');
    const help = await kvarm(['decision', 'context', '--help'], {});
    expect(help.stdout).toMatch(/--path <list>.*repeat the flag once per path; commas are part of the path/);
  });

  it('maps the repository lifecycle commands onto their REST routes', async () => {
    reply = { status: 200, body: { deleted: true } };
    const del = await kvarm(['repo', 'delete', 'o/r', '--json']);
    expect(del.code).toBe(0);
    expect(last()).toMatchObject({ method: 'DELETE', url: '/api/v1/repos/o/r', body: '' });
    expect(JSON.parse(del.stdout)).toEqual({ deleted: true });
    await kvarm(['repo', 'fork', 'o/r', '--name', 'r-copy']);
    expect(last()).toMatchObject({ method: 'POST', url: '/api/v1/repos/o/r/forks' });
    expect(JSON.parse(last().body)).toEqual({ name: 'r-copy' });
    await kvarm(['repo', 'import', 'https://example.test/src.git', '--name', 'src', '--branch', 'main', '--visibility', 'public']);
    expect(last()).toMatchObject({ method: 'POST', url: '/api/v1/import' });
    expect(JSON.parse(last().body)).toEqual({ url: 'https://example.test/src.git', name: 'src', branch: 'main', visibility: 'public' });
    const missing = await kvarm(['repo', 'import']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/url.*required/);
  });

  it('sends no body for a POST without body parameters', async () => {
    await kvarm(['change', 'merge', 'o/r', '3']);
    expect(last()).toMatchObject({ method: 'POST', url: '/api/v1/repos/o/r/changes/3/merge', body: '' });
  });

  it('maps the dependency and train commands onto their REST routes', async () => {
    const sha = 'c'.repeat(40);
    await kvarm(['deps', 'add', 'o/r', 'ab12', '--on-workspace', 'cd34', '--revision', sha]);
    expect(last()).toMatchObject({ method: 'POST', url: '/api/v1/repos/o/r/workspaces/ab12/dependencies' });
    expect(JSON.parse(last().body)).toEqual({ onWorkspace: 'cd34', revision: sha });
    await kvarm(['deps', 'list', 'o/r', 'ab12']);
    expect(last()).toMatchObject({ method: 'GET', url: '/api/v1/repos/o/r/workspaces/ab12/dependencies' });
    await kvarm(['deps', 'repin', 'o/r', 'ab12', 'e1', '--revision', sha, '--on-workspace', 'ef56']);
    expect(last()).toMatchObject({ method: 'POST', url: '/api/v1/repos/o/r/workspaces/ab12/dependencies/e1/repin' });
    expect(JSON.parse(last().body)).toEqual({ revision: sha, onWorkspace: 'ef56' });
    await kvarm(['deps', 'detach', 'o/r', 'ab12', 'e1']);
    expect(last()).toMatchObject({ method: 'DELETE', url: '/api/v1/repos/o/r/workspaces/ab12/dependencies/e1', body: '' });
    await kvarm(['train', 'status', 'o/r', '--base', 'main']);
    expect(last()).toMatchObject({ method: 'GET', url: '/api/v1/repos/o/r/train?base=main' });
  });

  it('works without KVARM_PAT (anonymous public reads)', async () => {
    await kvarm(['repo', 'get', 'o/r'], { KVARM_BASE_URL: base });
    expect(last().auth).toBeUndefined();
  });
});

describe('kvarm status', () => {
  it('composes the active workspaces with their pins, the train and the open tasks from reads only', async () => {
    const edge = { id: 'e1', workspaceId: 'ab12', onWorkspace: 'cd34', revision: 'a'.repeat(40), state: 'active' };
    byPath.set('/api/v1/repos/o/r/workspaces', { status: 200, body: { workspaces: [{ id: 'ab12', status: 'active' }, { id: 'cd34', status: 'active' }], nextCursor: null } });
    byPath.set('/api/v1/repos/o/r/workspaces/ab12/dependencies', { status: 200, body: { dependencies: [edge] } });
    byPath.set('/api/v1/repos/o/r/workspaces/cd34/dependencies', { status: 200, body: { dependencies: [] } });
    byPath.set('/api/v1/repos/o/r/train', { status: 200, body: { entries: [{ number: 2, position: 1 }], dependencies: [edge], truncated: false } });
    byPath.set('/api/v1/repos/o/r/tasks', { status: 200, body: { tasks: [], nextCursor: null } });
    try {
      const before = seen.length;
      const r = await kvarm(['status', 'o/r', '--json']);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout.split('\n')).toHaveLength(1);
      const sent = seen.slice(before);
      expect(sent.every((s) => s.method === 'GET')).toBe(true);
      expect(sent.map((s) => s.url).sort()).toEqual(
        [
          '/api/v1/repos/o/r/workspaces?status=active&limit=100',
          '/api/v1/repos/o/r/train?limit=100',
          '/api/v1/repos/o/r/tasks?status=open&limit=100',
          '/api/v1/repos/o/r/workspaces/ab12/dependencies',
          '/api/v1/repos/o/r/workspaces/cd34/dependencies',
        ].sort(),
      );
      expect(JSON.parse(r.stdout)).toEqual({
        repo: 'o/r',
        workspaces: [
          { id: 'ab12', status: 'active', dependencies: [edge] },
          { id: 'cd34', status: 'active', dependencies: [] },
        ],
        workspacesTruncated: false,
        train: { entries: [{ number: 2, position: 1 }], dependencies: [edge], truncated: false },
        tasks: { tasks: [], nextCursor: null },
      });
      const again = await kvarm(['status', 'o/r', '--json']);
      expect(again.stdout).toBe(r.stdout);
      expect((await kvarm(['status', '--help'], {})).stdout).toMatch(/usage: kvarm status <repo> \[--json\]/);
      expect((await kvarm(['--help'], {})).stdout).toMatch(/\n  status <owner\/repo>/);
    } finally {
      byPath.clear();
    }
  });

  it('fails with the first failing read, its code and a next step', async () => {
    byPath.set('/api/v1/repos/o/private/workspaces', { status: 404, body: { error: 'not found', code: 'NOT_FOUND' } });
    try {
      const r = await kvarm(['status', 'o/private', '--json']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('NOT_FOUND');
      expect(r.stderr).toContain('o/private does not exist or is private to you');
      expect(JSON.parse(r.stdout)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(r.stdout + r.stderr).not.toContain(PAT);
      expect((await kvarm(['status'])).code).toBe(2);
    } finally {
      byPath.clear();
    }
  });
});

describe('kvarm failures', () => {
  it('exits 1 on an API error with the code, the cause and a next step, and never prints the token', async () => {
    reply = { status: 404, body: { error: 'not found', code: 'NOT_FOUND' } };
    const r = await kvarm(['repo', 'get', 'alice/private', '--json']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('NOT_FOUND');
    expect(r.stderr).toContain('alice/private');
    expect(r.stderr).toMatch(/hint: /);
    expect(JSON.parse(r.stdout)).toEqual({ status: 404, error: 'not found', code: 'NOT_FOUND' });
    expect(r.stdout + r.stderr).not.toContain(PAT);
    expect(r.stdout + r.stderr).not.toMatch(/kvarm_pat_/);
  });

  it('names the token and its scope on 401/403 without printing it', async () => {
    reply = { status: 401, body: { error: 'unauthorized' } };
    const unauth = await kvarm(['repo', 'list']);
    expect(unauth.code).toBe(1);
    expect(unauth.stderr).toMatch(/KVARM_PAT/);
    reply = { status: 403, body: { error: 'insufficient token scope', code: 'INSUFFICIENT_SCOPE' } };
    const scope = await kvarm(['grant', 'list', 'o/r']);
    expect(scope.code).toBe(1);
    expect(scope.stderr).toMatch(/api scope/);
    expect(unauth.stderr + scope.stderr).not.toContain(PAT);
  });

  it('shows the current state on a stale-revision conflict', async () => {
    reply = { status: 409, body: { error: 'head moved', code: 'HEAD_MOVED', headSha: 'abc' } };
    const r = await kvarm(['change', 'merge', 'o/r', '1']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('HEAD_MOVED');
    expect(r.stderr).toContain('"headSha":"abc"');
  });

  it('names the recovery commands for a blocked dependency and the current revision for a stale one', async () => {
    const dep = { id: 'e1', workspaceId: 'ab12', onWorkspace: 'cd34', revision: 'a'.repeat(40), state: 'broken', sourceHead: null };
    reply = { status: 409, body: { error: 'workspace ab12 depends on workspace cd34, which is broken', code: 'DEPENDENCY_BROKEN', dependencies: [dep] } };
    const broken = await kvarm(['queue', 'add', 'o/r', '4']);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain('DEPENDENCY_BROKEN');
    expect(broken.stderr).toContain('kvarm deps list o/r ab12');
    expect(broken.stderr).toContain('kvarm deps repin o/r ab12 e1 --on-workspace <live-workspace> --revision <its-head>');
    expect(broken.stderr).toContain('kvarm deps detach o/r ab12 e1');
    const head = 'b'.repeat(40);
    reply = { status: 409, body: { error: 'stale', code: 'DEPENDENCY_STALE', dependencies: [{ ...dep, state: 'stale', sourceHead: head }] } };
    expect((await kvarm(['change', 'merge', 'o/r', '4'])).stderr).toContain(`kvarm deps repin o/r ab12 e1 --revision ${head}`);
    reply = { status: 422, body: { error: 'not the current revision', code: 'REVISION_NOT_CURRENT', currentRevision: head } };
    const stale = await kvarm(['deps', 'repin', 'o/r', 'ab12', 'e1', '--revision', 'f'.repeat(40)]);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain(`hint: the source's current revision is ${head}; retry with --revision ${head}`);
    expect(broken.stderr + stale.stderr).not.toContain(PAT);
  });

  it('exits 2 for usage errors and names the problem', async () => {
    const cases: Array<[string[], RegExp]> = [
      [['repo', 'get'], /repo.*required/],
      [['change', 'get', 'o/r', 'x'], /number.*integer/],
      [['repo', 'get', 'o/r', '--bogus', '1'], /bogus/],
      [['repo', 'get', 'not-a-repo'], /owner\/name/],
      [['repo', 'frob'], /unknown command "repo frob"/],
      [['workspace', 'create', 'o/r', '--task', 't', '--intent', '{bad'], /intent.*JSON/],
      [['repo', 'get', 'o/r', 'extra'], /unexpected argument "extra"/],
    ];
    for (const [argv, msg] of cases) {
      const r = await kvarm(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.stderr, argv.join(' ')).toMatch(msg);
    }
    const noBase = await kvarm(['repo', 'list'], { KVARM_PAT: PAT });
    expect(noBase.code).toBe(2);
    expect(noBase.stderr).toMatch(/KVARM_BASE_URL is not set/);
  });

  it('exits 1 with the cause when the platform is unreachable', async () => {
    const r = await kvarm(['repo', 'list'], { KVARM_BASE_URL: 'http://127.0.0.1:1', KVARM_PAT: PAT });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/could not reach http:\/\/127\.0\.0\.1:1/);
    expect(r.stderr).not.toContain(PAT);
  });

  it('refuses a reply body past the 8 MiB read cap instead of buffering it whole', async () => {
    reply = { status: 200, body: 'x'.repeat(9 * 1024 * 1024) };
    const r = await kvarm(['repo', 'list']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/response body exceeds the 8388608-byte read cap/);
    expect(r.stdout + r.stderr).not.toContain(PAT);
  });
});
