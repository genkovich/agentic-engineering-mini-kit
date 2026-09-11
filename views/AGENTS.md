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

`views/session-index.js` — головна сторінка, дашборд. Експортує три функції: `renderDashboardPanels(dash, state, colors, notes)` (смужка зведення, примітки, моделі, заголовок активності з перемикачем періоду, два графіки, таблиця проєктів), `renderSessionsList(sessions, state, meta)` (заголовок, тулбар пошуку й ліміту, причому `<select name="project">` рендериться лише на «/», таблиця сесій або відфільтрований порожній стан) і `renderSessionIndex(sessions, meta)`, що складає їх разом зі скоуп-рядком і тримає порожній стан. Перші дві перевикористовують сторінки проєкту й сесії. Назва сесії в рядку це посилання на `/sessions/<id>`, id сесії лежить у `title` комірки; колонка часу зветься «Last activity». Агрегати приходять готовими в `meta.dashboard` з `listSessions()`; порожній стан через `empty()`; примітки (`invalidLimitNote`, `invalidDaysNote`, `truncated`, `unreadableCount`) через `esc()`. Стан сторінки живе в параметрах запиту: `href(state, overrides)` пише лише недефолтні значення, а `state.base` («/» або «/projects/<dir>») задає, куди ведуть посилання — `project` потрапляє в запит тільки на «/». Сам не звертається до диска.

`views/rename.js` — форма власної назви сесії. Експортує `renderRename({ session, label, back })`: одна `<form method="post">` з полем `label`, кнопкою очищення і прихованим `back` для повернення. Єдина сторінка, за якою стоїть запис, і пише він у `AGENT_OPS_HOME` через `lib/store.js`, не в теку агента.

Інлайн-стилі заборонені CSP, тому ширина смужок і стовпчиків задається атрибутами SVG, а не `style=`.

## Залежності

`views/layout.js` не імпортує нічого, це кінцева точка графа. Він не звертається до `lib/*` і про джерела сесій не знає.

`views/session-index.js` і `views/rename.js` імпортують лише `esc`/`empty`/`icon` з `views/layout.js` плюс `views/format.js` і `views/charts.js`; імпортів з `lib/*` у шарі немає. Усе потрібне приходить у записах сесій (`name`, `label`, `title`, `projectName`, `projectPath`, `projectDerived`, `stats`) і в `meta.dashboard`.

Споживач обох це `server.js`. Маршрут `GET /` читає `?limit`, `?q`, `?project` і `?days` (`parseLimit` і `parseDays` у `server.js`: невалідне значення відкочується на дефолт і додає примітку), викликає `listSessions({ limit, q, project, labels })`, передає результат у `renderSessionIndex()` і складає body для `layout()`: `res.type('html').send(layout({...}))`. Нова сторінка йде тим самим шляхом: рядок або функція рендеру → `layout()` → `res.send()`. Маршрути `GET`/`POST /sessions/:id/rename` рендерять `renderRename()` і після запису відповідають `303` на `back`.

## Стилі

`public/style.css` віддає `express.static` (`server.js:31`). `layout()` лише посилається на `/style.css` рядком у `<head>`; імпорту стилів у JS немає. Токени, інвентар компонентів і конвенції описує `docs/design-system.md`; нова сторінка складається з класів, які там перелічені, а нові токени в сторінці не оголошує.

## Конвенції

Як писати сторінки, лежить у `.claude/rules/views.md`. Claude Code підтягує це правило сам на файлах `views/**/*.js`; якщо твій інструмент правил не читає, відкрий його явно.
