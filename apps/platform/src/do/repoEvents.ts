export interface RepoEvent {
  seq: number;
  type: string;
  at: number;
  changeNumber?: number;
  headSha?: string;
  state?: string;
  ref?: string;
}

interface SocketAttachment {
  principal: string;
  expiresAt: number;
}

const TAG = 'repo-events';
const HISTORY = 'history';
const NEXT = 'next';
const MAX_EVENTS = 200;
const MAX_CONNECTION_MS = 10 * 60 * 1000;

export class RepoEvents implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
  ) {
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/since') {
      const raw = url.searchParams.get('seq') ?? '0';
      const since = Number(raw);
      if (!Number.isSafeInteger(since) || since < 0) return Response.json({ error: 'seq must be a non-negative integer' }, { status: 400 });
      const history = (await this.state.storage.get<RepoEvent[]>(HISTORY)) ?? [];
      const next = (await this.state.storage.get<number>(NEXT)) ?? 0;
      return Response.json({ events: history.filter((event) => event.seq > since), seq: next });
    }
    if (request.method === 'GET' && (url.pathname === '/live' || url.pathname.endsWith('/live'))) return this.handleUpgrade(request);
    if (request.method === 'POST' && url.pathname === '/publish') return this.publish(request);
    return new Response('not found', { status: 404 });
  }

  private async handleUpgrade(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('upgrade required', { status: 426 });
    const principal = request.headers.get('x-kvarm-principal') ?? '';
    const tokenExpiry = Number(request.headers.get('x-kvarm-expires-at') ?? '');
    if (!principal || !Number.isFinite(tokenExpiry)) return new Response('unauthorized', { status: 401 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const now = Date.now();
    server.serializeAttachment({ principal, expiresAt: Math.min(tokenExpiry, now + MAX_CONNECTION_MS) } satisfies SocketAttachment);
    this.state.acceptWebSocket(server, [TAG]);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async publish(request: Request): Promise<Response> {
    const input: unknown = await request.json().catch(() => null);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return Response.json({ error: 'invalid event' }, { status: 400 });
    const fields = input as Record<string, unknown>;
    if (typeof fields.type !== 'string' || fields.type.length === 0 || fields.type.length > 80) {
      return Response.json({ error: 'invalid event type' }, { status: 400 });
    }
    const event = await this.state.storage.transaction(async (storage) => {
      const seq = ((await storage.get<number>(NEXT)) ?? 0) + 1;
      const nextEvent: RepoEvent = { seq, type: fields.type as string, at: Date.now() };
      if (typeof fields.changeNumber === 'number' && Number.isSafeInteger(fields.changeNumber)) nextEvent.changeNumber = fields.changeNumber;
      if (typeof fields.headSha === 'string') nextEvent.headSha = fields.headSha;
      if (typeof fields.state === 'string') nextEvent.state = fields.state;
      if (typeof fields.ref === 'string') nextEvent.ref = fields.ref;
      const history = [...((await storage.get<RepoEvent[]>(HISTORY)) ?? []), nextEvent].slice(-MAX_EVENTS);
      await storage.put(NEXT, seq);
      await storage.put(HISTORY, history);
      return nextEvent;
    });
    for (const socket of this.state.getWebSockets(TAG)) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment || attachment.expiresAt <= Date.now()) {
        socket.close(4001, 'connection expired');
        continue;
      }
      try {
        socket.send(JSON.stringify(event));
      } catch {
        socket.close(1011, 'delivery failed');
      }
    }
    return Response.json({ event });
  }

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {}

  webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {}
}
