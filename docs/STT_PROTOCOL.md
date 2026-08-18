# STT worker protocol (core ⇄ services/stt-worker)

One long-lived Python process. The Whisper model is loaded **once** at startup and stays
resident. Core never spawns a Python process per phrase.

* Transport: **JSON Lines** over the worker's `stdin` / `stdout`.
* One request = exactly one line of JSON on `stdin`, terminated by `\n`.
* One response = exactly one line of JSON on `stdout`, terminated by `\n`.
* `stdout` carries **only** protocol JSON. Anything else is a protocol violation.
* `stderr` carries human-readable logs only; core forwards them to the log file.
* Every request carries an `id`; every response echoes it. Requests may complete
  out of order (they currently do not, but the protocol does not promise ordering).

## Requests (core → worker)

### `transcribe`

```json
{
  "id": "req_01H...",
  "op": "transcribe",
  "audio_path": "/absolute/path/to/capture.wav",
  "language": "ru",
  "initial_prompt": "React Query, useEffect, userData",
  "silence_threshold": 0.008
}
```

* `language`: `"auto" | "ru" | "en"`. `"auto"` means let Whisper detect it.
* `initial_prompt`: may be an empty string. Never longer than the configured budget.
* `audio_path`: mono 16 kHz PCM WAV. The worker does not delete it; core owns its lifetime.
* Captures longer than 31 minutes are rejected with `error_code: "audio_invalid"`
  before any frame is decoded (the settings schema caps `maxRecordingSeconds` at
  1800 s; the extra minute absorbs stop latency).
* A `transcribe` whose `id` is already in flight is dropped with a warning in the
  stderr log — never queued a second time — so every id still receives exactly one
  terminal response.

### `cancel`

```json
{ "id": "req_ctl_1", "op": "cancel", "target_id": "req_01H..." }
```

Best-effort. A decode already inside MLX cannot be interrupted mid-frame; the worker
marks the request cancelled and refuses to emit its result. Core must also enforce its
own timeout and must not wait for a `cancel` acknowledgement before failing the request.

The worker acknowledges the control request itself:

```json
{ "id": "req_ctl_1", "ok": true, "op": "cancel", "target_id": "req_01H...", "cancelled": true }
```

`cancelled` is `false` when the target had already been answered or never existed.

The cancelled request gets its own terminal line, emitted **immediately** by the cancel
handler rather than when the abandoned decode finishes:

```json
{ "id": "req_01H...", "ok": false, "op": "transcribe", "error_code": "cancelled" }
```

So every request id receives exactly one terminal response and core never blocks on MLX.
The GPU work itself still runs to completion in the background — cancellation frees core,
not the accelerator.

### `health`

```json
{ "id": "req_02H...", "op": "health" }
```

### `shutdown`

```json
{ "id": "req_03H...", "op": "shutdown" }
```

The worker flushes, replies `{"id": "req_03H...", "ok": true, "op": "shutdown"}`, and exits
with code 0. Any transcribe still queued is first answered with `error_code: "cancelled"`
and the message `worker is shutting down`, so no request id is left unanswered.

Nothing is ever written to stdout after the shutdown acknowledgement, so core may close
the pipe as soon as it arrives.

## Responses (worker → core)

### Success — `transcribe`

```json
{
  "id": "req_01H...",
  "ok": true,
  "op": "transcribe",
  "raw_transcript": "Так смотри, этот useEffect...",
  "detected_language": "ru",
  "audio_duration_ms": 6188,
  "transcription_ms": 781,
  "model": "mlx-community/whisper-large-v3-turbo",
  "no_speech": false,
  "warnings": ["silence_trimmed"]
}
```

`no_speech: true` means the audio held no usable speech. `raw_transcript` is then `""`
and core cancels the dictation without creating a history record.

### Success — `health`

```json
{
  "id": "req_02H...",
  "ok": true,
  "op": "health",
  "state": "ready",
  "ready": true,
  "backend": "mlx-whisper",
  "model": "mlx-community/whisper-large-v3-turbo",
  "device": "gpu",
  "load_ms": 3120,
  "warmed_up": true
}
```

`state` ∈ `starting | loading | ready | error`.

### Error

```json
{
  "id": "req_01H...",
  "ok": false,
  "op": "transcribe",
  "error_code": "audio_invalid",
  "error": "cannot read wav '/absolute/path/to/capture.wav': [Errno 2] No such file or directory: '/absolute/path/to/capture.wav'"
}
```

`error_code` ∈ `audio_invalid | model_not_loaded | cancelled | internal`.

### Unsolicited status events

The worker pushes these while loading, with `id: null`. Core relays them to SSE clients
so the dashboard can show real load progress instead of a spinner.

```json
{ "id": null, "ok": true, "op": "status", "state": "loading", "ready": false, "model": "..." }
{ "id": null, "ok": true, "op": "status", "state": "ready",   "ready": true,  "load_ms": 3120, "warmed_up": true }
```

## Startup sequence

1. Core spawns the worker with `--model <id>` and optional `--no-warmup`.
2. Worker emits `status: starting` immediately, before importing MLX (the import itself
   takes seconds, and the dashboard must not look hung).
3. Worker loads the model, emits `status: loading`.
4. Worker runs a warm-up decode on 1 s of generated silence so the first real phrase does
   not pay MLX's lazy-compilation cost. Warm-up failures are logged, not fatal.
5. Worker emits `status: ready` and begins reading requests.

## Crash handling

Core supervises the process. On unexpected exit it:

* fails every in-flight request with `stt_unavailable`,
* restarts with exponential backoff (1 s, 2 s, 4 s, capped at 30 s),
* counts restarts and surfaces the count in `/api/status`.

The worker also polices itself: a watchdog thread ends the process (exit code 3)
when the model load overruns its budget or a single decode overruns a generous,
audio-length-scaled deadline. A thread wedged inside Metal or a stalled download
cannot be interrupted from Python, so a hard exit — and core's restart with
backoff — is the recovery path.

## Silence handling

The worker trims leading and trailing silence before decoding, using a conservative
threshold so quiet human speech survives. If, after trimming, less than 200 ms of audio
remains, the response is `no_speech: true` — this is what stops Whisper from hallucinating
"Продолжение следует..." on an empty capture.
