// Guided review keyboard flow: j/k move between units, a marks the focused unit
// reviewed without a page load. The page works without this script.
const root = document.querySelector('.rv-root');
if (root) {
  const units = () => [...document.querySelectorAll('.rv-unit')];
  let current = -1;
  const focus = (i) => {
    const list = units();
    if (!list.length) return;
    current = Math.max(0, Math.min(list.length - 1, i));
    list.forEach((u) => u.classList.remove('focus'));
    const u = list[current];
    u.classList.add('focus');
    u.focus({ preventScroll: true });
    u.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const nextUnacked = () => {
    const list = units();
    const i = list.findIndex((u, idx) => idx > current && !u.classList.contains('acked'));
    focus(i === -1 ? current + 1 : i);
  };
  const ack = async (unit) => {
    const form = unit.querySelector('form.rv-ack');
    const button = form && form.querySelector('button');
    if (!form || !button || button.disabled) return;
    button.disabled = true;
    const res = await fetch(form.action, { method: 'POST', body: new FormData(form), headers: { 'x-kvarm-fetch': '1' } });
    if (!res.ok) {
      button.disabled = false;
      form.submit();
      return;
    }
    unit.classList.add('acked');
    button.textContent = 'Reviewed';
    const progress = document.querySelector('.rv-progress');
    if (progress) {
      const total = Number(progress.dataset.total) || 0;
      const done = document.querySelectorAll('.rv-unit.acked').length;
      progress.querySelector('.n').textContent = String(done);
      progress.querySelector('.bar > span').style.width = `${total ? Math.round((done / total) * 100) : 100}%`;
    }
  };
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.classList.contains('rv-ack')) return;
    const unit = form.closest('.rv-unit');
    if (!unit) return;
    e.preventDefault();
    ack(unit);
  });
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.metaKey || e.ctrlKey || e.altKey || (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
    if (e.key === 'j') focus(current + 1);
    else if (e.key === 'k') focus(current - 1);
    else if (e.key === 'a' && current >= 0) {
      const u = units()[current];
      if (u) ack(u).then(nextUnacked);
    } else return;
    e.preventDefault();
  });
}
