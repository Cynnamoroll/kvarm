/**
 * Provenance evidence levels (architecture §9 provenance).
 *
 * An attribution record names an agent, session, prompt hash and model. Kvarm
 * cannot see which model ran, so it states how much of the record it can
 * prove, computed here from the authenticated credential and never taken from
 * the request:
 *
 *   declared       the caller asserted the fields; nothing binds them to the
 *                  submitting principal (a human PAT naming an agent, agent A
 *                  naming agent B, a note written around Kvarm).
 *   authenticated  the record was submitted with a credential of the very
 *                  principal it names (that agent's token, or the human
 *                  naming themself), so Kvarm proves WHO submitted it, not
 *                  which model ran or what the prompt was.
 *   verified       additionally, a trusted execution service signed evidence
 *                  linking the repository, the submitting principal, the run
 *                  id, model, input (prompt) hash and the produced commit,
 *                  checked on write with Ed25519 against a repository key or
 *                  an instance key. Binding the repository and the submitting
 *                  principal is what stops one principal's signature from
 *                  being replayed by another or against another repository.
 *
 * Evidence that fails verification never raises the level; the reason codes
 * say why a record is not higher.
 */

import { sha256Hex } from '@kvarm/gitops';
import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import type { Actor } from './authz';

export type EvidenceLevel = 'declared' | 'authenticated' | 'verified';
export type TokenKind = 'session' | 'pat' | 'agent';

/** Signed evidence a caller passes along with an attribution write. */
export interface SignedEvidence {
  keyId: string;
  runId: string;
  /** Ed25519 signature over `canonicalPayload`, base64url or base64. */
  signature: string;
}

/** The level and its basis, as stored and returned. */
export interface Evidence {
  level: EvidenceLevel;
  /** Why the level is not higher (empty for verified). */
  reasons: string[];
  /** `user:<id>` or `agent:<id>` of the submitting credential, null without one. */
  principal: string | null;
  tokenKind: TokenKind | null;
  /** The credential's public prefix; never the token. */
  tokenPrefix: string | null;
  runId: string | null;
  keyId: string | null;
}

/** What the assessment needs to know about the submitter, beyond the evidence. */
export interface Submitter {
  principal: string | null;
  tokenKind: TokenKind | null;
  tokenId: string | null;
}

export const PROVENANCE_LIMITS = {
  /** Longest run id or key id. */
  idMax: 200,
  /** Instance keys read from KVARM_PROVENANCE_KEYS. */
  instanceKeysMax: 32,
  /** Live keys per repository. */
  repoKeysMax: 32,
  nameMax: 100,
} as const;

/** Version line of the canonical payload; a new format gets a new line. */
export const PROVENANCE_PAYLOAD_VERSION = 'kvarm-provenance-v2';

/**
 * The retired payload (five lines, no repository or principal). It is kept
 * byte-for-byte only to recognize a signature made under it: because it binds
 * neither the repository nor the submitting principal, one principal's
 * signature could be replayed by another principal or against another
 * repository, so a signature over these bytes never verifies.
 */
export const LEGACY_PROVENANCE_PAYLOAD_VERSION = 'kvarm-provenance-v1';

export interface CanonicalPayloadFields {
  /** The target repository's id: a signature is valid for exactly one repository. */
  repoId: string;
  /** `user:<id>` or `agent:<id>` of the authenticated submitter. */
  principal: string;
  runId: string;
  model: string;
  promptHash: string;
  commit: string;
}

/**
 * The exact bytes a trusted execution service signs (UTF-8): seven
 * newline-terminated lines, no other whitespace.
 *
 *   kvarm-provenance-v2
 *   repo:<repo id>
 *   principal:<user:<id> or agent:<id>>
 *   run:<runId>
 *   model:<model>
 *   input:<promptHash>
 *   commit:<40-hex commit sha>
 *
 * The repository and the submitting principal are part of the signed bytes,
 * so a valid signature is bound to one repository and one submitter.
 */
export function canonicalPayload(p: CanonicalPayloadFields): string {
  return `${PROVENANCE_PAYLOAD_VERSION}\nrepo:${p.repoId}\nprincipal:${p.principal}\nrun:${p.runId}\nmodel:${p.model}\ninput:${p.promptHash}\ncommit:${p.commit}\n`;
}

