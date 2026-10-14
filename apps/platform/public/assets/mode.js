const root = document.documentElement;
const status = document.getElementById('mode-status');

const set = (mode, announce) => {
  root.dataset.mode = mode;
  try {
    localStorage.setItem('kvarm-mode', mode);
  } catch {}
  document.querySelectorAll('[data-mode-set]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.modeSet === mode));
  });
  const url = new URL(location.href);
  url.searchParams.set('mode', mode);
  history.replaceState(null, '', url);
  if (announce && status) status.textContent = mode === 'agent' ? 'Showing the agent view' : 'Showing the human view';
};

document.querySelectorAll('[data-mode-set]').forEach((button) => {
  button.addEventListener('click', () => set(button.dataset.modeSet, true));
});

set(root.dataset.mode === 'agent' ? 'agent' : 'human', false);

const clock = document.getElementById('ft-clock');
if (clock) {
  const updateClock = () => {
    clock.textContent = new Date().toISOString().slice(11, 19);
  };
  updateClock();
  setInterval(updateClock, 1000);
}
