# stt-worker

The LocalVoiceFlow speech-to-text worker: one long-lived Python process that keeps an
MLX Whisper model resident on the GPU and speaks JSON Lines over `stdin`/`stdout`.

The wire format is specified in [`docs/STT_PROTOCOL.md`](../../docs/STT_PROTOCOL.md).
That document is the contract; this file only explains how the implementation meets it.

## Setup

`uv` is not installed on this machine, so the worker uses a plain venv:

```sh
/opt/homebrew/bin/python3.14 -m venv services/stt-worker/.venv
services/stt-worker/.venv/bin/pip install mlx-whisper numpy
```

## Running

```sh
services/stt-worker/.venv/bin/python -m lvf_stt \
    --model mlx-community/whisper-large-v3-turbo \
    [--no-warmup] [--log-level error|warn|info|debug]
```

Run it from `services/stt-worker/` (or install the package) so `lvf_stt` is importable.
Core spawns it with an argv array and `shell: false`; there is no shell involved anywhere.

Drive it by hand:

```sh
printf '%s\n' \
  '{"id":"1","op":"health"}' \
  '{"id":"2","op":"transcribe","audio_path":"/tmp/x.wav","language":"ru"}' \
  '{"id":"3","op":"shutdown"}' \
  | .venv/bin/python -m lvf_stt
```

## Modules

| Module | Responsibility | Imports MLX? |
|---|---|---|
| `protocol.py` | request/response dataclasses, parse + serialise | no — stdlib only |
| `audio.py` | WAV reading, downmix/resample repair, silence trimming | no — numpy only |
| `engine.py` | model load, warm-up, decode, text normalisation, filler guard | lazily, inside `load()` |
| `worker.py` | the stdin/stdout loop, dispatch, cancellation | no |
| `__main__.py` | argparse, logging, stdout claiming | no |

`protocol.py` and `audio.py` are importable on any machine, which is what lets the test
suite run without Apple Silicon.

## Design notes

**One MLX thread.** MLX streams are thread-local: weights materialised on one thread
cannot be decoded from another (`RuntimeError: There is no Stream(gpu, 1) in current
thread`). The import, the model load, the warm-up and every decode therefore run on a
single dedicated daemon thread. The main thread does nothing but read stdin, so `health`
and `cancel` are answered in microseconds even mid-decode.

**stdout is claimed.** `mlx_whisper` prints the detected language to stdout, and
`huggingface_hub` draws progress bars. Either would corrupt the stream core is parsing.
`__main__` duplicates fd 1 for the protocol and then points fd 1 at stderr, so stray
output lands in the log instead. Belt and braces: the decode kwargs use `verbose=None`,
which is the only fully silent setting — counterintuitively, `verbose=False` *enables*
the progress bar (`disable = verbose is not False`) and still prints the language.

**Warm-up on dithered near-silence.** A block of exact zeros sends Whisper straight down
its no-speech branch, so the decoder loop the first real phrase needs never gets compiled.
`audio.near_silence()` generates 1 s of ~1e-4 noise instead. Warm-up failure is logged and
non-fatal, per the protocol.

**Silence trimming is conservative.** The default peak threshold is 0.008 — quiet Russian
speech at arm's length peaks around 0.02–0.05, so anything higher starts clipping words.
150 ms of padding is kept on each side so plosives are not eaten. The no-speech decision is
made on the *voiced span* (first to last sample above threshold), not on the padded output,
otherwise the padding alone would always clear the 200 ms bar.

**Hallucination guard.** Whisper emits subtitle-credit phrases on silence
("Продолжение следует...", "Субтитры сделал DimaTorzok", "Thank you.", "you"). The denylist in
`engine.HALLUCINATION_DENYLIST` is consulted **only** when the capture was short
(≤ 1800 ms voiced) or quiet (peak ≤ 0.05), and only against the whole normalised
transcript — never a substring. A real sentence that merely starts with one of those
phrases is kept.

**Transcript normalisation.** NFC composition, whitespace runs collapsed, Whisper's
leading space stripped. NFC matters because Whisper can emit decomposed Cyrillic
(`и` + combining breve), which SQLite and the glossary would treat as a different string.

**Audio repair.** The agent is contracted to send mono 16 kHz PCM, but stereo or 48 kHz
input is downmixed/resampled rather than rejected, with a warning recorded so the dashboard
can surface a misconfigured input device.

## Warnings vocabulary

`warnings` in a `transcribe` response is drawn from this closed set:

| Warning | Meaning |
|---|---|
| `downmixed_from_<n>ch` | input was not mono; channels were averaged |
| `resampled_from_<rate>hz` | input was not 16 kHz; linearly resampled |
| `sample_width_<n>bit` | input was not 16-bit PCM |
| `silence_trimmed` | leading/trailing silence was cut |
| `empty_transcript` | the model returned nothing for audio that held signal |
| `hallucination_filtered` | a known filler phrase was dropped from a short/quiet capture |

## Tests

No test dependency beyond numpy. Both runners work:

```sh
.venv/bin/python -m unittest discover -s tests
.venv/bin/python -m pytest -q          # if pytest happens to be installed
```

`tests/test_protocol.py` needs neither numpy nor MLX; `tests/test_audio.py` and
`tests/test_worker.py` need numpy only. The worker tests drive a real `Worker` over real
pipes with a fake engine, so dispatch, cancellation and shutdown are exercised end to end
without loading a model.

## Measured on this machine (M1 Pro, macOS 26.4.1, Python 3.14.6, mlx-whisper 0.4.3)

Model `mlx-community/whisper-large-v3-turbo`, already in the HF cache.

| Stage | Measurement |
|---|---|
| `status: starting` emitted | ~80 ms after spawn |
| model load (`load_ms`) | 1.5–2.1 s warm cache, 5.0 s on the first run of a session |
| warm-up decode | 1.5–3.9 s |
| spawn → `status: ready` | 3.0–5.2 s (with warm-up), 1.6 s (`--no-warmup`) |
| warm decode, 2.45 s of speech | **684 / 686 / 688 ms** |
| warm decode, repo fixtures (3.0–6.2 s of speech) | 681–726 ms |
| warm decode, 18.3 s of speech | 964–1060 ms |
| first decode with `--no-warmup` | 869 ms, vs 693 ms once warm |
| `language: "auto"` vs `"ru"` | +600 ms for the detection pass |
| silence → `no_speech` | ~0–1 ms (never reaches the model) |
| `cancel` acknowledgement mid-decode | < 1 ms |
| `shutdown` during model load → exit | 93 ms |

Startup performs one Hugging Face revision check over the network (~1 s). Setting
`HF_HUB_OFFLINE=1` in the worker's environment skips it once the model is cached —
measured `load_ms` 1141, spawn → ready 2735 ms, decode unchanged at 708 ms.
