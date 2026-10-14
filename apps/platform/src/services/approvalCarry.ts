import type { RepoRow } from '../db/repos';
import { compareChange, type ChangeDiffTarget } from './changeDiff';
import type { HeadMoved } from './changes';

export interface FingerprintFile {
  path: string;
  oldPath: string | null;
  oldHash: string | null;
  newHash: string | null;
}

export interface HeadFingerprint {
  files: FingerprintFile[];
}

export interface CarryView {
  principal: string;
  fromHead: string;
  carried: boolean;
  unchangedPaths: string[];
  changedPaths: string[];
}

interface StoredReview {
  id: string;
  head_sha: string;
  principal: string;
  user_id: string;
  user_login: string;
  agent_id: string | null;
  agent_name: string | null;
  token_id: string | null;
  model_family: string | null;
  carried_from_head: string | null;
  carried_from_review: string | null;
  verdict: string;
  updated_at: number;
}

interface StoredFile {
  review_id: string;
  path: string;
  old_path: string | null;
  old_hash: string | null;
  new_hash: string | null;
}

export interface CarryViewReview {
  id: string;
  headSha: string;
  principal: string;
  verdict: string;
  carriedFromHead: string | null;
  carriedFromReview: string | null;
}

interface CarryChange extends ChangeDiffTarget {
  id: string;
  number: number;
  state: string;
  head_sha: string | null;
}

const REVIEW_SCAN_LIMIT = 200;
const FP_FILE_LIMIT = 100;

export async function headFingerprint(
  env: Env,
  repo: RepoRow,
  change: ChangeDiffTarget,
  headSha: string,
): Promise<HeadFingerprint | null> {
  try {
    const diff = await compareChange(env, repo, change, headSha);
    if (!diff.ok) return null;
    const response = diff.value.response;
    if (response.truncated || response.nextCursor !== undefined || response.files.length > FP_FILE_LIMIT) return null;
    return {
      files: response.files.map((file) => ({
        path: file.path,
        oldPath: file.oldPath ?? null,
        oldHash: file.oldHash,
        newHash: file.newHash,
      })),
    };
  } catch {
    return null;
  }
}

function sameFiles(a: readonly FingerprintFile[], b: readonly FingerprintFile[]): boolean {
  if (a.length !== b.length) return false;
  const right = new Map(b.map((file) => [file.path, file]));
  if (right.size !== b.length) return false;
  return a.every((file) => {
    const other = right.get(file.path);
    return other !== undefined && file.oldPath === other.oldPath && file.oldHash === other.oldHash && file.newHash === other.newHash;
  });
}

function matchingPaths(previous: readonly FingerprintFile[], current: readonly FingerprintFile[]): { unchangedPaths: string[]; changedPaths: string[] } {
  const byPath = new Map(current.map((file) => [file.path, file]));
  const oldByPath = new Map(previous.map((file) => [file.path, file]));
  const unchangedPaths: string[] = [];
  const changed = new Set<string>();
  for (const file of previous) {
    const next = byPath.get(file.path);
    if (next && file.oldPath === next.oldPath && file.oldHash === next.oldHash && file.newHash === next.newHash) unchangedPaths.push(file.path);
    else changed.add(file.path);
  }
  for (const file of current) if (!oldByPath.has(file.path)) changed.add(file.path);
  return { unchangedPaths: unchangedPaths.sort(), changedPaths: [...changed].sort() };
}

