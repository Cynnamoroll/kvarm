/** Small runtime config helpers over Env vars. */

export function siteName(env: Env): string {
  return env.SITE_NAME || 'Kvarm';
}

export function appOrigin(env: Env): string {
  return (env.APP_ORIGIN || 'http://localhost:8787').replace(/\/+$/, '');
}

/** Where clone URLs point (same host as the web app, GitHub-style). */
export function cloneBase(env: Env): string {
  return appOrigin(env);
}
