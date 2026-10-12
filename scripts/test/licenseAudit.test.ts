/**
 * Pure pieces of the dependency license audit (scripts/license-audit.mjs):
 * SPDX expression classification, the dependency list read from an npm v3
 * lockfile, and the committed docs/licenses.md report.
 */

import { describe, expect, it } from 'vitest';
import { classifyLicense, collectDependencies, collectWorkspaces, renderLicenseReport } from '../lib/license-audit.mjs';

describe('classifyLicense', () => {
  it('accepts common permissive identifiers', () => {
    for (const id of ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'CC0-1.0', 'PSF-2.0', 'BlueOak-1.0.0']) {
      expect(classifyLicense(id), id).toBe('permissive');
    }
  });

  it('flags copyleft, weak-copyleft and unknown licenses', () => {
    expect(classifyLicense('GPL-3.0-only')).toBe('copyleft');
    expect(classifyLicense('AGPL-3.0-or-later')).toBe('copyleft');
    expect(classifyLicense('LGPL-3.0-or-later')).toBe('weak-copyleft');
    expect(classifyLicense('MPL-2.0')).toBe('weak-copyleft');
    expect(classifyLicense('SSPL-1.0')).toBe('copyleft');
    expect(classifyLicense(undefined)).toBe('unknown');
    expect(classifyLicense('UNLICENSED')).toBe('unknown');
    expect(classifyLicense('SEE LICENSE IN LICENSE.txt')).toBe('unknown');
  });

  it('evaluates OR as the most permissive choice and AND as the most restrictive part', () => {
    expect(classifyLicense('MIT OR Apache-2.0')).toBe('permissive');
    expect(classifyLicense('(GPL-2.0-only OR MIT)')).toBe('permissive');
    expect(classifyLicense('Apache-2.0 AND LGPL-3.0-or-later AND MIT')).toBe('weak-copyleft');
    expect(classifyLicense('(MIT AND GPL-3.0-only)')).toBe('copyleft');
  });
});

const lockfile = {
  name: 'kvarm',
  lockfileVersion: 3,
  packages: {
    '': { name: 'kvarm', license: 'MIT' },
    'apps/platform': { name: '@kvarm/platform', dependencies: { hono: '^4.6.0', zod: '^4.4.3' } },
    'node_modules/@kvarm/platform': { resolved: 'apps/platform', link: true },
    'node_modules/hono': { version: '4.13.13', license: 'MIT' },
    'node_modules/zod': { version: '4.4.3', license: 'MIT' },
    'node_modules/body-parser/node_modules/content-type': { version: '2.1.0', license: 'MIT' },
    'node_modules/typescript': { version: '5.9.3', license: 'Apache-2.0', devOptional: true },
    'node_modules/@img/sharp-libvips-linux-x64': { version: '1.2.4', license: 'LGPL-3.0-or-later', dev: true, optional: true },
    'node_modules/lightningcss': { version: '1.30.2', license: 'MPL-2.0', dev: true },
    'node_modules/mystery': { version: '0.0.1', dev: true },
    'node_modules/legacy': { version: '1.0.0', licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] },
  },
};

describe('collectDependencies', () => {
  const deps = collectDependencies(lockfile);

  it('lists every installed package once, skipping workspace links and the root', () => {
    expect(deps.map((d) => d.name)).toEqual([
      '@img/sharp-libvips-linux-x64',
      'content-type',
      'hono',
      'legacy',
      'lightningcss',
      'mystery',
      'typescript',
      'zod',
    ]);
  });

  it('records version, license, scope and class', () => {
    const byName = Object.fromEntries(deps.map((d) => [d.name, d]));
    expect(byName.hono).toMatchObject({ version: '4.13.13', license: 'MIT', scope: 'runtime', class: 'permissive' });
    expect(byName.typescript).toMatchObject({ scope: 'runtime (optional)', class: 'permissive' });
    expect(byName['@img/sharp-libvips-linux-x64']).toMatchObject({ scope: 'development', class: 'weak-copyleft' });
    expect(byName.mystery).toMatchObject({ license: 'UNKNOWN', class: 'unknown' });
    expect(byName.legacy).toMatchObject({ license: 'MIT OR Apache-2.0', class: 'permissive' });
    expect(byName['content-type']).toMatchObject({ path: 'node_modules/body-parser/node_modules/content-type' });
  });

  it('lists the workspace packages separately with the root license', () => {
    expect(collectWorkspaces(lockfile)).toEqual([{ name: '@kvarm/platform', path: 'apps/platform', license: 'MIT' }]);
  });
});

describe('renderLicenseReport', () => {
  const md = renderLicenseReport(lockfile);

  it('names every dependency with its license', () => {
    expect(md).toContain('| hono | 4.13.13 | MIT | runtime |');
    expect(md).toContain('| lightningcss | 1.30.2 | MPL-2.0 | development |');
    expect(md).toContain('| @kvarm/platform | apps/platform | MIT |');
  });

  it('lists the non-permissive and unknown licenses explicitly', () => {
    const section = md.slice(md.indexOf('## Non-permissive'), md.indexOf('## Workspace packages'));
    expect(section).toContain('@img/sharp-libvips-linux-x64');
    expect(section).toContain('LGPL-3.0-or-later');
    expect(section).toContain('lightningcss');
    expect(section).toContain('mystery');
    expect(section).not.toContain('| hono');
    expect(section).toContain('Runtime dependencies with a non-permissive or unknown license: none.');
  });

  it('is deterministic', () => {
    expect(renderLicenseReport(lockfile)).toBe(md);
  });

  it('says "none" when every license is permissive', () => {
    const clean = { ...lockfile, packages: { '': lockfile.packages[''], 'node_modules/hono': lockfile.packages['node_modules/hono'] } };
    expect(renderLicenseReport(clean)).toContain('Non-permissive or unknown licenses: none.');
  });
});
