// Period analytics for the overview page. Source-agnostic on purpose: it is handed sessions
// that somebody else already read and enriched, so it never touches the disk and knows nothing
// about Claude Code's directory layout. The only module it depends on is the price table.
//
// Everything it reads off a session is already on the closed field list (AGENTS.md §Межі):
// `stats.days[day].{turns, tokens, byModel}`, `stats.models`, `stats.tools`, `stats.tokens`,
// `stats.turns`, `stats.firstTs`, `stats.lastTs`, plus the session's own identity fields.
import { PRICING, estimateCost, estimateSessionCost } from './pricing.js';
import { EMPTY_TOKENS, addSplitTokens, intoModels } from './tokens.js';

// The overview offers a year on top of the dashboard's three periods; beyond a quarter the
// day columns stop being readable, so the buckets fold into weeks.
export const PERIOD_CHOICES_OVERVIEW = [7, 30, 90, 365];
const DEFAULT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_MAX_SPAN = 90;
const TOP_N = 10;

// Mon…Sun, the order a week is read in, not the order Date.getUTCDay() numbers it.
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
function utcMidnight(ms) { return Math.floor(ms / DAY_MS) * DAY_MS; }
// 0 = Monday, so the weekday chart and the weekly buckets agree on where a week starts.
function weekdayIndex(ms) { return (new Date(ms).getUTCDay() + 6) % 7; }

function priceTable(pricing) {
  return (pricing && pricing.perMillion) || PRICING.perMillion;
}

function summed(models, table) {
  const cost = estimateSessionCost(models, table);
  return { usd: cost.usd, priced: cost.priced };
}

// abs is always the plain difference; pct is null when there is nothing to divide by, which the
// page renders as "—" rather than as an infinite rise.
function delta(current, previous) {
  return { abs: current - previous, pct: previous === 0 ? null : ((current - previous) / previous) * 100 };
}

// The window rule is the dashboard's (lib/claude/index.js buildDashboard): it ends at `now`, and
// when nothing at all happened inside it, it slides back to end on the latest activity so a
// quiet home still shows its history instead of an empty page.
function planWindow(sessions, now, span) {
  const lastActivity = sessions.reduce((max, s) => Math.max(max, s.stats.lastTs ?? s.mtimeMs ?? 0), 0);
  const slid = lastActivity > 0 && now - lastActivity > span * DAY_MS;
  const endDay = utcMidnight(slid ? lastActivity : now);
  const granularity = span > DAILY_MAX_SPAN ? 'week' : 'day';
  const buckets = [];
  const index = new Map();
  let startDay;
  if (granularity === 'day') {
    startDay = endDay - (span - 1) * DAY_MS;
    for (let i = 0; i < span; i++) {
      const d = startDay + i * DAY_MS;
      index.set(dayKey(d), buckets.length);
      buckets.push(newBucket(dayKey(d)));
    }
  } else {
    const weeks = Math.floor(span / 7);
    const lastMonday = endDay - weekdayIndex(endDay) * DAY_MS;
    startDay = lastMonday - (weeks - 1) * 7 * DAY_MS;
    for (let w = 0; w < weeks; w++) {
      const s = startDay + w * 7 * DAY_MS;
      buckets.push(newBucket(dayKey(s)));
      for (let i = 0; i < 7; i++) index.set(dayKey(s + i * DAY_MS), w);
    }
  }
  const coveredDays = granularity === 'day' ? span : buckets.length * 7;
  return {
    granularity,
    slid,
    buckets,
    index,
    window: { start: dayKey(startDay), end: dayKey(endDay) },
    prev: { start: dayKey(startDay - coveredDays * DAY_MS), end: dayKey(startDay - DAY_MS) },
    prevRange: { from: startDay - coveredDays * DAY_MS, to: startDay - DAY_MS },
  };
}

// `label` is the bucket's ISO start day; the view turns it into an axis caption, so the
// analytics never decide how a date is spelled.
function newBucket(label) {
  return { label, start: label, cost: { usd: 0, priced: true }, tokensByModel: {}, sessions: 0, turns: 0, models: {}, ids: new Set() };
}

function emptyTotals() {
  return { sessions: 0, turns: 0, tokens: EMPTY_TOKENS(), cost: { usd: 0, priced: true }, activeDays: 0 };
}

