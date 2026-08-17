# LocalVoiceFlow — Implementation Plan

> Статус: план зафиксирован до начала реализации. Все цифры в разделе «Проверка окружения»
> получены реальными запусками на этой машине, а не взяты из документации.

## 0. Проверка окружения (факты, а не предположения)

| Компонент | Факт | Как проверено |
|---|---|---|
| OS | macOS 26.4.1 (25E253) | `sw_vers` |
| CPU | Apple M1 Pro, `arm64` | `sysctl machdep.cpu.brand_string` |
| Node | v24.19.0 | `node --version` |
| `node:sqlite` | доступен без флагов (`DatabaseSync`) | реальный `CREATE TABLE`/`INSERT`/`SELECT` |
| pnpm | 9.15.9 | `pnpm --version` |
| Python | 3.14.6 (Homebrew) | `python3 --version` |
| `uv` | **не установлен** | `which uv` |
| Swift | 6.3.2, target `arm64-apple-macosx26.0` | `swift --version` |
| Xcode | 26.5 (17F42) | `xcodebuild -version` |
| ffmpeg | `/opt/homebrew/bin/ffmpeg` | `which ffmpeg` |
| `claude` | 2.1.234, `authMethod: claude.ai`, `subscriptionType: max` | `claude auth status` |
| `codex` | codex-cli 0.147.0, `Logged in using ChatGPT` | `codex login status` |
| API-ключи в env | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY` — не заданы | probe |
| `mlx-whisper` | 0.4.3 ставится на Python 3.14, `Device(gpu, 0)` | venv + `import mlx.core` |
| Модель STT | `mlx-community/whisper-large-v3-turbo`, 1.61 GB, скачана | `snapshot_download` |

### Реально измеренные задержки (baseline, до написания кода)

| Этап | Замер |
|---|---|
| MLX Whisper, холодная загрузка + распознавание 6.2 s аудио | 3.80 s |
| MLX Whisper, тёплый процесс, то же аудио | 0.78 / 0.78 / 0.78 s |
| `claude -p` haiku, effort low, **со** встроенным thinking | 6.1–7.8 s (444–499 thinking-токенов) |
| `claude -p` haiku, effort low, `MAX_THINKING_TOKENS=0` | **1.61 s** (`duration_ms`), 2.57 s wall |
| `codex exec` gpt-5.6-luna, `model_reasoning_effort="low"` | 13.4 s wall |
| `codex exec` gpt-5.6-luna, `model_reasoning_effort="none"` | 7.4 s wall |

Вывод: реалистичный бюджет для короткой фразы — **≈ 2.5–3.5 s** на связке
MLX Whisper (warm) + Claude Haiku (`MAX_THINKING_TOKENS=0`). Обещание «1–2 s» не даётся.

## 1. Проверенные контракты CLI

### Claude Code 2.1.234

Флаги, наличие которых подтверждено запуском (в том числе скрытые, которых нет в `--help`):

```
-p/--print              --model            --effort {low,medium,high,xhigh,max}
--output-format json    --json-schema      --no-session-persistence
--max-turns    (скрытый, принимается)      --system-prompt-file (скрытый, принимается)
--append-system-prompt-file (скрытый)      --tools (variadic)  --disallowed-tools
--safe-mode             --setting-sources  --strict-mcp-config
```

Подтверждено smoke-тестом: `--safe-mode` **сохраняет** подписочную авторизацию
(`provider: "firstParty"`, `costUSD` списывается на подписку), корректно применяет
`--system-prompt-file` и возвращает `structured_output` по `--json-schema`.
Поэтому `--safe-mode` используется (он отключает CLAUDE.md, скиллы, плагины, хуки, MCP).
`--bare` **не используется** — он строго требует `ANTHROPIC_API_KEY`.

Критично для скорости: `MAX_THINKING_TOKENS=0` в env дочернего процесса убирает
extended thinking и даёт 4-кратное ускорение при неизменном качестве редактуры.

`--tools` объявлен как variadic (`<tools...>`), поэтому он **никогда не ставится последним**
перед позиционным аргументом. Payload передаётся через **stdin**, а не argv — это
и безопаснее, и снимает лимит на длину аргумента.

### Codex CLI 0.147.0

```
codex exec -m <model> -c 'model_reasoning_effort="<effort>"' -c 'tools.web_search=false'
           --sandbox read-only --skip-git-repo-check --ephemeral
           --ignore-user-config --ignore-rules
           -C <empty-dir> --output-schema <file> -o <out-file> -
