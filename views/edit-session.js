// The one page that writes: everything the dashboard knows about a session that the journal
// does not — an own name, tags, a note and a star. Plain GET/POST, no client script; the page
// redirects back to where it came from.
//
// The hidden `form=edit` marker tells the server that all four fields are present, so a field
// left empty means "clear it" rather than "not sent". A POST without the marker (the `/rename`
// alias) patches only the fields it actually carries.
import { esc } from './layout.js';

const TAG_HELP = 'Comma separated. Letters, digits, underscore and dash, up to 32 characters each, 10 tags at most.';

export function renderEditSession({ session, entry = {}, back }) {
  const label = entry.label ?? '';
  const tags = (entry.tags ?? []).join(', ');
  const note = entry.note ?? '';
  const starred = Boolean(entry.starred);
  const anything = Boolean(label || tags || note || starred);
  const journalTitle = session.title ?? 'Untitled session';
  return `<h1>Edit this session</h1>
<p class="sub">Journal title: <strong>${esc(journalTitle)}</strong>. Your name, tags, note and star are stored by the dashboard, never in the agent's home, and the name replaces the journal title everywhere here.</p>
<form class="edit" method="post" action="/sessions/${esc(session.sessionId)}/edit">
<input type="hidden" name="form" value="edit">
<input type="hidden" name="back" value="${esc(back)}">
<label for="label">Name this session</label>
<input id="label" type="text" name="label" value="${esc(label)}" maxlength="120" placeholder="${esc(journalTitle)}" autofocus>
<label for="tags">Tags</label>
<input id="tags" type="text" name="tags" value="${esc(tags)}" maxlength="400" placeholder="bug, refactor" aria-describedby="tags-help">
<p id="tags-help" class="dim field-help">${esc(TAG_HELP)}</p>
<label for="note">Note</label>
<textarea id="note" name="note" rows="5" maxlength="2000" placeholder="Why this session matters to you">${esc(note)}</textarea>
<label class="check" for="starred"><input id="starred" type="checkbox" name="starred" value="1"${starred ? ' checked' : ''}> Star this session</label>
<div class="actions">
<button type="submit">Save</button>
${anything ? '<button type="submit" name="clear" value="1" class="secondary">Clear all</button>' : ''}
<a href="${esc(back)}">Cancel</a>
</div>
</form>
<dl class="facts">
<dt>Session</dt><dd class="id">${esc(session.sessionId)}</dd>
<dt>Project</dt><dd>${esc(session.projectName)} <span class="dim">${esc(session.projectPath)}</span></dd>
</dl>`;
}
