# views/

Карта HTML-шару. Сторінки рендерить сервер: кожна це рядок HTML, загорнутий у `layout()`. Фреймворка, гідратації та збірки фронтенду немає.

## Файли й експорти

`views/layout.js` — спільний каркас. Він експортує чотири функції:

- `esc(value)`: екранує `&`, `<`, `>` і `"`. `null` та `undefined` стають порожнім рядком.
- `layout({ title, body, nav, head, current, source, home })`: повертає готовий документ від `<!doctype html>`: шапка з бренд-знаком, бейджем джерела (`source`) і навігацією, футер зі шляхом, який читаємо (`home`). `current` це href поточної сторінки в навігації, за замовчуванням `/`. `nav` і `head` за замовчуванням порожні; розділи навігації лежать у масиві `NAV` усередині файла.
- `empty(message)`: абзац `<p class="empty">` для порожнього стану.
- `icon(name, label)`: inline `<svg>` з прихованого спрайта іконок (`ICONS` у тому ж файлі). Декоративна за замовчуванням; `label` робить її значущою для скрінрідера. Нову іконку додають у `ICONS`, а не інлайнять у сторінці.

Бренд-знак це inline SVG, той самий рядок іде у favicon як `data:` URI; зовнішніх ресурсів шапка не тягне. У `<head>` перед стилями підключено `public/theme.js`: він ставить `data-theme` на `<html>` з `localStorage` до першого кадру, а кнопка `data-theme-toggle` в навігації перемикає тему; подвійний клік повертає системну.

`views/format.js` — чисті форматери значень, спільні для всіх сторінок: `humanSize(bytes)`, `humanCount(n)` («3.3K», «163K», «2.4M»), `formatMtime(ms)` і `isoMtime(ms)` (фіксовані поля власного розбору, без `toLocaleString`, щоб формат не плавав між збірками Node), `shortDay('2026-08-20')` → «20 Aug», `formatDuration(ms)` («45s», «3m 20s», «2h 05m», «1d 3h»), `formatUsd(n)` (нижче цента чотири знаки, далі два) і `relativeTime(ms, now)` («just now», «5 min ago», «yesterday», «3 days ago», після двох тижнів — дата). Нічого не імпортує, тести в `test/format.test.js`.

`views/charts.js` — примітиви inline-SVG і контролів: `columnChart(buckets, { key, label, series, tip, fallback, formatMax })` малює складені стовпчики по масиву бакетів (день, тиждень, хід), кожен бакет несе `label` для осі, а порожній масив дає голу рамку з написом «No activity to chart yet.» замість помилки; `sparkline(values, { label })`, `shareBar(segments, { className })`, `segmented(items)`, `stat(icon, value, label, title)` і `mark(colors, projectDirName)` / `slotOf(colors, dir)` — мапа кольорів передається явно, модульного стану в шарі немає. Імпортує лише `esc` та `icon` з `layout.js`.

`views/session-index.js` — головна сторінка, дашборд. Експортує чотири функції: `renderDashboardPanels(dash, state, colors, notes)` (смужка зведення, примітки, моделі, заголовок активності з перемикачем періоду, два графіки, таблиця проєктів), `renderSessionsList(sessions, state, meta)` (заголовок, тулбар пошуку й ліміту, причому `<select name="project">` рендериться лише на «/», таблиця сесій або відфільтрований порожній стан) `renderSessionIndex(sessions, meta)`, що складає їх разом зі скоуп-рядком і тримає порожній стан, і `renderNotes(meta)` — абзаци `.note` для того, що пішло не так (спільні зі сторінкою проєкту). Перші дві перевикористовують сторінки проєкту й сесії. Назва сесії в рядку це посилання на `/sessions/<id>`, комірка проєкту й рядок таблиці Projects ведуть на `/projects/<dir>`, а легенда графіка лишає фільтр `?project=` на місці; id сесії лежить у `title` комірки; колонка часу зветься «Last activity». Агрегати приходять готовими в `meta.dashboard` з `listSessions()`; порожній стан через `empty()`; примітки (`invalidLimitNote`, `invalidDaysNote`, `truncated`, `unreadableCount`) через `esc()`. Стан сторінки живе в параметрах запиту: `href(state, overrides)` пише лише недефолтні значення, а `state.base` («/» або «/projects/<dir>») задає, куди ведуть посилання — `project` потрапляє в запит тільки на «/». Сам не звертається до диска.

