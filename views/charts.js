// Inline-SVG chart and control primitives shared by the dashboard, the project page and the
// session page. Everything here is pure: buckets and options in, an HTML string out. Inline
// styles are blocked by the CSP, so geometry lives in SVG attributes, never in `style=`.
import { esc, icon } from './layout.js';

// Colors come from lib/claude assignColors(): the six busiest projects own a slot each, the
// rest share the neutral mark. The map is passed in explicitly, never held at module level.
export function slotOf(colors, projectDirName) {
  return colors[projectDirName] ?? null;
}

export function mark(colors, projectDirName) {
  const slot = slotOf(colors, projectDirName);
  return `<span class="mark ${slot === null ? 'mark-other' : `mark-${slot}`}"></span>`;
}

// One frame for every column chart: stacked columns, one per bucket (a day, a week, a turn),
// ≤24px wide with a 2px gap between segments, one gridline at the maximum, bucket ticks only.
// `series(bucket)` returns the ordered segments [{ value, fill }] and `tip(bucket)` the tooltip
// payload public/dashboard.js renders ({ title, subtitle, rows: [{ cls, name, text }] });
// <title> is the no-script fallback. Every bucket carries a `label` for the x axis.
// Two charts share a row, so the viewBox is half the page width: text keeps its size.
export function columnChart(buckets, { key, label, series, tip, fallback, formatMax }) {
  const width = 520;
  const height = 200;
  const padLeft = 40;
  const padRight = 24;
  const padBottom = 22;
  const padTop = 10;
  const plotW = width - padLeft - padRight;
  const plotH = height - padBottom - padTop;
  const gap = 2;
  const slot = plotW / buckets.length;
  const barW = Math.min(24, slot - 6);
  const totals = buckets.map((b) => series(b).reduce((sum, seg) => sum + seg.value, 0));
  const max = Math.max(1, ...totals);

  const columns = buckets.map((b, i) => {
    const x = padLeft + i * slot + (slot - barW) / 2;
    let y = padTop + plotH;
    const rects = [];
    for (const seg of series(b)) {
      if (!seg.value) continue;
      const h = (seg.value / max) * plotH;
      y -= h;
      const drawH = Math.max(0, h - (rects.length ? gap : 0));
      rects.push(`<rect x="${x.toFixed(1)}" y="${(y + (rects.length ? gap : 0)).toFixed(1)}" width="${barW.toFixed(1)}" height="${drawH.toFixed(1)}" fill="${seg.fill}"></rect>`);
    }
    const hit = `<rect class="hit" x="${(padLeft + i * slot).toFixed(1)}" y="${padTop}" width="${slot.toFixed(1)}" height="${plotH}" fill="transparent"></rect>`;
    return `<g class="col" tabindex="0" data-tip="${esc(JSON.stringify(tip(b)))}"><title>${esc(fallback(b))}</title>${hit}${rects.join('')}</g>`;
  }).join('\n');

  const step = buckets.length <= 7 ? 1 : buckets.length <= 30 ? 7 : 15;
  const ticks = [];
  for (let i = 0; i < buckets.length; i += step) ticks.push(i);
  // Always label the last bucket; drop the previous tick when it would sit on top of it.
  const last = buckets.length - 1;
  if (ticks[ticks.length - 1] !== last) {
    if (last - ticks[ticks.length - 1] < step / 2) ticks.pop();
    ticks.push(last);
  }
  const axis = ticks.map((i) => {
    const x = padLeft + i * slot + slot / 2;
    return `<text x="${x.toFixed(1)}" y="${height - 6}" text-anchor="middle">${esc(buckets[i].label)}</text>`;
  }).join('');

  return `<div class="chart-host" data-chart="${key}">
<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">
<line x1="${padLeft}" y1="${padTop}" x2="${width - padRight}" y2="${padTop}" class="grid"></line>
<text x="${padLeft - 6}" y="${padTop + 4}" text-anchor="end">${esc(formatMax(max))}</text>
<line x1="${padLeft}" y1="${padTop + plotH}" x2="${width - padRight}" y2="${padTop + plotH}" class="axis"></line>
<text x="${padLeft - 6}" y="${padTop + plotH + 4}" text-anchor="end">0</text>
${columns}
${axis}
</svg>
<div class="chart-tip" hidden role="status" aria-live="polite"></div>
</div>`;
}

// A tiny bar per bucket over the same window as the charts: the rhythm of a project at a
// glance, with the latest bar highlighted when it carries activity.
export function sparkline(values, { label } = {}) {
  const w = 160;
  const h = 22;
  const n = values.length;
  const slot = w / n;
  const barW = Math.max(1, slot - 1);
  const max = Math.max(1, ...values);
  const bars = values.map((v, i) => {
    if (!v) return '';
    const bh = Math.max(2, (v / max) * h);
    const hot = i === n - 1 ? ' class="hot"' : '';
    return `<rect${hot} x="${(i * slot).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}"></rect>`;
  }).join('');
  const active = values.filter(Boolean).length;
  const text = label ?? `${active} active ${active === 1 ? 'day' : 'days'} of ${n}`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(text)}"><title>${esc(text)}</title>${bars}</svg>`;
}

// One stacked bar of share: segments are laid out in percent of the total, each carrying its
// own <title>. `segments` is [{ value, cls, title }]; a 0.4% sliver of gap separates them.
export function shareBar(segments, { className = 'models-bar' } = {}) {
  const total = Math.max(1, segments.reduce((sum, s) => sum + s.value, 0));
  let x = 0;
  const rects = segments.map((s) => {
    const w = (s.value / total) * 100;
    const rect = `<rect class="${s.cls}" x="${x.toFixed(2)}" width="${Math.max(0, w - 0.4).toFixed(2)}" height="8"><title>${esc(s.title)}</title></rect>`;
    x += w;
    return rect;
  }).join('');
  return `<svg class="${className}" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>`;
}

// A row of links that reads as one control: the current value carries aria-current.
export function segmented(items) {
  return `<span class="segmented">${items.map(({ label, to, on }) => `<a href="${esc(to)}"${on ? ' aria-current="true"' : ''}>${esc(label)}</a>`).join('')}</span>`;
}

export function stat(iconName, value, label, title = '') {
  return `<div class="stat"${title ? ` title="${esc(title)}"` : ''}><span class="stat-value">${esc(value)}</span><span class="stat-label">${icon(iconName)}${esc(label)}</span></div>`;
}
