// Renders the dashboard: a stat strip and an activity chart over every session, the projects
// and models breakdowns, then the recent sessions list with search, project filter and the
// limit switcher. Also the empty state and notes for anything the read had to work around.
// The panels are exported on their own so the project and session pages can reuse them.
// Never touches the disk: everything arrives already read and aggregated by lib/claude.
import { esc, empty, icon } from './layout.js';
import { humanCount, humanSize, formatMtime, isoMtime, shortDay } from './format.js';
import { columnChart, sparkline, shareBar, segmented, stat, mark, slotOf } from './charts.js';

const LIMIT_CHOICES = [10, 25, 50, 100];
const MAX_LIMIT = 1000; // the server's ceiling for ?limit, mirrored so the "All" link never asks for more
const DEFAULT_LIMIT = 50;
const PERIODS = [7, 30, 90];
const DEFAULT_DAYS = 30;

// Every control is a link: the page state lives in the query string, so it can be copied.
// Only non-default values are written, which keeps the plain "/" as the canonical home.
// `state.base` is the page the links point back at: "/" for the dashboard, "/projects/<dir>"
// for a project page, which is already scoped and therefore never writes `project`.
export function href(state, overrides = {}) {
  const next = { ...state, ...overrides };
  const base = next.base ?? '/';
  const params = new URLSearchParams();
  if (next.q) params.set('q', next.q);
  if (base === '/' && next.project) params.set('project', next.project);
  if (next.days !== DEFAULT_DAYS) params.set('days', String(next.days));
  if (next.limit !== DEFAULT_LIMIT) params.set('limit', String(next.limit));
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

function projectDescriptor(name, path, derived) {
  const flag = derived
    ? ' <span class="dim" title="Derived from the encoded directory name, not an exact restore">*</span>'
    : '';
  return `<span class="project-name">${esc(name)}</span><span class="project-path" title="${esc(path)}">${esc(path)}</span>${flag}`;
}

function buildNotes(meta) {
  const notes = [];
  if (meta.invalidLimitNote) notes.push(meta.invalidLimitNote);
  if (meta.invalidDaysNote) notes.push(meta.invalidDaysNote);
  if (meta.unreadableCount > 0) {
    const noun = meta.unreadableCount === 1 ? 'entry' : 'entries';
    notes.push(`${meta.unreadableCount} source ${noun} could not be read and were skipped.`);
  }
  return notes.map((note) => `<p class="note">${esc(note)}</p>`).join('\n');
}

/* ---- dashboard: stats, chart, projects, models ------------------------------------------ */

function buildStats(dash) {
  const p = dash.period;
  const window = `${shortDay(dash.windowStart)} to ${shortDay(dash.windowEnd)}`;
  const n = dash.span;
  return `<div class="stats" aria-label="Totals for the last ${n} days">
${stat('sessions', String(dash.total.sessions), 'sessions in total')}
${stat('sessions', String(p.sessions), `active in ${n} days`, window)}
${stat('calendar', String(p.activeDays), `active days of ${n}`, window)}
${stat('turns', String(p.turns), 'assistant turns', window)}
${stat('tokens', humanCount(p.tokens.output), 'output tokens', `${p.tokens.output} output tokens, ${window}`)}
${stat('tokens', humanCount(p.tokens.input), 'input tokens', `${p.tokens.input} input tokens, ${window}`)}
${stat('tokens', humanCount(p.tokens.cacheRead + p.tokens.cacheWrite), 'cache tokens', `${p.tokens.cacheRead} read + ${p.tokens.cacheWrite} written, ${window}`)}
</div>`;
}

// The charts take plain buckets, so the day aggregates are labelled once here.
const dayBuckets = (dash) => dash.days.map((d) => ({ ...d, label: shortDay(d.day) }));

function periodSwitch(dash, state) {
  return segmented(PERIODS.map((n) => ({ label: `${n} days`, to: href(state, { days: n }), on: n === dash.span })));
}

function slidNote(dash) {
  return dash.windowSlid
    ? `<p class="dim chart-note">Nothing in the last ${dash.span} days, so this is the ${dash.span} days up to the latest activity, ${shortDay(dash.windowEnd)}.</p>`
    : '';
}

// Sessions per day, one segment per project (the six colored slots, the rest neutral).
function buildSessionsChart(dash, state, colors) {
  const colorOf = (dir) => (slotOf(colors, dir) === null ? 'var(--line-strong)' : `var(--mark-${slotOf(colors, dir)})`);
  const nameOf = (dir) => dash.projects.find((p) => p.projectDirName === dir)?.name ?? dir;
  const entriesOf = (d) => Object.entries(d.byProject).sort((a, b) => b[1].sessions - a[1].sessions);
  const chart = columnChart(dayBuckets(dash), {
    key: 'sessions',
    label: `sessions per day, last ${dash.span} days`,
    series: (d) => entriesOf(d).map(([dir, share]) => ({ value: share.sessions, fill: colorOf(dir) })),
    tip: (d) => ({
      title: d.label,
      subtitle: d.sessions ? `${d.sessions} ${d.sessions === 1 ? 'session' : 'sessions'}, ${d.turns} turns, ${humanCount(d.tokens.output)} out, ${humanCount(d.tokens.input)} in` : 'No activity',
      rows: entriesOf(d).map(([dir, share]) => ({
        cls: slotOf(colors, dir) === null ? 'mark mark-other' : `mark mark-${slotOf(colors, dir)}`,
        name: nameOf(dir),
        text: `${share.sessions} · ${share.turns} turns · ${humanCount(share.output)} out`,
      })),
    }),
    fallback: (d) => (d.sessions ? `${d.label}: ${d.sessions} sessions, ${d.turns} turns` : `${d.label}: no activity`),
    formatMax: (n) => String(n),
  });
  const legendItems = dash.projects
    .filter((p) => slotOf(colors, p.projectDirName) !== null)
    .map((p) => `<a class="legend-item" href="${esc(href(state, { project: p.projectDirName }))}">${mark(colors, p.projectDirName)}${esc(p.name)}</a>`);
  if (dash.projects.some((p) => slotOf(colors, p.projectDirName) === null)) legendItems.push('<span class="legend-item"><span class="mark mark-other"></span>Other projects</span>');
  return `<section class="panel chart">
<h2>${icon('chart')}Sessions per day</h2>
${chart}
<div class="legend">${legendItems.join('')}</div>
</section>`;
}

// Tokens per day, one segment per token type. Cache is the quiet segment: it is usually the
// biggest number and the least interesting one, so it never steals the color.
function buildTokensChart(dash) {
  const segs = (d) => [
    { value: d.tokens.output, fill: 'var(--tok-out)', name: 'Output', cls: 'mark swatch-out' },
    { value: d.tokens.input, fill: 'var(--tok-in)', name: 'Input', cls: 'mark swatch-in' },
    { value: d.tokens.cacheRead + d.tokens.cacheWrite, fill: 'var(--tok-cache)', name: 'Cache', cls: 'mark swatch-cache' },
  ];
  const chart = columnChart(dayBuckets(dash), {
    key: 'tokens',
    label: `tokens per day, last ${dash.span} days`,
    series: segs,
    tip: (d) => {
      const total = segs(d).reduce((sum, x) => sum + x.value, 0);
      return {
        title: d.label,
        subtitle: total ? `${humanCount(total)} tokens in ${d.turns} ${d.turns === 1 ? 'turn' : 'turns'}` : 'No activity',
        rows: segs(d).filter((x) => x.value).map((x) => ({ cls: x.cls, name: x.name, text: humanCount(x.value) })),
      };
    },
    fallback: (d) => `${d.label}: ${humanCount(segs(d).reduce((sum, x) => sum + x.value, 0))} tokens`,
    formatMax: humanCount,
  });
  return `<section class="panel chart">
<h2>${icon('tokens')}Tokens per day</h2>
${chart}
<div class="legend"><span class="legend-item"><span class="mark swatch-out"></span>Output</span><span class="legend-item"><span class="mark swatch-in"></span>Input</span><span class="legend-item"><span class="mark swatch-cache"></span>Cache read + write</span></div>
</section>`;
}

function projectSpark(dash, projectDirName) {
  return sparkline(dash.days.map((d) => d.byProject[projectDirName]?.sessions ?? 0));
}

function buildProjects(dash, state, colors) {
  const rows = dash.projects.map((p) => `<tr${p.projectDirName === state.project ? ' class="on"' : ''}>
<td data-label="Project"><a class="project" href="${esc(href(state, { project: p.projectDirName }))}">${mark(colors, p.projectDirName)}${projectDescriptor(p.name, p.path, p.derived)}</a></td>
<td class="spark-cell" data-label="Last ${dash.span} days">${projectSpark(dash, p.projectDirName)}</td>
<td class="num" data-label="Sessions">${p.count}</td>
<td class="num" data-label="Turns">${p.turns}</td>
<td class="num" data-label="Output tokens" title="${p.tokens.output} output, ${p.tokens.input} input, ${p.tokens.cacheRead + p.tokens.cacheWrite} cache">${humanCount(p.tokens.output)}</td>
<td class="num when" data-label="Last activity" title="${isoMtime(p.latestMtimeMs)}">${formatMtime(p.latestMtimeMs)}</td>
</tr>`).join('\n');
  return `<section class="panel">
<h2>${icon('project')}Projects <span class="dim">${dash.projects.length}</span></h2>
<div class="table-wrap">
<table>
<thead><tr><th>Project</th><th>Last ${dash.span} days</th><th class="num">Sessions</th><th class="num">Turns</th><th class="num">Output tokens</th><th class="num">Last activity</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>
</section>`;
}

// Models as one stacked bar of output-token share plus one line per model. Four accent steps
// color the biggest models; anything beyond folds into a neutral segment, like projects.
const MODEL_SLOTS = 4;

function buildModels(dash) {
  const totalOut = Math.max(1, dash.models.reduce((sum, m) => sum + m.tokens.output, 0));
  const clsOf = (i) => (i < MODEL_SLOTS ? `model-${i}` : 'model-other');
  const bar = shareBar(dash.models.map((m, i) => ({
    value: m.tokens.output,
    cls: clsOf(i),
    title: `${m.model}: ${((m.tokens.output / totalOut) * 100).toFixed(0)}% of output tokens`,
  })));
  const rows = dash.models.map((m, i) => {
    const share = ((m.tokens.output / totalOut) * 100).toFixed(0);
    return `<li><span class="mark ${clsOf(i)}"></span><span class="model-name">${esc(m.model)}</span><span class="dim">${share}% · <strong title="${m.tokens.output} output tokens">${humanCount(m.tokens.output)}</strong> out · ${humanCount(m.tokens.input)} in · ${humanCount(m.tokens.cacheRead + m.tokens.cacheWrite)} cache · ${m.turns} ${m.turns === 1 ? 'turn' : 'turns'} · ${m.sessions} ${m.sessions === 1 ? 'session' : 'sessions'}</span></li>`;
  }).join('\n');
  const body = dash.models.length
    ? `${bar}\n<ul class="models">${rows}</ul>`
    : '<p class="dim">No assistant turns with a model recorded.</p>';
  return `<section class="panel models-panel">
<h2>${icon('model')}Models <span class="dim">${dash.models.length}</span></h2>
${body}
</section>`;
}

// The whole dashboard above the sessions list: stat strip, models, the activity heading with
// its period switch, both charts and the projects table. Shared with the project page.
// `notes` is page-level warning HTML; it sits under the stat strip, where the index puts it.
export function renderDashboardPanels(dash, state, colors = {}, notes = '') {
  return `${buildStats(dash)}
${notes}
${buildModels(dash)}
<div class="panel-head"><h2>${icon('calendar')}Activity <span class="dim">${esc(shortDay(dash.windowStart))} to ${esc(shortDay(dash.windowEnd))}</span></h2>${periodSwitch(dash, state)}</div>
${slidNote(dash)}
<div class="charts">
${buildSessionsChart(dash, state, colors)}
${buildTokensChart(dash)}
</div>
${buildProjects(dash, state, colors)}`;
}

/* ---- recent sessions -------------------------------------------------------------------- */

function buildToolbar(state, projects, meta) {
  const options = projects.map((p) => `<option value="${esc(p.projectDirName)}"${p.projectDirName === state.project ? ' selected' : ''}>${esc(p.name)} (${p.count})</option>`).join('');
  const hiddenLimit = (state.limit !== DEFAULT_LIMIT ? `<input type="hidden" name="limit" value="${state.limit}">` : '')
    + (state.days !== DEFAULT_DAYS ? `<input type="hidden" name="days" value="${state.days}">` : '');
  const search = `<form class="search" method="get" action="${esc(state.base ?? '/')}" role="search">
${hiddenLimit}<input type="search" name="q" value="${esc(state.q)}" placeholder="Search name, project or id" aria-label="Search sessions">
<select name="project" aria-label="Project"><option value="">All projects</option>${options}</select>
<button type="submit">${icon('search')}Apply</button>${state.q || state.project ? `<a class="clear" href="${esc(href(state, { q: '', project: '' }))}">Clear</a>` : ''}
</form>`;
  const choices = LIMIT_CHOICES.includes(state.limit) ? LIMIT_CHOICES : [...LIMIT_CHOICES, state.limit].sort((a, b) => a - b);
  const items = choices.map((n) => ({ label: String(n), to: href(state, { limit: n }), on: n === state.limit }));
  const total = meta.totalFound ?? 0;
  if (total > state.limit && total <= MAX_LIMIT && !choices.includes(total)) {
    items.push({ label: `All ${total}`, to: href(state, { limit: total }), on: false });
  }
  const limit = segmented(items);
  return `<div class="toolbar">
${search}
<span class="control"><span class="label">Show newest</span>${limit}</span>
</div>`;
}

function nameCell(session, state) {
  const renameHref = `/sessions/${esc(session.sessionId)}/rename?back=${encodeURIComponent(href(state))}`;
  const rename = `<a class="rename-link" href="${renameHref}" title="Give this session your own name">${icon('pencil')}Rename</a>`;
  const to = `/sessions/${esc(session.sessionId)}`;
  if (session.label !== null) {
    const journal = session.title ? `Journal title: ${session.title}` : 'No journal title';
    return `<a class="title named" href="${to}" title="${esc(session.sessionId)} · ${esc(journal)}">${esc(session.label)}</a>${rename}`;
  }
  if (session.title !== null) return `<a class="title" href="${to}" title="${esc(session.sessionId)}">${esc(session.title)}</a>${rename}`;
  return `<a class="untitled" href="${to}" title="${esc(session.sessionId)} · The journal carries no generated title for this session">Untitled session</a>${rename}`;
}

function sessionRow(session, state, colors) {
  return `<tr>
<td data-label="Name">${nameCell(session, state)}</td>
<td data-label="Project"><a class="project" href="${esc(href(state, { project: session.projectDirName }))}">${mark(colors, session.projectDirName)}<span class="project-name">${esc(session.projectName)}</span></a></td>
<td class="id" data-label="Session" title="${esc(session.sessionId)}">${esc(session.sessionId)}</td>
<td class="num" data-label="Turns">${session.stats.turns}</td>
<td class="num" data-label="Output tokens" title="${session.stats.tokens.output} output, ${session.stats.tokens.input} input, ${session.stats.tokens.cacheRead + session.stats.tokens.cacheWrite} cache">${humanCount(session.stats.tokens.output)}</td>
<td class="num" data-label="Size" title="${session.size} bytes">${humanSize(session.size)}</td>
<td class="num when" data-label="Last activity" title="${isoMtime(session.mtimeMs)}">${formatMtime(session.mtimeMs)}</td>
</tr>`;
}

function buildSessionsHeading(sessions, meta, state) {
  const total = meta.totalFound ?? sessions.length;
  const filtered = state.q || state.project;
  let text;
  if (meta.truncated) text = `${sessions.length} newest of ${total}${filtered ? ' matching' : ''}`;
  else if (filtered) text = `${total} matching of ${meta.totalSessions ?? total}`;
  else text = `${total}`;
  return `<h2>${icon('sessions')}Recent sessions <span class="dim">${esc(text)}</span></h2>`;
}

// The sessions section on its own: heading, toolbar and either the table or the filtered
// empty state. Shared with the project page, which passes its own `state.base`.
export function renderSessionsList(sessions, state, meta = {}) {
  const colors = meta.colors ?? {};
  const projects = meta.projects ?? [];
  const filtered = state.q || state.project;
  let list;
  if (sessions.length === 0 && filtered) {
    const what = state.q ? `No sessions match “${state.q}”` : 'No sessions in this project';
    list = `${empty(`${what}. Clear the filter to see every session.`)}
<p class="sub"><a href="${esc(href(state, { q: '', project: '' }))}">Show all sessions</a></p>`;
  } else {
    list = `<div class="table-wrap">
<table>
<thead><tr><th>Name</th><th>Project</th><th>Session</th><th class="num">Turns</th><th class="num">Output tokens</th><th class="num">Size</th><th class="num">Last activity</th></tr></thead>
<tbody>
${sessions.map((s) => sessionRow(s, state, colors)).join('\n')}
</tbody>
</table>
</div>`;
  }
  return `<section class="panel sessions">
${buildSessionsHeading(sessions, meta, state)}
${buildToolbar(state, projects, meta)}
${list}
</section>`;
}

export function renderSessionIndex(sessions, meta = {}) {
  const state = {
    base: '/',
    q: meta.q ?? '',
    project: meta.project ?? '',
    limit: meta.limit ?? DEFAULT_LIMIT,
    days: meta.days ?? DEFAULT_DAYS,
  };
  const colors = meta.colors ?? {};
  const notesHtml = buildNotes({ ...meta, shown: sessions.length });
  const projects = meta.projects ?? [];
  const dash = meta.dashboard;

  if (!dash || dash.total.sessions === 0) {
    const where = meta.home ? ` Looked in ${meta.home}.` : '';
    return `${notesHtml}\n${empty(`No sessions found.${where}`)}`;
  }

  const scope = state.project
    ? `<p class="sub scope">Showing <strong>${esc(projects.find((p) => p.projectDirName === state.project)?.name ?? state.project)}</strong> only. <a href="${esc(href(state, { project: '' }))}">All projects</a></p>`
    : '';
  return `${scope}
${renderDashboardPanels(dash, state, colors, notesHtml)}
${renderSessionsList(sessions, state, meta)}`;
}
