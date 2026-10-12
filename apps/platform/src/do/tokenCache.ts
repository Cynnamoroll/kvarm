/**
 * Per-(repo, scope) cache of short-lived Artifacts git tokens. Keeps clone
 * paths from re-minting on every request: one binding call per repo per TTL
 * window instead of per clone.
 */

const TTL_SECONDS: Record<'read' | 'write', number> = {
  read: 3600, // 1 hour
  write: 21600, // 6 hours
};

interface TokenEntry {
  token: string;
  expiresAt: number;
}

export class TokenCache {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/token' && request.method === 'POST') {
      const { repo, scope } = (await request.json()) as { repo: string; scope: 'read' | 'write' };
      const ttl = TTL_SECONDS[scope] ?? 3600;
      const key = `token:${repo}:${scope}`;
      const now = Date.now();

      const cached = await this.state.storage.get<TokenEntry>(key);
      if (cached && cached.expiresAt - now > (ttl * 1000) / 4) {
        return Response.json({ token: cached.token });
      }

      try {
        const repoHandle = await this.env.ARTIFACTS.get(repo);
        const minted = await repoHandle.createToken(scope, ttl);
        const parsed = minted.expiresAt ? Date.parse(minted.expiresAt) : NaN;
        const entry: TokenEntry = {
          token: minted.plaintext,
          expiresAt: Number.isNaN(parsed) ? now + ttl * 1000 : parsed,
        };
        await this.state.storage.put(key, entry);
        return Response.json({ token: entry.token });
      } catch (err) {
        // Common cause: repo still importing upstream. Let the caller 503.
        return Response.json({ error: String(err) }, { status: 503 });
      }
    }
    return new Response('not found', { status: 404 });
  }
}
