// The overview page: one period, seen from every angle the aggregates allow. Cost per bucket,
// tokens per bucket stacked by model, the rhythm of the week, then projects, models and tools
// side by side, and the two top-10 lists that lead back into individual sessions.
//
// Like every other page here it is pure string building: `overview` arrives fully aggregated
// from lib/analytics.js, and nothing in this file reads the disk or imports lib/*.
import { esc, empty, icon } from './layout.js';
import { humanCount, shortDay, formatUsd, formatDuration } from './format.js';
import { columnChart, segmented, stat, mark } from './charts.js';

const PERIODS = [7, 30, 90, 365];
const DEFAULT_DAYS = 30;
const MODEL_SLOTS = 4;

// The page's own state in the query string, same contract as the dashboard's href(): only
// non-default values are written, so a bare /overview is the canonical address.
export function overviewHref(state, overrides = {}) {
  const next = { ...state, ...overrides };
  const params = new URLSearchParams();
  if (next.project) params.set('project', next.project);
  if (next.days !== DEFAULT_DAYS) params.set('days', String(next.days));
  const query = params.toString();
  return query ? `/overview?${query}` : '/overview';
}

// The analytics emit each bucket's start as an ISO day; the axis shows it as "20 Aug", which
// reads the same whether the bucket is one day or the week that opens on it.
const labelled = (buckets) => buckets.map((b) => ({ ...b, label: shortDay(b.label) }));

/* ---- the numbers strip ------------------------------------------------------------------- */

// "+12%" / "−8%" / "—". A period with nothing before it has no percentage to show, and an
// invented "+100%" would be a claim the data does not support.
function deltaSpan(d, { goodIsUp = true } = {}) {
  if (!d || d.pct === null) {
    return '<span class="delta" title="Nothing in the previous period to compare against">—</span>';
  }
  const rounded = Math.round(d.pct);
  if (rounded === 0) return '<span class="delta">0%</span>';
  const up = rounded > 0;
  const cls = up === goodIsUp ? 'delta-up' : 'delta-down';
  const sign = up ? '+' : '−';
  return `<span class="delta ${cls}">${sign}${Math.abs(rounded)}%</span>`;
}

// The same `.stat` tile the dashboard uses, with the change against the previous period sitting
// under the label. Built here rather than patched into stat()'s string, so the markup is one
// readable template instead of a substitution that breaks when the tile changes.
function statWithDelta(iconName, value, label, title, d) {
  return `<div class="stat" title="${esc(title)}"><span class="stat-value">${esc(value)}</span><span class="stat-label">${icon(iconName)}${esc(label)}</span>${deltaSpan(d)}</div>`;
}

function buildStrip(overview, asOf) {
  const t = overview.totals;
  const p = overview.prevTotals;
  const prevWindow = `${shortDay(overview.prev.start)} to ${shortDay(overview.prev.end)}`;
  const was = (n) => `Previous period (${prevWindow}): ${n}`;
  return `<div class="stats" aria-label="Totals for the last ${overview.span} days, against the period before">
${statWithDelta('sessions', String(t.sessions), 'active sessions', was(p.sessions), overview.delta.sessions)}
${statWithDelta('turns', String(t.turns), 'assistant turns', was(p.turns), overview.delta.turns)}
${statWithDelta('tokens', humanCount(t.tokens.output), 'output tokens', was(`${p.tokens.output} output tokens`), overview.delta.output)}
${statWithDelta('dollar', `≈ ${formatUsd(t.cost.usd)}`, 'est. cost', `${was(`≈ ${formatUsd(p.cost.usd)}`)}. Estimate from the static price table, prices as of ${asOf}; models without a price are excluded.`, overview.delta.cost)}
${stat('calendar', String(t.activeDays), 'active days', `Days with at least one assistant turn, ${shortDay(overview.window.start)} to ${shortDay(overview.window.end)}`)}
</div>`;
}

/* ---- charts ------------------------------------------------------------------------------ */

const unit = (overview) => (overview.granularity === 'week' ? 'week' : 'day');

function buildCostChart(overview, asOf) {
  const buckets = labelled(overview.buckets);
  const chart = columnChart(buckets, {
    key: 'cost',
    label: `estimated cost per ${unit(overview)}, last ${overview.span} days`,
    series: (b) => [{ value: b.cost.usd, fill: 'var(--tok-out)' }],
    tip: (b) => ({
      title: b.label,
      subtitle: b.turns ? `${b.turns} ${b.turns === 1 ? 'turn' : 'turns'} in ${b.sessions} ${b.sessions === 1 ? 'session' : 'sessions'}` : 'No activity',
      rows: b.cost.usd ? [{ cls: 'mark swatch-out', name: 'Estimated cost', text: `≈ ${formatUsd(b.cost.usd)} · estimate` }] : [],
    }),
    fallback: (b) => `${b.label}: ≈ ${formatUsd(b.cost.usd)} estimated`,
    formatMax: (n) => formatUsd(n),
  });
  return `<section class="panel chart">
<h2>${icon('dollar')}Estimated cost per ${unit(overview)}</h2>
${chart}
<p class="dim">Estimate, prices as of ${esc(asOf)}. Models without a price are excluded.</p>
</section>`;
}

