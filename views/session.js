import { layout, esc, empty } from './layout.js';
import { navFor, humanDate } from './sessions.js';

export function humanDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const clock = (at) => (at ? at.slice(11, 19) : '—');

function eventHtml(e) {
  if (e.kind === 'prompt') {
    return `<div class="ev"><div class="head"><span class="who">you</span><span class="t">${clock(e.at)}</span></div>
<pre>${esc(e.text)}</pre></div>`;
  }
  if (e.kind === 'assistant') {
    return `<div class="ev"><div class="head"><span class="who">claude</span><span class="t">${clock(e.at)}</span></div>
<pre>${esc(e.text)}</pre></div>`;
  }
  if (e.kind === 'compact') {
    return `<div class="ev compact"><div class="head"><span class="who">compacted</span><span class="t">${clock(e.at)}</span></div>
<pre>${esc(e.trigger)} · ${e.preTokens ?? '?'} → ${e.postTokens ?? '?'} tokens</pre></div>`;
  }
  const cls = e.isError ? 'ev tool err' : 'ev tool';
  return `<div class="${cls}"><div class="head">
  <span class="who">${esc(e.name)}${e.isError ? ' · error' : ''}</span>
  <span class="t">${clock(e.at)}</span>
  <span class="t">${humanDuration(e.durationMs)}</span>
</div>
${e.input ? `<pre>$ ${esc(e.input)}</pre>` : ''}
${e.output ? `<pre>${esc(e.output.slice(0, 2000))}</pre>` : ''}
${e.truncated ? '<p class="truncated">output truncated in the transcript; the full text was spilled to a tool-results file the transcript does not name</p>' : ''}
</div>`;
}

export function sessionPage({ session, timeline, tokens }) {
  const errors = timeline.events.filter((e) => e.kind === 'tool' && e.isError).length;
  const tools = timeline.events.filter((e) => e.kind === 'tool').length;

  const body = `<h1>${esc(session.title || session.sessionId.slice(0, 8))}</h1>
<p class="sub">${esc(session.projectLabel)} · ${esc(humanDate(session.modifiedAt))} · ${esc(session.sessionId)}</p>

<div class="cards">
  <div class="card"><div class="k">events</div><div class="v">${timeline.events.length}</div></div>
  <div class="card"><div class="k">tool calls</div><div class="v">${tools}</div></div>
  <div class="card"><div class="k">errors</div><div class="v">${errors}</div></div>
  <div class="card"><div class="k">observed span</div><div class="v">${humanDuration(timeline.spanMs)}</div></div>
</div>
<p class="note">Observed span is the gap between the first and the last timestamp in the file. The
transcript records no wall time, so this is what happened to the clock, not time anyone spent.</p>

${tokens ? tokensBlock(tokens) : ''}

<h2>Timeline</h2>
${timeline.events.length === 0 ? empty('This session has no events.')
  : timeline.events.map(eventHtml).join('\n')}`;

  return layout({ title: `${session.title || session.sessionId} · agent-ops`, body, nav: navFor('') });
}

const N = (n) => n.toLocaleString('en-US').replaceAll(',', ' ');

// Vanilla SVG. One <rect> per response, five stacked series, no library and no client-side JS.
function bars(series) {
  if (series.length === 0) return '';
  const W = 900, H = 160, PAD = 24;
  const rows = [
    ['output', 'var(--accent)'],
    ['input', 'var(--good)'],
    ['cacheCreation', 'var(--warm)'],
    ['cacheRead', 'var(--muted)'],
  ];
  const max = Math.max(...series.map((s) => rows.reduce((a, [k]) => a + s[k], 0)), 1);
  const slot = (W - PAD * 2) / series.length;
  const barW = Math.max(2, Math.min(28, slot - 3));

  const rects = series.map((point, i) => {
    let y = H - PAD;
    return rows.map(([key, colour]) => {
      const h = (point[key] / max) * (H - PAD * 2);
      if (h <= 0) return '';
      y -= h;
      const x = PAD + i * slot + (slot - barW) / 2;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${colour}"><title>${key}: ${N(point[key])}</title></rect>`;
    }).join('');
  }).join('');

  const legend = rows.map(([key, colour], i) =>
    `<rect x="${PAD + i * 150}" y="4" width="10" height="10" fill="${colour}"/>` +
    `<text x="${PAD + i * 150 + 16}" y="13" fill="var(--muted)" font-size="11">${key}</text>`).join('');

  return `<svg viewBox="0 0 ${W} ${H + 20}" role="img" aria-label="tokens per response">
${legend}
<g transform="translate(0,20)">
<line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="var(--line)"/>
${rects}
</g>
</svg>`;
}

export function tokensBlock(t) {
  if (!t.available) {
    return `<h2>Tokens</h2>
<div class="cards"><div class="card"><div class="k">usage</div><div class="v na">not available</div></div></div>
<p class="note">No assistant record in this session carries message.usage. That is an empty answer, not a zero.</p>`;
  }
  const { totals } = t;
  return `<h2>Tokens</h2>
<div class="cards">
  <div class="card"><div class="k">input</div><div class="v">${N(totals.input)}</div></div>
  <div class="card"><div class="k">output</div><div class="v">${N(totals.output)}</div></div>
  <div class="card"><div class="k">cache read</div><div class="v">${N(totals.cacheRead)}</div></div>
  <div class="card"><div class="k">cache creation</div><div class="v">${N(totals.cacheCreation)}</div></div>
  <div class="card"><div class="k">thinking</div><div class="v">${N(totals.thinking)}</div></div>
  <div class="card"><div class="k">context window</div><div class="v na">not available</div></div>
</div>
<p class="note">${t.responses} API responses across ${t.assistantRecords} assistant records; ${t.duplicateRecords} repeats of the same usage were dropped before summing.
Context window is not recorded in Claude Code transcripts, so no percentage of context is shown.</p>
${t.compactions.length ? `<p class="note">Compacted ${t.compactions.length}x: ${t.compactions.map((c) => `${c.trigger} ${N(c.preTokens ?? 0)} → ${N(c.postTokens ?? 0)}`).join(', ')}</p>` : ''}
${bars(t.series)}
`;
}
