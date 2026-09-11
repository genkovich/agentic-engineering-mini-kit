// One session: what it is, what it cost, what it used and what happened in it, in that order.
// Everything arrives already read and aggregated by lib/claude (`getSession`); this file only
// shapes it. The timeline carries no message text by construction — the journal reader never
// reads one — and no field here is a place to start.
import { esc, icon } from './layout.js';
import { humanCount, humanSize, isoMtime, formatDuration, formatUsd } from './format.js';
import { columnChart, shareBar, stat, mark } from './charts.js';

const MODEL_SLOTS = 4; // the same four steps the dashboard uses before folding into neutral

// The journal timestamps are epoch ms; isoMtime gives "YYYY-MM-DD HH:MM:SS" in local time, so
// the clock column is its tail and the full value goes in the title.
function clockOf(ts) {
  if (typeof ts !== 'number') return '<span class="tl-time dim">--:--:--</span>';
  const iso = isoMtime(ts);
  return `<span class="tl-time" title="${esc(iso)}">${esc(iso.slice(11))}</span>`;
}

/* ---- head ------------------------------------------------------------------------------ */

function costLine(analytics, asOf) {
  const { cost } = analytics;
  if (analytics.perModel.length === 0) return 'no turns';
  const prices = `estimate, prices as of ${asOf}`;
  if (cost.priced) return `≈ ${formatUsd(cost.usd)} · ${prices}`;
  return `≈ ${formatUsd(cost.usd)} for priced models · no price for ${cost.unpriced.join(', ')} · ${prices}`;
}

function buildHead(session, colors, back, asOf) {
  const { analytics, stats } = session;
  const heading = session.label !== null
    ? `${esc(session.label)} <span class="named-flag">${icon('tag')}named by you</span>`
    : esc(session.title ?? 'Untitled session');
  const editHref = `/sessions/${esc(session.sessionId)}/rename?back=${encodeURIComponent(back)}`;
  const project = `<a class="project" href="/projects/${esc(session.projectDirName)}">${mark(colors, session.projectDirName)}<span class="project-name">${esc(session.projectName)}</span><span class="project-path" title="${esc(session.projectPath)}">${esc(session.projectPath)}</span></a>`;
  const models = analytics.perModel.length
    ? analytics.perModel.map((m) => esc(m.model)).join(', ')
    : 'no model recorded';
  const facts = [
    `<span class="id" title="${esc(session.sessionId)}">${esc(session.sessionId)}</span>`,
    `${icon('clock')}${esc(formatDuration(analytics.durationMs))}`,
    `${icon('turns')}${stats.turns} ${stats.turns === 1 ? 'turn' : 'turns'}`,
    `${icon('sessions')}${stats.prompts} ${stats.prompts === 1 ? 'prompt' : 'prompts'}`,
    `${icon('model')}${models}`,
  ].join('<span class="sep">·</span>');
  return `<div class="page-head">
<h1>${heading}</h1>
<p class="sub">${project}</p>
<p class="sub facts-line">${facts}</p>
<p class="resume-line"><code class="resume">claude --resume ${esc(session.sessionId)}</code> <a class="edit-link" href="${editHref}">${icon('pencil')}Edit</a></p>
<p class="cost-note">${icon('dollar')}${esc(costLine(analytics, asOf))}</p>
</div>`;
}

/* ---- numbers, models, tools ------------------------------------------------------------- */

function buildStats(session) {
  const t = session.analytics.tokensByType;
  const e = session.extras;
  const subagents = Object.values(e.subagents).reduce((sum, n) => sum + n, 0);
  return `<div class="stats" aria-label="Totals for this session">
${stat('turns', String(session.stats.turns), 'assistant turns')}
${stat('tokens', humanCount(t.output), 'output tokens', `${t.output} output tokens`)}
${stat('tokens', humanCount(t.input), 'input tokens', `${t.input} input tokens`)}
${stat('tokens', humanCount(t.cacheRead + t.cacheWrite), 'cache tokens', `${t.cacheRead} read + ${t.cacheWrite} written`)}
${stat('tool', String(session.analytics.toolsTop.reduce((sum, x) => sum + x.calls, 0)), 'tool calls')}
${stat('compact', String(session.stats.compacts.count), 'compactions', `${session.stats.compacts.preTokens} tokens before, ${session.stats.compacts.postTokens} after`)}
${stat('agent', String(subagents), 'subagent runs')}
</div>`;
}

function buildModels(session) {
  const models = session.analytics.perModel;
  if (models.length === 0) return '';
  const totalOut = Math.max(1, models.reduce((sum, m) => sum + m.tokens.output, 0));
  const clsOf = (i) => (i < MODEL_SLOTS ? `model-${i}` : 'model-other');
  const bar = shareBar(models.map((m, i) => ({
    value: m.tokens.output,
    cls: clsOf(i),
    title: `${m.model}: ${((m.tokens.output / totalOut) * 100).toFixed(0)}% of output tokens`,
  })));
  const rows = models.map((m, i) => {
    const share = ((m.tokens.output / totalOut) * 100).toFixed(0);
    const cost = m.cost.priced ? `≈ ${formatUsd(m.cost.usd)}` : 'no price';
    return `<li><span class="mark ${clsOf(i)}"></span><span class="model-name">${esc(m.model)}</span><span class="dim">${share}% · <strong title="${m.tokens.output} output tokens">${humanCount(m.tokens.output)}</strong> out · ${humanCount(m.tokens.input)} in · ${humanCount(m.tokens.cacheRead + m.tokens.cacheWrite)} cache · ${m.turns} ${m.turns === 1 ? 'turn' : 'turns'} · ${esc(cost)}</span></li>`;
  }).join('\n');
  return `<section class="panel models-panel">
<h2>${icon('model')}Models <span class="dim">${models.length}</span></h2>
${bar}
<ul class="models">${rows}</ul>
</section>`;
}