// The stacked slots follow the models panel exactly: the biggest model by output tokens owns
// slot 0, so a color means the same model in both places on this page.
function buildTokensChart(overview) {
  const order = overview.models.map((m) => m.model);
  const fillOf = (i) => (i < MODEL_SLOTS ? `var(--model-${i})` : 'var(--line-strong)');
  const clsOf = (i) => (i < MODEL_SLOTS ? `mark model-${i}` : 'mark model-other');
  const segs = (b) => order.map((model, i) => ({
    value: b.tokensByModel[model]?.output ?? 0,
    fill: fillOf(i),
    name: model,
    cls: clsOf(i),
  }));
  const buckets = labelled(overview.buckets);
  const chart = columnChart(buckets, {
    key: 'tokens',
    label: `output tokens per ${unit(overview)} by model, last ${overview.span} days`,
    series: segs,
    tip: (b) => {
      const rows = segs(b).filter((s) => s.value);
      const total = rows.reduce((sum, s) => sum + s.value, 0);
      return {
        title: b.label,
        subtitle: total ? `${humanCount(total)} output tokens` : 'No activity',
        rows: rows.map((s) => ({ cls: s.cls, name: s.name, text: humanCount(s.value) })),
      };
    },
    fallback: (b) => `${b.label}: ${humanCount(segs(b).reduce((sum, s) => sum + s.value, 0))} output tokens`,
    formatMax: humanCount,
  });
  const legend = order.map((model, i) => `<span class="legend-item"><span class="${clsOf(i)}"></span>${esc(model)}</span>`).join('');
  return `<section class="panel chart">
<h2>${icon('tokens')}Output tokens per ${unit(overview)}</h2>
${chart}
<div class="legend">${legend}</div>
</section>`;
}

// Seven bars, one per weekday: which days the work actually happens on. Plain rects, because
// the shape carries the whole message and a full chart frame would drown it.
function buildWeekday(overview) {
  const max = Math.max(1, ...overview.weekday.map((w) => w.sessions));
  const w = 220;
  const h = 60;
  const slot = w / overview.weekday.length;
  const barW = slot - 8;
  const bars = overview.weekday.map((d, i) => {
    const bh = d.sessions ? Math.max(2, (d.sessions / max) * h) : 0;
    const x = i * slot + 4;
    const rect = bh
      ? `<rect x="${x.toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}"></rect>`
      : '';
    const caption = `${d.label}: ${d.sessions} ${d.sessions === 1 ? 'session' : 'sessions'}, ${d.turns} ${d.turns === 1 ? 'turn' : 'turns'}`;
    return `<g><title>${esc(caption)}</title><rect class="hit" x="${(i * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${h}" fill="transparent"></rect>${rect}</g>`;
  }).join('');
  const labels = overview.weekday
    .map((d) => `<span>${esc(d.label)}</span>`)
    .join('');
  return `<section class="panel weekday">
<h2>${icon('calendar')}Sessions by weekday</h2>
<svg class="weekday-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="sessions per weekday, Monday to Sunday">${bars}</svg>
<div class="weekday-labels">${labels}</div>
</section>`;
}

/* ---- tables ------------------------------------------------------------------------------ */

const costText = (cost) => (cost.usd === 0 && !cost.priced ? '—' : `≈ ${esc(formatUsd(cost.usd))}`);

function buildProjects(overview, colors) {
  if (overview.projects.length === 0) return '';
  const rows = overview.projects.map((p) => `<tr>
<td data-label="Project"><a class="project" href="/projects/${esc(p.projectDirName)}">${mark(colors, p.projectDirName)}<span class="project-name">${esc(p.name)}</span></a></td>
<td class="num" data-label="Sessions">${p.sessions}</td>
<td class="num" data-label="Turns">${p.turns}</td>
<td class="num" data-label="Output tokens" title="${p.tokens.output} output, ${p.tokens.input} input">${esc(humanCount(p.tokens.output))}</td>
<td class="num" data-label="Est. cost">${costText(p.cost)}</td>
</tr>`).join('\n');
  return `<section class="panel">
<h2>${icon('project')}Projects <span class="dim">${overview.projects.length}</span></h2>
<div class="table-wrap"><table>
<thead><tr><th>Project</th><th class="num">Sessions</th><th class="num">Turns</th><th class="num">Output tokens</th><th class="num">Est. cost</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
</section>`;
}

