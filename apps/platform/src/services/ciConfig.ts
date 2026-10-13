/**
 * The `.kvarm/ci.json` schema. Pure, so the repository can validate its own
 * CI configuration in Node with the exact rules the platform applies.
 */

export const CI_CONFIG_PATH = '.kvarm/ci.json';
export const CI_LIMITS = {
  jobs: 16,
  name: 100,
  command: 8 * 1024,
  configBytes: 64 * 1024,
  summaryBytes: 64 * 1024,
  minTimeoutSeconds: 1,
  maxTimeoutSeconds: 3_600,
  defaultTimeoutSeconds: 900,
} as const;

export interface CiJobConfig {
  name: string;
  run: string;
  required: boolean;
  timeoutSeconds: number;
}

export interface CiConfig {
  jobs: CiJobConfig[];
}

/** Structurally a `ServiceResult` (repos/service.ts), without its Worker-typed imports. */
export type CiConfigResult = { ok: true; value: CiConfig } | { ok: false; status: number; error: string; code: string };

const fail = (error: string, code: string): CiConfigResult => ({ ok: false, status: 422, error, code });

export function parseCiConfig(text: string): CiConfigResult {
  if (new TextEncoder().encode(text).length > CI_LIMITS.configBytes) return fail(`${CI_CONFIG_PATH} is too large`, 'CI_CONFIG_TOO_LARGE');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail(`${CI_CONFIG_PATH} must be valid JSON`, 'INVALID_CI_CONFIG');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !Array.isArray((raw as { jobs?: unknown }).jobs)) {
    return fail(`${CI_CONFIG_PATH} must contain a jobs array`, 'INVALID_CI_CONFIG');
  }
  const list = (raw as { jobs: unknown[] }).jobs;
  if (list.length > CI_LIMITS.jobs) return fail(`${CI_CONFIG_PATH} may contain at most ${CI_LIMITS.jobs} jobs`, 'TOO_MANY_CI_JOBS');
  const names = new Set<string>();
  const jobs: CiJobConfig[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return fail('each CI job must be an object', 'INVALID_CI_JOB');
    const j = item as Record<string, unknown>;
    if (typeof j.name !== 'string' || j.name.trim().length === 0 || j.name.trim().length > CI_LIMITS.name || j.name.toLowerCase().startsWith('kvarm/')) {
      return fail(`CI job names must be 1-${CI_LIMITS.name} characters and may not start with kvarm/`, 'INVALID_CI_JOB_NAME');
    }
    const name = j.name.trim();
    if (names.has(name)) return fail(`duplicate CI job name: ${name}`, 'DUPLICATE_CI_JOB');
    names.add(name);
    if (typeof j.run !== 'string' || j.run.trim().length === 0 || j.run.length > CI_LIMITS.command) {
      return fail(`CI job ${name} must have a run command of at most ${CI_LIMITS.command} characters`, 'INVALID_CI_COMMAND');
    }
    if (j.required !== undefined && typeof j.required !== 'boolean') return fail(`CI job ${name} required must be a boolean`, 'INVALID_CI_REQUIRED');
    const timeout = j.timeoutSeconds ?? CI_LIMITS.defaultTimeoutSeconds;
    if (
      typeof timeout !== 'number' ||
      !Number.isInteger(timeout) ||
      timeout < CI_LIMITS.minTimeoutSeconds ||
      timeout > CI_LIMITS.maxTimeoutSeconds
    ) {
      return fail(`CI job ${name} timeoutSeconds is invalid`, 'INVALID_CI_TIMEOUT');
    }
    jobs.push({ name, run: j.run, required: j.required !== false, timeoutSeconds: timeout });
  }
  return { ok: true, value: { jobs } };
}
