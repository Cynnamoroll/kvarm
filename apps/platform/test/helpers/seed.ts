/**
 * Shared seeds and fakes for the workerd tests (the test/helpers convention,
 * alongside fakeArtifacts/fakeWorkOS/memGit). seedUser and seedRepo insert the
 * full production row shape — including pushed_at and owner_org_id — so a new
 * required column lands in one place instead of drifting across copies.
 */

import { commit, FakeRepo, fakeRepos, type Files } from './fakeArtifacts';

/**
 * Workflow binding fake. `create` records every call in `created` and indexes
 * `instances` by id; `failNext`/`creates` script outages and count calls.
 * Strict mode rejects duplicate ids and unknown `get`s, for tests that cover
 * the binding's uniqueness contract.
 */
export class FakeWorkflow {
  created: Array<{ id?: string; params?: unknown }> = [];
  instances = new Map<string, unknown>();
  creates = 0;
  failNext = 0;

  constructor(private readonly strict = false) {}

  async create(opts: { id?: string; params?: unknown }) {
    this.creates++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('simulated workflow outage');
    }
    const id = opts.id ?? crypto.randomUUID();
    if (this.strict && this.instances.has(id)) throw new Error(`instance.already_exists: ${id}`);
    this.created.push(opts);
    this.instances.set(id, opts.params);
    return { id };
  }

  async get(id: string) {
    if (this.strict && !this.instances.has(id)) throw new Error('instance.not_found');
    return { id };
  }
}

/** Events binding for tests that never inspect queue traffic. */
export const fakeEvents = {
  async send() {},
  async sendBatch() {},
};

/** Events binding that records every send for assertions on `sent`. */
export function recordingEvents() {
  const sent: Array<{ body: any; delaySeconds?: number }> = [];
  /** Sends whose body matches reject, as a failing queue would. */
  const failSends: { match: ((body: any) => boolean) | null } = { match: null };
  /** Runs while a send is in flight (before it is recorded). */
  const onSend: { fn: ((body: any) => Promise<void> | void) | null } = { fn: null };
  return {
    sent,
    failSends,
    onSend,
    async send(body: unknown, opts?: { delaySeconds?: number }) {
      if (failSends.match?.(body)) throw new Error('queue send rejected (test)');
      await onSend.fn?.(body);
      sent.push({ body, ...(opts?.delaySeconds !== undefined ? { delaySeconds: opts.delaySeconds } : {}) });
    },
    async sendBatch(msgs: Array<{ body: unknown }>) {
      for (const m of msgs) sent.push({ body: m.body });
    },
  };
}
export type RecordingEvents = ReturnType<typeof recordingEvents>;

export interface SeedUserOptions {
  admin?: boolean;
  email?: string;
  name?: string;
  workosUserId?: string;
  createdAt?: number;
  /** Optional login→id registry the test keeps for itself. */
  userIds?: Record<string, string>;
}

export async function seedUser(env: Env, login: string, opts: SeedUserOptions = {}): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      id,
      opts.workosUserId ?? `test:${login}`,
      login,
      opts.email ?? `${login}@kvarm.invalid`,
      opts.name ?? login,
      opts.admin ? 1 : 0,
      opts.createdAt ?? Date.now(),
    )
    .run();
  if (opts.userIds) opts.userIds[login] = id;
  return id;
}

export interface SeedRepoOptions {
  owner: string;
  visibility: 'public' | 'private';
  defaultBranch?: string;
  createdAt?: number;
  pushedAt?: number | null;
  /** Defaults to the org row matching `owner`, as production writes it. */
  ownerOrgId?: string | null;
  artifactsName?: string;
  artifactsRemote?: string;
  description?: string | null;
  /** Register a FakeRepo under artifactsName (default true); tests that only
   * exercise authorization and never reach the fake remote pass false. */
  register?: boolean;
  /** Optional name→id registry the test keeps for itself. */
  repoIds?: Record<string, string>;
}

export async function seedRepo(env: Env, name: string, opts: SeedRepoOptions): Promise<{ id: string; repo: FakeRepo }> {
  const artifactsName = opts.artifactsName ?? `${opts.owner}--${name}`;
  const repo = new FakeRepo();
  if (opts.register !== false) fakeRepos.set(artifactsName, repo);
  const id = crypto.randomUUID();
  if (opts.repoIds) opts.repoIds[name] = id;
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, description, created_at, pushed_at, owner_org_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT id FROM orgs WHERE login = ?)))`,
  )
    .bind(
      id,
      opts.owner,
      name,
      artifactsName,
      opts.artifactsRemote ?? `https://artifacts.invalid/git/default/${artifactsName}.git`,
      opts.visibility,
      opts.defaultBranch ?? 'main',
      opts.description ?? null,
      opts.createdAt ?? Date.now(),
      opts.pushedAt ?? null,
      opts.ownerOrgId ?? null,
      opts.owner,
    )
    .run();
  return { id, repo };
}

/** seedRepo plus one commit on the default branch; `main` is its sha. */
export async function seedRepoWithCommit(
  env: Env,
  name: string,
  opts: SeedRepoOptions & { files?: Files },
): Promise<{ id: string; repo: FakeRepo; main: string }> {
  const { id, repo } = await seedRepo(env, name, opts);
  const main = await commit(repo, opts.files ?? { 'README.md': 'readme\n' });
  repo.refs.set(`refs/heads/${opts.defaultBranch ?? 'main'}`, main.sha);
  return { id, repo, main: main.sha };
}
