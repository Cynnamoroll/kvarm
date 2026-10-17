/**
 * Shared request helpers for the workerd tests. `call` covers the drifted
 * per-file variants (token/body/raw-body, per-call env override, manual
 * redirects) and always asserts the x-kvarm-cost header — the platform
 * invariant the file-local copies that skipped it had lost. `request` is the
 * raw-Response form for tests that drive git protocol or page flows.
 */

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect } from 'vitest';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../../src/cost/meter';
import worker from '../../src/index';

export const ORIGIN = 'https://kvarm.test';

export interface Reply {
  status: number;
  text: string;
  bytes: Uint8Array;
  json: Record<string, any>;
  cost: CostCounters;
  headers: Headers;
}

export interface ServerTimingMetric {
  dur: number;
  desc?: string;
}

export function parseServerTiming(value: string | null): Map<string, ServerTimingMetric> {
  if (!value) throw new Error('missing server-timing header');
  const metrics = new Map<string, ServerTimingMetric>();
  for (const entry of value.split(',')) {
    const [name, ...parameters] = entry.trim().split(';');
    const duration = parameters.find((parameter) => parameter.startsWith('dur='));
    const desc = parameters.find((parameter) => parameter.startsWith('desc='));
    if (!name || !duration) throw new Error(`invalid server-timing metric: ${entry}`);
    const dur = Number(duration.slice('dur='.length));
    if (!Number.isFinite(dur) || dur < 0) throw new Error(`invalid server-timing duration: ${entry}`);
    metrics.set(name, {
      dur,
      ...(desc ? { desc: desc.slice('desc='.length).replace(/^"|"$/g, '') } : {}),
    });
  }
  return metrics;
}

/** Sends a prebuilt Request through the worker, draining the execution context. */
export async function send(env: Env, req: Request): Promise<Reply> {
  const ctx = createExecutionContext();
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  await waitOnExecutionContext(ctx);
  const cost = parseCostHeader(res.headers.get(COST_HEADER));
  expect(cost, `${COST_HEADER}: ${res.headers.get(COST_HEADER)}`).not.toBeNull();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    // non-JSON body
  }
  return { status: res.status, text, bytes, json, cost: cost!, headers: res.headers };
}

export interface CallOptions {
  token?: string;
  /** JSON-serialized body (sets content-type). */
  body?: unknown;
  /** Verbatim body for non-JSON payloads. */
  rawBody?: BodyInit | null;
  headers?: Record<string, string>;
  redirect?: RequestInit['redirect'];
  /** Per-call env override, for tests that run a request against a second env. */
  env?: Env;
  origin?: string;
}

export async function call(env: Env, method: string, path: string, opts: CallOptions = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return send(
    opts.env ?? env,
    new Request(`${opts.origin ?? ORIGIN}${path}`, {
      method,
      headers,
      ...(opts.redirect !== undefined ? { redirect: opts.redirect } : {}),
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : opts.rawBody !== undefined ? { body: opts.rawBody } : {}),
    }),
  );
}

/** Raw-Response request through the worker, for tests that read the stream themselves. */
export async function request(env: Env, path: string, init: RequestInit = {}, origin = ORIGIN): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch!(
    new Request(`${origin}${path}`, init) as Request<unknown, IncomingRequestCfProperties>,
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}
