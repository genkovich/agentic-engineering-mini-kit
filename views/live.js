import { layout, esc, empty } from './layout.js';
import { navFor, humanDate } from './sessions.js';

export function livePage({ active, home, windowMinutes }) {
  const rows = active.map((s) => `<tr>
  <td><span class="dot live"></span><a href="/sessions/${esc(s.sessionId)}">${esc(s.title || s.sessionId.slice(0, 8))}</a></td>
  <td class="dim">${esc(s.projectLabel)}</td>
  <td class="dim">${esc(humanDate(s.modifiedAt))}</td>
</tr>`).join('\n');

  const body = `<h1>Live</h1>
<p class="sub">Sessions touched in the last ${windowMinutes} minutes, in ${esc(home)}</p>
${active.length === 0 ? empty('Nothing has been written recently. The feed below still listens.')
  : `<table><thead><tr><th>Session</th><th>Project</th><th>Last write</th></tr></thead><tbody>
${rows}
</tbody></table>`}

<h2>Feed</h2>
<div class="feed" id="feed"><div class="dim">waiting for the first append…</div></div>
<p class="note">The feed is a tail of the session files as they grow. It never reloads the page.</p>`;

  return layout({ title: 'Live · agent-ops', body, nav: navFor('/live'), head: '<script src="/live.js" defer></script>' });
}
