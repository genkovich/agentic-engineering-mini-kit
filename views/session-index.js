// Renders the dashboard: a stat strip and a 30-day activity chart over every session, the
// projects and models breakdowns, then the recent sessions list with search, project filter
// and the limit switcher. Also the empty state and notes for anything the read had to work
// around. Never touches the disk: everything arrives already read and aggregated by lib/claude.
import { esc, empty, icon } from './layout.js';

const UNITS = ['B', 'KB', 'MB', 'GB'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LIMIT_CHOICES = [10, 25, 50, 100];
const MAX_LIMIT = 1000; // the server's ceiling for ?limit, mirrored so the "All" link never asks for more
const DEFAULT_LIMIT = 50;
const PERIODS = [7, 30, 90];
const DEFAULT_DAYS = 30;

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

// Token counts: 975 → "975", 3265 → "3.3K", 162900 → "163K", 2400000 → "2.4M".
function humanCount(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1000000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1000000).toFixed(1)}M`;
}

// Hand-rolled instead of toLocaleString: fixed fields, no dependency on ICU data being
// present, so the format never varies across Node builds or CI platforms.
const pad = (n) => String(n).padStart(2, '0');

function formatMtime(mtimeMs) {
  const d = new Date(mtimeMs);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isoMtime(mtimeMs) {
  const d = new Date(mtimeMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// "2026-08-20" → "20 Aug"; chart axis and legend text, no time part.
function shortDay(dayKey) {
  const [, m, d] = dayKey.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

// Colors come from lib/claude assignColors(): the six busiest projects own a slot each, the
// rest share the neutral mark. Set once per render so every helper reads the same map.
let colorMap = {};
const slotOf = (projectDirName) => colorMap[projectDirName] ?? null;

function mark(projectDirName) {
  const slot = slotOf(projectDirName);
  return `<span class="mark ${slot === null ? 'mark-other' : `mark-${slot}`}"></span>`;
}

// Every control is a link: the page state lives in the query string, so it can be copied.
// Only non-default values are written, which keeps the plain "/" as the canonical home.
function href(state, overrides = {}) {
  const next = { ...state, ...overrides };
  const params = new URLSearchParams();
  if (next.q) params.set('q', next.q);
  if (next.project) params.set('project', next.project);
  if (next.days !== DEFAULT_DAYS) params.set('days', String(next.days));
  if (next.limit !== DEFAULT_LIMIT) params.set('limit', String(next.limit));
  const query = params.toString();
  return query ? `/?${query}` : '/';
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
  if (meta.unreadableCount > 0) {
    const noun = meta.unreadableCount === 1 ? 'entry' : 'entries';
    notes.push(`${meta.unreadableCount} source ${noun} could not be read and were skipped.`);
  }
  return notes.map((note) => `<p class="note">${esc(note)}</p>`).join('\n');
}

/* ---- dashboard: stats, chart, projects, models ------------------------------------------ */

function stat(iconName, value, label, title = '') {
  return `<div class="stat"${title ? ` title="${esc(title)}"` : ''}><span class="stat-value">${esc(value)}</span><span class="stat-label">${icon(iconName)}${esc(label)}</span></div>`;
}

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

// One frame for every daily column chart: stacked columns, one per day, ≤24px wide with a 2px
// gap between segments, one gridline at the maximum, date ticks only. `series(day)` returns the
// ordered segments [{ value, fill }] and `tip(day)` the tooltip payload public/dashboard.js
// renders ({ title, subtitle, rows: [{ cls, name, text }] }); <title> is the no-script fallback.
// Two charts share a row, so the viewBox is half the page width: text keeps its size.
function columnChart(dash, { key, series, tip, fallback, formatMax }) {
  const width = 520;
  const height = 200;
  const padLeft = 40;
  const padRight = 24;
  const padBottom = 22;
  const padTop = 10;
  const plotW = width - padLeft - padRight;
  const plotH = height - padBottom - padTop;
  const gap = 2;
  const slot = plotW / dash.days.length;
  const barW = Math.min(24, slot - 6);
  const totals = dash.days.map((d) => series(d).reduce((sum, seg) => sum + seg.value, 0));
  const max = Math.max(1, ...totals);

  const columns = dash.days.map((d, i) => {
    const x = padLeft + i * slot + (slot - barW) / 2;
    let y = padTop + plotH;
    const rects = [];
    for (const seg of series(d)) {
      if (!seg.value) continue;
      const h = (seg.value / max) * plotH;
      y -= h;
      const drawH = Math.max(0, h - (rects.length ? gap : 0));
      rects.push(`<rect x="${x.toFixed(1)}" y="${(y + (rects.length ? gap : 0)).toFixed(1)}" width="${barW.toFixed(1)}" height="${drawH.toFixed(1)}" fill="${seg.fill}"></rect>`);
    }
    const hit = `<rect class="hit" x="${(padLeft + i * slot).toFixed(1)}" y="${padTop}" width="${slot.toFixed(1)}" height="${plotH}" fill="transparent"></rect>`;
    return `<g class="col" tabindex="0" data-tip="${esc(JSON.stringify(tip(d)))}"><title>${esc(fallback(d))}</title>${hit}${rects.join('')}</g>`;
  }).join('\n');

  const step = dash.days.length <= 7 ? 1 : dash.days.length <= 30 ? 7 : 15;
  const ticks = [];
  for (let i = 0; i < dash.days.length; i += step) ticks.push(i);
  // Always label the last day; drop the previous tick when it would sit on top of it.
  const last = dash.days.length - 1;
  if (ticks[ticks.length - 1] !== last) {
    if (last - ticks[ticks.length - 1] < step / 2) ticks.pop();
    ticks.push(last);
  }
  const axisDays = ticks.map((i) => {
    const x = padLeft + i * slot + slot / 2;
    return `<text x="${x.toFixed(1)}" y="${height - 6}" text-anchor="middle">${esc(shortDay(dash.days[i].day))}</text>`;
  }).join('');

  return `<div class="chart-host" data-chart="${key}">
