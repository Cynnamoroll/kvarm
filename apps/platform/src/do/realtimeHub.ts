/**
 * Per-repo/PR websocket fan-out for live updates (pushes, check runs).
 * Uses the hibernation API so idle sockets cost nothing.
 */

export class RealtimeHub {
  constructor(private state: DurableObjectState, _env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 400 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server as WebSocket);
    return new Response(null, { status: 101, webSocket: client as WebSocket });
  }

  /** Broadcast a JSON message to all hibernated sockets on this hub. */
  async broadcast(message: unknown): Promise<void> {
    const sockets = this.state.getWebSockets();
    const payload = JSON.stringify(message);
    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch {
        // dead sockets get reaped automatically
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Minimal protocol: client sends {"type":"ping"} and we pong.
    if (typeof message === 'string' && message.includes('ping')) {
      ws.send('{"type":"pong"}');
    }
  }
}
