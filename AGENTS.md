# agent-ops-dashboard

Локальний дашборд над логами сесій coding-агентів. Читає домашню теку агента з диска (`~/.claude` або `CLAUDE_HOME`), рендерить HTML на сервері й слухає лише `127.0.0.1`. Бази даних, автентифікації та збірки фронтенду немає. Залежність рівно одна, `express`; dev-залежностей нуль, тестовий рушій вбудований `node:test`.

Що вже є, знає код. Що будуємо далі, лежить у `docs/roadmap.md`. Терміни домену пояснює `CONTEXT.md`.

## Запуск і перевірки

| Команда | Що робить |
|---|---|
| `npm ci` | ставить залежності. Node 22 (`.nvmrc`), CI ганяє 22 і 24 |
| `npm run verify` | ворота: `node --test` по `test/*.test.js`. Ганяй перед кожним комітом |
| `npm run demo` | сервер на синтетичних `fixtures/claude-home/`, порт 4180 |
| `npm start` | читає справжню `~/.claude`. Агент цього не запускає, для роботи є `demo` |
| `npm run dev` | те саме, що `start`, але з `--watch` |

CI ганяє `verify` на Linux, macOS і Windows, тому в тестах не викликай `find`, `grep`, `wc` чи `jq` через shell; для підрахунків із диска є `test/oracle.js`.

Git не зберігає mtime. `preverify` і `predemo` вирівнюють дати фікстур скриптом `scripts/pin-fixture-mtimes.mjs`; якщо запускаєш тести інакше, спершу виконай його.

Лінтера немає, ворота це тести. Результат команди записуй таким, яким він був; не запускав, так і пиши.

`.claude/settings.example.json` містить Stop-hook на `scripts/verify-hook.mjs`: скопіюй його в `.claude/settings.json`, і `npm run verify` ганятиметься сам, а червоний результат не дасть завершити роботу.

## Конвенції

Тут те, що діє скрізь. Деталі зони лежать у правилах, перелік нижче.

- ESM, `"type": "module"`. Вбудовані модулі імпортуємо з префіксом `node:`.
- Тільки named exports, `export default` у репо немає.
- Класів немає: стан живе в замиканні або в plain-обʼєкті.
- Робота з файлами синхронна (`node:fs`), `node:fs/promises` у репо немає.
- Код і коментарі в ньому англійською, документи в `docs/` і `CONTEXT.md` українською. Тому назва змінної англійська навіть тоді, коли термін для неї український.

## Межі

- Джерело сесій це домашня тека coding-агента, і її ми лише читаємо. Джерел зараз два: `CLAUDE_HOME` (типово `~/.claude`) і `CODEX_HOME` (типово `~/.codex`). Застосунок не пише в жодну з них і не змінює файли сесій; єдиний виняток це `scripts/pin-fixture-mtimes.mjs`, який чіпає лише фікстури в репозиторії. Власні дані дашборду (назви сесій, теги, нотатки й закладки) живуть у `AGENT_OPS_HOME`, типово `~/.agent-ops`, у файлі `sessions.json` виду `{id: {label, tags, note, starred}}`, і пишуться лише через `lib/store.js`; старий `labels.json` лишається джерелом лише на читання, звідки записи виводяться, доки `sessions.json` ще не створено. Тести й `demo` задають тимчасову теку самі.
- Переліки й індекси будуємо з метаданих файлів: імʼя, розмір, час зміни. Вміст JSONL читаємо лише там, де фіча прямо цього вимагає у своїй специфікації, і лише службові поля із закритого переліку (ADR-0001): `type` і `timestamp` запису, `aiTitle` запису типу `ai-title`, `cwd`, `subtype` запису `system` і `compactMetadata.{trigger,preTokens,postTokens}`; з `message` лише `id`, `model` і `usage`; з блоків `message.content[]` лише `type` блока, `name` та `id` блока `tool_use`, `tool_use_id` та `is_error` блока `tool_result`; з файлів `agent-*.meta.json` лише `agentType`, а з `tool-results/*` лише розмір із `statSync`. Факт запитання рахуємо з того, що `message.content` це рядок, і самого рядка не торкаємось. `text`, `input`, `content` блока, `thinking` і будь-який текст повідомлень не читаємо ніколи; обʼєкт блока, запису чи `message` не зберігаємо й не повертаємо. Назву й робочу теку індекс бере з голови файла (`readSessionHead` у `lib/claude/index.js`), решту рахують `readSessionStats`, `readSessionTimeline` і `readSessionExtras` у `lib/claude/journal.js`, з мемоізацією за шляхом, розміром і mtime. Для Codex (`lib/codex/index.js`) той самий перелік має свої назви: із запису `timestamp` і `type`; `session_meta.payload.{id, cwd}`; `turn_context.payload.{model, cwd}`; `response_item.payload.type`, а далі лише `name` і `call_id` для `function_call` та `custom_tool_call`, `call_id` для `local_shell_call` (назва інструмента завжди `shell`) і `call_id` та булів `output.success` для `function_call_output` та `custom_tool_call_output`; `event_msg.payload.type`, а для `token_count` лише числа під `payload.info.last_token_usage`; із `compacted` лише сам факт. `content`, `arguments`, `input`, тіло `output`, `message`, `text`, `instructions`, `summary` і `reasoning` не читаємо ніколи. Заголовка сесії Codex не генерує, тому `title` там завжди `null`. Нове поле в перелік додає лише специфікація фічі разом із правкою цього рядка.
- Текст розмов не потрапляє в репозиторій, фікстури, логи й нікуди за межі машини розробника. Справжні транскрипти, ключі та особисті дані теж; для прикладів є `fixtures/`.
- Тести й локальний запуск працюють на синтетичних `fixtures/claude-home/` і `fixtures/codex-home/`: `test/helpers.js` і `scripts/demo.mjs` задають `CLAUDE_HOME` і `CODEX_HOME` самі. Особисті `~/.claude` й `~/.codex` в тестах, фікстурах і прикладах не використовуй: на машині розробника вони справжні.
- CSP в `layout()` і привʼязку до `127.0.0.1` не послаблюй без окремого рішення людини.
- Нових залежностей не додаємо без рішення людини. Зараз вона рівно одна, `express`.
- Нову потребу за цими межами спочатку погоджуємо з людиною й оновлюємо цей розділ разом зі специфікацією.

