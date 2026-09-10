// Renders the session index: a table of every session found (project, id, size, modified),
// the empty state when none were found, and notes for anything the read had to work around.
import { esc, empty } from './layout.js';
import { deriveProjectLabel } from '../lib/claude/index.js';

const UNITS = ['B', 'KB', 'MB', 'GB'];

function humanSize(bytes) {
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const formatted = unitIndex === 0 ? String(value) : value.toFixed(1);
  return `${formatted} ${UNITS[unitIndex]}`;
}

// Hand-rolled instead of toLocaleString: fixed fields, no dependency on ICU data being
// present, so the format never varies across Node builds or CI platforms.
function formatMtime(mtimeMs) {
  const d = new Date(mtimeMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function buildNotes(meta) {
  const notes = [];
  if (meta.invalidLimitNote) notes.push(meta.invalidLimitNote);
  if (meta.truncated) {
    notes.push(`Showing ${meta.shown} of ${meta.totalFound} sessions found, before truncation.`);
  }
  if (meta.unreadableCount > 0) {
    const noun = meta.unreadableCount === 1 ? 'entry' : 'entries';
    notes.push(`${meta.unreadableCount} source ${noun} could not be read and were skipped.`);
  }
  return notes.map((note) => `<p class="note">${esc(note)}</p>`).join('\n');
}

export function renderSessionIndex(sessions, meta = {}) {
  const notesHtml = buildNotes({ ...meta, shown: sessions.length });

  if (sessions.length === 0) {
    return `${notesHtml}\n${empty('No sessions found.')}`;
  }

  const rows = sessions.map((session) => {
    const { label, derived } = deriveProjectLabel(session.projectDirName);
    const marker = derived
      ? ' <span class="dim" title="Derived from the encoded directory name, not an exact restore">*</span>'
      : '';
    return `<tr>
<td>${esc(label)}${marker}</td>
<td>${esc(session.sessionId)}</td>
<td class="num" title="${session.size} bytes">${humanSize(session.size)}</td>
<td class="num">${formatMtime(session.mtimeMs)}</td>
</tr>`;
  }).join('\n');

  return `${notesHtml}
<table>
<thead><tr><th>Project</th><th>Session</th><th class="num">Size</th><th class="num">Modified</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}
