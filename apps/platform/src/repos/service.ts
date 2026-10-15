/**
 * Repo lifecycle service: the single path by which repos get created,
 * imported, forked, and deleted. Wraps the Artifacts binding and keeps the
 * D1 registry (including the upstream remote) in sync.
 */

import {
  artifactsRepoName,
  createRepoRow,
  deleteRepoRowStatement,
  getRepo,
  isValidRepoName,
  type RepoRow,
} from '../db/repos';
import { purgeGitTokens } from '../artifacts/tokens';
import { deleteSnapshotObjects, snapshotCleanupStatements } from '../services/snapshots';
import { changeCleanupStatements } from '../services/changes';
import { workspaceCleanupStatements } from '../services/workspaces';
import { issueCleanupStatements } from '../services/issues';
import { arenaCleanupStatements } from '../services/candidates';
import { compositionCleanupStatements } from '../services/compositions';
import { historyCleanupStatements } from '../services/history';

import type { ServiceResult } from './types';
export type { ServiceResult } from './types';

export interface CreateRepoParams {
  ownerLogin: string;
  name: string;
  description?: string | null;
  visibility?: 'public' | 'private';
  defaultBranch?: string;
  /** Set for org repos; personal repos leave it unset. */
  ownerOrgId?: string | null;
}

/**
 * The creation prefix shared by create, import and fork: the requested name
 * trimmed with a trailing `.git` stripped, validated, and checked against
 * the owner's existing repos. Returns the normalized name and its Artifacts
 * repository name so only the operation-specific steps differ per path.
 */
async function prepareRepoCreation(
  env: Env,
  ownerLogin: string,
  requested: string,
): Promise<ServiceResult<{ name: string; artifactsName: string }>> {
  const name = requested.trim().replace(/\.git$/, '');
  if (!isValidRepoName(name)) {
    return { ok: false, status: 400, error: 'invalid name (letters, digits, dot, dash, underscore; max 100)', code: 'INVALID_REPO_NAME' };
  }
  if (await getRepo(env.DB, ownerLogin, name)) {
    return { ok: false, status: 409, error: 'you already have a repo with that name', code: 'REPO_EXISTS' };
  }
  return { ok: true, value: { name, artifactsName: artifactsRepoName(ownerLogin, name) } };
}

export async function createRepo(env: Env, p: CreateRepoParams): Promise<ServiceResult<RepoRow>> {
  const prepared = await prepareRepoCreation(env, p.ownerLogin, p.name);
  if (!prepared.ok) return prepared;
  const { name, artifactsName } = prepared.value;
  const visibility = p.visibility === 'public' ? 'public' : 'private';
  const defaultBranch = (p.defaultBranch ?? 'main').replace(/[^a-zA-Z0-9._/-]+/g, '-') || 'main';

  let created;
  try {
    created = await env.ARTIFACTS.create(artifactsName, {
      description: p.description ?? undefined,
      readOnly: false,
      setDefaultBranch: defaultBranch,
    });
  } catch (err) {
    return { ok: false, status: 502, error: `Artifacts create failed: ${String(err)}`, code: 'ARTIFACTS_UNAVAILABLE' };
  }

  const row = await createRepoRow(env, {
    owner_login: p.ownerLogin,
    name,
    artifacts_name: artifactsName,
    artifacts_remote: created.remote,
    visibility,
    default_branch: created.defaultBranch ?? defaultBranch,
    description: p.description ?? null,
    fork_parent_id: null,
    owner_org_id: p.ownerOrgId ?? null,
  });
  return { ok: true, value: row };
}

export interface ImportRepoParams extends CreateRepoParams {
  sourceUrl: string;
  branch?: string;
}

export async function importRepo(env: Env, p: ImportRepoParams): Promise<ServiceResult<RepoRow>> {
  const url = p.sourceUrl.trim();
  if (!/^https:\/\/[^\s]+$/.test(url)) {
    return { ok: false, status: 400, error: 'url must be an HTTPS git remote', code: 'INVALID_URL' };
  }
  const prepared = await prepareRepoCreation(env, p.ownerLogin, p.name);
  if (!prepared.ok) return prepared;
  const { name, artifactsName } = prepared.value;

  let imported;
  try {
    imported = await env.ARTIFACTS.import({
      source: { url, branch: p.branch },
      target: { name: artifactsName },
    });
  } catch (err) {
    return { ok: false, status: 502, error: `Artifacts import failed: ${String(err)}`, code: 'ARTIFACTS_UNAVAILABLE' };
  }

  const row = await createRepoRow(env, {
    owner_login: p.ownerLogin,
    name,
    artifacts_name: artifactsName,
    artifacts_remote: imported.remote,
    visibility: p.visibility === 'public' ? 'public' : 'private',
    default_branch: imported.defaultBranch ?? 'main',
    description: `Imported from ${url}`,
    fork_parent_id: null,
  });
  return { ok: true, value: row };
}

