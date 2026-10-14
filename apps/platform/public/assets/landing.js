const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function mount(canvas, variant) {
  const context = canvas.getContext('2d');
  if (!context) return;
  let width = 0;
  let height = 0;
  let visible = true;
  const resize = () => {
    const bounds = canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, 2);
    width = bounds.width;
    height = bounds.height;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  };
  const draw = (time) => {
    context.clearRect(0, 0, width, height);
    const nodes = variant === 'field' ? 18 : 30;
    const points = Array.from({ length: nodes }, (_, i) => {
      const angle = (i / nodes) * Math.PI * 2 + time * (i % 2 ? 0.025 : -0.018);
      const radius = 0.16 + ((i * 17) % 31) / 100;
      return {
        x: width * (0.5 + Math.cos(angle) * radius),
        y: height * (0.5 + Math.sin(angle) * radius * 0.72),
      };
    });
    context.lineWidth = 0.6;
    points.forEach((point, i) => {
      const next = points[(i + 3) % points.length];
      context.strokeStyle = 'rgba(169,177,188,.16)';
      context.beginPath();
      context.moveTo(point.x, point.y);
      context.lineTo(next.x, next.y);
      context.stroke();
      context.fillStyle = i % 5 === 0 ? 'rgba(77,141,255,.9)' : 'rgba(233,237,242,.45)';
      context.fillRect(point.x - 1, point.y - 1, 2, 2);
    });
  };
  resize();
  draw(0);
  new ResizeObserver(() => {
    resize();
    draw(0);
  }).observe(canvas);
  new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
  }).observe(canvas);
  if (reducedMotion) return;
  const frame = (time) => {
    if (visible) draw(time / 1000);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

document.querySelectorAll('canvas[data-ambient]').forEach((canvas) => mount(canvas, canvas.dataset.ambient));
