import { Hono } from 'hono';
import { GIT_PATH_RE, handleGitRequest } from './routes/git';

export { TokenCache, RateLimiter, RealtimeHub, MergeLock } from './do';
export { SnapshotBuilder, CiPipeline, MergeWorkflow, RepoImport } from './workflows';

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

// Everything else falls through to static assets (public/). Web SSR routes
// get mounted here in M2.
app.all('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  return res;
});

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, _env: Env, _ctx: ExecutionContext) {
    // Artifacts event subscription delivers here (wired in M4).
    for (const message of batch.messages) {
      message.ack();
    }
  },
} satisfies ExportedHandler<Env>;