/** The retired payload's bytes, to recognize (never to verify) a legacy signature. */
export function legacyCanonicalPayload(p: { runId: string; model: string; promptHash: string; commit: string }): string {
  return `${LEGACY_PROVENANCE_PAYLOAD_VERSION}\nrun:${p.runId}\nmodel:${p.model}\ninput:${p.promptHash}\ncommit:${p.commit}\n`;
}

type Fail = Extract<ServiceResult<never>, { ok: false }>;
const fail = (status: number, code: string, error: string): Fail => ({ ok: false, status, code, error });

// Control characters (newlines above all) would let one field forge another line of the payload.
function lineSafe(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

/** Validates the optional `evidence` member of an attribution write. */
export function parseSignedEvidence(v: unknown): ServiceResult<SignedEvidence | null> {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== 'object' || Array.isArray(v)) {
    return fail(422, 'INVALID_EVIDENCE', 'evidence must be an object {keyId, runId, signature}');
  }
  const o = v as Record<string, unknown>;
  for (const k of ['keyId', 'runId', 'signature'] as const) {
    const s = o[k];
    if (typeof s !== 'string' || s.length === 0 || s.length > (k === 'signature' ? 200 : PROVENANCE_LIMITS.idMax) || !lineSafe(s)) {
      return fail(422, 'INVALID_EVIDENCE', `evidence.${k} must be a non-empty single-line string`);
    }
  }
  return { ok: true, value: { keyId: o.keyId as string, runId: o.runId as string, signature: o.signature as string } };
}

export function submitterOf(actor: Actor | null): Submitter {
  if (!actor) return { principal: null, tokenKind: null, tokenId: null };
  if (actor.agent) return { principal: `agent:${actor.agent.agentId}`, tokenKind: 'agent', tokenId: actor.agent.tokenId };
  if (actor.via === 'pat') {
    // An actor rebuilt from a stored principal (the merge train's enqueuer) names no credential.
    return { principal: `user:${actor.user.id}`, tokenKind: actor.patId ? 'pat' : null, tokenId: actor.patId ?? null };
  }
  return { principal: `user:${actor.user.id}`, tokenKind: 'session', tokenId: null };
}

/**
 * Whether the record's `agent` names the submitting principal: an agent
 * token's own agent name, or a human's own login.
 */
function principalReason(actor: Actor | null, agent: string): string | null {
  if (!actor) return 'no-credential';
  if (actor.agent) return agent === actor.agent.agentName ? null : 'agent-not-submitter';
  return agent === actor.user.login ? null : 'human-submitted-agent-metadata';
}

// ---------------------------------------------------------------------------
// Keys and signatures
// ---------------------------------------------------------------------------

export function base64urlDecode(s: string): Uint8Array | null {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(norm) || norm.length % 4 === 1) return null;
  try {
    const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function base64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A key's id: the first 16 hex characters of the SHA-256 of its raw bytes. */
export async function keyFingerprint(raw: Uint8Array): Promise<string> {
  return (await sha256Hex(raw)).slice(0, 16);
}

/** Decodes a raw Ed25519 public key (32 bytes, base64url or base64). */
export function parsePublicKey(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || s.length > 64) return null;
  const raw = base64urlDecode(s.trim());
  return raw && raw.length === 32 ? raw : null;
}

/** Instance keys: KVARM_PROVENANCE_KEYS, comma- or whitespace-separated raw public keys. */
async function instanceKey(env: Env, keyId: string): Promise<Uint8Array | null> {
  const list = (env.KVARM_PROVENANCE_KEYS ?? '').split(/[\s,]+/).filter(Boolean).slice(0, PROVENANCE_LIMITS.instanceKeysMax);
  for (const entry of list) {
    const raw = parsePublicKey(entry);
    if (raw && (await keyFingerprint(raw)) === keyId) return raw;
  }
  return null;
}

async function repoKey(env: Env, repo: RepoRow, keyId: string): Promise<Uint8Array | null> {
  const row = await env.DB.prepare('SELECT public_key FROM provenance_keys WHERE repo_id = ?1 AND id = ?2 AND revoked_at IS NULL')
    .bind(repo.id, keyId)
    .first<{ public_key: string }>();
  return row ? parsePublicKey(row.public_key) : null;
}

