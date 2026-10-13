/**
 * Commit attribution as git notes on refs/notes/kvarm-attribution.
 *
 * A note is the JSON record `{agent, session, promptHash, model?, actor, at}`
 * followed by a newline, so `git fetch <remote> refs/notes/kvarm-attribution:…`
 * plus `git notes --ref=kvarm-attribution show <sha>` reads exactly what the
 * REST and MCP readers return. Writes build one notes commit on the current
 * notes tip and push it with that tip as the expected old value; a writer that
 * loses the race re-reads the tip and rebuilds, so concurrent writers never
 * drop each other's notes. Every write is also appended to the events ledger.
 *
 * The note is what the caller asserted. What Kvarm can prove about it (the
 * evidence level, architecture §9) is computed at write time from the
 * credential and any signed execution evidence, stored in D1 keyed by the
 * note's digest, and returned next to the record; it is never in the note.
 *
 * Callers authorize first through the shared authority lookup; nothing here
 * checks access.
 */

import { KVARM_NOTES_REF, NotesTreeError, ZERO_OID, buildNotesCommit, encode, findNote, sha256Hex } from '@kvarm/gitops';
import { withLazyRepo, type LazyRepo } from '../artifacts/repo';
import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import type { Actor } from './authz';
import { artifactsPusher, type GitPusher } from './gitwrite';
import { KVARM_COMMITTER, artifactsMergeSources } from './merge';
import { RefStoreUnavailable, isFullSha, lsRefs, readCommitInfo, type ResolveContext } from './refs';
import {
  assessEvidence,
  parseSignedEvidence,
  undeclaredEvidence,
  type Evidence,
  type EvidenceLevel,
  type Submitter,
} from './provenance';

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

/** A note as the readers return it: the record plus what Kvarm can prove about it (services/provenance.ts). */
export type AttributionView = AttributionRecord & { evidence: Evidence };

/** An assessed write: the evidence to store and the credential that submitted it. */
export interface Assessed {
  evidence: Evidence;
  submitter: Submitter;
}

export interface AttributionContext {
  env: Env;
  repo: RepoRow;
  actor: Actor | null;
  waitUntil(p: Promise<unknown>): void;
}

export interface AttributionWrite {
  record: AttributionRecord;
  /** The stored evidence (declared with `evidence-not-recorded` if storing it failed). */
  evidence: Evidence;
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
  return actor?.user.login ?? 'kvarm';
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
  source: 'api' | 'merge' | 'task',
  assessed: Assessed,
): Promise<AttributionWrite> {
  const ctx = resolveCtx(cx, artifacts);
  const reader = artifactsMergeSources(ctx);
  const content = encode(`${JSON.stringify(record)}\n`);
  for (let attempt = 0; attempt < ATTRIBUTION_LIMITS.attempts; attempt++) {
    const tip = (await lsRefs(ctx, [KVARM_NOTES_REF])).get(KVARM_NOTES_REF) ?? null;
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
        author: { ...KVARM_COMMITTER, time: Math.floor(Date.now() / 1000) },
        message: `Attribution for ${sha}\n`,
      });
    } catch (err) {
      if (err instanceof NotesTreeError) throw new RefStoreUnavailable(err.message);
      throw err;
    }
    const r = await pusher.updateRef({ ref: KVARM_NOTES_REF, oldOid: tip ?? ZERO_OID, newOid: built.commit }, built.objects);
    if (r.status === 'stale') continue;
    if (r.status !== 'ok') {
      throw new RefStoreUnavailable(`notes update ${r.status}: ${r.reason ?? r.error ?? `HTTP ${r.httpStatus}`}`);
    }
    const evidence = await recordLedger(cx.env, {
      repoId: cx.repo.id,
      commit: sha,
      notesCommit: built.commit,
      source,
      replaced: built.replaced !== null,
      attribution: record,
      noteDigest: await sha256Hex(content),
      assessed,
    });
    return { record, evidence, replaced: built.replaced !== null, notesCommit: built.commit };
  }
  throw new RefStoreUnavailable(`${KVARM_NOTES_REF} kept moving; retry`);
}

interface LedgerEntry {
  repoId: string;
  commit: string;
  notesCommit: string;
  source: 'api' | 'merge' | 'task';
  replaced: boolean;
  attribution: AttributionRecord;
  noteDigest: string;
  assessed: Assessed;
}

