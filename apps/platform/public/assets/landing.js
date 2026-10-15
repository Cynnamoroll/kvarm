const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const dpr = Math.min(devicePixelRatio || 1, 2);

function fit(canvas) {
  const bounds = canvas.getBoundingClientRect();
  canvas.width = Math.round(bounds.width * dpr);
  canvas.height = Math.round(bounds.height * dpr);
  const context = canvas.getContext('2d');
  context?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { context, width: bounds.width, height: bounds.height };
}

function animate(canvas, draw) {
  let visible = true;
  let frame = fit(canvas);
  let time = 0;
  const render = (elapsed) => {
    time += elapsed;
    if (frame.context && frame.width && frame.height) draw(frame, time);
  };
  new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
  }).observe(canvas);
  new ResizeObserver(() => {
    frame = fit(canvas);
    render(0);
  }).observe(canvas);
  render(0);
  if (reduceMotion) return;
  let previous = performance.now();
  const tick = (now) => {
    const elapsed = Math.min(0.05, (now - previous) / 1000);
    previous = now;
    if (visible) render(elapsed);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const intents = [
  { path: 'packages/gitops/', point: [0.3, 0.34] },
  { path: 'apps/platform/', point: [0.46, 0.62] },
  { path: 'packages/ops/', point: [0.2, 0.66] },
  { path: 'apps/cli/', point: [0.55, 0.28] },
  { path: 'docs/', point: [0.36, 0.84] },
  { path: 'packages/ui/', point: [0.6, 0.8] },
];

function swarm(canvas) {
  const agents = Array.from({ length: 180 }, (_, i) => ({
    x: random(),
    y: random(),
    intent: i % intents.length,
    orbit: 14 + random() * random() * 70,
    speed: (0.25 + random() * 0.6) * (random() < 0.5 ? -1 : 1),
    phase: random() * Math.PI * 2,
    radius: random() < 0.08 ? 3 : 1 + random() * 1.4,
  }));
  let elapsed = 0;
  let previous = 0;
  animate(canvas, ({ context, width, height }, time) => {
    const fieldWidth = width * (width > 760 ? 0.68 : 1);
    context.clearRect(0, 0, width, height);
    const centerX = fieldWidth * 0.5;
    const centerY = height * 0.52;
    const radius = Math.min(fieldWidth, height) * 0.44;
    context.lineWidth = 1;
    for (let ring = 0; ring < 5; ring++) {
      context.beginPath();
      context.strokeStyle = `rgba(169,177,188,${0.05 + ring * 0.012})`;
      context.setLineDash(ring % 2 ? [2, 5] : []);
      context.ellipse(centerX, centerY, radius * (1 - ring * 0.04), radius * (0.86 - ring * 0.12), time * 0.03 * (ring % 2 ? 1 : -1) + ring, 0, Math.PI * 2);
      context.stroke();
    }
    context.setLineDash([]);
    const clusters = intents.map((intent, i) => ({
      ...intent,
      x: intent.point[0] * fieldWidth + Math.sin(time * 0.21 + i) * 18,
      y: intent.point[1] * height + Math.cos(time * 0.17 + i * 2) * 14,
      count: 0,
    }));
    const step = (dt) => {
      elapsed += dt;
      for (const agent of agents) {
        const cluster = clusters[agent.intent];
        const angle = agent.phase + elapsed * agent.speed;
        const targetX = (cluster.x + Math.cos(angle) * agent.orbit) / fieldWidth;
        const targetY = (cluster.y + Math.sin(angle) * agent.orbit * 0.8) / height;
        const easing = Math.min(1, dt * 1.6);
        agent.x += (targetX - agent.x) * easing;
        agent.y += (targetY - agent.y) * easing;
      }
    };
    if (time === 0) for (let i = 0; i < 240; i++) step(1 / 30);
    step(Math.max(0, time - previous));
    previous = time;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const distance = Math.hypot(clusters[i].x - clusters[j].x, clusters[i].y - clusters[j].y);
        if (distance < 210) {
          const x = (clusters[i].x + clusters[j].x) / 2;
          const y = (clusters[i].y + clusters[j].y) / 2;
          const alpha = (1 - distance / 210) * 0.55;
          const glow = context.createRadialGradient(x, y, 0, x, y, 120);
          glow.addColorStop(0, `rgba(255,107,74,${alpha * 0.55})`);
          glow.addColorStop(0.45, `rgba(212,85,201,${alpha * 0.22})`);
          glow.addColorStop(1, 'rgba(91,61,245,0)');
          context.fillStyle = glow;
          context.fillRect(x - 120, y - 120, 240, 240);
        }
      }
    }
    for (const agent of agents) clusters[agent.intent].count++;
    context.lineWidth = 0.6;
    for (let i = 0; i < agents.length; i += 2) {
      const agent = agents[i];
      const other = agents[(i * 7 + 3) % agents.length];
      if (agent.intent !== other.intent) continue;
      const x = agent.x * fieldWidth;
      const y = agent.y * height;
      const otherX = other.x * fieldWidth;
      const otherY = other.y * height;
      const distance = Math.hypot(x - otherX, y - otherY);
      if (distance < 90) {
        context.strokeStyle = `rgba(169,177,188,${0.22 * (1 - distance / 90)})`;
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(otherX, otherY);
        context.stroke();
      }
    }
    for (const agent of agents) {
      const x = agent.x * fieldWidth;
      const y = agent.y * height;
      const pulse = 0.6 + 0.4 * Math.sin(time * 2 + agent.phase);
      context.fillStyle = agent.radius > 2.4 ? 'rgba(77,141,255,.9)' : `rgba(233,237,242,${0.35 + pulse * 0.4})`;
      context.fillRect(x - agent.radius / 2, y - agent.radius / 2, agent.radius, agent.radius);
      if (agent.radius > 2.5) {
        context.strokeStyle = 'rgba(233,237,242,.35)';
        context.beginPath();
        context.arc(x, y, 5 + pulse * 2, 0, Math.PI * 2);
        context.stroke();
      }
    }
    context.strokeStyle = 'rgba(77,141,255,.7)';
    context.beginPath();
    context.moveTo(centerX - 8, centerY);
    context.lineTo(centerX + 8, centerY);
    context.moveTo(centerX, centerY - 8);
    context.lineTo(centerX, centerY + 8);
    context.stroke();
    context.font = '10.5px "JetBrains Mono", monospace';
    context.textBaseline = 'middle';
    clusters.forEach((cluster, i) => {
      const labelX = cluster.x + (i % 2 ? 46 : -46);
      const labelY = cluster.y - 34;
      context.strokeStyle = 'rgba(169,177,188,.5)';
      context.beginPath();
      context.moveTo(cluster.x, cluster.y);
      context.lineTo(labelX, labelY);
      context.stroke();
      context.beginPath();
      context.arc(cluster.x, cluster.y, 3, 0, Math.PI * 2);
      context.fillStyle = 'rgba(15,103,245,1)';
      context.fill();
      const label = `example · ${cluster.path}`;
      const labelWidth = context.measureText(label).width;
      const x = Math.max(8, Math.min(fieldWidth - labelWidth - 44, i % 2 ? labelX + 6 : labelX - labelWidth - 48));
      context.fillStyle = 'rgba(233,237,242,.88)';
      context.fillText(label, x, labelY);
      const bars = Math.min(5, Math.round(cluster.count / 7));
      for (let bar = 0; bar < 5; bar++) {
        context.fillStyle = bar < bars ? 'rgba(233,237,242,.85)' : 'rgba(169,177,188,.18)';
        context.fillRect(x + labelWidth + 8 + bar * 6, labelY - 4, 4, 8);
      }
    });
  });
}

