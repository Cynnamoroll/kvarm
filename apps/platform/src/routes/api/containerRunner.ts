/**
 * Container CI runner showcase routes (containers/ciRunnerSandbox.ts). Limited
 * to instance admins with a ci-scoped PAT on a repository they can write,
 * because every run bills a Container. The caller's own bearer token is what
 * the container's runner claims and reports with, the same as `kvarm runner`.
 *
 *   POST   repos/:owner/:repo/ci/container-runs {mode: cold|warm} -> 200 ContainerRunReport
 *   DELETE repos/:owner/:repo/ci/container-runs/snapshot          -> 200 {reset, snapshot}
 */

import { Hono, type Context } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App } from '../api';
import type { RepoRow } from '../../db/repos';

export const containerRunnerApi = new Hono<App>();

async function adminContext(c: Context<App>): Promise<{ repo: RepoRow } | { denied: Response }> {
  const d = await authorizeRoute(c, 'write', { requireActor: true, transport: 'ci' });
  if (!d.ok) return { denied: denyJson(c, d) };
  if (!d.actor || d.actor.agent || d.actor.user.is_admin !== true) {
    return { denied: c.json({ error: 'the container CI runner is limited to instance admins', code: 'ADMIN_REQUIRED' }, 403) };
  }
  if (!c.env.CI_SANDBOX) return { denied: c.json({ error: 'this deployment has no container CI runner', code: 'CONTAINER_UNAVAILABLE' }, 503) };
  return { repo: d.repo };
}

containerRunnerApi.post('/repos/:owner/:repo/ci/container-runs', async (c) => {
  const x = await adminContext(c);
  if ('denied' in x) return x.denied;
  const body: unknown = await c.req.json().catch(() => undefined);
  const mode = body && typeof body === 'object' && !Array.isArray(body) ? (body as { mode?: unknown }).mode : undefined;
  if (mode !== 'cold' && mode !== 'warm') return c.json({ error: 'mode must be cold or warm', code: 'INVALID_MODE' }, 422);
  const header = c.req.header('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return c.json({ error: 'a ci-scoped PAT is required; a browser session cannot be handed to the runner', code: 'PAT_REQUIRED' }, 422);
  const r = await c.env.CI_SANDBOX.getByName(x.repo.id).run({
    mode,
    repo: `${x.repo.owner_login}/${x.repo.name}`,
    baseUrl: new URL(c.req.url).origin,
    token: header.slice('Bearer '.length).trim(),
    runnerId: `container-${mode}-${crypto.randomUUID().slice(0, 8)}`,
  });
  if (!r.ok) return c.json({ error: r.error, code: r.code }, r.status as never);
  return actorJson(c, r.value);
});

containerRunnerApi.delete('/repos/:owner/:repo/ci/container-runs/snapshot', async (c) => {
  const x = await adminContext(c);
  if ('denied' in x) return x.denied;
  return actorJson(c, await c.env.CI_SANDBOX.getByName(x.repo.id).reset());
});