function buildModels(overview) {
  if (overview.models.length === 0) return '';
  const clsOf = (i) => (i < MODEL_SLOTS ? `mark model-${i}` : 'mark model-other');
  const rows = overview.models.map((m, i) => `<tr>
<td data-label="Model"><span class="${clsOf(i)}"></span><span class="model-name">${esc(m.model)}</span></td>
<td class="num" data-label="Turns">${m.turns}</td>
<td class="num" data-label="Sessions">${m.sessions}</td>
<td class="num" data-label="Output tokens" title="${m.tokens.output} output, ${m.tokens.input} input">${esc(humanCount(m.tokens.output))}</td>
<td class="num" data-label="Est. cost"${m.priced ? '' : ' title="This model is not in the price table, so it has no estimate"'}>${m.priced ? `≈ ${esc(formatUsd(m.cost.usd))}` : 'no price'}</td>
</tr>`).join('\n');
  return `<section class="panel">
<h2>${icon('model')}Models <span class="dim">${overview.models.length}</span></h2>
<div class="table-wrap"><table>
<thead><tr><th>Model</th><th class="num">Turns</th><th class="num">Sessions</th><th class="num">Output tokens</th><th class="num">Est. cost</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
</section>`;
}

function buildTools(overview) {
  if (overview.tools.length === 0) return '';
  const rows = overview.tools.map((t) => `<tr>
<td data-label="Tool"><span class="tool-name">${esc(t.name)}</span></td>
<td class="num" data-label="Calls">${t.calls}</td>
<td class="num" data-label="Errors">${t.errors}</td>
<td class="num" data-label="Error rate">${(t.errorRate * 100).toFixed(1)}%</td>
<td class="num" data-label="Sessions">${t.sessions}</td>
</tr>`).join('\n');
  return `<section class="panel">
<h2>${icon('tool')}Tools <span class="dim">${overview.tools.length}</span></h2>
<div class="table-wrap"><table>
<thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">Errors</th><th class="num">Error rate</th><th class="num">Sessions</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
<p class="dim">Tool counts are per session, not per day: a session active in this period contributes its whole tally.</p>
</section>`;
}

function sessionLink(row) {
  const text = row.name ?? 'Untitled session';
  return `<a class="title" href="/sessions/${esc(row.sessionId)}" title="${esc(row.sessionId)}">${esc(text)}</a>`;
}

function buildTop(heading, iconName, rows, valueHeading, valueCell) {
  if (rows.length === 0) return '';
  const body = rows.map((row) => `<tr>
<td data-label="Session">${sessionLink(row)}</td>
<td data-label="Project"><a class="project" href="/projects/${esc(row.projectDirName)}"><span class="project-name">${esc(row.projectName)}</span></a></td>
<td class="num" data-label="Turns">${row.turns}</td>
<td class="num" data-label="${esc(valueHeading)}">${valueCell(row)}</td>
</tr>`).join('\n');
  return `<section class="panel">
<h2>${icon(iconName)}${esc(heading)} <span class="dim">top ${rows.length}</span></h2>
<div class="table-wrap"><table>
<thead><tr><th>Session</th><th>Project</th><th class="num">Turns</th><th class="num">${esc(valueHeading)}</th></tr></thead>
<tbody>
${body}
</tbody>
</table></div>
</section>`;
}

/* ---- the page ---------------------------------------------------------------------------- */

export function renderOverview({ overview, state = {}, colors = {}, asOf = '', notes = '' }) {
  const scopeName = state.projectName ?? state.project;
  const scope = state.project
    ? `<p class="sub scope">Showing <strong>${esc(scopeName)}</strong> only. <a href="${esc(overviewHref(state, { project: '' }))}">All projects</a></p>`
    : '';
  const periods = segmented(PERIODS.map((n) => ({
    label: n === 365 ? '1 year' : `${n} days`,
    to: overviewHref(state, { days: n }),
    on: n === overview.span,
  })));
  const head = `<div class="page-head">
<div class="panel-head"><h1>Overview</h1>${periods}</div>
<p class="sub">${esc(shortDay(overview.window.start))} to ${esc(shortDay(overview.window.end))}<span class="sep">·</span>compared with ${esc(shortDay(overview.prev.start))} to ${esc(shortDay(overview.prev.end))}<span class="sep">·</span>every cost is an estimate, prices as of ${esc(asOf)}</p>
</div>`;
  const slid = overview.windowSlid
    ? `<p class="dim chart-note">Nothing in the last ${overview.span} days, so this is the ${overview.span} days up to the latest activity, ${esc(shortDay(overview.window.end))}.</p>`
    : '';

  if (overview.totals.sessions === 0) {
    return `${head}
${scope}
${notes}
${empty('No sessions were active in this period. Try a longer period, or clear the project filter.')}`;
  }

  return `${head}
${scope}
${notes}
${buildStrip(overview, asOf)}
${slid}
<div class="charts">
${buildCostChart(overview, asOf)}
${buildTokensChart(overview)}
</div>
<div class="overview-grid">
${buildProjects(overview, colors)}
${buildModels(overview)}
${buildTools(overview)}
</div>
<div class="charts">
${buildTop('Most expensive sessions', 'dollar', overview.topExpensive, 'Est. cost', (row) => costText(row.cost))}
${buildTop('Longest sessions', 'clock', overview.topLongest, 'Duration', (row) => esc(formatDuration(row.durationMs)))}
</div>
${buildWeekday(overview)}`;
}
