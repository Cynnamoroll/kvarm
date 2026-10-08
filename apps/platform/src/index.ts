import { Hono } from 'hono';
import { GIT_PATH_RE, handleGitRequest } from './routes/git';
import { authRoutes } from './routes/auth';
import { api } from './routes/api';
import { web } from './routes/web';
import { repoPages } from './routes/repoPages';
import { installFetchMeter, serveMetered } from './cost/meter';

export { TokenCache, RateLimiter, RealtimeHub, MergeLock } from './do';
export { SnapshotBuilder, CiPipeline, MergeWorkflow, RepoImport } from './workflows';

installFetchMeter();

const app = new Hono<{ Bindings: Env }>();

// Git smart HTTP gate. Mounted before every other route: paths like
// /{owner}/{repo}(.git)/info/refs are unambiguously git traffic; everything
// else falls through to web/API routes.
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const m = url.pathname.match(GIT_PATH_RE);
  if (m) {
    const [, owner, name, subpath] = m as unknown as [string, string, string, string];
    return handleGitRequest(c, owner, name, subpath);
  }
  return next();
});

app.get('/healthz', (c) => c.text('ok'));

// Static assets are served ahead of web routes (web's /:owner/:repo
// catch-all would otherwise swallow /assets/*).
app.use('/assets/*', async (c, next) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status !== 404) return res;
  return next();
});

app.route('/auth', authRoutes);
app.route('/api/v1', api);
app.route('/', web);
// Repo pages mount after the generic web routes: /new-repo, /import-repo and
// /settings/tokens are two-segment paths that must win over /:owner/:repo.
app.route('/:owner/:repo', repoPages);

// Static assets (public/*) as the final fallback.
app.all('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status === 404) {
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
  return res;
});

export default {
  // Every response carries x-forge-cost (src/cost/meter.ts).
  fetch: (request, env, ctx) => serveMetered(request, env, ctx, app.fetch),
  async queue(batch: MessageBatch<unknown>, _env: Env, _ctx: ExecutionContext) {
    // Artifacts event subscription delivers here (wired in M4).
    for (const message of batch.messages) {
      message.ack();
    }
  },
} satisfies ExportedHandler<Env>;
