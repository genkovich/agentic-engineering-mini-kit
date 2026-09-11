// The one page that writes: a form to give a session its own name, or to clear it back to the
// journal title. Plain GET/POST, no client script; the page redirects back to where it came from.
import { esc } from './layout.js';

export function renderRename({ session, label, back }) {
  const current = label ?? '';
  const journalTitle = session.title ?? 'Untitled session';
  return `<h1>Name this session</h1>
<p class="sub">Journal title: <strong>${esc(journalTitle)}</strong>. Your name is stored by the dashboard, never in the agent's home, and replaces the journal title everywhere here.</p>
<form class="rename" method="post" action="/sessions/${esc(session.sessionId)}/rename">
<input type="hidden" name="back" value="${esc(back)}">
<label for="label">Own name</label>
<input id="label" type="text" name="label" value="${esc(current)}" maxlength="120" placeholder="${esc(journalTitle)}" autofocus>
<div class="actions">
<button type="submit">Save name</button>
${current ? '<button type="submit" name="clear" value="1" class="secondary">Clear name</button>' : ''}
<a href="${esc(back)}">Cancel</a>
</div>
</form>
<dl class="facts">
<dt>Session</dt><dd class="id">${esc(session.sessionId)}</dd>
<dt>Project</dt><dd>${esc(session.projectName)} <span class="dim">${esc(session.projectPath)}</span></dd>
</dl>`;
}