function log(list) {
  const events = [
    'Example workspace · packages/gitops/',
    'Example intent · paths declared',
    'Example forecast · possible overlap to review',
    'Example candidates · comparison opened',
    'Example composition · inspect resulting tree',
    'Example checks · exact tree requested',
    'Example decision · reason recorded',
  ];
  let index = 0;
  const append = () => {
    const item = document.createElement('li');
    item.textContent = events[index++ % events.length];
    list.append(item);
    while (list.children.length > 14) list.firstElementChild.remove();
  };
  for (let i = 0; i < events.length; i++) append();
  if (!reduceMotion) setInterval(append, 1800);
}

function term() {
  document.querySelectorAll('[data-term]').forEach((element) => {
    const output = element.querySelector('[data-cmd-out]');
    element.querySelectorAll('[data-cmd]').forEach((button) => button.addEventListener('click', () => {
      element.querySelectorAll('[data-cmd]').forEach((tab) => {
        tab.setAttribute('aria-selected', String(tab === button));
      });
      output.textContent = button.dataset.cmd;
    }));
    element.querySelector('[data-copy]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      try {
        await navigator.clipboard.writeText(output.textContent);
      } catch {}
      button.textContent = 'Copied';
      setTimeout(() => {
        button.textContent = 'Copy';
      }, 1200);
    });
  });
}

function fitText() {
  document.querySelectorAll('.hero-word span, .wordmark-foot').forEach((element) => {
    const parent = element.parentElement;
    const styles = getComputedStyle(parent);
    const box = parent.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
    element.style.fontSize = '100px';
    element.style.display = 'inline-block';
    const width = element.getBoundingClientRect().width;
    element.style.display = '';
    let fontSize = 100 * box / width;
    element.style.fontSize = `${fontSize.toFixed(2)}px`;
    while (element.scrollWidth > box + 1 && fontSize > 10) {
      fontSize *= 0.99;
      element.style.fontSize = `${fontSize.toFixed(2)}px`;
    }
    (element.closest('.hero-word') || element).classList.add('fitted');
  });
}

Promise.all([document.fonts.load('900 100px Archivo'), document.fonts.ready]).then(() => {
  fitText();
  addEventListener('resize', fitText);
  document.fonts.addEventListener('loadingdone', fitText);
  const swarmCanvas = document.getElementById('swarm');
  if (swarmCanvas) swarm(swarmCanvas);
  const eventLog = document.getElementById('log');
  if (eventLog) log(eventLog);
  term();
});