async function storedReviews(
  env: Env,
  changeSetId: string,
  currentHead: string,
): Promise<{ reviews: StoredReview[]; files: Map<string, FingerprintFile[]> }> {
  const result = await env.DB.prepare(
    `SELECT r.id, r.head_sha, r.principal, r.user_id, r.user_login, r.agent_id, r.agent_name, r.token_id, r.model_family,
            r.carried_from_head, r.carried_from_review, r.verdict, r.updated_at
       FROM change_reviews r
      WHERE r.change_set_id = ?1 AND r.head_sha != ?2
      ORDER BY r.updated_at DESC, r.id LIMIT ${REVIEW_SCAN_LIMIT}`,
  )
    .bind(changeSetId, currentHead)
    .all<StoredReview>();
  const reviews: StoredReview[] = [];
  const principals = new Set<string>();
  for (const review of result.results ?? []) {
    if (principals.has(review.principal)) continue;
    principals.add(review.principal);
    reviews.push(review);
  }
  const approvals = reviews.filter((review) => review.verdict === 'approve');
  if (approvals.length === 0) return { reviews: approvals, files: new Map() };
  const ids = approvals.map((review) => review.id);
  const filesResult = await env.DB.prepare(
    `SELECT review_id, path, old_path, old_hash, new_hash FROM change_review_files
      WHERE review_id IN (${ids.map((_, index) => `?${index + 1}`).join(',')}) ORDER BY review_id, path`,
  )
    .bind(...ids)
    .all<StoredFile>();
  const files = new Map<string, FingerprintFile[]>();
  for (const file of filesResult.results ?? []) {
    const list = files.get(file.review_id) ?? [];
    list.push({ path: file.path, oldPath: file.old_path, oldHash: file.old_hash, newHash: file.new_hash });
    files.set(file.review_id, list);
  }
  return { reviews: approvals, files };
}

async function currentReviews(env: Env, changeSetId: string, head: string): Promise<Map<string, StoredReview>> {
  const result = await env.DB.prepare(
    `SELECT id, head_sha, principal, user_id, user_login, agent_id, agent_name, token_id, model_family,
            carried_from_head, carried_from_review, verdict, updated_at
       FROM change_reviews WHERE change_set_id = ?1 AND head_sha = ?2`,
  )
    .bind(changeSetId, head)
    .all<StoredReview>();
  return new Map((result.results ?? []).map((review) => [review.principal, review]));
}

export async function carryView(
  env: Env,
  repo: RepoRow,
  change: CarryChange,
  currentHead: string,
  reviews: readonly CarryViewReview[],
): Promise<CarryView[]> {
  const latestByPrincipal = new Map<string, CarryViewReview>();
  for (const review of reviews) if (!latestByPrincipal.has(review.principal)) latestByPrincipal.set(review.principal, review);
  const candidates = [...latestByPrincipal.values()].filter((review) => review.verdict === 'approve');
  const sourceIds = candidates.map((review) => (review.headSha === currentHead ? review.carriedFromReview : review.id)).filter((id): id is string => id !== null);
  if (sourceIds.length === 0) return [];
  const filesResult = await env.DB.prepare(
    `SELECT review_id, path, old_path, old_hash, new_hash FROM change_review_files
      WHERE review_id IN (${sourceIds.map((_, index) => `?${index + 1}`).join(',')}) ORDER BY review_id, path`,
  )
    .bind(...sourceIds)
    .all<StoredFile>();
  const files = new Map<string, FingerprintFile[]>();
  for (const file of filesResult.results ?? []) {
    const list = files.get(file.review_id) ?? [];
    list.push({ path: file.path, oldPath: file.old_path, oldHash: file.old_hash, newHash: file.new_hash });
    files.set(file.review_id, list);
  }
  const validCandidates = candidates.filter((review) =>
    files.has(review.headSha === currentHead ? review.carriedFromReview ?? '' : review.id),
  );
  if (validCandidates.length === 0) return [];
  const current = await headFingerprint(env, repo, change, currentHead);
  if (!current) return [];
  const out: CarryView[] = [];
  for (const review of validCandidates) {
    if (review.headSha === currentHead && !review.carriedFromReview) continue;
    const sourceId = review.headSha === currentHead ? review.carriedFromReview! : review.id;
    const source = files.get(sourceId);
    if (!source) continue;
    const match = matchingPaths(source, current.files);
    out.push({
      principal: review.principal,
      fromHead: review.headSha === currentHead ? review.carriedFromHead ?? review.headSha : review.headSha,
      carried: review.headSha === currentHead && review.carriedFromReview === sourceId && sameFiles(source, current.files),
      ...match,
    });
  }
  return out;
}