<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(key)} per day, last ${dash.span} days">
<line x1="${padLeft}" y1="${padTop}" x2="${width - padRight}" y2="${padTop}" class="grid"></line>
<text x="${padLeft - 6}" y="${padTop + 4}" text-anchor="end">${esc(formatMax(max))}</text>
<line x1="${padLeft}" y1="${padTop + plotH}" x2="${width - padRight}" y2="${padTop + plotH}" class="axis"></line>
<text x="${padLeft - 6}" y="${padTop + plotH + 4}" text-anchor="end">0</text>
${columns}
${axisDays}
</svg>
<div class="chart-tip" hidden role="status" aria-live="polite"></div>
</div>`;
}

function periodSwitch(dash, state) {
  return segmented(PERIODS.map((n) => ({ label: `${n} days`, to: href(state, { days: n }), on: n === dash.span })));
}

function slidNote(dash) {
  return dash.windowSlid
    ? `<p class="dim chart-note">Nothing in the last ${dash.span} days, so this is the ${dash.span} days up to the latest activity, ${shortDay(dash.windowEnd)}.</p>`
    : '';
}

// Sessions per day, one segment per project (the six colored slots, the rest neutral).
function buildSessionsChart(dash, state) {
  const colorOf = (dir) => (slotOf(dir) === null ? 'var(--line-strong)' : `var(--mark-${slotOf(dir)})`);
  const nameOf = (dir) => dash.projects.find((p) => p.projectDirName === dir)?.name ?? dir;
  const entriesOf = (d) => Object.entries(d.byProject).sort((a, b) => b[1].sessions - a[1].sessions);
  const chart = columnChart(dash, {
    key: 'sessions',
    series: (d) => entriesOf(d).map(([dir, share]) => ({ value: share.sessions, fill: colorOf(dir) })),
    tip: (d) => ({
      title: shortDay(d.day),
      subtitle: d.sessions ? `${d.sessions} ${d.sessions === 1 ? 'session' : 'sessions'}, ${d.turns} turns, ${humanCount(d.tokens.output)} out, ${humanCount(d.tokens.input)} in` : 'No activity',
      rows: entriesOf(d).map(([dir, share]) => ({
        cls: slotOf(dir) === null ? 'mark mark-other' : `mark mark-${slotOf(dir)}`,
        name: nameOf(dir),
        text: `${share.sessions} · ${share.turns} turns · ${humanCount(share.output)} out`,
      })),
    }),
    fallback: (d) => (d.sessions ? `${shortDay(d.day)}: ${d.sessions} sessions, ${d.turns} turns` : `${shortDay(d.day)}: no activity`),
    formatMax: (n) => String(n),
  });
  const legendItems = dash.projects
    .filter((p) => slotOf(p.projectDirName) !== null)
    .map((p) => `<a class="legend-item" href="${esc(href(state, { project: p.projectDirName }))}">${mark(p.projectDirName)}${esc(p.name)}</a>`);
  if (dash.projects.some((p) => slotOf(p.projectDirName) === null)) legendItems.push('<span class="legend-item"><span class="mark mark-other"></span>Other projects</span>');
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
  const chart = columnChart(dash, {
    key: 'tokens',
    series: segs,
    tip: (d) => {
      const total = segs(d).reduce((sum, x) => sum + x.value, 0);
      return {
        title: shortDay(d.day),
        subtitle: total ? `${humanCount(total)} tokens in ${d.turns} ${d.turns === 1 ? 'turn' : 'turns'}` : 'No activity',
        rows: segs(d).filter((x) => x.value).map((x) => ({ cls: x.cls, name: x.name, text: humanCount(x.value) })),
      };
    },
    fallback: (d) => `${shortDay(d.day)}: ${humanCount(segs(d).reduce((sum, x) => sum + x.value, 0))} tokens`,
    formatMax: humanCount,
  });
  return `<section class="panel chart">
