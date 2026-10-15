/**
 * @kvarm/ui — zero-runtime HTML construction for streaming SSR.
 *
 * The `html` tagged template escapes interpolations by default; wrap values in
 * `raw()` to emit trusted markup. Everything is plain strings, so responses
 * stream immediately and there is no client or server runtime cost — the
 * lesson from GitHub's move off CSS-in-JS, applied from day one.
 *
 * Convention: interpolate user data bare (escaped exactly once); pass
 * composed fragments and pre-encoded URLs through `raw()`. Never pre-escape
 * a value with `escapeHtml()` before handing it to `html` — that double-
 * escapes. Values pre-encoded with `encodeURIComponent()` must also be
 * wrapped in `raw()`, or the `%` signs would be escaped.
 */

export { languageOf, highlightLines, type Language } from './highlight.js';
export class Raw {
  constructor(readonly value: string) {}
}

export function raw(value: string): Raw {
  return new Raw(value);
}

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderValue(value: unknown): string {
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  if (value === null || value === undefined || value === false) return '';
  if (value === true) return '';
  return escapeHtml(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += renderValue(values[i]);
  }
  return out;
}

/** Attributes helper: skips null/undefined/false values. */
export function attrs(pairs: Record<string, unknown>): string {
  let out = '';
  for (const [key, value] of Object.entries(pairs)) {
    if (value === null || value === undefined || value === false) continue;
    if (value === true) {
      out += ` ${key}`;
    } else {
      out += ` ${key}="${escapeHtml(value)}"`;
    }
  }
  return out;
}

/** Human byte sizes. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

export function timeAgo(unixMs: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - unixMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 31) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}
