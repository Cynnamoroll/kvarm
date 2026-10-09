import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATIONS } from '@forge/ops';
import { main } from '../src/main.js';

const BIN = fileURLToPath(new URL('../bin/forge.js', import.meta.url));
const PAT = `forge_pat_${'ab'.repeat(32)}`;

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
    const r = reply;
    reply = { status: 200, body: { ok: true } };
    res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function forge(argv: string[], env: Record<string, string | undefined> = { FORGE_BASE_URL: base, FORGE_PAT: PAT }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { env, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

const last = () => seen[seen.length - 1]!;

describe('forge help', () => {
  it('lists checkout and every registry command', async () => {
    const r = await forge(['--help'], {});
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/checkout <owner\/repo> <ref> <dir>/);
    for (const op of OPERATIONS) expect(r.stdout, op.name).toContain(op.command.join(' '));
  });

  it('prints usage, arguments and the REST/MCP mapping for every command', async () => {
    for (const op of OPERATIONS) {
      const r = await forge([...op.command, '--help'], {});
      expect(r.code, op.name).toBe(0);
      expect(r.stdout, op.name).toContain(`usage: forge ${op.command.join(' ')}`);
      expect(r.stdout, op.name).toContain(op.description);
      expect(r.stdout, op.name).toContain(`MCP tool: ${op.name}`);
      expect(r.stdout, op.name).toContain(`REST: ${op.method} /api/v1${op.path}`);
      for (const p of op.params) expect(r.stdout, `${op.name}.${p.name}`).toContain(p.description);
    }
    const help = await forge(['help', 'file', 'read'], {});
    expect(help.stdout).toContain('usage: forge file read <repo> <path> [--ref <string>]');
  });

  it('lists the verbs of a group given alone and exits 2', async () => {
    const r = await forge(['workspace'], {});
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

describe('forge operations', () => {
  it('maps positionals and flags onto the REST request and prints the JSON reply', async () => {
    reply = { status: 200, body: { ref: 'main', path: 'README.md', encoding: 'utf-8', content: 'hi\n' } };
    const r = await forge(['file', 'read', 'cynthia/demo', 'README.md', '--ref', 'main', '--json']);
    expect(r.code, r.stderr).toBe(0);
    expect(last()).toMatchObject({ method: 'GET', url: '/api/v1/repos/cynthia/demo/contents?path=README.md&ref=main', auth: `Bearer ${PAT}` });
    expect(r.stdout.split('\n')).toHaveLength(1);
    expect(JSON.parse(r.stdout)).toEqual({ ref: 'main', path: 'README.md', encoding: 'utf-8', content: 'hi\n' });
  });

  it('pretty-prints without --json and accepts --flag=value', async () => {
    reply = { status: 200, body: { files: [] } };
    const r = await forge(['compare', 'get', 'o/r', 'main', 'feature/x', '--order=risk']);
    expect(r.code).toBe(0);
    expect(last().url).toBe('/api/v1/repos/o/r/compare/main...feature%2Fx?order=risk');
    expect(JSON.parse(r.stdout)).toEqual({ files: [] });
    expect(r.stdout).toContain('\n');
  });

  it('sends body parameters as JSON with kebab-case flags, lists and JSON values', async () => {
    await forge(['workspace', 'create', 'o/r', '--task', 'fix it', '--agent', 'bot', '--intent', '{"paths":["a.ts"]}']);
    expect(last()).toMatchObject({ method: 'POST', url: '/api/v1/repos/o/r/workspaces', contentType: 'application/json' });
    expect(JSON.parse(last().body)).toEqual({ task: 'fix it', agent: 'bot', intent: { paths: ['a.ts'] } });
    await forge(['workspace', 'change-set', 'o/r', 'abcd', '--title', 't', '--merge-policy', 'review']);
    expect(JSON.parse(last().body)).toEqual({ title: 't', mergePolicy: 'review' });
    await forge(['intent', 'set', 'o/r', 'abcd', '--paths', 'a.ts', '--paths', 'src/', '--ttl-seconds', '120']);
    expect(JSON.parse(last().body)).toEqual({ paths: ['a.ts', 'src/'], ttlSeconds: 120 });
    await forge(['nexus', 'forecast', 'o/r', '--paths', 'a.ts,src/']);
    expect(last().url).toBe('/api/v1/repos/o/r/forecast?paths=a.ts%2Csrc%2F');
  });

  it('sends no body for a POST without body parameters', async () => {
    await forge(['change', 'merge', 'o/r', '3']);
    expect(last()).toMatchObject({ method: 'POST', url: '/api/v1/repos/o/r/changes/3/merge', body: '' });
  });

  it('works without FORGE_PAT (anonymous public reads)', async () => {
    await forge(['repo', 'get', 'o/r'], { FORGE_BASE_URL: base });
    expect(last().auth).toBeUndefined();
  });
});

describe('forge failures', () => {
  it('exits 1 on an API error with the code, the cause and a next step, and never prints the token', async () => {
    reply = { status: 404, body: { error: 'not found', code: 'NOT_FOUND' } };
    const r = await forge(['repo', 'get', 'cynthia/private', '--json']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('NOT_FOUND');
    expect(r.stderr).toContain('cynthia/private');
    expect(r.stderr).toMatch(/hint: /);
    expect(JSON.parse(r.stdout)).toEqual({ status: 404, error: 'not found', code: 'NOT_FOUND' });
    expect(r.stdout + r.stderr).not.toContain(PAT);
    expect(r.stdout + r.stderr).not.toMatch(/forge_pat_/);
  });

  it('names the token and its scope on 401/403 without printing it', async () => {
    reply = { status: 401, body: { error: 'unauthorized' } };
    const unauth = await forge(['repo', 'list']);
    expect(unauth.code).toBe(1);
    expect(unauth.stderr).toMatch(/FORGE_PAT/);
    reply = { status: 403, body: { error: 'insufficient token scope', code: 'INSUFFICIENT_SCOPE' } };
    const scope = await forge(['grant', 'list', 'o/r']);
    expect(scope.code).toBe(1);
    expect(scope.stderr).toMatch(/api scope/);
    expect(unauth.stderr + scope.stderr).not.toContain(PAT);
  });

  it('shows the current state on a stale-revision conflict', async () => {
    reply = { status: 409, body: { error: 'head moved', code: 'HEAD_MOVED', headSha: 'abc' } };
    const r = await forge(['change', 'merge', 'o/r', '1']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('HEAD_MOVED');
    expect(r.stderr).toContain('"headSha":"abc"');
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
      const r = await forge(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.stderr, argv.join(' ')).toMatch(msg);
    }
    const noBase = await forge(['repo', 'list'], { FORGE_PAT: PAT });
    expect(noBase.code).toBe(2);
    expect(noBase.stderr).toMatch(/FORGE_BASE_URL is not set/);
  });

  it('exits 1 with the cause when the platform is unreachable', async () => {
    const r = await forge(['repo', 'list'], { FORGE_BASE_URL: 'http://127.0.0.1:1', FORGE_PAT: PAT });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/could not reach http:\/\/127\.0\.0\.1:1/);
    expect(r.stderr).not.toContain(PAT);
  });
});
