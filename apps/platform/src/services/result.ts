/**
 * The ServiceResult plumbing the services used to vendor file by file:
 * fail(), the RefStoreUnavailable -> 503 wrapper, the INVALID_BODY object
 * guard, the stored-JSON reader and the UNIQUE-violation sniff. Deliberately
 * a leaf (a type-only import of ServiceResult from repos/types.ts) so every
 * service may import it without closing a dependency cycle. Root-level
 * script tests typecheck through this file, so it must never import a
 * workerd-typed module (refs.ts and above).
 */

import type { ServiceResult } from '../repos/types';

export type { ServiceResult };

/** Thrown by the refs read path when the artifact store cannot answer; the 503 in guarded(). */
export class RefStoreUnavailable extends Error {}

/** The failure half of a ServiceResult; services extend it with their extra fields. */
export type Fail = Extract<ServiceResult<never>, { ok: false }>;

/**
 * The one argument order — fail(status, error, code[, extra]) — so a call
 * pasted between services can never silently swap the message and the code.
 */
export function fail<F extends object = Record<string, never>>(status: number, error: string, code: string, extra = {} as F): Fail & F {
  return { ok: false, status, error, code, ...extra };
}

/**
 * Runs fn, turning a transient Artifacts ref-store failure into the shared
 * 503 STORAGE_UNAVAILABLE result while logging it under the caller's event
 * key (`<service>RefStore`).
 */
export async function guarded<T>(event: string, fn: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RefStoreUnavailable) {
      console.warn(JSON.stringify({ [event]: err.message.slice(0, 200) }));
      return fail(503, 'repository storage is unavailable, retry shortly', 'STORAGE_UNAVAILABLE');
    }
    throw err;
  }
}

/**
 * The request/input body when it is a plain JSON object, else the canonical
 * 400 INVALID_BODY. `shape` keeps each endpoint's `{fields}` hint in the
 * message, e.g. objectBody(input, '{title, body?}').
 */
export function objectBody(input: unknown, shape?: string): ServiceResult<Record<string, unknown>> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? { ok: true, value: input as Record<string, unknown> }
    : fail(400, `body must be a JSON object${shape ? ` ${shape}` : ''}`, 'INVALID_BODY');
}

/** Stored JSON read back; a corrupt row degrades to the fallback instead of throwing on the read path. */
export function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * The one place SQLite's 'UNIQUE constraint failed: <table>.<cols>' error
 * text is trusted. Pass the exact constraint tail when it is known so CHECK
 * and FOREIGN KEY failures are not misreported as a name conflict.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const msg = String(err);
  return constraint ? msg.includes(`UNIQUE constraint failed: ${constraint}`) : /UNIQUE constraint failed/i.test(msg);
}
