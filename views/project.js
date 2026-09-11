// One project: the same dashboard panels the index shows, but over this project's sessions
// only, followed by its session list. The page is already scoped, so its links never carry a
// `project` query param — `href()` refuses to write one once `state.base` is a project page.
import { esc, icon } from './layout.js';
import { humanCount } from './format.js';
import { mark } from './charts.js';
import { renderDashboardPanels, renderSessionsList } from './session-index.js';

function buildHead(project, colors) {
  const derived = project.derived
    ? ' <span class="dim" title="Derived from the encoded directory name, not an exact restore">*</span>'
    : '';
  return `<div class="page-head">
<h1>${mark(colors, project.projectDirName)}${esc(project.name)}</h1>
<p class="sub"><span class="project-path" title="${esc(project.path)}">${esc(project.path)}</span>${derived}</p>
<p class="sub facts-line">${icon('sessions')}${project.count} ${project.count === 1 ? 'session' : 'sessions'}<span class="sep">·</span>${icon('turns')}${project.turns} ${project.turns === 1 ? 'turn' : 'turns'}<span class="sep">·</span>${icon('tokens')}${esc(humanCount(project.tokens.output))} output tokens<span class="sep">·</span><a href="/">All projects</a></p>
</div>`;
}

// `dash` is the dashboard built over this project's sessions; `state.base` is already
// `/projects/<dir>`, so every control on the page stays inside it.
export function renderProject({ project, dash, sessions, state, colors = {}, notes = '', meta = {}, asOf = '' }) {
  return `${buildHead(project, colors)}
${renderDashboardPanels(dash, state, colors, notes, asOf)}
${renderSessionsList(sessions, state, meta)}`;
}
