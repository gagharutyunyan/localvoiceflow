# Core HTTP API

Base URL: `http://127.0.0.1:43117` (port configurable via `LVF_PORT`). The server binds
**only** to the loopback interface.

## Authentication

A random 32-byte token is generated on first run and stored at
`~/Library/Application Support/LocalVoiceFlow/token` with mode `0600`.

* **macOS agent** sends `Authorization: Bearer <token>` on every request.
* **Browser** cannot read the token file, so the agent opens the dashboard via
  `GET /session?token=<token>`, which sets an `HttpOnly`, `SameSite=Strict` session
  cookie (`lvf_session`) and redirects to `/`. `scripts/start.sh` prints the same URL.
* Mutating requests (`POST`/`PATCH`/`PUT`/`DELETE`) additionally require the `Origin`
  header, when present, to equal the server's own origin. This blocks a malicious page
  in the user's browser from driving the API.
* `GET /api/health` is unauthenticated (liveness only, no user data).

## Endpoints

### `GET /api/health`

```json
{ "ok": true, "version": "0.1.0", "uptimeMs": 12345 }
```

### `GET /api/status` → `StatusResponse`

Full dashboard state: STT worker readiness and model, active provider/model/effort, last
dictation with real latencies, last error, permission states as reported by the agent.

### `GET /api/events` (SSE)

`text/event-stream`. Emits `ServerEvent` values (see `packages/shared/src/events.ts`):
`hello`, `pipeline`, `stt-status`, `settings-changed`. Event payloads never contain user
text — only ids, stages, durations and lengths.

### `POST /api/dictations`

The main path. Body is the raw WAV (`Content-Type: audio/wav`), max 64 MB. Metadata comes
in headers so no multipart parsing is needed on either side:

| Header | Meaning |
|---|---|
| `X-LVF-Recording-Mode` | `push-to-talk` \| `locked` |
| `X-LVF-App-Name` | percent-encoded UTF-8 app name |
| `X-LVF-Bundle-Id` | target bundle identifier |
| `X-LVF-Window-Title` | percent-encoded; ignored unless the user enabled it |
| `X-LVF-Pid` | target process id |
| `X-LVF-Audio-Duration-Ms` | duration measured by the agent |
| `X-LVF-Peak-Amplitude` | 0..1 peak, used to reject silent captures early |
| `X-LVF-Dictation-Id` | optional client-supplied id, so the agent can correlate SSE |

Responds with `DictationOutcome`:

```json
{
  "id": "dct_...",
  "status": "completed",
  "text": "Так смотри, этот useEffect...",
  "isRawFallback": false,
  "audioDurationMs": 6188,
  "sttLatencyMs": 781,
  "llmLatencyMs": 1614,
  "totalLatencyMs": 2461,
  "warnings": []
}
```

* `status: "cancelled"` with no `text` — the capture held no speech, or was too short.
  Nothing is written to history.
* `status: "failed"` — `errorCode` / `errorMessage` are set. `text` still carries the raw
  transcript when `insertRawTranscriptWhenLlmFails` is on.

### `POST /api/dictations/:id/cancel`

Aborts an in-flight dictation (STT and/or LLM child process tree). Used by `Escape`.

### `GET /api/dictations` → `{ items: DictationRecord[], total: number }`

Query: `q`, `status`, `bundleId`, `llmProvider`, `llmModel`, `from`, `to`, `limit`, `offset`.

### `GET /api/dictations/:id` → `DictationRecord`
### `PATCH /api/dictations/:id` — body `{ "finalText": "..." }` (manual edit)
### `DELETE /api/dictations/:id`
### `POST /api/dictations/delete` — body `{ "ids": [...] }` (bulk)
### `DELETE /api/dictations` — clears all history (requires `?confirm=yes`)
### `POST /api/dictations/:id/reprocess` — body `ReprocessRequest`

Re-runs correction on the stored raw transcript with the current or an explicitly chosen
provider/model/effort/profile. Updates the record in place and returns it.

### `GET /api/dictations/export?format=json|csv`
### `GET /api/dictations/:id/audio` — 404 unless audio storage was on for that record

## Dictionary

```
GET    /api/dictionary                → { items: DictionaryTerm[] }
POST   /api/dictionary                → DictionaryTerm          (body: DictionaryTermInput)
PATCH  /api/dictionary/:id            → DictionaryTerm          (body: DictionaryTermPatch)
DELETE /api/dictionary/:id
POST   /api/dictionary/bulk           → { updated: number }     (body: { ids, enabled })
POST   /api/dictionary/import         → { created, updated, skipped, duplicates }
GET    /api/dictionary/export?format=json|csv
POST   /api/dictionary/preview        → glossary preview, see below
```

`POST /api/dictionary/preview` — body `{ "rawTranscript": "...", "bundleId"?: "..." }`:

```json
{
  "rawTranscript": "...",
  "afterReplacements": "...",
  "hits": [{ "alias": "юз эффект", "canonical": "useEffect", "index": 12 }],
  "skipped": ["хук"],
  "glossary": [{ "canonical": "useEffect", "aliases": ["юз эффект"] }],
  "sttInitialPrompt": "React, useEffect, ...",
  "promptPreview": "<the exact stdin payload>",
  "profile": "developer"
}
```

The preview never includes the system prompt or any environment value.

## Settings

```
GET   /api/settings          → Settings
PATCH /api/settings          → Settings          (body: SettingsPatch, deep-merged)
POST  /api/settings/reset-prompt → { systemPrompt: string }
GET   /api/settings/prompt   → { systemPrompt, isCustom }
```

Changes take effect on the next dictation. No restart required for provider, model,
effort or profile.

## App profiles

```
GET    /api/app-profiles     → { items: AppProfile[] }
PUT    /api/app-profiles     → AppProfile   (body: AppProfile, upsert by bundleId)
DELETE /api/app-profiles/:bundleId
```

## Provider presets

```
GET    /api/provider-presets → { items: ProviderPreset[] }
POST   /api/provider-presets → ProviderPreset
DELETE /api/provider-presets/:id
```

A preset is `{ id, provider, model, effort, label, builtin }`. Custom model IDs the user
types are saved here so they appear in the dropdown next time.

## Diagnostics

### `GET /api/diagnostics` → full doctor payload

macOS version, architecture, app version, core status, STT worker state and loaded model,
`claude` path/version/auth (**never** the token), `codex` path/version/login status,
permissions as reported by the agent, **names only** of API-key env vars that are set,
active provider/model/effort, last error, SQLite writability, port.

### `POST /api/diagnostics/test-provider`

Body `{ provider, model, effort }`. Runs one tiny real correction through the CLI and
returns `{ ok, latencyMs, model, provider, sample, error? }`. This spends subscription
quota, so it only ever runs on an explicit click.

### `POST /api/diagnostics/test-transcription`

Body `{ path? }`. Runs the bundled fixture (or a given file) through the live STT worker
and returns transcript plus latency.

### `POST /api/diagnostics/open` — body `{ "target": "data" | "logs" | "audio" }`

Opens the directory in Finder. The target is an enum, never a path from the client.

## Agent-only endpoints

```
POST /api/agent/status     body: AgentStatus          (permissions + Fn tap state)
GET  /api/agent/config     → the subset of settings the agent needs
```

## Errors

Every failure returns

```json
{ "error": { "code": "llm_timeout", "message": "..." } }
```

with `code` drawn from `ERROR_CODES` in `packages/shared/src/providers.ts`.
