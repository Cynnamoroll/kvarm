/**
 * Commit attribution as git notes on refs/notes/forge-attribution.
 *
 * A note is the JSON record `{agent, session, promptHash, model?, actor, at}`
 * followed by a newline, so `git fetch <remote> refs/notes/forge-attribution:…`
 * plus `git notes --ref=forge-attribution show <sha>` reads exactly what the
 * REST and MCP readers return. Writes build one notes commit on the current
 * notes tip and push it with that tip as the expected old value; a writer that
 * loses the race re-reads the tip and rebuilds, so concurrent writers never
 * drop each other's notes. Every write is also appended to the events ledger.
 *
 * Callers authorize first through the shared authority lookup; nothing here
 * checks access.
 */

import { FORGE_NOTES_REF, NotesTreeError, ZERO_OID, buildNotesCommit, encode, findNote } from '@forge/gitops';
import { withLazyRepo, type LazyRepo } from '../artifacts/repo';
import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import type { Actor } from './authz';
import { artifactsPusher, type GitPusher } from './gitwrite';
import { FORGE_COMMITTER, artifactsMergeSources } from './merge';
import { RefStoreUnavailable, isFullSha, lsRefs, readCommitInfo, type ResolveContext } from './refs';

export const ATTRIBUTION_LIMITS = {
  /** Longest agent, session, promptHash or model value. */
  fieldMax: 200,
  /** Notes commits built per write when other writers keep moving the notes ref. */
  attempts: 4,
  /** Largest note blob a reader accepts. */
  noteMaxBytes: 64 * 1024,
} as const;

export interface AttributionRecord {
  agent: string;
  session: string;
  promptHash: string | null;
  model?: string;
  actor: string;
  /** ISO 8601 UTC */
  at: string;
}

export type AttributionInput = Pick<AttributionRecord, 'agent' | 'session' | 'promptHash' | 'model'>;

export interface AttributionContext {
  env: Env;
  repo: RepoRow;
  actor: Actor | null;
  waitUntil(p: Promise<unknown>): void;
}

export interface AttributionWrite {
  record: AttributionRecord;
  /** An earlier note on the commit was replaced. */
  replaced: boolean;
  notesCommit: string;
}

type Fail = Extract<ServiceResult<never>, { ok: false }>;

const fail = (status: number, code: string, error: string): Fail => ({ ok: false, status, code, error });

function textField(v: unknown, name: string, code: string, required: boolean): string | undefined | Fail {
  if (v === undefined || v === null) {
    return required ? fail(422, code, `${name} is required (a string of 1-${ATTRIBUTION_LIMITS.fieldMax} characters)`) : undefined;
  }
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > ATTRIBUTION_LIMITS.fieldMax) {
    return fail(422, code, `${name} must be a non-empty string of at most ${ATTRIBUTION_LIMITS.fieldMax} characters`);
  }
  return v;
}

const isFail = (v: unknown): v is Fail => typeof v === 'object' && v !== null && (v as Fail).ok === false;

/**
 * Validates `{agent, session, promptHash, model?}`. With `defaults`, every
 * field is optional and missing ones come from the defaults (merge
 * attribution, where the merging principal fills in what the request omits).
 */
export function parseAttributionInput(input: unknown, defaults?: AttributionInput): ServiceResult<AttributionInput> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail(400, 'INVALID_BODY', 'body must be a JSON object {agent, session, promptHash, model?}');
  }
  const o = input as Record<string, unknown>;
  const required = defaults === undefined;
  const agent = textField(o.agent, 'agent', 'INVALID_AGENT', required);
  if (isFail(agent)) return agent;
  const session = textField(o.session, 'session', 'INVALID_SESSION', required);
  if (isFail(session)) return session;
  const promptHash = textField(o.promptHash, 'promptHash', 'INVALID_PROMPT_HASH', required);
  if (isFail(promptHash)) return promptHash;
  const model = textField(o.model, 'model', 'INVALID_MODEL', false);
  if (isFail(model)) return model;
  return {
    ok: true,
    value: {
      agent: agent ?? defaults!.agent,
      session: session ?? defaults!.session,
      promptHash: promptHash ?? defaults?.promptHash ?? null,
      ...((model ?? defaults?.model) !== undefined ? { model: (model ?? defaults?.model)! } : {}),
    },
  };
}

