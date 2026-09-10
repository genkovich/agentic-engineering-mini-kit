# views/

Карта HTML-шару. Сторінки рендерить сервер: кожна це рядок HTML, загорнутий у `layout()`. Фреймворка, гідратації та збірки фронтенду немає.

## Файли й експорти

`views/layout.js` — спільний каркас. Він експортує три функції:

- `esc(value)`: екранує `&`, `<`, `>` і `"`. `null` та `undefined` стають порожнім рядком.
- `layout({ title, body, nav, head })`: повертає готовий документ від `<!doctype html>`. `nav` і `head` за замовчуванням порожні.
- `empty(message)`: абзац `<p class="empty">` для порожнього стану.

`views/session-index.js` — друга сторінка шару, для складнішого рендеру (`views/AGENTS.md` конвенція: складніша сторінка виносить свою функцію в окремий файл). Експортує `renderSessionIndex(sessions, meta)`: таблиця сесій, порожній стан через `empty()`, примітки (`invalidLimitNote`, `truncated`, `unreadableCount`) через `esc()`. Сам не звертається до диска — приймає готові дані.

## Залежності

`views/layout.js` не імпортує нічого, це кінцева точка графа. Він не звертається до `lib/*` і про джерела сесій не знає.

`views/session-index.js` імпортує `esc`/`empty` з `views/layout.js` і `deriveProjectLabel` з `lib/claude/index.js` (єдиний імпорт з `lib/*` у цьому шарі).

Споживач обох це `server.js`. Маршрут `GET /` читає `?limit`, викликає `listSessions()`, передає результат у `renderSessionIndex()` і складає body для `layout()`: `res.type('html').send(layout({...}))`. Нова сторінка йде тим самим шляхом: рядок або функція рендеру → `layout()` → `res.send()`.

## Стилі

`public/style.css` віддає `express.static` (`server.js:11`). `layout()` лише посилається на `/style.css` рядком у `<head>`; імпорту стилів у JS немає.

## Конвенції

Як писати сторінки, лежить у `.claude/rules/views.md`. Claude Code підтягує це правило сам на файлах `views/**/*.js`; якщо твій інструмент правил не читає, відкрий його явно.
