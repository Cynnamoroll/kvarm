/**
 * Platform personal access tokens (PATs) for git-over-HTTPS, REST, and MCP.
 * Human sign-in is WorkOS AuthKit (see auth/workos.ts); PATs exist because
 * git clients need basic-auth credentials tied to a user. Tokens are stored
 * SHA-256-hashed; the plaintext is shown exactly once at mint time.
 */

import { sha256Hex } from '@forge/gitops';

export type Scope = 'read' | 'write' | 'api' | 'ci';

export interface PATInfo {
  id: string;
  userId: string;
  scopes: Scope[];
}

/** write implies read for git operations. */
export function scopesAllow(scopes: string[], needed: Scope): boolean {
  if (scopes.includes(needed)) return true;
  return needed === 'read' && scopes.includes('write');
}

function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const b of buf) s += b.toString(16).padStart(2, '0');
  return s;
}

export function parseBasicAuth(
  header: string | undefined,
): { username: string; password: string } | null {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const decoded = atob(header.slice(6));
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

export async function mintPAT(
  env: Env,
  userId: string,
  name: string,
  scopes: Scope[],
): Promise<{ id: string; token: string; prefix: string }> {
  const token = `forge_pat_${randomHex(32)}`;
  const hash = await sha256Hex(token);
  const id = crypto.randomUUID();
  const prefix = token.slice(0, 18);
  await env.DB.prepare(
    'INSERT INTO pat (id, user_id, name, prefix, hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, userId, name, prefix, hash, JSON.stringify(scopes), Date.now())
    .run();
  return { id, token, prefix };
}

export async function revokePAT(env: Env, id: string, userId: string): Promise<boolean> {
  const res = await env.DB.prepare('DELETE FROM pat WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function verifyPAT(env: Env, token: string): Promise<PATInfo | null> {
  if (!token.startsWith('forge_pat_')) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    'SELECT id, user_id, scopes, expires_at FROM pat WHERE hash = ?',
  )
    .bind(hash)
    .first<{ id: string; user_id: string; scopes: string; expires_at: number | null }>();
  if (!row) return null;
  if (row.expires_at !== null && row.expires_at < Date.now()) return null;
  let scopes: Scope[] = [];
  try {
    scopes = JSON.parse(row.scopes) as Scope[];
  } catch {
    scopes = [];
  }
  return { id: row.id, userId: row.user_id, scopes };
}

/** Fire-and-forget last-used stamping (callers wrap in waitUntil). */
export function touchPAT(env: Env, id: string): Promise<unknown> {
  return env.DB.prepare('UPDATE pat SET last_used_at = ? WHERE id = ?')
    .bind(Date.now(), id)
    .run();
}
