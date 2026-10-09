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

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; code?: string };

export interface CreateRepoParams {
  ownerLogin: string;
  name: string;
  description?: string | null;
  visibility?: 'public' | 'private';
  defaultBranch?: string;
  /** Set for org repos; personal repos leave it unset. */
  ownerOrgId?: string | null;
}

export async function createRepo(env: Env, p: CreateRepoParams): Promise<ServiceResult<RepoRow>> {
  const name = p.name.trim();
  if (!isValidRepoName(name)) {
    return { ok: false, status: 400, error: 'invalid name (letters, digits, dot, dash, underscore; max 100)' };
  }
  if (await getRepo(env.DB, p.ownerLogin, name)) {
    return { ok: false, status: 409, error: 'you already have a repo with that name' };
  }
  const visibility = p.visibility === 'public' ? 'public' : 'private';
  const defaultBranch = (p.defaultBranch ?? 'main').replace(/[^a-zA-Z0-9._/-]+/g, '-') || 'main';
  const artifactsName = artifactsRepoName(p.ownerLogin, name);

  let created;
  try {
    created = await env.ARTIFACTS.create(artifactsName, {
      description: p.description ?? undefined,
      readOnly: false,
      setDefaultBranch: defaultBranch,
    });
  } catch (err) {
    return { ok: false, status: 502, error: `Artifacts create failed: ${String(err)}` };
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
    return { ok: false, status: 400, error: 'url must be an HTTPS git remote' };
  }
  const name = p.name.trim().replace(/\.git$/, '');
  if (!isValidRepoName(name)) {
    return { ok: false, status: 400, error: 'invalid repo name' };
  }
  if (await getRepo(env.DB, p.ownerLogin, name)) {
    return { ok: false, status: 409, error: 'you already have a repo with that name' };
  }
  const artifactsName = artifactsRepoName(p.ownerLogin, name);

  let imported;
  try {
    imported = await env.ARTIFACTS.import({
      source: { url, branch: p.branch },
      target: { name: artifactsName },
    });
  } catch (err) {
    return { ok: false, status: 502, error: `Artifacts import failed: ${String(err)}` };
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
  const forkName = name.trim();
  if (!isValidRepoName(forkName)) {
    return { ok: false, status: 400, error: 'invalid fork name' };
  }
  if (await getRepo(env.DB, ownerLogin, forkName)) {
    return { ok: false, status: 409, error: 'you already have a repo with that name' };
  }
  const artifactsName = artifactsRepoName(ownerLogin, forkName);
  let forked;
  try {
    const handle = await env.ARTIFACTS.get(parent.artifacts_name);
    forked = await handle.fork(artifactsName, { readOnly: false });
  } catch (err) {
    return { ok: false, status: 502, error: `Artifacts fork failed: ${String(err)}` };
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
    return { ok: false, status: 502, error: `Artifacts delete failed: ${String(err)}` };
  }
  // One batch: the repo row with its change and snapshot rows, returning the
  // tarball keys. Change rows reference the repo, so they go first.
  const changeStmts = changeCleanupStatements(env.DB, repo.id);
  const results = await env.DB.batch<{ r2_key: string }>([
    ...changeStmts,
    deleteRepoRowStatement(env.DB, repo.id),
    ...snapshotCleanupStatements(env.DB, repo.id),
  ]);
  const keys = results[changeStmts.length + 1];
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
