import { layout, esc, empty } from './layout.js';

const KB = 1024;
export function humanSize(bytes) {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < KB * KB) return `${(bytes / KB).toFixed(0)} KB`;
  return `${(bytes / KB / KB).toFixed(1)} MB`;
}

export function humanDate(iso) {
  return iso.replace('T', ' ').slice(0, 16);
}

export function sessionsPage({ sessions, home, limit }) {
  const rows = sessions.map((s) => `<tr>
  <td><a href="/sessions/${esc(s.sessionId)}">${esc(s.title || `untitled ${s.sessionId.slice(0, 8)}`)}</a>
      ${s.titleSource ? `<span class="dim"> · ${esc(s.titleSource)}</span>` : ''}</td>
  <td class="dim">${esc(s.projectLabel)}</td>
  <td class="dim">${esc(humanDate(s.modifiedAt))}</td>
  <td class="num dim">${esc(humanSize(s.sizeBytes))}</td>
  <td class="dim">${esc(s.sessionId.slice(0, 8))}</td>
</tr>`).join('\n');

  const body = `<h1>Sessions</h1>
<p class="sub">${sessions.length} shown of ${limit.total} in ${esc(home)}</p>
${sessions.length === 0 ? empty('No sessions found under this Claude home.') : `<table>
<thead><tr><th>Title</th><th>Project</th><th>Modified</th><th class="num">Size</th><th>Id</th></tr></thead>
<tbody>
${rows}
</tbody></table>`}`;

  return layout({ title: 'Sessions · agent-ops', body, nav: navFor('/') });
}

export function navFor(current) {
  const links = [['/', 'sessions'], ['/live', 'live'], ['/analytics', 'analytics']];
  return links.map(([href, label]) =>
    `<a href="${href}" class="${href === current ? 'on' : ''}">${label}</a>`).join('');
}
