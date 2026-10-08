/** Repo registry queries. Git objects live in Artifacts; metadata lives in D1. */

export type Visibility = 'public' | 'private';

export interface RepoRow {
  id: string;
  owner_login: string;
  name: string;
  artifacts_name: string;
  artifacts_remote: string;
  visibility: Visibility;
  default_branch: string;
  description: string | null;
  fork_parent_id: string | null;
  stars: number;
  created_at: number;
  pushed_at: number | null;
  /** Owning organization for org repos; null (or absent in older cached rows) for personal repos. */
  owner_org_id?: string | null;
}

export interface NewRepo {
  owner_login: string;
  name: string;
  artifacts_name: string;
  artifacts_remote: string;
  visibility: Visibility;
  default_branch: string;
  description: string | null;
  fork_parent_id: string | null;
  owner_org_id?: string | null;
}

/** Artifacts namespace is flat; owner/name is encoded deterministically. */
export function artifactsRepoName(owner: string, name: string): string {
  return `${owner.toLowerCase()}--${name.toLowerCase()}`.replace(/[^a-z0-9._-]+/g, '-');
}

export function isValidRepoName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name) && !name.endsWith('.git');
}

export async function createRepoRow(env: Env, data: NewRepo): Promise<RepoRow> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote,
      visibility, default_branch, description, fork_parent_id, stars, created_at, owner_org_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(
      id,
      data.owner_login,
      data.name,
      data.artifacts_name,
      data.artifacts_remote,
      data.visibility,
      data.default_branch,
      data.description,
      data.fork_parent_id,
      now,
      data.owner_org_id ?? null,
    )
    .run();
  return {
    id,
    owner_login: data.owner_login,
    name: data.name,
    artifacts_name: data.artifacts_name,
    artifacts_remote: data.artifacts_remote,
    visibility: data.visibility,
    default_branch: data.default_branch,
    description: data.description,
    fork_parent_id: data.fork_parent_id,
    stars: 0,
    created_at: now,
    pushed_at: null,
    owner_org_id: data.owner_org_id ?? null,
  };
}

export async function getRepo(
  db: D1Database,
  owner: string,
  name: string,
): Promise<RepoRow | null> {
  const row = await db
    .prepare('SELECT * FROM repos WHERE owner_login = ? AND name = ?')
    .bind(owner, name)
    .first<RepoRow>();
  return row ?? null;
}

export async function getRepoById(db: D1Database, id: string): Promise<RepoRow | null> {
  const row = await db.prepare('SELECT * FROM repos WHERE id = ?').bind(id).first<RepoRow>();
  return row ?? null;
}

export async function listReposForOwner(
  db: D1Database,
  owner: string,
  limit = 50,
): Promise<RepoRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM repos WHERE owner_login = ? ORDER BY pushed_at DESC, created_at DESC LIMIT ?')
    .bind(owner, limit)
    .all<RepoRow>();
  return results ?? [];
}

/**
 * Advances pushed_at strictly: it never moves backwards and two pushes within
 * the same millisecond still yield distinct values (it keys cached views).
 */
export async function touchRepoPushed(db: D1Database, id: string, at = Date.now()): Promise<void> {
  await db
    .prepare('UPDATE repos SET pushed_at = MAX(COALESCE(pushed_at, 0) + 1, ?) WHERE id = ?')
    .bind(at, id)
    .run();
}

export async function deleteRepoRow(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM repos WHERE id = ?').bind(id).run();
}