function buildTools(session) {
  const tools = session.analytics.toolsTop;
  if (tools.length === 0) return '';
  const totalCalls = Math.max(1, tools.reduce((sum, t) => sum + t.calls, 0));
  const rows = tools.map((t) => `<tr>
<td data-label="Tool"><span class="tool-name">${esc(t.name)}</span></td>
<td class="num" data-label="Calls">${t.calls}</td>
<td class="num" data-label="Errors" title="${(t.errorShare * 100).toFixed(0)}% of this tool's calls failed">${t.errors}</td>
<td class="num" data-label="Share">${((t.calls / totalCalls) * 100).toFixed(0)}%</td>
</tr>`).join('\n');
  return `<section class="panel">
<h2>${icon('tool')}Tools <span class="dim">${tools.length}</span></h2>
<div class="table-wrap">
<table>
<thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">Errors</th><th class="num">Share of calls</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>
</section>`;
}

/* ---- per-turn chart and timeline --------------------------------------------------------- */

// On a capped session both the chart and the timeline start at the first retained event, while
// every number above them covers the whole session. Saying so once per block is the difference
// between an honest chart and a wrong one.
function cappedNote(timeline) {
  if (!timeline.capped) return '';
  const collapsed = timeline.total - timeline.events.length;
  return `<p class="dim chart-note">First ${collapsed} events collapsed; analytics cover the whole session.</p>`;
}

function buildTurnChart(session) {
  const buckets = session.analytics.turnBuckets;
  const chart = columnChart(buckets, {
    key: 'turns',
    label: 'tokens per turn',
    series: (b) => [{ value: b.tokens, fill: 'var(--tok-out)' }],
    tip: (b) => ({
      title: b.label,
      subtitle: `${b.turns} ${b.turns === 1 ? 'turn' : 'turns'}, ${humanCount(b.tokens)} tokens`,
      rows: [],
    }),
    fallback: (b) => `${b.label}: ${b.turns} ${b.turns === 1 ? 'turn' : 'turns'}, ${humanCount(b.tokens)} tokens`,
    formatMax: humanCount,
  });
  return `<section class="panel chart">
<h2>${icon('chart')}Tokens per turn</h2>
${cappedNote(session.timeline)}
${chart}
</section>`;
}

const TIMELINE_ICON = { prompt: 'sessions', turn: 'model', result: 'tool', compact: 'compact' };

function timelineRow(event) {
  let body;
  if (event.kind === 'prompt') {
    body = '<span class="tl-what">Prompt</span>';
  } else if (event.kind === 'turn') {
    const t = event.tokens;
    const tools = event.tools.length
      ? `<span class="tl-tools">${event.tools.map((x) => esc(x.name)).join(', ')}</span>`
      : '';
    body = `<span class="tl-what">${esc(event.model ?? 'unknown model')}</span><span class="tl-nums">${humanCount(t.output)} out · ${humanCount(t.input)} in</span>${tools}`;
  } else if (event.kind === 'result') {
    const chip = event.ok === false
      ? '<span class="chip chip-bad">error</span>'
      : '<span class="chip chip-ok">ok</span>';
    body = `<span class="tl-what">${esc(event.name)}</span>${chip}`;
  } else {
    body = `<span class="tl-what">Compaction</span><span class="tl-nums">${humanCount(event.preTokens)} → ${humanCount(event.postTokens)} tokens</span><span class="tl-tools">${esc(event.trigger)}</span>`;
  }
  return `<li class="tl-row tl-kind-${esc(event.kind)}">${clockOf(event.ts)}${icon(TIMELINE_ICON[event.kind] ?? 'sessions')}${body}</li>`;
}

function buildTimeline(session) {
  const { timeline } = session;
  const shown = timeline.events.length;
  const count = timeline.capped ? `${shown} of ${timeline.total}` : String(timeline.total);
  const list = shown
    ? `<ol class="timeline">\n${timeline.events.map(timelineRow).join('\n')}\n</ol>`
    : '<p class="dim">Nothing recorded in this journal yet.</p>';
  return `<section class="panel">
<h2>${icon('clock')}Timeline <span class="dim">${esc(count)}</span></h2>
${cappedNote(timeline)}
${list}
</section>`;
}

/* ---- what the session left on disk beside the journal ------------------------------------ */

function buildExtras(session) {
  const { subagents, toolResults } = session.extras;
  const types = Object.entries(subagents).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (types.length === 0 && toolResults.count === 0) return '';
  const agentList = types.length
    ? `<ul class="extras-list">${types.map(([type, n]) => `<li>${icon('agent')}<span class="tool-name">${esc(type)}</span><span class="dim">${n} ${n === 1 ? 'run' : 'runs'}</span></li>`).join('')}</ul>`
    : '';
  const results = toolResults.count
    ? `<p class="dim">${icon('tool')}${toolResults.count} tool ${toolResults.count === 1 ? 'result' : 'results'} spilled to disk, ${esc(humanSize(toolResults.bytes))} in total. Only their sizes are read.</p>`
    : '';
  return `<section class="panel">
<h2>${icon('agent')}Beside the journal</h2>
${agentList}
${results}
</section>`;
}

// `back` is where the Edit link returns to, normally this page. `asOf` is the pricing date from
// lib/pricing.js, passed in because a view never imports lib/*.
export function renderSession({ session, colors = {}, back = '/', asOf = '' }) {
  return `${buildHead(session, colors, back, asOf)}
${buildStats(session)}
${buildModels(session)}
${buildTools(session)}
${buildTurnChart(session)}
${buildTimeline(session)}
${buildExtras(session)}`;
}
