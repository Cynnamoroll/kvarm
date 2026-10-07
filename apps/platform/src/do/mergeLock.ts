/**
 * Serializes merges per repository. Merges run in a Workflow (M5); this DO
 * exists so concurrent agent pushes can't interleave merge commits and so
 * the merge queue has a single wait point.
 */

export class MergeLock {
  constructor(private state: DurableObjectState, _env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const key = url.pathname === '/acquire' ? 'repo' : null;
    if (!key) return new Response('not found', { status: 404 });

    const holder = (await this.state.storage.get<string>('holder')) ?? null;
    if (request.method === 'POST' && url.pathname === '/acquire') {
      if (holder) {
        return Response.json({ locked: true, holder });
      }
      const body = (await request.json().catch(() => ({}))) as { holder?: string };
      await this.state.storage.put('holder', body.holder ?? crypto.randomUUID());
      return Response.json({ locked: false });
    }
    if (request.method === 'POST' && url.pathname === '/release') {
      await this.state.storage.delete('holder');
      return Response.json({ released: true });
    }
    return new Response('not found', { status: 404 });
  }
}