/** The human the record names: an agent token's minting user, else the caller. */
export function actorLogin(actor: Actor | null): string {
  return actor?.user.login ?? 'forge';
}

function makeRecord(input: AttributionInput, actor: string, at = new Date()): AttributionRecord {
  return {
    agent: input.agent,
    session: input.session,
    promptHash: input.promptHash,
    ...(input.model !== undefined ? { model: input.model } : {}),
    actor,
    at: at.toISOString(),
  };
}

function resolveCtx(cx: AttributionContext, artifacts: LazyRepo): ResolveContext {
  return { env: cx.env, repo: cx.repo, artifacts, bypass: false, waitUntil: cx.waitUntil };
}

/**
 * Writes `record` as the note of `sha` (a commit the caller knows exists).
 * Throws RefStoreUnavailable when the git store cannot be read or written.
 */
export async function writeAttributionNote(
  cx: AttributionContext,
  artifacts: LazyRepo,
  pusher: GitPusher,
  sha: string,
  record: AttributionRecord,
  source: 'api' | 'merge',
): Promise<AttributionWrite> {
  const ctx = resolveCtx(cx, artifacts);
  const reader = artifactsMergeSources(ctx);
  const content = encode(`${JSON.stringify(record)}\n`);
  for (let attempt = 0; attempt < ATTRIBUTION_LIMITS.attempts; attempt++) {
    const tip = (await lsRefs(ctx, [FORGE_NOTES_REF])).get(FORGE_NOTES_REF) ?? null;
    let parent: { commit: string; tree: string } | null = null;
    if (tip) {
      const info = await readCommitInfo(ctx, tip);
      if (!info) throw new RefStoreUnavailable(`notes commit ${tip} is not readable`);
      parent = { commit: tip, tree: info.tree };
    }
    let built;
    try {
      built = await buildNotesCommit({
        reader,
        parent,
        target: sha,
        content,
        author: { ...FORGE_COMMITTER, time: Math.floor(Date.now() / 1000) },
        message: `Attribution for ${sha}\n`,
      });
    } catch (err) {
      if (err instanceof NotesTreeError) throw new RefStoreUnavailable(err.message);
      throw err;
    }
    const r = await pusher.updateRef({ ref: FORGE_NOTES_REF, oldOid: tip ?? ZERO_OID, newOid: built.commit }, built.objects);
    if (r.status === 'stale') continue;
    if (r.status !== 'ok') {
      throw new RefStoreUnavailable(`notes update ${r.status}: ${r.reason ?? r.error ?? `HTTP ${r.httpStatus}`}`);
    }
    await recordLedger(cx.env, { repoId: cx.repo.id, commit: sha, notesCommit: built.commit, source, replaced: built.replaced !== null, attribution: record });
    return { record, replaced: built.replaced !== null, notesCommit: built.commit };
  }
  throw new RefStoreUnavailable(`${FORGE_NOTES_REF} kept moving; retry`);
}

/** Appends to the events ledger; a ledger failure is logged, the note already landed. */
async function recordLedger(env: Env, payload: Record<string, unknown>): Promise<void> {
  const now = Date.now();
  try {
    await env.DB.prepare('INSERT INTO events (id, type, payload, processed_at, created_at) VALUES (?1, ?2, ?3, ?4, ?4)')
      .bind(crypto.randomUUID(), 'attribution.set', JSON.stringify(payload), now)
      .run();
  } catch (err) {
    console.warn(JSON.stringify({ attributionLedgerFailed: String(err).slice(0, 200), commit: payload.commit }));
  }
}

async function guarded<T>(fn: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RefStoreUnavailable) {
      console.warn(JSON.stringify({ attributionStore: err.message.slice(0, 200) }));
      return fail(503, 'STORAGE_UNAVAILABLE', 'repository storage is unavailable, retry shortly');
    }
    throw err;
  }
}

