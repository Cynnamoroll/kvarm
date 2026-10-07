/**
 * Repo-scoped Artifacts git tokens, cached per (repo, scope) in the
 * TokenCache DO. Mints via the Artifacts binding; refreshes at ~25%
 * remaining TTL. Anonymous public reads and PAT-authenticated reads share
 * the same read token since platform authorization already happened.
 */

export async function getGitToken(
  env: Env,
  artifactsName: string,
  scope: 'read' | 'write',
): Promise<string> {
  const id = env.TOKENS.idFromName(`${artifactsName}:${scope}`);
  const stub = env.TOKENS.get(id);
  const res = await stub.fetch('https://token-cache/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: artifactsName, scope }),
  });
  if (!res.ok) {
    throw new Error(`artifacts token mint failed (${res.status})`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}