export async function forkRepo(
  env: Env,
  parent: RepoRow,
  ownerLogin: string,
  name: string,
): Promise<ServiceResult<RepoRow>> {
  const prepared = await prepareRepoCreation(env, ownerLogin, name);
  if (!prepared.ok) return prepared;
  const { name: forkName, artifactsName } = prepared.value;
  let forked;
  try {
    const handle = await env.ARTIFACTS.get(parent.artifacts_name);
    forked = await handle.fork(artifactsName, { readOnly: false });
  } catch (err) {
    return { ok: false, status: 502, error: `Artifacts fork failed: ${String(err)}`, code: 'ARTIFACTS_UNAVAILABLE' };
  }
  const row = await createRepoRow(env, {
    owner_login: ownerLogin,
    name: forkName,
    artifacts_name: artifactsName,
    artifacts_remote: forked.remote,
    visibility: 'private',
    default_branch: forked.defaultBranch ?? parent.default_branch,
    description: `Fork of ${parent.owner_login}/${parent.name}`,
    fork_parent_id: parent.id,
  });
  return { ok: true, value: row };
}

export async function deleteRepo(
  env: Env,
  repo: RepoRow,
): Promise<ServiceResult<{ deleted: true }>> {
  try {
    await env.ARTIFACTS.delete(repo.artifacts_name);
  } catch (err) {
    return { ok: false, status: 502, error: `Artifacts delete failed: ${String(err)}`, code: 'ARTIFACTS_UNAVAILABLE' };
  }
  // One batch: the repo row with its workspace, change and snapshot rows,
  // returning the tarball keys. Those rows reference the repo (and workspaces
  // their change sets), so they go first.
  const before = [
    ...compositionCleanupStatements(env.DB, repo.id),
    ...arenaCleanupStatements(env.DB, repo.id),
    ...workspaceCleanupStatements(env.DB, repo.id),
    ...changeCleanupStatements(env.DB, repo.id),
    ...issueCleanupStatements(env.DB, repo.id),
    ...historyCleanupStatements(env.DB, repo.id),
  ];
  const results = await env.DB.batch<{ r2_key: string }>([
    ...before,
    deleteRepoRowStatement(env.DB, repo.id),
    ...snapshotCleanupStatements(env.DB, repo.id),
  ]);
  const keys = results[before.length + 1];
  await purgeGitTokens(repo.artifacts_name);
  try {
    await deleteSnapshotObjects(env, (keys?.results ?? []).map((r) => r.r2_key));
  } catch (err) {
    // The repo is gone either way; leftover tarballs are unreachable.
    console.log(JSON.stringify({ snapshotCleanupFailed: repo.id, error: String(err).slice(0, 200) }));
  }
  return { ok: true, value: { deleted: true } };
}

/** Visibility or description update; returns the fresh row. */
export async function updateRepo(
  env: Env,
  repo: RepoRow,
  patch: { description?: string; visibility?: 'public' | 'private' },
): Promise<RepoRow> {
  const stmts: D1PreparedStatement[] = [];
  if (typeof patch.description === 'string') {
    stmts.push(
      env.DB.prepare('UPDATE repos SET description = ? WHERE id = ?').bind(patch.description.slice(0, 500), repo.id),
    );
  }
  if (patch.visibility === 'public' || patch.visibility === 'private') {
    stmts.push(env.DB.prepare('UPDATE repos SET visibility = ? WHERE id = ?').bind(patch.visibility, repo.id));
  }
  stmts.push(env.DB.prepare('SELECT * FROM repos WHERE id = ?').bind(repo.id));
  const results = await env.DB.batch<RepoRow>(stmts);
  return results[results.length - 1]?.results?.[0] ?? repo;
}