У смужці зведення стоїть плитка «est. cost» з `dash.period.cost`; дату таблиці цін дає `asOf`, пʼятий параметр `renderDashboardPanels(dash, state, colors, notes, asOf)`, бо view не імпортує `lib/*`. У таблиці сесій є колонка «Est. cost» (`session.cost` з `listSessions`; «—» на сесії без ходів або без ціни), а заголовки «Output tokens», «Est. cost» і «Last activity» це посилання `?sort=tokens|cost|time`; `aria-sort="descending"` стоїть на `<th>` лише активної колонки. `state.sort` пишеться в запит лише коли це не `time`, і той самий ключ їде прихованим полем у формі пошуку.

`views/overview.js` — сторінка огляду за період. Експортує `renderOverview({ overview, state, colors, asOf, notes })` і
`overviewHref(state, overrides)` (пише в запит лише `project` і недефолтний `days`; база завжди `/overview`). Сторінка
складається так: `.page-head` із заголовком і `segmented` періодів 7 / 30 / 90 / «1 year», рядок вікна з датою таблиці
цін, смужка `.stats`, де кожна плитка несе `.delta` («+12%», «−8%» або «—», коли порівнювати нема з чим), `columnChart`
вартості за бакетами, `columnChart` вихідних токенів за бакетами, складених за моделями в тому ж порядку слотів, що й
таблиця моделей, `.overview-grid` із трьома таблицями (проєкти з `mark()` і посиланням на `/projects/<dir>`, моделі,
інструменти з `errorRate` у відсотках), два топ-10 (найдорожчі й найдовші сесії) з посиланнями на `/sessions/<id>` і
міні-графік `.weekday` по днях тижня. Агрегати приходять готовими з `lib/analytics.js`; сам файл диску не торкається.
Кожна цифра вартості підписана «≈» і як оцінка, дата таблиці цін названа один раз у шапці.

`views/edit-session.js` — форма всього, що дашборд знає про сесію понад журнал. Експортує `renderEditSession({ session, entry, back })`: одна `<form class="edit" method="post">` з полями `label`, `tags` (через кому), `note` (`<textarea maxlength="2000">`) і чекбоксом `starred`, кнопками «Save» і «Clear all» та прихованим `back` для повернення. Прихований `form=edit` каже серверу, що всі чотири поля присутні, тому порожнє поле означає «очисти», а не «не надіслано»; POST без цього маркера (аліас `/rename`) патчить лише надіслані поля. Єдина сторінка, за якою стоїть запис, і пише він у `AGENT_OPS_HOME` через `lib/store.js`, не в теку агента.

`views/session.js` — сторінка однієї сесії. Експортує `renderSession({ session, colors, back, asOf })`: шапка
(назва, мітка «named by you», проєкт-посилання, id, тривалість, ходи, промпти, моделі), команда
`claude --resume <id>` з посиланням «Edit», рядок вартості (`.cost-note`), смужка чисел, частки моделей,
таблиця інструментів, `columnChart` за ходами і хронологія `<ol class="timeline">`. `asOf` це дата таблиці
цін: view не імпортує `lib/*`, тому `PRICING.asOf` передає сервер. На обрізаній сесії графік ходів і
хронологія несуть примітку, що перші N подій згорнуто, а аналітика рахована по всьому журналу. Жодне поле
рядка хронології не несе тексту розмови: там лише вид події, модель або назва інструмента й числа.

`views/project.js` — сторінка одного проєкту. Експортує `renderProject({ project, dash, sessions, state,
colors, notes, meta })`: шапка проєкту, далі `renderDashboardPanels` на звуженому дашборді й
`renderSessionsList`. `state.base` це `/projects/<dir>`, тому жодне посилання сторінки не пише `?project=`,
а `<select name="project">` у тулбарі не рендериться.

Інлайн-стилі заборонені CSP, тому ширина смужок і стовпчиків задається атрибутами SVG, а не `style=`.

## Залежності

`views/layout.js` не імпортує нічого, це кінцева точка графа. Він не звертається до `lib/*` і про джерела сесій не знає.

