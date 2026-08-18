"""MLX Whisper engine: load once, stay resident, decode warm.

The only module that touches ``mlx_whisper`` — and it does so lazily, inside
:meth:`WhisperEngine.load`. The import itself costs seconds, and the protocol
requires ``status: starting`` on stdout before that cost is paid.

Everything above the import boundary (text normalisation, the hallucination guard,
kwarg construction) is plain Python so it stays unit-testable on any machine.
"""

from __future__ import annotations

import importlib
import logging
import threading
import time
import unicodedata
from dataclasses import dataclass
from typing import Any

import numpy as np

from . import audio as audio_mod

log = logging.getLogger(__name__)


def normalize_transcript(text: str) -> str:
    """NFC, collapse whitespace runs, drop Whisper's leading space.

    Whisper emits decomposed forms for some Cyrillic (``и`` + combining breve for
    ``й``) depending on the tokenizer path; SQLite and the clipboard both treat those
    as different strings from the composed form, so normalising here keeps history
    search and glossary matching honest.
    """
    if not text:
        return ""
    composed = unicodedata.normalize("NFC", text)
    return " ".join(composed.split())


#: Phrases Whisper emits when handed silence or noise. They come from the training
#: corpus (YouTube subtitle credits, channel outros) and are never something a user
#: dictated into a 1-second capture. Compared after :func:`_denylist_key`, and only
#: consulted for audio that was both very short *and* very quiet — see
#: :func:`is_filler_hallucination`. Real speech is therefore never dropped.
HALLUCINATION_DENYLIST: frozenset[str] = frozenset(
    {
        "продолжение следует",
        "субтитры сделал dimatorzok",
        "субтитры делал dimatorzok",
        "субтитры и перевод выполнил dimatorzok",
        "редактор субтитров а.синецкая корректор а.егорова",
        "субтитры и корректировка егорова",
        "спасибо за просмотр",
        "спасибо за внимание",
        "подписывайтесь на канал",
        "продолжение в следующей серии",
        "thank you",
        "thanks for watching",
        "thank you for watching",
        "you",
        "bye",
        "so",
        "please subscribe",
        "subtitles by the amara.org community",
    }
)

#: A capture is eligible for the denylist only when it is BOTH this short and this
#: quiet. Exceeding either bound — a longer voiced span, or normal speaking level —
#: is proof of a real utterance, so a loud short "Bye" is never eaten.
FILLER_MAX_DURATION_MS = 1800
FILLER_MAX_PEAK = 0.05

_TRAILING_PUNCT = " .,!?…:;—-\"'«»„“”"


def _denylist_key(text: str) -> str:
    return normalize_transcript(text).strip(_TRAILING_PUNCT).casefold()


def is_filler_hallucination(text: str, *, duration_ms: int, peak: float) -> bool:
    """True when a short *and* quiet capture produced only a known filler phrase."""
    if duration_ms > FILLER_MAX_DURATION_MS or peak > FILLER_MAX_PEAK:
        return False
    return _denylist_key(text) in HALLUCINATION_DENYLIST


def build_transcribe_kwargs(
    model: str,
    language: str,
    initial_prompt: str,
    *,
    fp16: bool = True,
) -> dict[str, Any]:
    """Assemble the kwargs for ``mlx_whisper.transcribe``.

    Verified against mlx-whisper 0.4.3: the glossary hint kwarg is ``initial_prompt``
    and ``fp16`` reaches ``DecodingOptions`` through ``**decode_options``.
    ``language=None`` is what turns on Whisper's own language detection.
    """
    kwargs: dict[str, Any] = {
        # Counterintuitive but verified against 0.4.3: `verbose=False` *enables* the
        # tqdm progress bar (`disable = verbose is not False`) and still prints
        # "Detected language: ..." to stdout, which would corrupt the JSON stream.
        # Only `verbose=None` is fully silent.
        "verbose": None,
        "path_or_hf_repo": model,
        "fp16": fp16,
        "word_timestamps": False,
        # Each dictation is an independent utterance; carrying decoder context across
        # requests is exactly how Whisper starts repeating the previous phrase.
        "condition_on_previous_text": False,
    }
    lang = (language or "").strip().lower()
    kwargs["language"] = None if lang in ("", "auto") else lang
    prompt = (initial_prompt or "").strip()
    if prompt:
        kwargs["initial_prompt"] = prompt
    return kwargs


@dataclass
class EngineState:
    state: str = "starting"
    ready: bool = False
    model: str = ""
    device: str | None = None
    load_ms: int | None = None
    warmed_up: bool = False
    error: str | None = None


def _device_kind(mx: Any) -> str:
    """`Device(gpu, 0)` -> `"gpu"`, for the `device` field of a health response."""
    text = str(mx.default_device())
    if text.startswith("Device(") and "," in text:
        return text[len("Device(") : text.index(",")]
    return text


class ModelNotLoadedError(RuntimeError):
    """Raised when a decode is requested but the model never became available."""


