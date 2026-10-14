const root = document.querySelector('[data-live-repo][data-live-root]');
if (root) {
  const repo = root.dataset.liveRepo;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let socket;
  let seq = 0;
  let retry = 0;
  let failedAt = 0;
  let refreshTimer;
  let reconnectTimer;
  let offlineTimer;
  const status = document.querySelector('[data-live-status]');

  const setStatus = (online) => {
    if (!status) return;
    status.hidden = false;
    status.textContent = online ? 'LIVE' : 'OFFLINE';
    status.dataset.state = online ? 'live' : 'offline';
    status.setAttribute('aria-label', online ? 'Live updates connected' : 'Live updates offline');
  };
  const refresh = async () => {
    const response = await fetch(location.href, { headers: { accept: 'text/html' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`refresh failed: ${response.status}`);
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    root.querySelectorAll('[data-live-region]').forEach((region) => {
      const next = doc.querySelector(`[data-live-region="${CSS.escape(region.dataset.liveRegion)}"]`);
      if (next) region.replaceWith(next);
    });
  };
  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh().catch(() => undefined), reduced ? 0 : 300);
  };
  const readCursor = async () => {
    if (!repo) return;
    const response = await fetch(`/api/v1/repos/${repo}/events?since=${seq}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`cursor failed: ${response.status}`);
    const body = await response.json();
    if (Array.isArray(body.events) && body.events.length) {
      seq = Math.max(seq, ...body.events.map((event) => Number(event.seq) || 0));
      scheduleRefresh();
    }
    seq = Math.max(seq, Number(body.seq) || 0);
  };
  const reconnect = () => {
    clearTimeout(reconnectTimer);
    const delay = Math.min(30000, 500 * 2 ** Math.min(retry, 6)) * (0.75 + Math.random() * 0.5);
    reconnectTimer = setTimeout(connect, delay);
  };
  const connect = async () => {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${scheme}//${location.host}/api/v1/repos/${repo}/live`);
    socket.addEventListener('open', () => {
      clearTimeout(offlineTimer);
      retry = 0;
      failedAt = 0;
      setStatus(true);
      readCursor().catch(() => undefined);
    });
    socket.addEventListener('message', (message) => {
      try {
        const event = JSON.parse(message.data);
        if (Number.isFinite(event.seq)) seq = Math.max(seq, event.seq);
        scheduleRefresh();
      } catch {}
    });
    socket.addEventListener('close', () => {
      if (!failedAt) failedAt = Date.now();
      retry += 1;
      if (status) status.hidden = true;
      clearTimeout(offlineTimer);
      offlineTimer = setTimeout(() => {
        if (failedAt && Date.now() - failedAt > 10000) setStatus(false);
      }, 10001);
      if (Date.now() - failedAt > 10000) setStatus(false);
      readCursor().catch(() => undefined);
      reconnect();
    });
    socket.addEventListener('error', () => socket.close());
  };
  setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) socket.send('ping');
  }, 30000);
  connect();
}
