const root = document.querySelector('.review-guide-root');
if (root) {
  const rows = () => [...root.querySelectorAll('[data-review-file-row]')];
  let current = -1;
  const focus = (index) => {
    const list = rows();
    if (!list.length) return;
    current = Math.max(0, Math.min(list.length - 1, index));
    list.forEach((row) => row.classList.remove('review-focus'));
    const row = list[current];
    row.classList.add('review-focus');
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (event.metaKey || event.ctrlKey || event.altKey ||
        (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName)))) return;
    if (event.key === 'j') focus(current + 1);
    else if (event.key === 'k') focus(current - 1);
    else if (event.key === 'a' && current >= 0) rows()[current]?.querySelector('form.review-ack-form')?.requestSubmit();
    else return;
    event.preventDefault();
  });
}
