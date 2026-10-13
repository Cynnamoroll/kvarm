/**
 * Fleet pages: repository environments (definitions, builds, rebuilds) and the
 * signed-in user's sandboxes across repositories, with command approvals and
 * the command audit log. SSR only; every mutation is a plain form post that
 * the environments and sandboxes services authorize (architecture §0.6).
 */

import { Hono, type Context } from 'hono';
import { html, raw, timeAgo } from '@kvarm/ui';
import type { RepoRow } from '../db/repos';
import { clientIp, requestCredential, type ApiActor } from './api';
import { layout } from '../web/render';
import { repoPage } from '../render/repoShell';
import { resolveRepoAccess } from '../services/access';
import { getRepo } from '../db/repos';
import * as environments from '../services/environments';
import * as sandboxes from '../services/sandboxes';
import type { EnvironmentBuildView, EnvironmentView } from '../services/environments';
import type { SandboxApprovalView, SandboxCommandView, SandboxView } from '../services/sandboxes';

type App = { Bindings: Env; Variables: { refreshCookies: string[] } };

/** Mounted at `/:owner/:repo`, ahead of the repo page router. */
export const fleetRepoPages = new Hono<App>();
/** Mounted at `/fleet`, ahead of the generic web routes. */
export const fleetPages = new Hono<App>();

const INSTANCES = ['basic', 'standard-1', 'standard-2', 'standard-3', 'standard-4'] as const;

interface Resolved {
  repo: RepoRow;
  viewer: ApiActor | null;
  role: string;
}

function finish(c: Context<App>, res: Response): Response {
  for (const cookie of c.get('refreshCookies') ?? []) res.headers.append('Set-Cookie', cookie);
  return res;
}

function htmlResponse(c: Context<App>, body: string, status = 200): Response {
  return finish(c, new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } }));
}

function notFound(c: Context<App>): Response {
  return finish(c, new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } }));
}

async function resolveRepo(c: Context<App>): Promise<Resolved | null> {
  const owner = c.req.param('owner');
  const name = c.req.param('repo');
  if (!owner || !name) return null;
  const access = await resolveRepoAccess(c.env, {
    owner,
    name,
    need: 'read',
    transport: 'page',
    credential: await requestCredential(c),
    clientIp: clientIp(c),
    rejectedCredentialAsAnonymous: true,
  });
  if (!access.ok) return null;
  return { repo: access.repo, viewer: access.actor, role: access.role };
}

async function sessionActor(c: Context<App>): Promise<ApiActor | null> {
  const credential = await requestCredential(c);
  return credential.kind === 'session' ? credential.actor : null;
}

function sandboxContext(c: Context<App>, repo: RepoRow, actor: ApiActor | null): sandboxes.SandboxContext {
  return {
    env: c.env,
    repo,
    actor,
    origin: new URL(c.req.url).origin,
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  };
}

function repoBase(repo: RepoRow): string {
  return `/${repo.owner_login}/${repo.name}`;
}

function pill(status: string): string {
  return html`<span class="pill pill-${status}">${status}</span>`;
}

function ago(iso: string | null): string {
  return iso ? timeAgo(Date.parse(iso)) : '—';
}