class WhisperEngine:
    """Owns the resident model. Thread-safe for one decoder plus concurrent readers."""

    def __init__(self, model: str, *, warmup: bool = True, fp16: bool = True) -> None:
        self._model = model
        self._warmup = warmup
        self._fp16 = fp16
        self._mlx_whisper: Any = None
        self._state_lock = threading.Lock()
        self._loaded = threading.Event()
        self._state = EngineState(model=model)
        # The worker already funnels all MLX work onto one thread; this guards the
        # engine against a second caller (diagnostics, a benchmark) decoding
        # concurrently, which MLX does not support.
        self._decode_lock = threading.Lock()

    # -- state ------------------------------------------------------------------

    @property
    def model(self) -> str:
        return self._model

    def _snapshot_locked(self) -> EngineState:
        return EngineState(
            state=self._state.state,
            ready=self._state.ready,
            model=self._state.model,
            device=self._state.device,
            load_ms=self._state.load_ms,
            warmed_up=self._state.warmed_up,
            error=self._state.error,
        )

    def snapshot(self) -> EngineState:
        with self._state_lock:
            return self._snapshot_locked()

    def _set_state(self, **changes: Any) -> EngineState:
        with self._state_lock:
            for key, value in changes.items():
                setattr(self._state, key, value)
            return self._snapshot_locked()

    def wait_until_loaded(self, timeout: float | None = None) -> bool:
        return self._loaded.wait(timeout)

    # -- loading ----------------------------------------------------------------

    def load(self, on_status: Any = None) -> EngineState:
        """Import MLX, materialise the model, warm it up.

        ``on_status`` is called with an :class:`EngineState` after each transition so
        the worker can push the documented unsolicited status events.
        """

        def notify(state: EngineState) -> None:
            if on_status is not None:
                on_status(state)

        notify(self._set_state(state="loading", ready=False))
        started = time.perf_counter()
        try:
            self._mlx_whisper = importlib.import_module("mlx_whisper")
            mx = importlib.import_module("mlx.core")
            device_kind = _device_kind(mx)

            self._prime_model(mx)
            load_ms = int((time.perf_counter() - started) * 1000)
            self._set_state(device=device_kind, load_ms=load_ms)
        except Exception as exc:  # model download/IO/MLX failures are all fatal here
            log.error("model load failed: %s", exc, exc_info=True)
            state = self._set_state(state="error", ready=False, error=str(exc))
            self._loaded.set()
            notify(state)
            return state

        if self._warmup:
            self._run_warmup()

        state = self._set_state(state="ready", ready=True, error=None)
        self._loaded.set()
        notify(state)
        return state

    def _prime_model(self, mx: Any) -> None:
        """Materialise the weights before the first real request.

        mlx-whisper caches the model in ``transcribe.ModelHolder`` keyed by
        (repo, dtype), so priming it with the dtype the real decodes will use means
        those decodes never touch disk. If a future version drops ModelHolder the
        warm-up decode still loads the model — just without a separate load_ms.
        """
        dtype = mx.float16 if self._fp16 else mx.float32
        try:
            transcribe_mod = importlib.import_module("mlx_whisper.transcribe")
            holder = transcribe_mod.ModelHolder
        except (ImportError, AttributeError):
            log.warning("mlx_whisper.transcribe.ModelHolder unavailable; deferring load")
            return
        holder.get_model(self._model, dtype)

    def _run_warmup(self) -> None:
        """One decode over generated near-silence, to pay MLX's lazy compilation cost."""
        try:
            started = time.perf_counter()
            with self._decode_lock:
                self._mlx_whisper.transcribe(
                    audio_mod.near_silence(1.0),
                    **build_transcribe_kwargs(self._model, "auto", "", fp16=self._fp16),
                )
            elapsed = int((time.perf_counter() - started) * 1000)
            log.info("warm-up decode finished in %d ms", elapsed)
            self._set_state(warmed_up=True)
        except Exception as exc:  # non-fatal by contract
            # `warmed_up` stays False, which is how core learns the first real phrase
            # will pay MLX's lazy-compilation cost.
            log.warning("warm-up failed (continuing without it): %s", exc)

    # -- decoding ---------------------------------------------------------------

    def transcribe(
        self,
        audio: str | np.ndarray,
        language: str = "auto",
        initial_prompt: str = "",
    ) -> dict[str, Any]:
        """Decode a path or an already-loaded float32 mono array.

        The worker passes an array because it has already trimmed silence; a path is
        accepted so the engine stays usable on its own (diagnostics, benchmarks).
        """
        if self._mlx_whisper is None:
            raise ModelNotLoadedError("mlx_whisper is not loaded")
        kwargs = build_transcribe_kwargs(
            self._model, language, initial_prompt, fp16=self._fp16
        )
        with self._decode_lock:
            return self._mlx_whisper.transcribe(audio, **kwargs)
