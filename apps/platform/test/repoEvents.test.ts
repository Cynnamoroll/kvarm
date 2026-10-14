import { env as cfEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const env = cfEnv as unknown as Env;

function stub() {
  return env.REPO_EVENTS.get(env.REPO_EVENTS.idFromName(crypto.randomUUID()));
}

async function publish(target: ReturnType<typeof stub>, type: string): Promise<void> {
  const response = await target.fetch('https://repo-events/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type }),
  });
  expect(response.status).toBe(200);
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true }));
}

describe('RepoEvents', () => {
  it('reads cursor events in order and caps history at 200', async () => {
    const target = stub();
    await publish(target, 'first');
    await publish(target, 'second');
    const fromZero = await target.fetch('https://repo-events/since?seq=0');
    expect(await fromZero.json()).toMatchObject({
      events: [{ seq: 1, type: 'first' }, { seq: 2, type: 'second' }],
      seq: 2,
    });
    const fromOne = await target.fetch('https://repo-events/since?seq=1');
    expect(await fromOne.json()).toMatchObject({ events: [{ seq: 2, type: 'second' }], seq: 2 });

    for (let index = 0; index < 203; index += 1) await publish(target, 'ring');
    const response = await target.fetch('https://repo-events/since?seq=0');
    const body = (await response.json()) as { events: Array<{ seq: number }>; seq: number };
    expect(body.events).toHaveLength(200);
    expect(body.events[0]?.seq).toBe(6);
    expect(body.events.at(-1)?.seq).toBe(205);
    expect(body.seq).toBe(205);
  });

  it('uses hibernation sockets for heartbeat, broadcast, and expired-connection closure', async () => {
    const target = stub();
    const response = await target.fetch(
      new Request('https://repo-events/live', {
        headers: {
          Upgrade: 'websocket',
          'x-kvarm-principal': 'user:test',
          'x-kvarm-expires-at': String(Date.now() + 60_000),
        },
      }),
    );
    expect(response.status).toBe(101);
    const socket = (response as Response & { webSocket: WebSocket }).webSocket;
    socket.accept();
    const pong = nextMessage(socket);
    socket.send('ping');
    expect(await pong).toBe('pong');

    const broadcast = nextMessage(socket);
    await publish(target, 'change.updated');
    expect(JSON.parse(await broadcast)).toMatchObject({ seq: 1, type: 'change.updated' });
    socket.close(1000, 'done');

    const expired = await target.fetch(
      new Request('https://repo-events/live', {
        headers: {
          Upgrade: 'websocket',
          'x-kvarm-principal': 'user:expired',
          'x-kvarm-expires-at': '1',
        },
      }),
    );
    const expiredSocket = (expired as Response & { webSocket: WebSocket }).webSocket;
    expiredSocket.accept();
    const closed = new Promise<number>((resolve) => {
      expiredSocket.addEventListener('close', (event) => resolve(event.code), { once: true });
    });
    await publish(target, 'change.updated');
    expect(await closed).toBe(4001);
  });
});