<h2>${icon('tokens')}Tokens per day</h2>
${chart}
<div class="legend"><span class="legend-item"><span class="mark swatch-out"></span>Output</span><span class="legend-item"><span class="mark swatch-in"></span>Input</span><span class="legend-item"><span class="mark swatch-cache"></span>Cache read + write</span></div>
</section>`;
}

// A tiny bar per day for one project, over the same window as the charts: the rhythm of a
// project at a glance, with today's/latest bars highlighted when they carry activity.
function sparkline(dash, projectDirName) {
  const w = 160;
  const h = 22;
  const n = dash.days.length;
  const slot = w / n;
  const barW = Math.max(1, slot - 1);
  const values = dash.days.map((d) => d.byProject[projectDirName]?.sessions ?? 0);
  const max = Math.max(1, ...values);
  const bars = values.map((v, i) => {
    if (!v) return '';
    const bh = Math.max(2, (v / max) * h);
    const hot = i === n - 1 ? ' class="hot"' : '';
    return `<rect${hot} x="${(i * slot).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}"></rect>`;
  }).join('');
  const active = values.filter(Boolean).length;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${active} active ${active === 1 ? 'day' : 'days'} of ${n}"><title>${active} active ${active === 1 ? 'day' : 'days'} of ${n}</title>${bars}</svg>`;
}