function checkSha(sha: string): Fail | null {
  return isFullSha(sha) ? null : fail(400, 'INVALID_SHA', `"${sha.slice(0, 80)}" is not a full 40-character lowercase commit sha`);
}

/** POST commits/:sha/attribution */
export function setAttribution(
  cx: AttributionContext,
  sha: string,
  input: unknown,
  pusher: GitPusher = artifactsPusher(cx.env, cx.repo),
): Promise<ServiceResult<AttributionWrite>> {
  const bad = checkSha(sha);
  if (bad) return Promise.resolve(bad);
  const parsed = parseAttributionInput(input);
  if (!parsed.ok) return Promise.resolve(parsed);
  return guarded(() =>
    withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) => {
      if (!(await readCommitInfo(resolveCtx(cx, artifacts), sha))) {
        return fail(404, 'COMMIT_NOT_FOUND', `no commit ${sha} in this repository`);
      }
      const written = await writeAttributionNote(cx, artifacts, pusher, sha, makeRecord(parsed.value, actorLogin(cx.actor)), 'api');
      return { ok: true, value: written };
    }),
  );
}

/** GET commits/:sha/attribution: the note, or 404 when the commit has none. */
export function getAttribution(cx: AttributionContext, sha: string): Promise<ServiceResult<AttributionRecord>> {
  const bad = checkSha(sha);
  if (bad) return Promise.resolve(bad);
  const none = fail(404, 'ATTRIBUTION_NOT_FOUND', `commit ${sha} has no attribution`);
  return guarded(() =>
    withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) => {
      const ctx = resolveCtx(cx, artifacts);
      const tip = (await lsRefs(ctx, [FORGE_NOTES_REF])).get(FORGE_NOTES_REF) ?? null;
      if (!tip) return none;
      const info = await readCommitInfo(ctx, tip);
      if (!info) throw new RefStoreUnavailable(`notes commit ${tip} is not readable`);
      const sources = artifactsMergeSources(ctx, ATTRIBUTION_LIMITS.noteMaxBytes);
      let loc;
      try {
        loc = await findNote(sources, info.tree, sha);
      } catch (err) {
        if (err instanceof NotesTreeError) throw new RefStoreUnavailable(err.message);
        throw err;
      }
      if (!loc) return none;
      const bytes = await sources.readBlob(loc.blob).catch(() => null);
      if (!bytes) return fail(422, 'ATTRIBUTION_UNREADABLE', `the note on ${sha} is missing or larger than ${ATTRIBUTION_LIMITS.noteMaxBytes} bytes`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        parsed = null;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return fail(422, 'ATTRIBUTION_NOT_JSON', `the note on ${sha} is not a JSON attribution record`);
      }
      return { ok: true, value: parsed as AttributionRecord };
    }),
  );
}

export interface MergeAttributionInput {
  changeNumber: number;
  mergeCommit: string;
  /** Request fields (already validated with `parseAttributionInput(…, defaults)`). */
  input: AttributionInput | null;
}

/** The defaults a merge fills in for fields its request omitted. */
export function mergeAttributionDefaults(actor: Actor | null, changeNumber: number): AttributionInput {
  return {
    agent: actor?.agent?.agentName ?? actor?.user.login ?? 'forge',
    session: `forge:merge/change-${changeNumber}`,
    promptHash: null,
  };
}

/** Notes a Forge-created merge commit with the merging principal; failures are logged. */
export async function attributeMerge(cx: AttributionContext, artifacts: LazyRepo, pusher: GitPusher, m: MergeAttributionInput): Promise<void> {
  const input = m.input ?? mergeAttributionDefaults(cx.actor, m.changeNumber);
  try {
    await writeAttributionNote(cx, artifacts, pusher, m.mergeCommit, makeRecord(input, actorLogin(cx.actor)), 'merge');
  } catch (err) {
    console.warn(JSON.stringify({ mergeAttributionFailed: String(err).slice(0, 200), mergeCommit: m.mergeCommit }));
  }
}
