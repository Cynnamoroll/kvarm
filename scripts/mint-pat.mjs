#!/usr/bin/env node
/**
 * Ops script: mint a platform PAT directly in your deployment's remote D1
 * database (the target configured for scripts/wrangler-target.mjs), or with
 * --local in the local dev database that `wrangler dev -c wrangler.dev.jsonc`
 * serves (no Cloudflare account involved).
 *
 * Creates the user (non-admin) when the login does not exist yet, inserts a
 * PAT row with the given scopes, and writes the plaintext token to KEY=<token>
 * in a gitignored env file. Only the token prefix and PAT id (for revocation
 * via DELETE /api/v1/user/tokens/:id) are printed.
 *
 * Idempotent: if KEY is already set in the env file, nothing is minted unless
 * --rotate is passed (the old PAT row is left in place).
 *
 * Usage:
 *   node scripts/mint-pat.mjs --login <login> --scopes read,write,api,ci \
 *     --name my-token --token-file .env.local \
 *     --key KVARM_PAT [--email you@example.invalid] [--rotate] [--local]
 *
 * Remote mode requires `wrangler` (logged in) resolvable through npx, and
 * KVARM_D1_DATABASE_ID in the environment or apps/platform/.env.deploy.
 * --local needs only the local migrations applied
 * (`npm run db:migrate:local --workspace apps/platform`).
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { localD1Args, remoteD1Args } from './lib/wrangler-target.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platformDir = resolve(repoRoot, 'apps/platform');
const ALLOWED_SCOPES = ['read', 'write', 'api', 'ci'];

function fail(message) {
  console.error(`mint-pat: ${message}`);
  process.exit(1);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const { values: args } = parseArgs({
  options: {
    login: { type: 'string' },
    email: { type: 'string' },
    scopes: { type: 'string' },
    name: { type: 'string' },
    'token-file': { type: 'string' },
    key: { type: 'string' },
    rotate: { type: 'boolean', default: false },
    local: { type: 'boolean', default: false },
  },
});

const login = args.login ?? fail('--login is required');
if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(login)) fail('--login must match [a-z0-9-]{1,39}');
const scopes = (args.scopes ?? fail('--scopes is required')).split(',').map((s) => s.trim());
for (const s of scopes) {
  if (!ALLOWED_SCOPES.includes(s)) fail(`unknown scope "${s}" (allowed: ${ALLOWED_SCOPES.join(',')})`);
}
const name = args.name ?? fail('--name is required');
if (!/^[\w .:-]{1,64}$/.test(name)) fail('--name must be 1-64 word characters, spaces, dots, colons or dashes');
const key = args.key ?? fail('--key is required');
if (!/^[A-Z][A-Z0-9_]*$/.test(key)) fail('--key must be an UPPER_SNAKE env var name');
const email = args.email ?? `${login}@kvarm.invalid`;
const envFile = resolve(args['token-file'] ?? fail('--token-file is required'));

const ignored = spawnSync('git', ['-C', repoRoot, 'check-ignore', '-q', envFile]);
if (ignored.status !== 0) fail(`${envFile} is not gitignored; refusing to write a plaintext token there`);

const existing = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
const keyLine = new RegExp(`^${key}=.*$`, 'm');
if (keyLine.test(existing) && !args.rotate) {
  console.log(`${key} is already set in ${envFile}; nothing minted (pass --rotate to mint a new token)`);
  process.exit(0);
}

const token = `kvarm_pat_${randomBytes(32).toString('hex')}`;
const hash = createHash('sha256').update(token).digest('hex');
const prefix = token.slice(0, 18);
const patId = randomUUID();
const now = Date.now();

const sql = [
  `INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at)
     SELECT ${sqlString(randomUUID())}, ${sqlString(`kvarm-ops:${login}`)}, ${sqlString(login)},
            ${sqlString(email)}, ${sqlString(login)}, 0, ${now}
     WHERE NOT EXISTS (SELECT 1 FROM users WHERE login = ${sqlString(login)})`,
  `INSERT INTO pat (id, user_id, name, prefix, hash, scopes, created_at)
     SELECT ${sqlString(patId)}, id, ${sqlString(name)}, ${sqlString(prefix)}, ${sqlString(hash)},
            ${sqlString(JSON.stringify(scopes))}, ${now}
     FROM users WHERE login = ${sqlString(login)}`,
  `SELECT u.login AS login, u.is_admin AS isAdmin, p.prefix AS prefix, p.scopes AS scopes
     FROM pat p JOIN users u ON u.id = p.user_id WHERE p.id = ${sqlString(patId)}`,
].join(';\n');

const wrangler = spawnSync(process.execPath, args.local ? localD1Args(sql) : remoteD1Args(sql), { cwd: platformDir, encoding: 'utf8' });
if (wrangler.status !== 0) {
  fail(`wrangler d1 execute failed (exit ${wrangler.status})\n${wrangler.stderr}\n${wrangler.stdout}`);
}

let results;
try {
  const out = wrangler.stdout;
  results = JSON.parse(out.slice(out.indexOf('[')));
} catch {
  fail(`could not parse wrangler output:\n${wrangler.stdout}`);
}
const userCreated = (results[0]?.meta?.changes ?? 0) > 0;
const row = results[2]?.results?.[0];
if (!row || row.prefix !== prefix) fail('PAT row was not found after insert; nothing written');

const line = `${key}=${token}`;
const next = keyLine.test(existing)
  ? existing.replace(keyLine, line)
  : `${existing}${existing === '' || existing.endsWith('\n') ? '' : '\n'}${line}\n`;
writeFileSync(envFile, next, { mode: 0o600 });
chmodSync(envFile, 0o600);

console.log(
  JSON.stringify({
    login: row.login,
    userCreated,
    isAdmin: row.isAdmin === 1,
    patId,
    prefix: row.prefix,
    scopes: JSON.parse(row.scopes),
    envKey: key,
    envFile,
  }),
);
