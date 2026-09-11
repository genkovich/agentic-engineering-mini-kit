---
status: Accepted
owner: "maintainer"
reviewers: []
updated_at: "2026-09-11"
---

# 0001 — Agent home is read-only, and the journal fields we may read are a closed list

- **Status:** Accepted
- **Date:** 2026-09-11
- **Deciders:** maintainer

## Context

Дашборд живе над чужими даними: домашня тека coding-агента містить повні транскрипти розмов з кодом, ключами й особистими даними. Водночас крокам 1–4 потрібні числа, яких у метаданих файлів немає: моделі, токени, інструменти, компакції, підагенти. Без явного переліку кожна наступна фіча тихо розширює читання на одне поле більше, і межа приватності розмивається сама собою.

Рішення закриває D3 з роадмапу: чи потрібні хронології кроку 2 поля поза початковим переліком і як розширити «Межі» так, щоб текст лишався закритим.

## Decision drivers

- `idea-brief.md` §5: текст розмови не показуємо в жодному вигляді, включно з превʼю й підказками.
- `AGENTS.md` §Межі: застосунок не пише в `CLAUDE_HOME`; переліки будуємо з метаданих, вміст читаємо лише там, де специфікація прямо цього вимагає.
- Крок 2 потребує типів блоків `message.content[]`, імен інструментів і ознаки помилки, щоб намалювати хронологію без тексту.
- Перелік має бути перевірним: рецензент мусить мати змогу порівняти код із одним рядком документа.

## Decision outcome

**Chosen:** домашня тека агента лише читається, а перелік дозволених полів журналу закритий і розширюється лише специфікацією фічі разом із правкою `AGENTS.md` §Межі.

Дозволено читати:

- запис: `type`, `timestamp`, `cwd`, `aiTitle` (для запису типу `ai-title`);
- `message`: `id`, `model`, `usage`;
- `message.content[]`: лише `type` блока;
- блок `tool_use`: `name`, `id`;
- блок `tool_result`: `tool_use_id`, `is_error`;
- запис `system`: `subtype`;
- `compactMetadata`: `trigger`, `preTokens`, `postTokens`;
- `agentType` з файлів `agent-*.meta.json`.

Заборонено читати й показувати будь-яке поле з текстом: `text`, `input`, `content` як рядок, `thinking`, а також вміст `tool_result` поза `is_error`.

### Codex CLI (крок 5)

Codex тримає сесію як `sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`, де кожен рядок це
`{timestamp, type, payload}`, а `type` це назва варіанта `RolloutItem` у snake_case. Перелік
понять той самий, що для Claude, лише назви полів інші. Дозволено читати:

- запис: `timestamp`, `type`;
- `session_meta.payload`: `id`, `cwd`;
- `turn_context.payload`: `model`, `cwd`;
- `response_item.payload`: `type`, а далі лише
  - для `function_call` і `custom_tool_call`: `name` і `call_id`;
  - для `local_shell_call`: `call_id` (назва інструмента завжди `shell`);
  - для `function_call_output` і `custom_tool_call_output`: `call_id` і булів прапорець
    `output.success`, якщо запис його несе; якщо ні, результат вважається успішним;
- `event_msg.payload`: `type`, а для `token_count` лише числа під
  `payload.info.last_token_usage` (`input_tokens`, `cached_input_tokens`,
  `cache_write_input_tokens`, `output_tokens`);
- `compacted`: лише сам факт запису.

Заборонено читати `content`, `arguments`, `input`, тіло `output`, `message`, `text`,
`instructions`, `summary` і будь-які міркування (`reasoning`). Заголовка сесії Codex не генерує,
тому `title` завжди `null`: єдиний текст, який міг би за нього правити, це вміст розмови.

Адаптер деструктурує лише перелічені ключі й ніколи не лишає в себе сам запис чи `payload`.

Запис у `CLAUDE_HOME` заборонений повністю; власні дані дашборду живуть окремо (див. [[0002-dashboard-store-outside-agent-home]]).

## Consequences

**Positive**
- Межа приватності перевіряється механічно: є перелік, є код, є рев'ю.
- Кроки 2–4 мають усе потрібне для хронології, аналітики й підагентів, не торкаючись тексту.
- Нове поле коштує явного рішення людини, тому розширення не відбувається випадково.

**Negative**
- Частина природних фіч недоступна назавжди: пошук за змістом, превʼю останнього повідомлення, теми розмов.
- Кожне нове джерело мусить укластися в той самий перелік або отримати власне рішення.

**Neutral**
- Перелік прив'язаний до формату Claude Code; інші джерела мапують свої поля на ті самі поняття.
- Codex отримав власний перелік у цьому ж рішенні, а не окреме ADR: поняття ті самі, відрізняються лише назви полів.

## Links

- [[../roadmap.md]] §Decisions so far
- [[../idea-brief.md]] §5, §8
- `AGENTS.md` §Межі
