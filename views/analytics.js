import { layout, esc, empty } from './layout.js';
import { navFor } from './sessions.js';

const N = (n) => n.toLocaleString('en-US').replaceAll(',', ' ');

// Vanilla SVG again: a day axis, one bar per day, a <title> for the hover value.
function dayBars(rows, pick, colour, label) {
  if (rows.length === 0) return empty(`No ${label} to chart.`);
  const W = 900, H = 180, PAD = 30;
  const max = Math.max(...rows.map(pick), 1);
  const slot = (W - PAD * 2) / rows.length;
  const barW = Math.max(3, Math.min(40, slot - 6));

  const bars = rows.map((row, i) => {
    const value = pick(row);
    const h = (value / max) * (H - PAD * 2);
    const x = PAD + i * slot + (slot - barW) / 2;
    return `<rect x="${x.toFixed(1)}" y="${(H - PAD - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${colour}"><title>${esc(row.day)}: ${N(value)}</title></rect>`;
  }).join('');

  const ticks = rows.map((row, i) => {
    if (rows.length > 12 && i % Math.ceil(rows.length / 12) !== 0) return '';
    const x = PAD + i * slot + slot / 2;
    return `<text x="${x.toFixed(1)}" y="${H - PAD + 14}" fill="var(--muted)" font-size="10" text-anchor="middle">${esc(row.day.slice(5))}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} per day">
<text x="${PAD}" y="14" fill="var(--muted)" font-size="11">max ${N(max)}</text>
<line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="var(--line)"/>
${bars}${ticks}
</svg>`;
}

export function analyticsPage({ stats, home }) {
  const tools = stats.topTools.slice(0, 15);
  const maxCalls = Math.max(...tools.map((t) => t.calls), 1);

  const body = `<h1>Analytics</h1>
<p class="sub">${esc(home)}</p>

<div class="cards">
  <div class="card"><div class="k">sessions</div><div class="v">${N(stats.totalSessions)}</div></div>
  <div class="card"><div class="k">parsed for tools/tokens</div><div class="v">${N(stats.scanned)}</div></div>
  <div class="card"><div class="k">bytes parsed</div><div class="v">${(stats.bytesScanned / 1048576).toFixed(0)} MB</div></div>
  <div class="card"><div class="k">failed tool calls</div><div class="v">${N(stats.toolErrors)}</div></div>
  <div class="card"><div class="k">took</div><div class="v">${N(stats.elapsedMs)} ms</div></div>
</div>
<p class="note">Sessions per day covers every session in the index. Tools and tokens cover the
${N(stats.scanned)} freshest sessions only; ${N(stats.skipped)} older ones were not opened. Raise it with
<span class="mono">?scan=N</span> and watch the timing card.</p>

<h2>Sessions per day</h2>
${dayBars(stats.sessionsPerDay, (r) => r.sessions, 'var(--accent)', 'sessions')}

<h2>Tokens per day</h2>
${dayBars(stats.tokensPerDay, (r) => r.output + r.input, 'var(--good)', 'tokens')}
<p class="note">Input plus output, cache excluded. Deduplicated on message.id, so this is one entry
per API response, not one per assistant record.</p>

<h2>Top tools</h2>
${tools.length === 0 ? empty('No tool calls in the scanned window.') : `<table>
<thead><tr><th>Tool</th><th class="num">Calls</th><th></th></tr></thead><tbody>
${tools.map((t) => `<tr><td>${esc(t.name)}</td><td class="num">${N(t.calls)}</td>
<td><svg viewBox="0 0 200 10" style="width:200px;height:10px"><rect x="0" y="0" width="${(t.calls / maxCalls * 200).toFixed(1)}" height="10" fill="var(--warm)"/></svg></td></tr>`).join('\n')}
</tbody></table>`}`;

  return layout({ title: 'Analytics · agent-ops', body, nav: navFor('/analytics') });
}