function buildProjects(dash, state) {
  const rows = dash.projects.map((p) => `<tr${p.projectDirName === state.project ? ' class="on"' : ''}>
<td data-label="Project"><a class="project" href="${esc(href(state, { project: p.projectDirName }))}">${mark(p.projectDirName)}${projectDescriptor(p.name, p.path, p.derived)}</a></td>
<td class="spark-cell" data-label="Last ${dash.span} days">${sparkline(dash, p.projectDirName)}</td>
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
  let x = 0;
  const segments = dash.models.map((m, i) => {
    const w = (m.tokens.output / totalOut) * 100;
    const cls = i < MODEL_SLOTS ? `model-${i}` : 'model-other';
    const seg = `<rect class="${cls}" x="${x.toFixed(2)}" width="${Math.max(0, w - 0.4).toFixed(2)}" height="8"><title>${esc(m.model)}: ${w.toFixed(0)}% of output tokens</title></rect>`;
    x += w;
    return seg;
  }).join('');
  const rows = dash.models.map((m, i) => {
    const share = ((m.tokens.output / totalOut) * 100).toFixed(0);
    const cls = i < MODEL_SLOTS ? `model-${i}` : 'model-other';
    return `<li><span class="mark ${cls}"></span><span class="model-name">${esc(m.model)}</span><span class="dim">${share}% · <strong title="${m.tokens.output} output tokens">${humanCount(m.tokens.output)}</strong> out · ${humanCount(m.tokens.input)} in · ${humanCount(m.tokens.cacheRead + m.tokens.cacheWrite)} cache · ${m.turns} ${m.turns === 1 ? 'turn' : 'turns'} · ${m.sessions} ${m.sessions === 1 ? 'session' : 'sessions'}</span></li>`;
  }).join('\n');
  const body = dash.models.length
    ? `<svg class="models-bar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">${segments}</svg>\n<ul class="models">${rows}</ul>`
    : '<p class="dim">No assistant turns with a model recorded.</p>';
  return `<section class="panel models-panel">
<h2>${icon('model')}Models <span class="dim">${dash.models.length}</span></h2>
${body}
</section>`;
}

/* ---- recent sessions -------------------------------------------------------------------- */

function segmented(items) {
  return `<span class="segmented">${items.map(({ label, to, on }) => `<a href="${esc(to)}"${on ? ' aria-current="true"' : ''}>${esc(label)}</a>`).join('')}</span>`;
}

function buildToolbar(state, projects, meta) {
  const options = projects.map((p) => `<option value="${esc(p.projectDirName)}"${p.projectDirName === state.project ? ' selected' : ''}>${esc(p.name)} (${p.count})</option>`).join('');
  const hiddenLimit = (state.limit !== DEFAULT_LIMIT ? `<input type="hidden" name="limit" value="${state.limit}">` : '')
    + (state.days !== DEFAULT_DAYS ? `<input type="hidden" name="days" value="${state.days}">` : '');
  const search = `<form class="search" method="get" action="/" role="search">
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
  if (session.label !== null) {
    const journal = session.title ? `Journal title: ${session.title}` : 'No journal title';
    return `<span class="title named" title="${esc(journal)}">${esc(session.label)}</span>${rename}`;
  }
  if (session.title !== null) return `<span class="title">${esc(session.title)}</span>${rename}`;
  return `<span class="untitled" title="The journal carries no generated title for this session">Untitled session</span>${rename}`;
}

function sessionRow(session, state) {
  return `<tr>
<td data-label="Name">${nameCell(session, state)}</td>
<td data-label="Project"><a class="project" href="${esc(href(state, { project: session.projectDirName }))}">${mark(session.projectDirName)}<span class="project-name">${esc(session.projectName)}</span></a></td>
<td class="id" data-label="Session" title="${esc(session.sessionId)}">${esc(session.sessionId)}</td>
<td class="num" data-label="Turns">${session.stats.turns}</td>
<td class="num" data-label="Output tokens" title="${session.stats.tokens.output} output, ${session.stats.tokens.input} input, ${session.stats.tokens.cacheRead + session.stats.tokens.cacheWrite} cache">${humanCount(session.stats.tokens.output)}</td>
<td class="num" data-label="Size" title="${session.size} bytes">${humanSize(session.size)}</td>
<td class="num when" data-label="Modified" title="${isoMtime(session.mtimeMs)}">${formatMtime(session.mtimeMs)}</td>
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

export function renderSessionIndex(sessions, meta = {}) {
  const state = {
    q: meta.q ?? '',
    project: meta.project ?? '',
    limit: meta.limit ?? DEFAULT_LIMIT,
    days: meta.days ?? DEFAULT_DAYS,
  };
  colorMap = meta.colors ?? {};
  const notesHtml = buildNotes({ ...meta, shown: sessions.length });
  const projects = meta.projects ?? [];
  const filtered = state.q || state.project;
  const dash = meta.dashboard;

  if (!dash || dash.total.sessions === 0) {
    const where = meta.home ? ` Looked in ${meta.home}.` : '';
    return `${notesHtml}\n${empty(`No sessions found.${where}`)}`;
  }

  let list;
  if (sessions.length === 0 && filtered) {
    const what = state.q ? `No sessions match “${state.q}”` : 'No sessions in this project';
    list = `${empty(`${what}. Clear the filter to see every session.`)}
<p class="sub"><a href="${esc(href(state, { q: '', project: '' }))}">Show all sessions</a></p>`;
  } else {
    list = `<div class="table-wrap">
<table>
<thead><tr><th>Name</th><th>Project</th><th>Session</th><th class="num">Turns</th><th class="num">Output tokens</th><th class="num">Size</th><th class="num">Modified</th></tr></thead>
<tbody>
${sessions.map((s) => sessionRow(s, state)).join('\n')}
</tbody>
</table>
</div>`;
  }

  const scope = state.project
    ? `<p class="sub scope">Showing <strong>${esc(projects.find((p) => p.projectDirName === state.project)?.name ?? state.project)}</strong> only. <a href="${esc(href(state, { project: '' }))}">All projects</a></p>`
    : '';
  return `${scope}
${buildStats(dash)}
${notesHtml}
${buildModels(dash)}
<div class="panel-head"><h2>${icon('calendar')}Activity <span class="dim">${esc(shortDay(dash.windowStart))} to ${esc(shortDay(dash.windowEnd))}</span></h2>${periodSwitch(dash, state)}</div>
${slidNote(dash)}
<div class="charts">
${buildSessionsChart(dash, state)}
${buildTokensChart(dash)}
</div>
${buildProjects(dash, state)}
<section class="panel sessions">
${buildSessionsHeading(sessions, meta, state)}
${buildToolbar(state, projects, meta)}
${list}
</section>`;
}
