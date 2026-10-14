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

import { KVARM_NOTES_REF, NotesTreeError, ZERO_OID, buildNotesCommit, encode, findNote, parseTree, sha256Hex, type GitObject, type NotesTreeReader } from '@kvarm/gitops';
import { withLazyRepo, type LazyRepo } from '../artifacts/repo';
import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import { fail, guarded as baseGuarded, objectBody, type Fail } from './result';
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



function textField(v: unknown, name: string, code: string, required: boolean): string | undefined | Fail {
  if (v === undefined || v === null) {
    return required ? fail(422, `${name} is required (a string of 1-${ATTRIBUTION_LIMITS.fieldMax} characters)`, code) : undefined;
  }
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > ATTRIBUTION_LIMITS.fieldMax) {
    return fail(422, `${name} must be a non-empty string of at most ${ATTRIBUTION_LIMITS.fieldMax} characters`, code);
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
  const parsed = objectBody(input, '{agent, session, promptHash, model?}');
  if (!parsed.ok) return parsed;
  const o = parsed.value;
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

type AttributionlessContext = Omit<AttributionContext, 'actor'>;

function resolveCtx(cx: AttributionlessContext, artifacts: LazyRepo): ResolveContext {
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
  const { evidence } = e.assessed;
  try {
    const [, stored] = await env.DB.batch([ledgerStatement(env, e, now), evidenceStatement(env, e, now)]);
    const prefix = (stored?.results as Array<{ token_prefix: string | null }> | undefined)?.[0]?.token_prefix ?? null;
    return { ...evidence, tokenPrefix: prefix };
  } catch (err) {
    console.warn(JSON.stringify({ attributionEvidenceFailed: String(err).slice(0, 200), commit: e.commit }));
    await ledgerStatement(env, e, now)
      .run()
      .catch((again: unknown) => console.warn(JSON.stringify({ attributionLedgerFailed: String(again).slice(0, 200), commit: e.commit })));
    return undeclaredEvidence('evidence-not-recorded');
  }
}

/** The events-ledger row of one attribution write. */
function ledgerStatement(env: Env, e: LedgerEntry, now: number): D1PreparedStatement {
  const { evidence } = e.assessed;
  return env.DB.prepare('INSERT INTO events (id, type, payload, processed_at, created_at) VALUES (?1, ?2, ?3, ?4, ?4)').bind(
    crypto.randomUUID(),
    'attribution.set',
    JSON.stringify({
      repoId: e.repoId,
      commit: e.commit,
      notesCommit: e.notesCommit,
      source: e.source,
      replaced: e.replaced,
      attribution: e.attribution,
      evidence: { level: evidence.level, reasons: evidence.reasons, principal: evidence.principal, tokenKind: evidence.tokenKind, runId: evidence.runId, keyId: evidence.keyId },
    }),
    now,
  );
}

/**
 * The evidence row of one attribution write, keyed by the note digest:
 * concurrent writers of one commit each store their own row, and a reader
 * picks the row of the note the ref holds. The token prefix is read from the
 * credential row by id, so no token material passes through here.
 */
function evidenceStatement(env: Env, e: LedgerEntry, now: number): D1PreparedStatement {
  const { evidence, submitter } = e.assessed;
  const r = e.attribution;
  return env.DB.prepare(
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
  ).bind(
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
  );
}

/**
 * The ledger and evidence rows of a publication chain's notes, one D1 batch
 * like a single write. The notes already landed, so a failure is logged and
 * the ledger rows are retried alone — the evidence writes cannot lose them,
 * and the chain's notes then read as declared, exactly like a single write
 * whose evidence batch failed.
 */
async function recordLedgerBatch(env: Env, entries: LedgerEntry[]): Promise<void> {
  const now = Date.now();
  const commits = entries.map((e) => e.commit).join(',');
  try {
    await env.DB.batch(entries.flatMap((e) => [ledgerStatement(env, e, now), evidenceStatement(env, e, now)]));
  } catch (err) {
    console.warn(JSON.stringify({ attributionEvidenceFailed: String(err).slice(0, 200), commits }));
    await env.DB
      .batch(entries.map((e) => ledgerStatement(env, e, now)))
      .catch((again: unknown) => console.warn(JSON.stringify({ attributionLedgerFailed: String(again).slice(0, 200), commits })));
  }
}

const guarded = <T>(fn: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> => baseGuarded('attributionStore', fn);

function checkSha(sha: string): Fail | null {
  return isFullSha(sha) ? null : fail(400, `"${sha.slice(0, 80)}" is not a full 40-character lowercase commit sha`, 'INVALID_SHA');
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
        return fail(404, `no commit ${sha} in this repository`, 'COMMIT_NOT_FOUND');
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

/**
 * The evidence as a reader at `role` may see it. The submitting principal id
 * and the credential's public prefix are admin-only: an attribution note can
 * be read by anyone with read access, including anonymous visitors on a
 * public repo, and the note already carries the agent/actor display name.
 */
export function evidenceForReader(evidence: Evidence, admin: boolean): Evidence {
  return admin ? evidence : { ...evidence, principal: null, tokenPrefix: null };
}

/** GET commits/:sha/attribution: the note with its evidence, or 404 when the commit has none. */
export function getAttribution(cx: AttributionContext, sha: string, opts: { evidence?: boolean } = {}): Promise<ServiceResult<AttributionView>> {
  const bad = checkSha(sha);
  if (bad) return Promise.resolve(bad);
  const none = fail(404, `commit ${sha} has no attribution`, 'ATTRIBUTION_NOT_FOUND');
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
      if (!bytes) return fail(422, `the note on ${sha} is missing or larger than ${ATTRIBUTION_LIMITS.noteMaxBytes} bytes`, 'ATTRIBUTION_UNREADABLE');
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        parsed = null;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return fail(422, `the note on ${sha} is not a JSON attribution record`, 'ATTRIBUTION_NOT_JSON');
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

/** One merge of a batched notes write: the merge carries its own principal. */
export interface MergeAttributionItem extends MergeAttributionInput {
  actor: Actor | null;
}

/**
 * Notes several Kvarm-created merge commits (one publication chain lands
 * several merges at once) in one notes commit and one push: each attempt
 * reads the notes tip once, chains one built commit per note on the previous
 * one, and pushes the last with the tip as the expected old value; a `stale`
 * push restarts the whole batch from the fresh tip. Every note is assessed
 * and recorded exactly like a single write, in one ledger batch. One merge
 * keeps the single-note path unchanged. Failures are logged per merge.
 */
export async function attributeMerges(
  cx: Omit<AttributionContext, 'actor'>,
  artifacts: LazyRepo,
  pusher: GitPusher,
  merges: readonly MergeAttributionItem[],
): Promise<void> {
  if (merges.length === 0) return;
  if (merges.length === 1) {
    const m = merges[0]!;
    await attributeMerge({ ...cx, actor: m.actor }, artifacts, pusher, m);
    return;
  }
  const ctx = resolveCtx(cx, artifacts);
  const reader = artifactsMergeSources(ctx);
  const notes = merges.map((m) => {
    const input = m.input ?? mergeAttributionDefaults(m.actor, m.changeNumber);
    return { actor: m.actor, sha: m.mergeCommit, input, record: makeRecord(input, actorLogin(m.actor)) };
  });
  try {
    // Assessed once, before any note lands: an assessment failure fails the
    // whole batch, exactly like a single write.
    const assessed = await Promise.all(notes.map((n) => assessEvidence(cx.env, cx.repo, n.actor, n.sha, n.input, null)));
    for (let attempt = 0; attempt < ATTRIBUTION_LIMITS.attempts; attempt++) {
      const tip = (await lsRefs(ctx, [KVARM_NOTES_REF])).get(KVARM_NOTES_REF) ?? null;
      let parent: { commit: string; tree: string } | null = null;
      if (tip) {
        const info = await readCommitInfo(ctx, tip);
        if (!info) throw new RefStoreUnavailable(`notes commit ${tip} is not readable`);
        parent = { commit: tip, tree: info.tree };
      }
      // Each note chains on the previous one before anything is pushed, so
      // the reader must also answer for the trees this batch just built.
      const built = new Map<string, Uint8Array>();
      const localReader: NotesTreeReader = {
        async readTree(hash) {
          const raw = built.get(hash);
          return raw ? parseTree(raw) : reader.readTree(hash);
        },
      };
      const objects: GitObject[] = [];
      const writes: Array<{ notesCommit: string; replaced: boolean; noteDigest: string }> = [];
      for (const n of notes) {
        const content = encode(`${JSON.stringify(n.record)}\n`);
        let builtNote;
        try {
          builtNote = await buildNotesCommit({
            reader: localReader,
            parent,
            target: n.sha,
            content,
            author: { ...KVARM_COMMITTER, time: Math.floor(Date.now() / 1000) },
            message: `Attribution for ${n.sha}\n`,
          });
        } catch (err) {
          if (err instanceof NotesTreeError) throw new RefStoreUnavailable(err.message);
          throw err;
        }
        for (const o of builtNote.objects) if (o.type === 'tree') built.set(o.hash, o.raw);
        objects.push(...builtNote.objects);
        writes.push({ notesCommit: builtNote.commit, replaced: builtNote.replaced !== null, noteDigest: await sha256Hex(content) });
        parent = { commit: builtNote.commit, tree: builtNote.tree };
      }
      const r = await pusher.updateRef({ ref: KVARM_NOTES_REF, oldOid: tip ?? ZERO_OID, newOid: writes[writes.length - 1]!.notesCommit }, objects);
      if (r.status === 'stale') continue;
      if (r.status !== 'ok') {
        throw new RefStoreUnavailable(`notes update ${r.status}: ${r.reason ?? r.error ?? `HTTP ${r.httpStatus}`}`);
      }
      await recordLedgerBatch(
        cx.env,
        notes.map((n, i) => ({
          repoId: cx.repo.id,
          commit: n.sha,
          notesCommit: writes[i]!.notesCommit,
          source: 'merge',
          replaced: writes[i]!.replaced,
          attribution: n.record,
          noteDigest: writes[i]!.noteDigest,
          assessed: assessed[i]!,
        })),
      );
      return;
    }
    throw new RefStoreUnavailable(`${KVARM_NOTES_REF} kept moving; retry`);
  } catch (err) {
    console.warn(JSON.stringify({ mergeAttributionFailed: String(err).slice(0, 200), mergeCommits: notes.map((n) => n.sha).join(',') }));
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