/**
 * Appends to the events ledger and stores the evidence in one batch. The note
 * already landed, so a failure is logged; if the batch fails, the ledger row
 * is retried alone so the evidence write cannot lose it, and the write
 * reports the level readers will then see: declared, since no evidence row
 * matches the note.
 */
async function recordLedger(env: Env, e: LedgerEntry): Promise<Evidence> {
  const now = Date.now();
  const { evidence, submitter } = e.assessed;
  const r = e.attribution;
  const ledger = () =>
    env.DB.prepare('INSERT INTO events (id, type, payload, processed_at, created_at) VALUES (?1, ?2, ?3, ?4, ?4)')
      .bind(
        crypto.randomUUID(),
        'attribution.set',
        JSON.stringify({
          repoId: e.repoId,
          commit: e.commit,
          notesCommit: e.notesCommit,
          source: e.source,
          replaced: e.replaced,
          attribution: r,
          evidence: { level: evidence.level, reasons: evidence.reasons, principal: evidence.principal, tokenKind: evidence.tokenKind, runId: evidence.runId, keyId: evidence.keyId },
        }),
        now,
      );
  try {
    const [, stored] = await env.DB.batch([
      ledger(),
      // Keyed by the note digest: concurrent writers of one commit each store their own row, and a reader picks the
      // row of the note the ref holds. The token prefix is read from the credential row by id, so no token
      // material passes through here.
      env.DB.prepare(
        `INSERT INTO attribution_evidence (repo_id, commit_sha, note_digest, notes_commit, source, agent, session, prompt_hash, model, actor,
                                           level, reasons, principal, token_kind, token_prefix, run_id, key_id, at, recorded_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                 CASE ?14 WHEN 'pat' THEN (SELECT prefix FROM pat WHERE id = ?15)
                          WHEN 'agent' THEN (SELECT prefix FROM agent_tokens WHERE id = ?15) END,
                 ?16, ?17, ?18, ?19)
         ON CONFLICT (repo_id, commit_sha, note_digest) DO UPDATE SET
           notes_commit = excluded.notes_commit, source = excluded.source, level = excluded.level, reasons = excluded.reasons,
           principal = excluded.principal, token_kind = excluded.token_kind, token_prefix = excluded.token_prefix,
           run_id = excluded.run_id, key_id = excluded.key_id, recorded_at = excluded.recorded_at
         RETURNING token_prefix`,
      )
        .bind(
          e.repoId,
          e.commit,
          e.noteDigest,
          e.notesCommit,
          e.source,
          r.agent,
          r.session,
          r.promptHash,
          r.model ?? null,
          r.actor,
          evidence.level,
          JSON.stringify(evidence.reasons),
          submitter.principal,
          submitter.tokenKind,
          submitter.tokenId,
          evidence.runId,
          evidence.keyId,
          Date.parse(r.at),
          now,
        ),
    ]);
    const prefix = (stored?.results as Array<{ token_prefix: string | null }> | undefined)?.[0]?.token_prefix ?? null;
    return { ...evidence, tokenPrefix: prefix };
  } catch (err) {
    console.warn(JSON.stringify({ attributionEvidenceFailed: String(err).slice(0, 200), commit: e.commit }));
    await ledger()
      .run()
      .catch((again: unknown) => console.warn(JSON.stringify({ attributionLedgerFailed: String(again).slice(0, 200), commit: e.commit })));
    return undeclaredEvidence('evidence-not-recorded');
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
  const signed = parseSignedEvidence((input as Record<string, unknown>).evidence);
  if (!signed.ok) return Promise.resolve(signed);
  return guarded(() =>
    withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) => {
      if (!(await readCommitInfo(resolveCtx(cx, artifacts), sha))) {
        return fail(404, 'COMMIT_NOT_FOUND', `no commit ${sha} in this repository`);
      }
      const assessed = await assessEvidence(cx.env, cx.repo, cx.actor, sha, parsed.value, signed.value);
      const written = await writeAttributionNote(cx, artifacts, pusher, sha, makeRecord(parsed.value, actorLogin(cx.actor)), 'api', assessed);
      return { ok: true, value: written };
    }),
  );
}

interface EvidenceRow {
  note_digest: string;
  level: EvidenceLevel;
  reasons: string;
  principal: string | null;
  token_kind: Evidence['tokenKind'];
  token_prefix: string | null;
  run_id: string | null;
  key_id: string | null;
}

