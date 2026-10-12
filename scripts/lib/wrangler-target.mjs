/**
 * Deployment-target overlay for apps/platform/wrangler.jsonc. The committed
 * config carries neutral defaults (a zero D1 database id, a localhost
 * APP_ORIGIN); a deployer's own target comes from KVARM_* settings.
 */

import { fileURLToPath } from 'node:url';

export const PLACEHOLDER_D1_DATABASE_ID = '00000000-0000-0000-0000-000000000000';

export const WRANGLER_TARGET = fileURLToPath(new URL('../wrangler-target.mjs', import.meta.url));

/** Arguments for `spawnSync(process.execPath, ...)` running one remote D1 statement on the configured target. */
export function remoteD1Args(sql) {
  return [WRANGLER_TARGET, 'd1', 'execute', 'DB', '--remote', '--json', '--command', sql];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SETTINGS = ['KVARM_D1_DATABASE_ID', 'KVARM_D1_DATABASE_NAME', 'KVARM_APP_ORIGIN', 'CLOUDFLARE_ACCOUNT_ID'];

/** Parses JSON with comments and trailing commas (the wrangler.jsonc dialect). */
export function parseJsonc(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? '')) j++;
      if (text[j] !== '}' && text[j] !== ']') out += ch;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return JSON.parse(out);
}

/** Reads KEY=VALUE lines (optional `export `, quotes, # comments). */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || raw.trimStart().startsWith('#')) continue;
    let value = m[2] ?? '';
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    out[m[1] ?? ''] = value;
  }
  return out;
}

/** The KVARM_* target settings, with non-empty process variables taking precedence over the env file. */
export function resolveSettings(processEnv, fileEnv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of SETTINGS) {
    const value = processEnv[key] || fileEnv[key];
    if (value) out[key] = value;
  }
  return out;
}

/**
 * The committed config with the deployer's target applied. Throws when the
 * D1 database id is missing or still the placeholder, or when an origin is
 * required (deploys) and missing or not a bare http(s) origin.
 */
export function targetConfig(base, settings, { requireOrigin }) {
  const config = structuredClone(base);
  const id = settings.KVARM_D1_DATABASE_ID;
  if (!id || !UUID.test(id) || id === PLACEHOLDER_D1_DATABASE_ID) {
    throw new Error('KVARM_D1_DATABASE_ID must be the id printed by `wrangler d1 create` (a UUID)');
  }
  const db = config.d1_databases?.find((d) => d.binding === 'DB');
  if (!db) throw new Error('wrangler.jsonc has no d1_databases entry with binding DB');
  db.database_id = id;
  if (settings.KVARM_D1_DATABASE_NAME) db.database_name = settings.KVARM_D1_DATABASE_NAME;

  const origin = settings.KVARM_APP_ORIGIN?.replace(/\/+$/, '');
  if (origin) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      url = null;
    }
    if (!url || !/^https?:$/.test(url.protocol) || url.origin !== origin) {
      throw new Error(`KVARM_APP_ORIGIN must be a bare http(s) origin such as https://kvarm.example.com (got ${origin})`);
    }
    config.vars = { ...config.vars, APP_ORIGIN: origin };
  } else if (requireOrigin) {
    throw new Error('KVARM_APP_ORIGIN must be set to the public origin of your worker (https://<worker>.<subdomain>.workers.dev or a custom domain)');
  }
  return config;
}
