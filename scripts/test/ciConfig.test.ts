/**
 * The repository's own CI configuration (.kvarm/ci.json) against the
 * platform's CI config schema, and the rule that Kvarm's own CI is the only
 * automated gate (no third-party CI configuration in the tree).
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CI_CONFIG_PATH, CI_LIMITS, parseCiConfig } from '../../apps/platform/src/services/ciConfig';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const rootPackage = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')) as { scripts: Record<string, string> };

describe('the repository .kvarm/ci.json', () => {
  const text = readFileSync(`${ROOT}${CI_CONFIG_PATH}`, 'utf8');
  const parsed = parseCiConfig(text);

  it('is valid against the platform CI config schema', () => {
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  });

  it('defines the required typecheck, lint and test jobs over the package.json gate scripts', () => {
    if (!parsed.ok) throw new Error(parsed.error);
    const byName = new Map(parsed.value.jobs.map((j) => [j.name, j]));
    expect([...byName.keys()].sort()).toEqual(['lint', 'test', 'typecheck']);
    for (const [name, script] of [
      ['typecheck', 'npm run typecheck'],
      ['lint', 'npm run lint'],
      ['test', 'npm run test'],
    ] as const) {
      const job = byName.get(name)!;
      expect(job.required, name).toBe(true);
      expect(job.run, name).toContain(script);
      expect(rootPackage.scripts[script.slice('npm run '.length)], name).toBeDefined();
    }
  });
});

describe('parseCiConfig', () => {
  const job = (more: Record<string, unknown> = {}) => ({ name: 'build', run: 'npm test', ...more });
  const parse = (config: unknown) => parseCiConfig(JSON.stringify(config));

  it('defaults required to true and the timeout to 900 s', () => {
    expect(parse({ jobs: [job()] })).toEqual({ ok: true, value: { jobs: [{ name: 'build', run: 'npm test', required: true, timeoutSeconds: 900 }] } });
  });

  it('rejects invalid JSON and a missing jobs array', () => {
    expect(parseCiConfig('{')).toMatchObject({ ok: false, status: 422, code: 'INVALID_CI_CONFIG' });
    expect(parse({ job: [] })).toMatchObject({ ok: false, code: 'INVALID_CI_CONFIG' });
  });

  it('rejects names reserved for platform checks, empty names and duplicates', () => {
    expect(parse({ jobs: [job({ name: 'kvarm/guard' })] })).toMatchObject({ ok: false, code: 'INVALID_CI_JOB_NAME' });
    expect(parse({ jobs: [job({ name: 'KVARM/x' })] })).toMatchObject({ ok: false, code: 'INVALID_CI_JOB_NAME' });
    expect(parse({ jobs: [job({ name: ' ' })] })).toMatchObject({ ok: false, code: 'INVALID_CI_JOB_NAME' });
    expect(parse({ jobs: [job(), job()] })).toMatchObject({ ok: false, code: 'DUPLICATE_CI_JOB' });
    // Whitespace is trimmed before storage, so the reservation must hold on
    // the trimmed name: a raw " kvarm/guard" must not become kvarm/guard.
    for (const name of [' kvarm/guard', '\tkvarm/guard', '\u00a0kvarm/guard', '\u3000kvarm/ci-config']) {
      expect(parse({ jobs: [job({ name })] }), JSON.stringify(name)).toMatchObject({ ok: false, code: 'INVALID_CI_JOB_NAME' });
    }
  });

  it(`allows at most ${CI_LIMITS.jobs} jobs and ${CI_LIMITS.configBytes} bytes`, () => {
    const jobs = Array.from({ length: CI_LIMITS.jobs + 1 }, (_, i) => job({ name: `j${i}` }));
    expect(parse({ jobs: jobs.slice(0, CI_LIMITS.jobs) }).ok).toBe(true);
    expect(parse({ jobs })).toMatchObject({ ok: false, code: 'TOO_MANY_CI_JOBS' });
    expect(parseCiConfig(`{"jobs":[],"pad":"${'x'.repeat(CI_LIMITS.configBytes)}"}`)).toMatchObject({ ok: false, code: 'CI_CONFIG_TOO_LARGE' });
  });

  it('accepts timeouts of 1-3600 whole seconds only', () => {
    expect(parse({ jobs: [job({ timeoutSeconds: 1 })] }).ok).toBe(true);
    expect(parse({ jobs: [job({ timeoutSeconds: 3600 })] }).ok).toBe(true);
    for (const t of [0, 3601, 1.5, '60']) expect(parse({ jobs: [job({ timeoutSeconds: t })] })).toMatchObject({ ok: false, code: 'INVALID_CI_TIMEOUT' });
  });

  it('rejects an empty run command and a non-boolean required flag', () => {
    expect(parse({ jobs: [job({ run: '  ' })] })).toMatchObject({ ok: false, code: 'INVALID_CI_COMMAND' });
    expect(parse({ jobs: [job({ required: 'yes' })] })).toMatchObject({ ok: false, code: 'INVALID_CI_REQUIRED' });
  });
});

describe('automated gate', () => {
  it('is Kvarm CI only: the tree holds no third-party CI configuration', () => {
    const thirdParty = [
      '.github/workflows',
      '.gitlab-ci.yml',
      '.circleci',
      '.travis.yml',
      'azure-pipelines.yml',
      'bitbucket-pipelines.yml',
      'Jenkinsfile',
      '.buildkite',
      '.drone.yml',
      'appveyor.yml',
      '.woodpecker.yml',
      '.woodpecker',
      'buildspec.yml',
      'cloudbuild.yaml',
    ];
    expect(thirdParty.filter((p) => existsSync(`${ROOT}${p}`))).toEqual([]);
  });
});
