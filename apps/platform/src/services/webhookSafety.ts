/**
 * Outbound webhook safety (architecture §11.5, §2.7): target URL policy,
 * request signing and the at-rest encryption of hook secrets.
 *
 * URL policy. Only `https:` targets without credentials are accepted, and a
 * host that names this machine, a private network or a cloud metadata
 * service is refused: IP literals in loopback, private, link-local, CGNAT,
 * multicast and reserved ranges (IPv4, IPv6 and IPv4-mapped IPv6), and
 * hostnames such as `localhost`, `*.local`, `*.internal` or a single label.
 * The WHATWG URL parser has already normalized decimal, octal and hex IPv4
 * forms to dotted quads, so `https://2130706433/` is checked as 127.0.0.1.
 * Workers cannot resolve DNS before a fetch, so a public name whose records
 * point at a private address is not detected here; Worker subrequests leave
 * from Cloudflare's network, never from the deployer's private network.
 * Delivery never follows redirects (a 3xx is a failed attempt), so an
 * accepted URL cannot bounce the request elsewhere.
 *
 * Signing. The receiver verifies `x-kvarm-signature: sha256=<hex>`, the
 * HMAC-SHA256 under the hook secret of `<x-kvarm-timestamp>.<raw body>`.
 * The timestamp is inside the MAC so a captured delivery cannot be replayed
 * with a fresh timestamp; receivers reject timestamps outside a tolerance.
 *
 * Secrets at rest. Signing needs the plaintext secret, so it is stored
 * AES-GCM encrypted under a key derived (HKDF-SHA256) from the
 * `WEBHOOK_SECRET_KEY` Worker secret, with the hook id as additional data so
 * a ciphertext copied onto another hook does not decrypt.
 */

export const WEBHOOK_URL_MAX = 2048;

export type UrlVerdict = { ok: true; url: string } | { ok: false; reason: string };

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.intranet', '.lan', '.home.arpa', '.corp', '.private'];
const BLOCKED_NAMES = new Set(['localhost', 'localhost.localdomain', 'metadata', 'metadata.google.internal', 'instance-data']);

function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** True for every IPv4 address that is not ordinary public unicast. */
export function isBlockedIpv4(o: readonly number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF assignments, TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands an IPv6 literal (without brackets) to eight 16-bit groups. */
function ipv6Groups(host: string): number[] | null {
  let h = host.toLowerCase();
  const zone = h.indexOf('%');
  if (zone >= 0) h = h.slice(0, zone);
  // A trailing dotted quad (::ffff:1.2.3.4) becomes two groups.
  const quad = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (quad) {
    const o = ipv4Octets(quad[2]!);
    if (!o) return null;
    h = `${quad[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === '' ? [] : s.split(':'));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** True for every IPv6 address that is not ordinary global unicast. */
export function isBlockedIpv6(g: readonly number[]): boolean {
  const first = g[0]!;
  const allZeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (allZeroPrefix(8)) return true; // ::
  if (allZeroPrefix(7) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the embedded address.
  if (allZeroPrefix(5) && (g[5] === 0xffff || g[5] === 0)) {
    return isBlockedIpv4([g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255]);
  }
  // NAT64 (64:ff9b::/96) embeds an IPv4 address too.
  if (first === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isBlockedIpv4([g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255]);
  }
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xffc0) === 0xfec0 || // site-local fec0::/10
    (first & 0xff00) === 0xff00 || // multicast
    (first === 0x2001 && g[1] === 0x0db8) || // documentation
    first === 0x2002 || // 6to4 can embed any IPv4 address
    (first === 0x2001 && g[1] === 0) // Teredo can embed any IPv4 address
  );
}

/**
 * Validates a webhook target and returns its normalized form. `selfHost` is
 * this deployment's own host (APP_ORIGIN), refused so a hook cannot call
 * back into the platform.
 */
export function checkWebhookUrl(raw: unknown, selfHost?: string | null): UrlVerdict {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'url must be a non-empty string' };
  if (raw.length > WEBHOOK_URL_MAX) return { ok: false, reason: `url must be at most ${WEBHOOK_URL_MAX} characters` };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'url is not a valid absolute URL' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'url must use https' };
  if (u.username || u.password) return { ok: false, reason: 'url must not carry credentials' };
  let host = u.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0) return { ok: false, reason: 'url must name a host' };
  if (host.startsWith('[')) {
    const g = ipv6Groups(host.slice(1, -1));
    if (!g) return { ok: false, reason: 'url host is not a valid IPv6 address' };
    if (isBlockedIpv6(g)) return { ok: false, reason: 'url host is a private, loopback, link-local or reserved address' };
  } else if (/^[\d.]+$/.test(host)) {
    const o = ipv4Octets(host);
    if (!o) return { ok: false, reason: 'url host is not a valid IPv4 address' };
    if (isBlockedIpv4(o)) return { ok: false, reason: 'url host is a private, loopback, link-local or reserved address' };
  } else {
    if (BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
      return { ok: false, reason: 'url host is a local or internal name' };
    }
    if (!host.includes('.')) return { ok: false, reason: 'url host must be a fully qualified public name' };
  }
  if (selfHost && host === selfHost.toLowerCase()) return { ok: false, reason: 'url must not target this Kvarm deployment' };
  return { ok: true, url: u.toString() };
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `sha256=<hex>` over `<timestamp>.<body>`, as sent in `x-kvarm-signature`. */
export async function signWebhook(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${body}`)))}`;
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A new hook secret: 32 random bytes, base64url (43 characters). */
export function newWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return b64(bytes).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export const WEBHOOK_KEY_VERSION = 1;
const MASTER_KEY_MIN = 32;

/** True when the deployment has a usable `WEBHOOK_SECRET_KEY`. */
export function webhookKeyConfigured(env: Env): boolean {
  return typeof env.WEBHOOK_SECRET_KEY === 'string' && env.WEBHOOK_SECRET_KEY.length >= MASTER_KEY_MIN;
}

async function dataKey(env: Env): Promise<CryptoKey> {
  if (!webhookKeyConfigured(env)) throw new Error('WEBHOOK_SECRET_KEY is not configured');
  const ikm = await crypto.subtle.importKey('raw', enc.encode(env.WEBHOOK_SECRET_KEY), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('kvarm-webhook-secrets'), info: enc.encode(`v${WEBHOOK_KEY_VERSION}`) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealWebhookSecret(env: Env, hookId: string, secret: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`webhook:${hookId}`) }, await dataKey(env), enc.encode(secret));
  return { ciphertext: b64(new Uint8Array(ct)), iv: b64(iv) };
}

export async function openWebhookSecret(env: Env, hookId: string, sealed: { ciphertext: string; iv: string }): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(sealed.iv), additionalData: enc.encode(`webhook:${hookId}`) },
    await dataKey(env),
    unb64(sealed.ciphertext),
  );
  return new TextDecoder().decode(pt);
}