export async function storeReviewFingerprint(
  env: Env,
  repo: RepoRow,
  change: ChangeDiffTarget,
  headSha: string,
  reviewId: string,
): Promise<void> {
  try {
    const fingerprint = await headFingerprint(env, repo, change, headSha);
    if (!fingerprint) return;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM change_review_files WHERE review_id = ?1').bind(reviewId),
      ...fingerprint.files.map((file) =>
        env.DB.prepare(
          `INSERT INTO change_review_files (review_id, path, old_path, old_hash, new_hash)
           VALUES (?1, ?2, ?3, ?4, ?5)`,
        ).bind(reviewId, file.path, file.oldPath, file.oldHash, file.newHash),
      ),
    ]);
  } catch {
    // Fingerprints improve later carry; they never invalidate a landed review.
  }
}

async function changeForHead(env: Env, e: HeadMoved): Promise<{ repo: RepoRow; change: CarryChange } | null> {
  const row = await env.DB.prepare(
    `SELECT r.*, c.id AS change_id, c.number, c.base_ref, c.state, c.head_sha
       FROM repos r JOIN change_sets c ON c.repo_id = r.id
      WHERE r.id = ?1 AND c.id = ?2`,
  )
    .bind(e.repoId, e.change.id)
    .first<RepoRow & { change_id: string; number: number; base_ref: string; state: string; head_sha: string | null }>();
  if (!row || row.head_sha !== e.headSha || (row.state !== 'open' && row.state !== 'conflicted')) return null;
  const { change_id, number, base_ref, state, head_sha, ...repo } = row;
  return { repo, change: { id: change_id, number, base: base_ref, state, head_sha } };
}

export async function carryApprovals(e: HeadMoved): Promise<void> {
  try {
    const found = await changeForHead(e.env, e);
    if (!found || !found.change.head_sha) return;
    const current = await headFingerprint(e.env, found.repo, found.change, e.headSha);
    if (!current) return;
    const prior = await storedReviews(e.env, found.change.id, e.headSha);
    const currentRows = await currentReviews(e.env, found.change.id, e.headSha);
    for (const review of prior.reviews) {
      const files = prior.files.get(review.id);
      if (!files || !sameFiles(files, current.files)) continue;
      if (currentRows.has(review.principal)) continue;
      const id = crypto.randomUUID();
      const now = Date.now();
      await e.env.DB.batch([
        e.env.DB.prepare(
          `INSERT INTO change_reviews (id, repo_id, change_set_id, head_sha, principal, user_id, user_login, agent_id, agent_name,
                                       token_id, model_family, verdict, body, created_at, updated_at, carried_from_head, carried_from_review)
           SELECT ?1, c.repo_id, c.id, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'approve', NULL, ?11, ?11, ?12, ?13
             FROM change_sets c WHERE c.id = ?2 AND c.head_sha = ?3 AND c.state IN ('open', 'conflicted')
           ON CONFLICT (change_set_id, head_sha, principal) DO NOTHING`,
        ).bind(id, found.change.id, e.headSha, review.principal, review.user_id, review.user_login, review.agent_id, review.agent_name, review.token_id, review.model_family, now, review.head_sha, review.id),
        ...files.map((file) =>
          e.env.DB.prepare(
            `INSERT INTO change_review_files (review_id, path, old_path, old_hash, new_hash)
             SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM change_reviews WHERE id = ?1 AND carried_from_review = ?6)
             ON CONFLICT (review_id, path) DO NOTHING`,
          ).bind(id, file.path, file.oldPath, file.oldHash, file.newHash, review.id),
        ),
      ]);
    }
  } catch {
    // A failed optional carry must not fail the head push.
  }
}

export function sameFingerprint(a: HeadFingerprint | null, b: HeadFingerprint | null): boolean {
  return a !== null && b !== null && sameFiles(a.files, b.files);
}
