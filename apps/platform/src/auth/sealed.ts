/**
 * Sealed cookie values: AES-256-GCM under a key derived (HKDF-SHA256) from
 * WORKOS_COOKIE_PASSWORD. Each purpose derives its own key and is bound as
 * additional data, so a sign-in state cookie can never be replayed as a
 * session cookie or the other way round. Tampered, truncated or foreign
 * values unseal to null; callers treat that as "no cookie".
 */

export type SealPurpose = 'session' | 'auth-state';

const VERSION = 'v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const bin = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sealKey(password: string, purpose: SealPurpose): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('kvarm-sealed-cookie'), info: encoder.encode(purpose) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(password: string, purpose: SealPurpose, payload: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await sealKey(password, purpose);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(`${VERSION}:${purpose}`) },
    key,
    encoder.encode(JSON.stringify(payload)),
  );
  return `${VERSION}.${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

export async function unseal<T>(password: string, purpose: SealPurpose, value: string): Promise<T | null> {
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const iv = fromB64url(parts[1]!);
  const ct = fromB64url(parts[2]!);
  if (!iv || iv.length !== 12 || !ct || ct.length < 16) return null;
  try {
    const key = await sealKey(password, purpose);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(`${VERSION}:${purpose}`) },
      key,
      ct,
    );
    return JSON.parse(decoder.decode(pt)) as T;
  } catch {
    return null;
  }
}

/** Constant-time string comparison for tokens of public length. */
export function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  return b64url(new Uint8Array(digest));
}
