// The only HTML chrome in the project. Every page is layout(...) around a body string.

export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// Inline SVG is allowed by the CSP (it is markup, not a fetched resource).
// Three log lines of uneven length: the mark reads as "a record", which is what the app shows.
const BRAND_MARK = `<svg viewBox="0 0 22 22" aria-hidden="true"><rect x="1" y="1" width="20" height="20" rx="5" fill="#0f6e6b"/><path d="M6 7.5h10M6 11h6M6 14.5h8" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>`;
const FAVICON = `data:image/svg+xml,${encodeURIComponent(BRAND_MARK)}`;

// Icon set: one hidden sprite per page, referenced by <use>. Every symbol is a 16-unit box
// drawn with 1.5px strokes, so icons read as one family at any size. Add a symbol here and it
// is available to every page through icon(name); never inline a one-off icon in a view.
const ICONS = {
  sessions: '<path d="M3 4.5h10M3 8h6M3 11.5h8"/>',
  calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 7h11M5.5 2v3M10.5 2v3"/>',
  turns: '<path d="M3 6.5h8.5l-2.5-2.5M13 9.5H4.5L7 12"/>',
  tokens: '<path d="M8 2.5l4.8 2.75v5.5L8 13.5l-4.8-2.75v-5.5z"/><path d="M8 2.5v11M3.2 5.25L12.8 10.75M12.8 5.25L3.2 10.75" opacity=".45"/>',
  model: '<rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M6.5 1.5v2.5M9.5 1.5v2.5M6.5 12v2.5M9.5 12v2.5M1.5 6.5H4M1.5 9.5H4M12 6.5h2.5M12 9.5h2.5"/>',
  project: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5H12.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z"/>',
  chart: '<path d="M2.5 13.5h11M4.5 11V7M8 11V4M11.5 11V8.5"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>',
  pencil: '<path d="M3 13l.8-3.2 7.4-7.4a1.3 1.3 0 0 1 1.8 0l.6.6a1.3 1.3 0 0 1 0 1.8L6.2 12.2z"/><path d="M9.8 3.8l2.4 2.4"/>',
  tag: '<path d="M2.5 3.5v4.4l6.1 6.1 5.4-5.4-6.1-6.1H3.5a1 1 0 0 0-1 1z"/><circle cx="5.5" cy="6.5" r=".9"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  moon: '<path d="M13 10.2A5.5 5.5 0 0 1 5.8 3a5.5 5.5 0 1 0 7.2 7.2z"/>',
};

const SPRITE = `<svg hidden aria-hidden="true">${Object.entries(ICONS)
  .map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</symbol>`)
  .join('')}</svg>`;

// icon('tokens') → an inline <svg> that inherits the surrounding text color. Decorative by
// default; pass a label when the icon is the only thing conveying meaning.
export function icon(name, label = '') {
  if (!ICONS[name]) throw new Error(`unknown icon: ${name}`);
  const a11y = label ? ` role="img" aria-label="${esc(label)}"` : ' aria-hidden="true"';
  return `<svg class="icon"${a11y}><use href="#i-${name}"></use></svg>`;
}

// Top-level navigation. A page marks itself current by passing its href as `current`.
const NAV = [{ href: '/', label: 'Dashboard' }];

function renderNav(current) {
  return NAV.map(({ href, label }) => {
    const on = href === current ? ' aria-current="page"' : '';
    return `<a href="${href}"${on}>${esc(label)}</a>`;
  }).join('\n');
}

// `source` and `home` describe what the dashboard is reading; both are optional so a page that
// has nothing to say about the source still renders a complete shell.
export function layout({ title, body, nav = '', head = '', current = '/', source = '', home = '' }) {
  const sourceBadge = source ? `<span class="source">${esc(source)}</span>` : '';
  const homeLine = home ? `<span>Reading <code>${esc(home)}</code></span>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:">
<title>${esc(title)}</title>
<link rel="icon" href="${FAVICON}">
<script src="/theme.js"></script>
<link rel="stylesheet" href="/style.css">
${head}
</head>
<body>
${SPRITE}
<header class="top">
  <div class="top-inner">
    <a class="brand" href="/">${BRAND_MARK}<span>agent-ops</span></a>
    ${sourceBadge}
    <nav>${renderNav(current)}${nav}<button class="theme-toggle" type="button" data-theme-toggle title="Theme: follows your system. Click to switch" aria-label="Switch theme"><span class="when-light">${icon('moon')}</span><span class="when-dark">${icon('sun')}</span></button></nav>
  </div>
</header>
<main>
${body}
</main>
<footer class="foot">
  <div class="foot-inner">
    ${homeLine}
    <span>Read-only. Nothing here writes to the agent's home directory.</span>
  </div>
</footer>
</body>
</html>
`;
}

export function empty(message) {
  return `<p class="empty">${esc(message)}</p>`;
}
