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

// Filled in by S4. Kept here so the session page stays one view.
export let tokensBlock = () => '';
export function setTokensBlock(fn) { tokensBlock = fn; }