```

* `--ask-for-approval` в `codex exec` **отсутствует**; в exec-режиме approval и так `never`
  (подтверждено баннером `approval: never`).
* `--ephemeral` не сохраняет сессию на диск, `--ignore-user-config` не читает
  `~/.codex/config.toml` (авторизация при этом продолжает работать).
* Реальный список effort для `gpt-5.6-luna`, полученный из ответа сервера на невалидное
  значение: `none, low, medium, high, xhigh, max`. Значения `minimal` **нет** —
  ТЗ здесь расходится с реальностью, используется фактический список.
* Prompt подаётся через stdin (`-` как позиционный аргумент), не через argv.

## 2. Архитектура

```
┌──────────────────────┐   CGEventTap (Fn/Globe)        ┌──────────────────┐
│  mac-agent (Swift)   │──── AVAudioEngine → WAV 16k ──▶│  core (Node/TS)  │
│  LSUIElement, HUD    │◀─── SSE stages, final text ────│  Fastify :43117  │
└──────────────────────┘                                └────────┬─────────┘
        │ AX insert / ⌘V paste                                   │
        ▼                                                        │ JSON Lines
   активное приложение                            ┌──────────────▼──────────────┐
                                                  │  stt-worker (Python, MLX)   │
                                                  │  модель в памяти, warm      │
                                                  └─────────────────────────────┘
                                                                 │
                                                  ┌──────────────▼──────────────┐
                                                  │ claude / codex CLI (spawn)  │
                                                  │ shell:false, argv-массив    │
                                                  └─────────────────────────────┘
```

Web UI (React/Vite) собирается статикой и раздаётся core на `http://127.0.0.1:43117`.

### Ключевые решения

| Решение | Обоснование |
|---|---|
| `node:sqlite` вместо `better-sqlite3` | нулевые нативные зависимости, Node 24 stable → `pnpm install` не требует компиляции |
| Payload в CLI через **stdin** | нет shell-интерполяции, нет лимита argv, невозможна инъекция через аргументы |
| `--safe-mode` для Claude | подтверждено smoke-тестом, что подписка сохраняется; изолирует от пользовательских CLAUDE.md/хуков/MCP |
| `MAX_THINKING_TOKENS=0` | измеренное 4× ускорение критического пути |
| Один персистентный Python-процесс, JSON Lines | загрузка модели 1.6 GB ровно один раз; warm-транскрипция 0.78 s |
| venv-fallback, если нет `uv` | `uv` на машине отсутствует; bootstrap не ставит глобальные инструменты молча |
| Агент субскрайбится на SSE | HUD показывает реальные стадии (`transcribing`/`correcting`), а не таймеры |
| Fn через `CGEventTap` на `.flagsChanged` + `NSEvent` мониторинг | стандартный API; Fn = `.maskSecondaryFn` |
| State machine вынесена в отдельный модуль без AVFoundation | покрывается unit-тестами без аудио-железа |
| Bearer-токен в `~/Library/Application Support/LocalVoiceFlow/token` (0600) | защищает loopback API от других локальных процессов/браузерных страниц |

## 3. Вертикальные срезы (порядок работы)

1. **Каркас + контракты** — pnpm workspace, `packages/shared` (Zod-схемы), prompts, fixtures.
2. **Core** — SQLite + миграции, settings, dictionary, history, SSE, pipeline, mock-провайдеры.
3. **STT worker** — Python JSON Lines, MLX, warm-up, initial prompt из словаря.
4. **LLM-адаптеры** — Claude CLI, Codex CLI, health/doctor, timeout, cancel.
5. **Swift agent** — permissions, Fn state machine, запись, HUD, вставка, menu-bar.
6. **Web UI** — dashboard, history, dictionary, settings.
7. **Скрипты, тесты, benchmark, документация.**

## 4. Границы MVP

Реализуется: весь основной сценарий из ТЗ §29.
Не реализуется в MVP (зафиксировано как optional): `whisper.cpp` backend (интерфейс
`SttProvider` готов, второй провайдер не пишется), streaming/partial STT,
многопользовательский режим, notarization/Developer ID подпись (используется ad-hoc).