/** The stored evidence recorded for exactly these note bytes. */
async function noteEvidence(env: Env, repoId: string, sha: string, bytes: Uint8Array): Promise<Evidence> {
  const digest = await sha256Hex(bytes);
  const { results } = await env.DB.prepare(
    `SELECT note_digest, level, reasons, principal, token_kind, token_prefix, run_id, key_id
       FROM attribution_evidence WHERE repo_id = ?1 AND commit_sha = ?2 ORDER BY note_digest = ?3 DESC, recorded_at DESC LIMIT 1`,
  )
    .bind(repoId, sha, digest)
    .all<EvidenceRow>();
  const row = results[0];
  if (!row) return undeclaredEvidence('no-evidence-record');
  // The notes ref is an ordinary ref: a note pushed around Kvarm (or one whose evidence write failed) has no row.
  if (row.note_digest !== digest) return undeclaredEvidence('note-without-evidence');
  return evidenceFromRow(row);
}

export function evidenceFromRow(row: Omit<EvidenceRow, 'note_digest'>): Evidence {
  let reasons: string[] = [];
  try {
    reasons = JSON.parse(row.reasons) as string[];
  } catch {
    // always stored by recordLedger as a JSON array
  }
  return {
    level: row.level,
    reasons,
    principal: row.principal,
    tokenKind: row.token_kind,
    tokenPrefix: row.token_prefix,
    runId: row.run_id,
    keyId: row.key_id,
  };
}

/** GET commits/:sha/attribution: the note with its evidence, or 404 when the commit has none. */
export function getAttribution(cx: AttributionContext, sha: string, opts: { evidence?: boolean } = {}): Promise<ServiceResult<AttributionView>> {
  const bad = checkSha(sha);
  if (bad) return Promise.resolve(bad);
  const none = fail(404, 'ATTRIBUTION_NOT_FOUND', `commit ${sha} has no attribution`);
  return guarded(() =>
    withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) => {
      const ctx = resolveCtx(cx, artifacts);
      const tip = (await lsRefs(ctx, [KVARM_NOTES_REF])).get(KVARM_NOTES_REF) ?? null;
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
      // Existence checks skip the evidence read.
      const evidence = opts.evidence === false ? undeclaredEvidence('not-read') : await noteEvidence(cx.env, cx.repo.id, sha, bytes);
      return { ok: true, value: { ...(parsed as AttributionRecord), evidence } };
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
    agent: actor?.agent?.agentName ?? actor?.user.login ?? 'kvarm',
    session: `kvarm:merge/change-${changeNumber}`,
    promptHash: null,
  };
}

/** Notes a Kvarm-created merge commit with the merging principal; failures are logged. */
export async function attributeMerge(cx: AttributionContext, artifacts: LazyRepo, pusher: GitPusher, m: MergeAttributionInput): Promise<void> {
  const input = m.input ?? mergeAttributionDefaults(cx.actor, m.changeNumber);
  try {
    const assessed = await assessEvidence(cx.env, cx.repo, cx.actor, m.mergeCommit, input, null);
    await writeAttributionNote(cx, artifacts, pusher, m.mergeCommit, makeRecord(input, actorLogin(cx.actor)), 'merge', assessed);
  } catch (err) {
    console.warn(JSON.stringify({ mergeAttributionFailed: String(err).slice(0, 200), mergeCommit: m.mergeCommit }));
  }
}

/**
 * Notes a commit Kvarm accepted on a principal's behalf (a completed task's
 * resolution) unless it already carries a note and the caller gave no
 * fields of its own; failures are logged. Returns whether a note was written.
 */
export async function attributeCommit(
  cx: AttributionContext,
  pusher: GitPusher,
  sha: string,
  input: AttributionInput,
  opts: { replace: boolean },
): Promise<boolean> {
  try {
    if (!opts.replace) {
      const existing = await getAttribution(cx, sha, { evidence: false });
      if (existing.ok || existing.code !== 'ATTRIBUTION_NOT_FOUND') return false;
    }
    const assessed = await assessEvidence(cx.env, cx.repo, cx.actor, sha, input, null);
    await withLazyRepo(cx.env, cx.repo.artifacts_name, (artifacts) =>
      writeAttributionNote(cx, artifacts, pusher, sha, makeRecord(input, actorLogin(cx.actor)), 'task', assessed),
    );
    return true;
  } catch (err) {
    console.warn(JSON.stringify({ commitAttributionFailed: String(err).slice(0, 200), commit: sha }));
    return false;
  }
}