export function buildOverview(sessions, projects = [], { now = Date.now(), days = DEFAULT_DAYS, pricing = PRICING } = {}) {
  const span = PERIOD_CHOICES_OVERVIEW.includes(days) ? days : DEFAULT_DAYS;
  const table = priceTable(pricing);
  const plan = planWindow(sessions, now, span);
  const { buckets, index } = plan;

  const windowModels = {};
  const prevModels = {};
  const totals = emptyTotals();
  const prevTotals = emptyTotals();
  const activeDays = new Set();
  const prevActiveDays = new Set();
  const weekday = WEEKDAYS.map((label) => ({ label, sessions: 0, turns: 0, ids: new Set() }));
  const byProject = new Map();
  const byTool = new Map();
  const inWindow = [];
  // A session counts once for a period, not once per day it was active in.
  const prevIds = new Set();

  for (const session of sessions) {
    const dir = session.projectDirName;
    let project = byProject.get(dir);
    if (!project) {
      const known = projects.find((p) => p.projectDirName === dir);
      project = {
        projectDirName: dir,
        name: known?.name ?? session.projectName ?? dir,
        path: known?.path ?? session.projectPath ?? '',
        derived: known?.derived ?? session.projectDerived ?? true,
        sessions: 0, turns: 0, tokens: EMPTY_TOKENS(), models: {}, ids: new Set(),
      };
      byProject.set(dir, project);
    }
    let touched = false;
    for (const [day, d] of Object.entries(session.stats.days ?? {})) {
      const dayMs = Date.parse(`${day}T00:00:00Z`);
      if (!Number.isNaN(dayMs) && dayMs >= plan.prevRange.from && dayMs <= plan.prevRange.to) {
        prevTotals.turns += d.turns;
        addSplitTokens(prevTotals.tokens, d.tokens);
        if (d.turns > 0) prevActiveDays.add(day);
        for (const [model, entry] of Object.entries(d.byModel ?? {})) intoModels(prevModels, model, entry);
        prevIds.add(session.sessionId);
      }
      const idx = index.get(day);
      if (idx === undefined) continue;
      touched = true;
      const bucket = buckets[idx];
      bucket.turns += d.turns;
      bucket.ids.add(session.sessionId);
      totals.turns += d.turns;
      addSplitTokens(totals.tokens, d.tokens);
      if (d.turns > 0) activeDays.add(day);
      project.turns += d.turns;
      addSplitTokens(project.tokens, d.tokens);
      project.ids.add(session.sessionId);
      const wd = weekday[weekdayIndex(dayMs)];
      wd.turns += d.turns;
      wd.ids.add(session.sessionId);
      for (const [model, entry] of Object.entries(d.byModel ?? {})) {
        intoModels(bucket.models, model, entry);
        intoModels(windowModels, model, entry);
        intoModels(project.models, model, entry);
        if (!bucket.tokensByModel[model]) bucket.tokensByModel[model] = EMPTY_TOKENS();
        addSplitTokens(bucket.tokensByModel[model], entry.tokens);
      }
    }
    if (touched) inWindow.push(session);
  }

  prevTotals.sessions = prevIds.size;
  totals.sessions = inWindow.length;
  totals.activeDays = activeDays.size;
  prevTotals.activeDays = prevActiveDays.size;
  totals.cost = summed(windowModels, table);
  prevTotals.cost = summed(prevModels, table);

  for (const bucket of buckets) {
    bucket.sessions = bucket.ids.size;
    bucket.cost = summed(bucket.models, table);
    delete bucket.ids;
    delete bucket.models;
  }
  for (const wd of weekday) { wd.sessions = wd.ids.size; delete wd.ids; }

  // Tools have no per-day breakdown in the stats, so a session that was active in the window
  // contributes its whole tool tally. The page says so next to the table.
  for (const session of inWindow) {
    for (const [name, t] of Object.entries(session.stats.tools ?? {})) {
      let tool = byTool.get(name);
      if (!tool) { tool = { name, calls: 0, errors: 0, sessions: 0 }; byTool.set(name, tool); }
      tool.calls += t.calls || 0;
      tool.errors += t.errors || 0;
      tool.sessions++;
    }
  }

  const projectRows = [...byProject.values()]
    .filter((p) => p.ids.size > 0)
    .map((p) => ({
      projectDirName: p.projectDirName, name: p.name, path: p.path, derived: p.derived,
      sessions: p.ids.size, turns: p.turns, tokens: p.tokens, cost: summed(p.models, table),
    }))
    .sort((a, b) => b.cost.usd - a.cost.usd || b.tokens.output - a.tokens.output || a.name.localeCompare(b.name));

  const modelSessions = new Map();
  for (const session of inWindow) {
    for (const day of Object.values(session.stats.days ?? {})) {
      for (const model of Object.keys(day.byModel ?? {})) {
        if (!modelSessions.has(model)) modelSessions.set(model, new Set());
        modelSessions.get(model).add(session.sessionId);
      }
    }
  }
  const models = Object.entries(windowModels).map(([model, entry]) => {
    const cost = estimateCost(entry.tokens, model, table);
    return {
      model, turns: entry.turns, sessions: modelSessions.get(model)?.size ?? 0,
      tokens: entry.tokens, cost: { usd: cost.usd, priced: cost.priced }, priced: cost.priced,
    };
  }).sort((a, b) => b.tokens.output - a.tokens.output || a.model.localeCompare(b.model));

  const tools = [...byTool.values()]
    .map((t) => ({ ...t, errorRate: t.calls === 0 ? 0 : t.errors / t.calls }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  const describe = (session) => ({
    sessionId: session.sessionId,
    name: session.name ?? session.title ?? null,
    projectDirName: session.projectDirName,
    projectName: session.projectName ?? session.projectDirName,
  });

  const topExpensive = inWindow
    .map((s) => ({ ...describe(s), cost: summed(s.stats.models, table), turns: s.stats.turns }))
    .sort((a, b) => b.cost.usd - a.cost.usd || a.sessionId.localeCompare(b.sessionId))
    .slice(0, TOP_N);

  const topLongest = inWindow
    .map((s) => ({
      ...describe(s),
      durationMs: s.stats.firstTs !== null && s.stats.lastTs !== null ? Math.max(0, s.stats.lastTs - s.stats.firstTs) : 0,
      turns: s.stats.turns,
    }))
    .sort((a, b) => b.durationMs - a.durationMs || a.sessionId.localeCompare(b.sessionId))
    .slice(0, TOP_N);

  return {
    span,
    window: plan.window,
    prev: plan.prev,
    windowSlid: plan.slid,
    granularity: plan.granularity,
    buckets,
    totals,
    prevTotals,
    delta: {
      sessions: delta(totals.sessions, prevTotals.sessions),
      turns: delta(totals.turns, prevTotals.turns),
      output: delta(totals.tokens.output, prevTotals.tokens.output),
      cost: delta(totals.cost.usd, prevTotals.cost.usd),
    },
    weekday,
    projects: projectRows,
    models,
    tools,
    topExpensive,
    topLongest,
  };
}