async function ed25519Verify(raw: Uint8Array, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, data);
  } catch {
    return false;
  }
}

/**
 * Null when the signed evidence verifies for exactly these fields, else the
 * reason. The payload is built from the server-side target (the authenticated
 * submitter's principal id and the repository the write targets), so a
 * signature replayed by another principal or against another repository fails
 * here; a signature over the retired payload is reported as `legacy-payload`
 * and never verifies.
 */
async function verificationReason(
  env: Env,
  repo: RepoRow,
  commit: string,
  record: { model?: string; promptHash: string | null },
  submitter: Submitter,
  ev: SignedEvidence,
): Promise<string | null> {
  if (record.model === undefined) return 'evidence-without-model';
  if (record.promptHash === null) return 'evidence-without-prompt-hash';
  if (!lineSafe(record.model) || !lineSafe(record.promptHash)) return 'unsignable-field';
  if (submitter.principal === null) return 'no-credential';
  const sig = base64urlDecode(ev.signature);
  if (!sig || sig.length !== 64) return 'malformed-signature';
  const raw = (await instanceKey(env, ev.keyId)) ?? (await repoKey(env, repo, ev.keyId));
  if (!raw) return 'unknown-key';
  const fields = { runId: ev.runId, model: record.model, promptHash: record.promptHash, commit };
  const payload = new TextEncoder().encode(canonicalPayload({ ...fields, repoId: repo.id, principal: submitter.principal }));
  if (await ed25519Verify(raw, sig, payload)) return null;
  // Recognize the retired payload so an old signature reads as legacy, not as a plain bad signature.
  const legacy = new TextEncoder().encode(legacyCanonicalPayload(fields));
  return (await ed25519Verify(raw, sig, legacy)) ? 'legacy-payload' : 'bad-signature';
}

/**
 * The evidence level of a record `actor` submits for `commit`. The token
 * prefix is filled in by the write that stores the evidence.
 */