`views/session-index.js` і `views/edit-session.js` імпортують лише `esc`/`empty`/`icon` з `views/layout.js` плюс `views/format.js` і `views/charts.js`; імпортів з `lib/*` у шарі немає. Усе потрібне приходить у записах сесій (`name`, `label`, `tags`, `note`, `starred`, `title`, `projectName`, `projectPath`, `projectDerived`, `stats`) і в `meta.dashboard`.

Споживач обох це `server.js`. Маршрут `GET /` читає `?limit`, `?q`, `?project` і `?days` (`parseLimit` і `parseDays` у `server.js`: невалідне значення відкочується на дефолт і додає примітку), викликає `listSessions({ limit, q, project, entries, tag, starred })` (`entries` це `readStore()` з `lib/store.js`), передає результат у `renderSessionIndex()` і складає body для `layout()`: `res.type('html').send(layout({...}))`. Нова сторінка йде тим самим шляхом: рядок або функція рендеру → `layout()` → `res.send()`. Маршрути `GET`/`POST /sessions/:id/edit` рендерять `renderEditSession()` і після запису відповідають `303` на `back`; `GET /sessions/:id/rename` це `302` на `/edit` з тим самим query, а `POST /sessions/:id/rename` лишається робочим і йде тим самим обробником, бо редирект загубив би тіло форми. `GET /sessions/:id` віддає `renderSession()` (id валідує сам `getSession`, невідомий → сторінка 404), `GET /projects/:dir` перевіряє `dir` регуляркою і шукає його серед знайдених проєктів, ніколи не складаючи зі значення шлях; обидві сторінки підключають `/dashboard.js` через `head`, бо рендерять `columnChart`. `GET /overview` читає `?days` (через `parseDaysFrom(raw, PERIOD_CHOICES_OVERVIEW)`) і `?project`, віддає `listSessions().scoped` у `buildOverview()` з `lib/analytics.js` і рендерить `renderOverview()`. Саме `scoped`, а не `sessions`: `sessions` зрізаний по `limit` і відфільтрований по `q`, тому сума по ньому описувала б лише частину сесій. Будь-яка нова сторінкова агрегація бере `scoped`. `?sort` на «/» і на сторінці проєкту розбирає `parseSort` у `server.js`: невідоме значення відкочується на `time` і додає примітку.

## Стилі

`public/style.css` віддає `express.static` (`server.js:31`). `layout()` лише посилається на `/style.css` рядком у `<head>`; імпорту стилів у JS немає. Токени, інвентар компонентів і конвенції описує `docs/design-system.md`; нова сторінка складається з класів, які там перелічені, а нові токени в сторінці не оголошує.

## Конвенції

Як писати сторінки, лежить у `.claude/rules/views.md`. Claude Code підтягує це правило сам на файлах `views/**/*.js`; якщо твій інструмент правил не читає, відкрий його явно.

## Машинний шар

Сторінки мають машинних двійників, і живуть вони поза `views/`: `lib/api-routes.js` реєструє на `app` три JSON-ендпоінти й один CSV, `lib/api.js` віддає `toApiSession(s)`, `lib/csv.js` — `toCsv(columns, rows)`.

- `GET /api/sessions?limit&q&project&days&sort&tag&starred` → `{ sessions, totalFound, truncated, projects, generatedAt }`.
- `GET /api/sessions/:id` → та сама сесія плюс `timeline`, `analytics`, `extras`; невідомий id це `404` з `{ error: 'not found' }`.
- `GET /api/overview?days&project` → результат `buildOverview()` над `scoped` плюс `asOf`.
- `GET /overview.csv?days&project&table=projects|models|tools|sessions` → `text/csv; charset=utf-8` з `Content-Disposition`; `table` поза цим переліком це `400` текстом.

Кожна відповідь це `Cache-Control: no-store`, а тіло збирається з явно названих полів: запис сесії ніколи не розпилюється в відповідь, тому нове поле в API з'являється лише правкою `toApiSession` (`AGENTS.md` §Межі). Розбір параметрів спільний із сторінками й лежить у `lib/query.js`, тому `?days=400` означає одне й те саме на сторінці та в API.

У заголовках панелей стоїть `.api-links`: «CSV» на кожну таблицю огляду й «JSON» один раз, а в заголовку «Recent sessions» — посилання на `/api/sessions` з поточним query.