## Де що лежить

- `server.js`: маршрути Express і складання сторінок.
- `lib/sources.js`: реєстр і контракт джерел. Адаптер дає `id`, `label`, `home`, `scan`, `readHead`, `describeProject`, `readStats`, `readTimeline`, `readExtras` (і, за бажанням, `pruneStatsMemo`); чого бракує, те `registerSource()` кидає помилкою. `projectDirName` це ключ проєкту спільний для всіх джерел: він має відповідати `^[A-Za-z0-9._-]{1,300}$`, а джерело без власної теки проєкту виводить його з `cwd` через `projectDirNameFor()` з того самого модуля, інакше один проєкт розʼїдеться на два рядки. Нове джерело це `lib/<vendor>/index.js`, який викликає `registerSource()`. Реєстрація відбувається на імпорті модуля, тому новий адаптер треба ще й імпортувати в `server.js`; без цього рядка `listSources()` мовчки його не покаже.
- `lib/claude/index.js`: адаптер Claude Code, віддає `claudeHome()` і `projectsDir()`.
- `lib/codex/index.js`: адаптер Codex CLI, віддає `codexHome()` і `sessionsDir()`; проєкт виводить із `cwd` через `projectDirNameFor()`.
- `lib/journal-memo.js`: мемо за шляхом, розміром і mtime та обрізання хронології, спільні для всіх адаптерів.
- `lib/sessions.js`: оркестрація над джерелами. Обходить `allSources()`, збагачує сирі записи методами того джерела, що їх дало, і додає кожній сесії `source: {id, label}`. Ні від якого `lib/<vendor>/` не залежить; `listSessions`, `getSession` і решта живуть тут, а `lib/claude/index.js` лишає тонкі ре-експорти.
- `lib/query.js`: розбір параметрів запиту, спільний для сторінок і API.
- `lib/api.js` і `lib/csv.js`: `toApiSession(s)` з явним переліком полів і `toCsv(columns, rows)` за RFC 4180. `lib/api-routes.js` реєструє на `app` JSON-ендпоінти й `GET /overview.csv`.
- `views/`: HTML-шар. Карта шару у `views/AGENTS.md`.
- `public/style.css`: єдиний стиль, віддається через `express.static`. Токени, компоненти й конвенції вигляду описує `docs/design-system.md`.
- `test/`: `*.test.js` це ворота; `test/helpers.js` піднімає застосунок на фікстурах, `test/oracle.js` рахує факти з диска.
- `scripts/`: standalone-скрипти на `.mjs`.
- `fixtures/claude-home/` і `fixtures/codex-home/`: синтетичні сесії обох джерел для тестів і локального запуску.
- `docs/roadmap.md`: що будуємо далі. `CONTEXT.md`: словник домену.
- `docs/adr/`: загальні архітектурні рішення.
- `examples/`: архів готових документів для читання людиною. За основу нових артефактів без прямого прохання не бери.

## Правила за зонами

Технічні конвенції лежать у `.claude/rules/`. Claude Code довантажує потрібне сам, коли відкриває файл зони; `.cursor/rules/*.mdc` дзеркалять їх для Cursor. Codex цих тек не читає, тому потрібне правило відкривай явно.

| Файл | Коли діє |
|---|---|
| `.claude/rules/javascript.md` | будь-який `.js` або `.mjs` |
| `.claude/rules/tests.md` | усе під `test/` |
| `.claude/rules/views.md` | `.js` під `views/` |

## Чого не робити

- Не писати в джерело сесій.
- Не додавати UI-фреймворк чи збірку фронтенду.
- Не викликати shell-утиліти в тестах.
- Не додавати залежність.
- Не логувати тіла розмов.