export async function assessEvidence(
  env: Env,
  repo: RepoRow,
  actor: Actor | null,
  commit: string,
  record: { agent: string; model?: string; promptHash: string | null },
  signed: SignedEvidence | null,
): Promise<{ evidence: Evidence; submitter: Submitter }> {
  const submitter = submitterOf(actor);
  const reasons: string[] = [];
  const push = (reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  const who = principalReason(actor, record.agent);
  if (who) push(who);
  let verified = false;
  if (signed) {
    const why = await verificationReason(env, repo, commit, record, submitter, signed);
    if (why) push(why);
    else verified = true;
  } else {
    push('no-signed-evidence');
  }
  // A ladder: a valid signature over a record its submitter cannot claim stays declared.
  const level: EvidenceLevel = who ? 'declared' : verified ? 'verified' : 'authenticated';
  return {
    submitter,
    evidence: {
      level,
      reasons,
      principal: submitter.principal,
      tokenKind: submitter.tokenKind,
      tokenPrefix: null,
      runId: verified ? signed!.runId : null,
      keyId: verified ? signed!.keyId : null,
    },
  };
}

/** The evidence of a note Kvarm has no matching record for. */
export function undeclaredEvidence(reason: string): Evidence {
  return { level: 'declared', reasons: [reason], principal: null, tokenKind: null, tokenPrefix: null, runId: null, keyId: null };
}

/** Model-family claims (agents.model_family) are self-declared at principal creation; nothing verifies them yet. */
export function modelFamilyEvidence(family: string | null, human: boolean): EvidenceLevel | null {
  if (family === null) return null;
  // `human` comes from the authenticated principal kind, not from a declaration.
  return human ? 'authenticated' : 'declared';
}

// ---------------------------------------------------------------------------
// Repository keys (admin)
// ---------------------------------------------------------------------------

export interface ProvenanceKeyView {
  id: string;
  name: string;
  publicKey: string;
  scope: 'repository' | 'instance';
  createdAt: string | null;
  revokedAt: string | null;
}

interface KeyRow {
  id: string;
  name: string;
  public_key: string;
  created_at: number;
  revoked_at: number | null;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function keyView(r: KeyRow): ProvenanceKeyView {
  return { id: r.id, name: r.name, publicKey: r.public_key, scope: 'repository', createdAt: iso(r.created_at), revokedAt: iso(r.revoked_at) };
}

/** GET provenance-keys: the repository's keys (revoked included) and the instance keys. */
export async function listProvenanceKeys(env: Env, repo: RepoRow): Promise<ServiceResult<{ keys: ProvenanceKeyView[] }>> {
  const { results } = await env.DB.prepare(
    // Live keys first: at most repoKeysMax of them, so every key that still verifies is always listed.
    `SELECT id, name, public_key, created_at, revoked_at FROM provenance_keys WHERE repo_id = ?1
      ORDER BY revoked_at IS NOT NULL, created_at, id LIMIT ${PROVENANCE_LIMITS.repoKeysMax * 4}`,
  )
    .bind(repo.id)
    .all<KeyRow>();
  const keys = results.map(keyView);
  for (const entry of (env.KVARM_PROVENANCE_KEYS ?? '').split(/[\s,]+/).filter(Boolean).slice(0, PROVENANCE_LIMITS.instanceKeysMax)) {
    const raw = parsePublicKey(entry);
    if (raw) keys.push({ id: await keyFingerprint(raw), name: 'instance', publicKey: base64urlEncode(raw), scope: 'instance', createdAt: null, revokedAt: null });
  }
  return { ok: true, value: { keys } };
}

/** POST provenance-keys {name, publicKey}: trusts an execution service's Ed25519 public key for this repository. */
export async function addProvenanceKey(env: Env, repo: RepoRow, actor: Actor, input: unknown): Promise<ServiceResult<ProvenanceKeyView>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail(400, 'INVALID_BODY', 'body must be a JSON object {name, publicKey}');
  }
  const o = input as Record<string, unknown>;
  if (typeof o.name !== 'string' || o.name.trim().length === 0 || o.name.length > PROVENANCE_LIMITS.nameMax) {
    return fail(422, 'INVALID_NAME', `name must be a non-empty string of at most ${PROVENANCE_LIMITS.nameMax} characters`);
  }
  const raw = parsePublicKey(o.publicKey);
  if (!raw) return fail(422, 'INVALID_PUBLIC_KEY', 'publicKey must be a raw 32-byte Ed25519 public key, base64url encoded');
  const id = await keyFingerprint(raw);
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO provenance_keys (id, repo_id, name, public_key, created_by, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6
      WHERE (SELECT COUNT(*) FROM provenance_keys WHERE repo_id = ?2 AND revoked_at IS NULL) < ${PROVENANCE_LIMITS.repoKeysMax}
         OR EXISTS (SELECT 1 FROM provenance_keys WHERE repo_id = ?2 AND id = ?1 AND revoked_at IS NULL)
     ON CONFLICT (repo_id, id) DO UPDATE SET name = excluded.name, revoked_at = NULL
     RETURNING id, name, public_key, created_at, revoked_at`,
  )
    .bind(id, repo.id, o.name, base64urlEncode(raw), actor.user.id, now)
    .first<KeyRow>();
  if (!row) return fail(409, 'TOO_MANY_KEYS', `a repository trusts at most ${PROVENANCE_LIMITS.repoKeysMax} live keys`);
  return { ok: true, value: keyView(row) };
}

/** DELETE provenance-keys/:id: stops trusting a key for new writes; stored levels stay as recorded. */
export async function revokeProvenanceKey(env: Env, repo: RepoRow, id: string): Promise<ServiceResult<ProvenanceKeyView>> {
  const row = await env.DB.prepare(
    `UPDATE provenance_keys SET revoked_at = COALESCE(revoked_at, ?3) WHERE repo_id = ?1 AND id = ?2
     RETURNING id, name, public_key, created_at, revoked_at`,
  )
    .bind(repo.id, id, Date.now())
    .first<KeyRow>();
  if (!row) return fail(404, 'KEY_NOT_FOUND', 'no such provenance key in this repository');
  return { ok: true, value: keyView(row) };
}
