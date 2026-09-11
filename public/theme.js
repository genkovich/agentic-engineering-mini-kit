// Theme choice, applied before first paint so the page never flashes the wrong colors.
// Stored only in this browser (localStorage); nothing leaves the machine. Three states: follow
// the system (no attribute), or an explicit "dark" / "light" set on <html data-theme>.
(function () {
  const KEY = 'agent-ops-theme';
  const root = document.documentElement;
  let stored = null;
  try { stored = localStorage.getItem(KEY); } catch { /* storage may be unavailable */ }
  if (stored === 'dark' || stored === 'light') root.dataset.theme = stored;

  const systemDark = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const effective = () => root.dataset.theme || (systemDark() ? 'dark' : 'light');

  function describe(button) {
    const chosen = root.dataset.theme;
    button.title = chosen
      ? `Theme: ${chosen}. Click to switch, double-click to follow the system`
      : `Theme: follows your system (${effective()}). Click to switch`;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const button = document.querySelector('[data-theme-toggle]');
    if (!button) return;
    describe(button);
    button.addEventListener('click', () => {
      const next = effective() === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
      describe(button);
    });
    button.addEventListener('dblclick', () => {
      delete root.dataset.theme;
      try { localStorage.removeItem(KEY); } catch { /* ignore */ }
      describe(button);
    });
  });
})();