function lines(value: unknown): string[] {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function flash(message: string | undefined, kind: 'ok' | 'err' = 'err'): string {
  return message ? html`<div class="flash ${kind}">${message}</div>` : '';
}

function repoShell(c: Context<App>, resolved: Resolved, title: string, body: string, status = 200): Response {
  const page = repoPage(
    c.env,
    { repo: resolved.repo, ref: resolved.repo.default_branch, tab: 'environments', title },
    resolved.viewer?.user.login ?? null,
    body,
  );
  return htmlResponse(c, page, status);
}

// ---------------------------------------------------------------------------
// Environment form
// ---------------------------------------------------------------------------

interface FormValues {
  name: string;
  baseRef: string;
  instance: string;
  setupScript: string;
  validateScript: string;
  envVars: string;
  allowedHosts: string;
  deny: string;
  approve: string;
  rebuildPaths: string;
  idleMinutes: string;
  maxBuildAgeHours: string;
}

function formValues(env: EnvironmentView | null, defaultBranch: string): FormValues {
  return {
    name: env?.name ?? '',
    baseRef: env?.baseRef ?? defaultBranch,
    instance: env?.instance ?? 'standard-1',
    setupScript: env?.setupScript ?? '',
    validateScript: env?.validateScript ?? '',
    envVars: env ? Object.entries(env.envVars).map(([k, v]) => `${k}=${v}`).join('\n') : '',
    allowedHosts: env ? env.allowedHosts.join('\n') : '',
    deny: env ? env.commandPolicy.deny.join('\n') : '',
    approve: env ? env.commandPolicy.approve.join('\n') : '',
    rebuildPaths: env ? env.rebuildPaths.join('\n') : '',
    idleMinutes: String(env?.idleMinutes ?? 30),
    maxBuildAgeHours: String(env?.maxBuildAgeHours ?? 72),
  };
}

function formInput(form: Record<string, unknown>, creating: boolean): Record<string, unknown> {
  const envVars: Record<string, string> = {};
  for (const line of lines(form.envVars)) {
    const eq = line.indexOf('=');
    if (eq > 0) envVars[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  const input: Record<string, unknown> = {
    baseRef: String(form.baseRef ?? '').trim(),
    instance: String(form.instance ?? 'standard-1'),
    setupScript: String(form.setupScript ?? '').replaceAll('\r\n', '\n'),
    validateScript: String(form.validateScript ?? '').replaceAll('\r\n', '\n'),
    envVars,
    commandPolicy: { deny: lines(form.deny), approve: lines(form.approve) },
    idleMinutes: Number(form.idleMinutes),
    maxBuildAgeHours: Number(form.maxBuildAgeHours),
  };
  // Blank list fields keep the platform defaults instead of clearing them.
  const hosts = lines(form.allowedHosts);
  if (hosts.length > 0 || !creating) input.allowedHosts = hosts;
  const paths = lines(form.rebuildPaths);
  if (paths.length > 0 || !creating) input.rebuildPaths = paths;
  if (creating) {
    input.name = String(form.name ?? '').trim();
    input.os = 'linux';
  }
  return input;
}

function formFromBody(form: Record<string, unknown>): FormValues {
  const s = (key: keyof FormValues) => String(form[key] ?? '');
  return {
    name: s('name'),
    baseRef: s('baseRef'),
    instance: s('instance'),
    setupScript: s('setupScript'),
    validateScript: s('validateScript'),
    envVars: s('envVars'),
    allowedHosts: s('allowedHosts'),
    deny: s('deny'),
    approve: s('approve'),
    rebuildPaths: s('rebuildPaths'),
    idleMinutes: s('idleMinutes'),
    maxBuildAgeHours: s('maxBuildAgeHours'),
  };
}

function environmentForm(action: string, values: FormValues, creating: boolean, error?: string): string {
  const instanceOptions = INSTANCES.map(
    (i) => html`<option value="${i}" ${raw(values.instance === i ? 'selected' : '')}>${i}</option>`,
  ).join('');
  return html`
    ${raw(flash(error))}
    <form method="post" action="${raw(action)}" class="env-form">
      <div class="card">
        <div class="card-title">Basics</div>
        <div class="grid-2">
          <div>
            <label for="name">Name</label>
            ${raw(
              creating
                ? html`<input id="name" name="name" type="text" required pattern="[a-z][a-z0-9-]{0,62}" value="${values.name}" placeholder="default" />`
                : html`<input id="name" type="text" value="${values.name}" disabled />`,
            )}
          </div>
          <div>
            <label for="baseRef">Base branch</label>
            <input id="baseRef" name="baseRef" type="text" required value="${values.baseRef}" />
          </div>
          <div>
            <label for="os">Operating system</label>
            <select id="os" disabled><option>linux (amd64)</option></select>
            <p class="hint">macOS and Windows sandboxes are not available on Cloudflare yet.</p>
          </div>
          <div>
            <label for="instance">Instance</label>
            <select id="instance" name="instance">${raw(instanceOptions)}</select>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Build</div>
        <p class="hint">Runs once per build, never per sandbox. Builds have no credentials or secrets; only validated builds are used.</p>
        <label for="setupScript">Setup script</label>
        <textarea id="setupScript" name="setupScript" rows="8" spellcheck="false" placeholder="npm ci">${values.setupScript}</textarea>
        <label for="validateScript">Validate script</label>
        <textarea id="validateScript" name="validateScript" rows="3" spellcheck="false" placeholder="npm test -- --run">${values.validateScript}</textarea>
        <label for="envVars">Environment variables (KEY=value per line, non-secret)</label>
        <textarea id="envVars" name="envVars" rows="3" spellcheck="false">${values.envVars}</textarea>
        <div class="grid-2">
          <div>
            <label for="rebuildPaths">Rebuild when a push touches (globs, one per line)</label>
            <textarea id="rebuildPaths" name="rebuildPaths" rows="4" spellcheck="false" placeholder="default: lockfiles and .kvarm/**">${values.rebuildPaths}</textarea>
          </div>
          <div>
            <label for="maxBuildAgeHours">Rebuild after (hours)</label>
            <input id="maxBuildAgeHours" name="maxBuildAgeHours" type="number" min="1" max="600" value="${values.maxBuildAgeHours}" />
            <label for="idleMinutes">Sleep sandboxes after idle (minutes)</label>
            <input id="idleMinutes" name="idleMinutes" type="number" min="1" max="360" value="${values.idleMinutes}" />
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Policy</div>
        <label for="allowedHosts">Allowed hosts (globs, one per line; the platform is always reachable)</label>
        <textarea id="allowedHosts" name="allowedHosts" rows="4" spellcheck="false" placeholder="default: npm, PyPI, crates.io and Go module proxies">${values.allowedHosts}</textarea>
        <div class="grid-2">
          <div>
            <label for="deny">Never run (command globs)</label>
            <textarea id="deny" name="deny" rows="3" spellcheck="false" placeholder="rm -rf /*">${values.deny}</textarea>
          </div>
          <div>
            <label for="approve">Needs approval (command globs)</label>
            <textarea id="approve" name="approve" rows="3" spellcheck="false" placeholder="npm publish*">${values.approve}</textarea>
          </div>
        </div>
      </div>
      <p><button class="btn primary" type="submit">${creating ? 'Create environment' : 'Save and rebuild if needed'}</button></p>
    </form>`;
}

// ---------------------------------------------------------------------------
// Repository environment pages
// ---------------------------------------------------------------------------

function buildRow(base: string, env: EnvironmentView, build: EnvironmentBuildView): string {
  const duration =
    build.startedAt && build.finishedAt
      ? `${Math.max(1, Math.round((Date.parse(build.finishedAt) - Date.parse(build.startedAt)) / 1000))}s`
      : '';
  return html`
    <tr>
      <td><a href="${raw(`${base}/environments/${encodeURIComponent(env.name)}/builds/${build.id}`)}">#${build.seq}</a></td>
      <td>${raw(pill(build.status))}</td>
      <td class="muted">${build.reason}</td>
      <td><code>${build.baseSha ? build.baseSha.slice(0, 10) : '—'}</code></td>
      <td class="muted">${duration}</td>
      <td class="muted">${ago(build.createdAt)}</td>
    </tr>`;
}

fleetRepoPages.get('/environments', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  const base = repoBase(resolved.repo);
  const listed = await environments.listEnvironments(c.env, resolved.repo, resolved.viewer);
  if (!listed.ok) return notFound(c);
  const rows = await Promise.all(
    listed.value.map(async (env) => {
      const builds = await environments.listEnvironmentBuilds(c.env, resolved.repo, resolved.viewer, env.id, 1);
      const latest = builds.ok ? builds.value[0] : undefined;
      const state = env.readyBuildId ? 'ready' : latest?.status ?? 'queued';
      return html`
        <div class="env-row">
          <div>
            <a href="${raw(`${base}/environments/${encodeURIComponent(env.name)}`)}"><strong>${env.name}</strong></a>
            ${raw(pill(state))}
            ${raw(latest && latest.status !== 'ready' && latest.status !== 'superseded' && env.readyBuildId ? html` <span class="muted">build #${latest.seq} ${latest.status}</span>` : '')}
            <div class="muted small">${env.os} · ${env.instance} · from <code>${env.baseRef}</code> · updated ${ago(env.updatedAt)}</div>
          </div>
        </div>`;
    }),
  );
  const isAdmin = resolved.role === 'admin' && resolved.viewer !== null && !resolved.viewer.agent;
  const body = html`
    <div class="section-head">
      <div>
        <h2>Environments</h2>
        <p class="muted">Prebuilt Linux sandboxes for agents. Setup runs once per build; every sandbox starts from the last validated build and resumes where it left off.</p>
      </div>
      ${raw(isAdmin ? html`<a class="btn primary" href="${raw(`${base}/environments/new`)}">New environment</a>` : '')}
    </div>
    <div class="card">
      ${raw(rows.join('') || html`<p class="muted">No environments yet.${isAdmin ? ' Create one to give agents a ready-to-use cloud sandbox for this repository.' : ''}</p>`)}
    </div>
    <div class="card">
      <div class="card-title">Using a sandbox from any agent</div>
      <p class="muted">Agents call <code>start_sandbox</code> over MCP (or <code>POST /api/v1/repos/${resolved.repo.owner_login}/${resolved.repo.name}/sandboxes</code>), then <code>exec_sandbox</code>, <code>read_sandbox_file</code> and <code>write_sandbox_file</code>. Running sandboxes are listed on your <a href="/fleet">Fleet</a> page.</p>
    </div>`;
  return repoShell(c, resolved, `Environments · ${resolved.repo.owner_login}/${resolved.repo.name}`, body);
});

fleetRepoPages.get('/environments/new', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved || resolved.role !== 'admin' || !resolved.viewer) return notFound(c);
  const base = repoBase(resolved.repo);
  const body = html`
    <h2>New environment</h2>
    ${raw(environmentForm(`${base}/environments`, formValues(null, resolved.repo.default_branch), true))}`;
  return repoShell(c, resolved, 'New environment', body);
});

fleetRepoPages.post('/environments', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved || !resolved.viewer) return notFound(c);
  const form = (await c.req.parseBody()) as Record<string, unknown>;
  const created = await environments.createEnvironment(
    { env: c.env, repo: resolved.repo, actor: resolved.viewer },
    formInput(form, true) as unknown as environments.CreateEnvironmentInput,
  );
  const base = repoBase(resolved.repo);
  if (!created.ok) {
    const body = html`<h2>New environment</h2>${raw(environmentForm(`${base}/environments`, formFromBody(form), true, created.error))}`;
    return repoShell(c, resolved, 'New environment', body, created.status === 403 ? 403 : 422);
  }
  return finish(c, c.redirect(`${base}/environments/${encodeURIComponent(created.value.environment.name)}`));
});

async function loadEnvironment(c: Context<App>): Promise<{ resolved: Resolved; env: EnvironmentView } | null> {
  const resolved = await resolveRepo(c);
  if (!resolved) return null;
  const listed = await environments.listEnvironments(c.env, resolved.repo, resolved.viewer);
  if (!listed.ok) return null;
  const env = listed.value.find((e) => e.name === c.req.param('name'));
  return env ? { resolved, env } : null;
}

fleetRepoPages.get('/environments/:name', async (c) => {
  const loaded = await loadEnvironment(c);
  if (!loaded) return notFound(c);
  const { resolved, env } = loaded;
  const base = repoBase(resolved.repo);
  const envBase = `${base}/environments/${encodeURIComponent(env.name)}`;
  const builds = await environments.listEnvironmentBuilds(c.env, resolved.repo, resolved.viewer, env.id, 20);
  const buildList = builds.ok ? builds.value : [];
  const ready = buildList.find((b) => b.id === env.readyBuildId);
  const latest = buildList[0];
  const isAdmin = resolved.role === 'admin' && resolved.viewer !== null && !resolved.viewer.agent;
  const notice = c.req.query('rebuilt') ? flash('Rebuild requested.', 'ok') : '';
  const body = html`
    ${raw(notice)}
    <div class="section-head">
      <div>
        <h2>${env.name} ${raw(pill(env.readyBuildId ? 'ready' : latest?.status ?? 'queued'))}</h2>
        <p class="muted">${env.os} · ${env.instance} · from <code>${env.baseRef}</code>${env.pending ? ' · another build is queued' : ''}${latest && ready && latest.seq > ready.seq ? ` · latest build #${latest.seq} ${latest.status}` : ''}</p>
      </div>
      ${raw(
        isAdmin
          ? html`<div class="actions">
              <form method="post" action="${raw(`${envBase}/rebuild`)}"><button class="btn" type="submit">Rebuild</button></form>
              <a class="btn" href="${raw(`${envBase}/edit`)}">Edit</a>
            </div>`
          : '',
      )}
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-label">Serving build</div><div class="stat-value">${ready ? `#${ready.seq}` : '—'}</div><div class="muted small">${ready ? `${ready.baseSha?.slice(0, 10) ?? ''} · ${ago(ready.finishedAt)}` : 'no validated build yet'}</div></div>
      <div class="stat"><div class="stat-label">Rebuilds</div><div class="stat-value">${env.rebuildPaths.length}</div><div class="muted small">path globs · every ${env.maxBuildAgeHours}h</div></div>
      <div class="stat"><div class="stat-label">Egress</div><div class="stat-value">${env.allowedHosts.length}</div><div class="muted small">allowed hosts</div></div>
      <div class="stat"><div class="stat-label">Policy</div><div class="stat-value">${env.commandPolicy.deny.length} / ${env.commandPolicy.approve.length}</div><div class="muted small">denied / need approval</div></div>
    </div>
    <div class="card">
      <div class="card-title">Builds</div>
      ${raw(
        buildList.length
          ? html`<table class="table"><thead><tr><th>Build</th><th>Status</th><th>Reason</th><th>Commit</th><th>Took</th><th>Created</th></tr></thead>
              <tbody>${raw(buildList.map((b) => buildRow(base, env, b)).join(''))}</tbody></table>`
          : html`<p class="muted">No builds yet.</p>`,
      )}
    </div>
    <div class="card">
      <div class="card-title">Setup</div>
      <pre><code>${env.setupScript || '# no setup script'}</code></pre>
      ${raw(env.validateScript ? html`<div class="card-title">Validate</div><pre><code>${env.validateScript}</code></pre>` : '')}
    </div>
    ${raw(
      isAdmin
        ? html`<div class="card">
            <div class="card-title">Archive</div>
            <p class="muted">Archived environments stop rebuilding and cannot start new sandboxes.</p>
            <form method="post" action="${raw(`${envBase}/archive`)}" onsubmit="return confirm('Archive this environment?')"><button class="btn danger" type="submit">Archive environment</button></form>
          </div>`
        : '',
    )}`;
  return repoShell(c, resolved, `${env.name} · Environments`, body);
});

fleetRepoPages.get('/environments/:name/edit', async (c) => {
  const loaded = await loadEnvironment(c);
  if (!loaded || loaded.resolved.role !== 'admin' || !loaded.resolved.viewer) return notFound(c);
  const { resolved, env } = loaded;
  const envBase = `${repoBase(resolved.repo)}/environments/${encodeURIComponent(env.name)}`;
  const body = html`<h2>Edit ${env.name}</h2>${raw(environmentForm(envBase, formValues(env, resolved.repo.default_branch), false))}`;
  return repoShell(c, resolved, `Edit ${env.name}`, body);
});

fleetRepoPages.post('/environments/:name', async (c) => {
  const loaded = await loadEnvironment(c);
  if (!loaded || !loaded.resolved.viewer) return notFound(c);
  const { resolved, env } = loaded;
  const envBase = `${repoBase(resolved.repo)}/environments/${encodeURIComponent(env.name)}`;
  const form = (await c.req.parseBody()) as Record<string, unknown>;
  const updated = await environments.updateEnvironment(
    { env: c.env, repo: resolved.repo, actor: resolved.viewer },
    env.id,
    formInput(form, false) as environments.UpdateEnvironmentInput,
  );
  if (!updated.ok) {
    const values = { ...formFromBody(form), name: env.name };
    const body = html`<h2>Edit ${env.name}</h2>${raw(environmentForm(envBase, values, false, updated.error))}`;
    return repoShell(c, resolved, `Edit ${env.name}`, body, updated.status === 403 ? 403 : 422);
  }
  return finish(c, c.redirect(envBase));
});

fleetRepoPages.post('/environments/:name/rebuild', async (c) => {
  const loaded = await loadEnvironment(c);
  if (!loaded || !loaded.resolved.viewer) return notFound(c);
  const { resolved, env } = loaded;
  const result = await environments.rebuildEnvironment({ env: c.env, repo: resolved.repo, actor: resolved.viewer }, env.id);
  if (!result.ok) return notFound(c);
  return finish(c, c.redirect(`${repoBase(resolved.repo)}/environments/${encodeURIComponent(env.name)}?rebuilt=1`));
});

fleetRepoPages.post('/environments/:name/archive', async (c) => {
  const loaded = await loadEnvironment(c);
  if (!loaded || !loaded.resolved.viewer) return notFound(c);
  const { resolved, env } = loaded;
  const result = await environments.archiveEnvironment({ env: c.env, repo: resolved.repo, actor: resolved.viewer }, env.id);
  if (!result.ok) return notFound(c);
  return finish(c, c.redirect(`${repoBase(resolved.repo)}/environments`));
});

fleetRepoPages.get('/environments/:name/builds/:build', async (c) => {
  const loaded = await loadEnvironment(c);
  if (!loaded) return notFound(c);
  const { resolved, env } = loaded;
  const result = await environments.getEnvironmentBuild(c.env, resolved.repo, resolved.viewer, env.id, c.req.param('build'));
  if (!result.ok) return notFound(c);
  const build = result.value;
  const phases = Object.entries(build.phases)
    .map(([name, ms]) => html`<span class="phase"><span class="muted">${name}</span> ${(ms / 1000).toFixed(1)}s</span>`)
    .join('');
  const envBase = `${repoBase(resolved.repo)}/environments/${encodeURIComponent(env.name)}`;
  const body = html`
    <p><a href="${raw(envBase)}">← ${env.name}</a></p>
    <h2>Build #${build.seq} ${raw(pill(build.status))}</h2>
    <p class="muted">${build.reason} · commit <code>${build.baseSha ?? '—'}</code> · created ${ago(build.createdAt)}${build.attempt > 1 ? ` · attempt ${build.attempt}` : ''}</p>
    ${raw(build.error ? flash(build.error) : '')}
    ${raw(phases ? html`<div class="phases">${raw(phases)}</div>` : '')}
    <div class="card">
      <div class="card-title">Output</div>
      <pre class="log"><code>${build.outputTail || 'No output yet.'}</code></pre>
    </div>`;
  return repoShell(c, resolved, `Build #${build.seq} · ${env.name}`, body);
});

// ---------------------------------------------------------------------------
// Sandboxes
// ---------------------------------------------------------------------------

function commandRow(command: SandboxCommandView): string {
  const exit =
    command.policy === 'denied'
      ? pill('denied')
      : command.exitCode === null
        ? pill('pending')
        : command.exitCode === 0
          ? html`<span class="pill pill-ready">exit 0</span>`
          : html`<span class="pill pill-failed">exit ${command.exitCode}</span>`;
  const output = `${command.stdoutTail}${command.stderrTail}`;
  return html`
    <details class="cmd">
      <summary>
        ${raw(exit)}
        <code>${command.command}</code>
        <span class="spacer"></span>
        <span class="muted small">${command.actor} · ${(command.durationMs / 1000).toFixed(1)}s · ${ago(command.createdAt)}</span>
      </summary>
      <pre class="log"><code>${output || 'No output.'}</code></pre>
    </details>`;
}

fleetRepoPages.get('/sandboxes/:id', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved || !resolved.viewer) return notFound(c);
  const id = c.req.param('id');
  const found = await sandboxes.getSandbox(c.env, resolved.repo, resolved.viewer, id);
  if (!found.ok) return notFound(c);
  const sandbox = found.value;
  const commands = await sandboxes.listSandboxCommands(c.env, resolved.repo, resolved.viewer, id, 100);
  const commandList = commands.ok ? commands.value : [];
  const live = sandbox.status === 'running' || sandbox.status === 'sleeping' || sandbox.status === 'starting';
  const body = html`
    <p><a href="/fleet">← Fleet</a></p>
    <div class="section-head">
      <div>
        <h2><code>${sandbox.id.slice(0, 8)}</code> ${raw(pill(sandbox.status))}</h2>
        <p class="muted">${sandbox.environmentName ?? ''} · ${sandbox.task ?? 'no task'} · started ${ago(sandbox.createdAt)} · active ${ago(sandbox.lastActiveAt)}</p>
      </div>
      ${raw(live ? stopForms(`${repoBase(resolved.repo)}/sandboxes/${sandbox.id}`, sandbox.status) : '')}
    </div>
    ${raw(sandbox.error ? flash(sandbox.error) : '')}
    <div class="stats">
      <div class="stat"><div class="stat-label">Branch</div><div class="stat-value small"><code>${(sandbox.workspaceRef ?? '').replace('refs/heads/', '')}</code></div></div>
      <div class="stat"><div class="stat-label">Directory</div><div class="stat-value small"><code>${sandbox.repoDirectory ?? ''}</code></div></div>
      <div class="stat"><div class="stat-label">Kept until</div><div class="stat-value small">${new Date(sandbox.expiresAt).toISOString().slice(0, 10)}</div></div>
    </div>
    <div class="card">
      <div class="card-title">Commands</div>
      ${raw(commandList.map(commandRow).join('') || html`<p class="muted">No commands yet.</p>`)}
    </div>`;
  return repoShell(c, resolved, `Sandbox ${sandbox.id.slice(0, 8)}`, body);
});

function stopForms(action: string, status: string): string {
  return html`<div class="actions">
    ${raw(status === 'running' ? html`<form method="post" action="${raw(`${action}/stop`)}"><button class="btn" type="submit">Sleep</button></form>` : '')}
    <form method="post" action="${raw(`${action}/discard`)}" onsubmit="return confirm('Discard this sandbox and its saved state?')"><button class="btn danger" type="submit">Discard</button></form>
  </div>`;
}

async function stopFromPage(c: Context<App>, discard: boolean): Promise<Response> {
  const resolved = await resolveRepo(c);
  if (!resolved || !resolved.viewer) return notFound(c);
  const result = await sandboxes.stopSandbox(sandboxContext(c, resolved.repo, resolved.viewer), c.req.param('id') ?? '', { discard });
  if (!result.ok) return notFound(c);
  const back = c.req.header('referer');
  return finish(c, c.redirect(back && new URL(back).origin === new URL(c.req.url).origin ? back : '/fleet'));
}

fleetRepoPages.post('/sandboxes/:id/stop', (c) => stopFromPage(c, false));
fleetRepoPages.post('/sandboxes/:id/discard', (c) => stopFromPage(c, true));

// ---------------------------------------------------------------------------
// Fleet dashboard
// ---------------------------------------------------------------------------

function sandboxRow(sandbox: SandboxView): string {
  const href = `/${sandbox.repo}/sandboxes/${sandbox.id}`;
  return html`
    <tr>
      <td><a href="${raw(href)}"><code>${sandbox.id.slice(0, 8)}</code></a></td>
      <td>${raw(pill(sandbox.status))}</td>
      <td><a href="${raw(`/${sandbox.repo}`)}">${sandbox.repo}</a> <span class="muted">· ${sandbox.environmentName ?? ''}</span></td>
      <td class="muted ellipsis">${sandbox.task ?? ''}</td>
      <td class="muted">${ago(sandbox.lastActiveAt)}</td>
      <td class="right">${raw(sandbox.status === 'stopped' || sandbox.status === 'failed' ? '' : stopForms(`/${sandbox.repo}/sandboxes/${sandbox.id}`, sandbox.status))}</td>
    </tr>`;
}

function approvalRow(approval: SandboxApprovalView & { repo?: string }): string {
  return html`
    <div class="approval">
      <div>
        <code>${approval.command}</code>
        <div class="muted small">${approval.repo ?? ''} · sandbox <a href="${raw(`/${approval.repo ?? ''}/sandboxes/${approval.sandboxId}`)}"><code>${approval.sandboxId.slice(0, 8)}</code></a> · ${ago(approval.createdAt)}</div>
      </div>
      <div class="actions">
        <form method="post" action="/fleet/approvals/${approval.id}">
          <input type="hidden" name="repo" value="${approval.repo ?? ''}" />
          <button class="btn primary" name="decision" value="approve" type="submit">Approve</button>
          <button class="btn" name="decision" value="deny" type="submit">Deny</button>
        </form>
      </div>
    </div>`;
}

fleetPages.get('/', async (c) => {
  const actor = await sessionActor(c);
  if (!actor) return finish(c, c.redirect('/auth/sign-in?returnTo=%2Ffleet'));
  const [mine, approvals] = await Promise.all([
    sandboxes.listMySandboxes(c.env, actor, { limit: 100 }),
    sandboxes.listMyPendingApprovals(c.env, actor),
  ]);
  const all = mine.ok ? mine.value.sandboxes : [];
  const pending = approvals.ok ? approvals.value : [];
  const count = (status: string) => all.filter((s) => s.status === status).length;
  const active = all.filter((s) => s.status !== 'stopped' && s.status !== 'failed');
  const ended = all.filter((s) => s.status === 'stopped' || s.status === 'failed').slice(0, 20);
  const table = (rows: SandboxView[]) =>
    html`<table class="table"><thead><tr><th>Sandbox</th><th>Status</th><th>Repository</th><th>Task</th><th>Active</th><th></th></tr></thead>
      <tbody>${raw(rows.map(sandboxRow).join(''))}</tbody></table>`;
  const body = html`
    <div class="section-head">
      <div>
        <h2>Fleet</h2>
        <p class="muted">Cloud sandboxes your agents run in, across all repositories. Sleeping sandboxes resume with their files, dependencies and caches intact.</p>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-label">Running</div><div class="stat-value">${count('running') + count('starting')}</div></div>
      <div class="stat"><div class="stat-label">Sleeping</div><div class="stat-value">${count('sleeping')}</div></div>
      <div class="stat"><div class="stat-label">Awaiting approval</div><div class="stat-value">${pending.length}</div></div>
    </div>
    ${raw(
      pending.length
        ? html`<div class="card"><div class="card-title">Awaiting your approval</div>${raw(pending.map(approvalRow).join(''))}</div>`
        : '',
    )}
    <div class="card">
      <div class="card-title">Active sandboxes</div>
      ${raw(active.length ? table(active) : html`<p class="muted">No active sandboxes. Agents start one with <code>start_sandbox</code> from any repository that has an environment.</p>`)}
    </div>
    ${raw(ended.length ? html`<div class="card"><div class="card-title">Recently ended</div>${raw(table(ended))}</div>` : '')}`;
  return htmlResponse(c, layout(c.env, { title: 'Fleet', userLogin: actor.user.login }, body));
});

fleetPages.post('/approvals/:id', async (c) => {
  const actor = await sessionActor(c);
  if (!actor) return finish(c, c.redirect('/auth/sign-in?returnTo=%2Ffleet'));
  const form = (await c.req.parseBody()) as Record<string, unknown>;
  const [owner, name] = String(form.repo ?? '').split('/');
  if (!owner || !name) return notFound(c);
  const repo = await getRepo(c.env.DB, owner, name);
  if (!repo) return notFound(c);
  const decision = form.decision === 'approve' ? 'approve' : 'deny';
  await sandboxes.decideSandboxApproval(sandboxContext(c, repo, actor), c.req.param('id'), decision);
  return finish(c, c.redirect('/fleet'));
});
