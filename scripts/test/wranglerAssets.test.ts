/**
 * The web UI ships inside the Worker: every wrangler config binds the assets
 * directory (`public`, no separate site build), and every `/assets/…` or
 * `/favicon.ico` URL the server-rendered shells, scripts and stylesheets
 * reference exists there, so `npm run deploy` uploads a UI that cannot 404
 * its own shell. A config that stops binding assets, an emptied directory or
 * a page that links a file the deploy would not carry fails here, in the
 * gate, before any deployment.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseJsonc } from '../lib/wrangler-target.mjs';

const PLATFORM = fileURLToPath(new URL('../../apps/platform/', import.meta.url));
const CONFIGS = ['wrangler.jsonc', 'wrangler.dev.jsonc'];
const read = (name: string) => readFileSync(join(PLATFORM, name), 'utf8');

/** `/assets/…` and `/favicon.ico` URLs as the shells write them into HTML or CSS. */
const URL_RE = /(?:\/assets\/[A-Za-z0-9._/-]+|\/favicon\.ico)/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** Every public URL referenced from the Worker source or from a shipped asset itself. */
function referencedUrls(dirs: string[]): string[] {
  const urls = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of walk(dir)) {
      for (const match of readFileSync(file, 'utf8').matchAll(URL_RE)) urls.add(match[0]);
    }
  }
  return [...urls].sort();
}

describe.each(CONFIGS)('%s', (name) => {
  it('binds an existing assets directory as ASSETS, served through the worker', () => {
    const config = parseJsonc(read(name)) as { assets?: { directory?: string; binding?: string; run_worker_first?: boolean } };
    // A missing `assets` block deploys an API-only worker: every page that
    // falls through to assets 404s and GET / loses its stylesheet.
    expect(config.assets, 'the web UI ships with the worker; an assets block is required').toBeDefined();
    expect(config.assets!.binding).toBe('ASSETS');
    expect(config.assets!.run_worker_first).toBe(true);
    const directory = join(PLATFORM, config.assets!.directory ?? '');
    expect(statSync(directory).isDirectory(), `${directory} must exist at deploy time`).toBe(true);
    expect(existsSync(join(directory, 'favicon.ico'))).toBe(true);
  });
});

describe('the shipped UI references only files the deploy carries', () => {
  const config = parseJsonc(read('wrangler.jsonc')) as { assets: { directory: string } };
  const PUBLIC = join(PLATFORM, config.assets.directory);
  const urls = referencedUrls([join(PLATFORM, 'src'), PUBLIC]);

  it('the shells reference their stylesheet, scripts and icons', () => {
    // The two HTML shells (web/render.ts). If one of these stops being
    // referenced, the scan below loses its teeth.
    for (const url of ['/assets/app.css', '/assets/tokens.css', '/assets/console.css', '/assets/mode.js']) {
      expect(urls, `${url} must stay referenced by a shell`).toContain(url);
    }
    expect(urls.length).toBeGreaterThan(0);
  });

  it('every referenced URL exists in the assets directory', () => {
    for (const url of urls) {
      expect(existsSync(join(PUBLIC, url.slice(1))), `${url} is referenced but not shipped`).toBe(true);
    }
  });

  it('the web manifest names icons that ship beside it', () => {
    const manifestDir = join(PUBLIC, 'assets/brand');
    const manifest = JSON.parse(readFileSync(join(manifestDir, 'site.webmanifest'), 'utf8')) as { icons?: Array<{ src?: string }> };
    for (const icon of manifest.icons ?? []) {
      expect(existsSync(join(manifestDir, icon.src ?? '')), `manifest icon ${icon.src}`).toBe(true);
    }
  });
});
