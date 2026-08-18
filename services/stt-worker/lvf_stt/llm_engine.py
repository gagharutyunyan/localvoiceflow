"""MLX text-correction engine: one local model, one cached system prompt.

Latency shape this module is built around (measured on an M1 Pro with
Qwen3-4B-Instruct-2507-4bit):

* loading the model from disk: ~1.2 s, once per process;
* pre-filling the ~1300-token system prompt: ~5 s, once per prompt text —
  the KV cache is kept and rewound to the prompt boundary after every request;
* an actual correction then costs only the user-payload prefill plus generation:
  ~0.6 s for a short phrase, ~2.3 s for a paragraph.

Everything MLX runs on the worker's single MLX thread (see ``llm_worker``); this
module is written as if single-threaded except for ``snapshot``, which any thread
may call.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, replace
from typing import Any, Callable

log = logging.getLogger(__name__)

DEFAULT_LLM_MODEL = "mlx-community/Qwen3-4B-Instruct-2507-4bit"

#: Hard ceiling on generated tokens; the auto cap below stays well under it.
MAX_GENERATION_TOKENS = 8192

#: How often the generation loop checks for cancellation, in tokens. Checking every
#: token would serialise the async GPU pipeline for no benefit.
_CANCEL_CHECK_EVERY = 8


class ModelNotLoadedError(RuntimeError):
    pass


def auto_max_tokens(prompt_suffix_tokens: int) -> int:
    """Cap for the reply: edited dictation is about as long as its input, so twice the
    input plus slack is generous — and it stops a runaway generation from holding the
    pipeline for minutes.

    The ceiling is :data:`MAX_GENERATION_TOKENS`, not a tighter constant: a three-minute
    dictation is several thousand tokens, and a cap below its own input silently cut the
    tail off the user's text — the reply stopped mid-sentence and only a warning said so.
    """
    return min(MAX_GENERATION_TOKENS, prompt_suffix_tokens * 2 + 256)


@dataclass(frozen=True)
class LlmEngineState:
    model: str
    state: str = "starting"  # starting | loading | ready | error
    ready: bool = False
    load_ms: int | None = None
    warmed_prompt: bool = False
    error: str | None = None


@dataclass(frozen=True)
class CorrectionOutput:
    text: str
    prompt_tokens: int
    generation_tokens: int
    generation_ms: int
    finish_reason: str  # "stop" | "length" | "cancelled"


class LlmEngine:
    """Owns the model, the tokenizer and the system-prompt KV cache."""

    def __init__(self, model: str) -> None:
        self.model = model
        self._state = LlmEngineState(model=model)
        self._state_lock = threading.Lock()
        self._mlx_model: Any = None
        self._tokenizer: Any = None
        self._sampler: Any = None
        # The cached system prompt: token ids, and a KV cache holding exactly them.
        self._prefix_tokens: list[int] | None = None
        self._prefix_text: str | None = None
        self._cache: Any = None

    # -- state ------------------------------------------------------------------

    def snapshot(self) -> LlmEngineState:
        with self._state_lock:
            return self._state

    def _set_state(self, **changes: Any) -> LlmEngineState:
        with self._state_lock:
            self._state = replace(self._state, **changes)
            return self._state

    # -- lifecycle ---------------------------------------------------------------

    def load(self, on_status: Callable[[LlmEngineState], None] | None = None) -> LlmEngineState:
        """Loads the model. Downloads weights on first use, which can take minutes."""

        def emit(state: LlmEngineState) -> None:
            if on_status is not None:
                on_status(state)

        emit(self._set_state(state="loading", ready=False, error=None))
        started = time.perf_counter()
        try:
            from mlx_lm import load as mlx_load

            self._mlx_model, self._tokenizer = mlx_load(self.model)
            from mlx_lm.sample_utils import make_sampler

            # temp=0: corrections must be reproducible, not creative.
            self._sampler = make_sampler(temp=0.0)
        except Exception as exc:
            log.error("llm model load failed: %s", exc, exc_info=True)
            state = self._set_state(state="error", ready=False, error=str(exc))
            emit(state)
            return state

        load_ms = int((time.perf_counter() - started) * 1000)
        state = self._set_state(state="ready", ready=True, load_ms=load_ms, error=None)
        log.info("llm model %s loaded in %d ms", self.model, load_ms)
        emit(state)
        return state

    # -- prompt cache ------------------------------------------------------------

    def _tokenize_messages(self, messages: list[dict[str, str]], add_generation_prompt: bool) -> list[int]:
        try:
            return self._tokenizer.apply_chat_template(
                messages,
                add_generation_prompt=add_generation_prompt,
                tokenize=True,
                enable_thinking=False,
            )
        except TypeError:
            # Template without the enable_thinking knob (non-hybrid models).
            return self._tokenizer.apply_chat_template(
                messages, add_generation_prompt=add_generation_prompt, tokenize=True
            )

    def _cache_offset(self) -> int:
        return int(self._cache[0].offset) if self._cache else 0

    def _rewind_cache_to_prefix(self) -> None:
        """Drop everything past the system prompt; on any failure rebuild from scratch
        on the next request rather than trusting a possibly-corrupt cache."""
        if self._cache is None or self._prefix_tokens is None:
            return
        from mlx_lm.models.cache import can_trim_prompt_cache, trim_prompt_cache

        try:
            excess = self._cache_offset() - len(self._prefix_tokens)
            if excess <= 0:
                return
            if not can_trim_prompt_cache(self._cache):
                raise RuntimeError("prompt cache is not trimmable")
            trim_prompt_cache(self._cache, excess)
        except Exception as exc:
            log.warning("prompt cache rewind failed (%s); dropping the cache", exc)
            self._cache = None
            self._prefix_tokens = None
            self._prefix_text = None

    def warm(self, system_prompt: str) -> tuple[bool, int, int]:
        """Ensures the KV cache holds exactly ``system_prompt``.

        Returns ``(did_prefill, prefix_tokens, elapsed_ms)``. A matching cache is a
        no-op, so core can send ``warm`` on every reconnect and settings change.
        """
        if not self.snapshot().ready:
            raise ModelNotLoadedError("model is not loaded")
        if self._prefix_text == system_prompt and self._cache is not None:
            return False, len(self._prefix_tokens or []), 0

        import mlx.core as mx
        from mlx_lm.models.cache import make_prompt_cache

        started = time.perf_counter()
        prefix = list(
            self._tokenize_messages(
                [{"role": "system", "content": system_prompt}], add_generation_prompt=False
            )
        )
        cache = make_prompt_cache(self._mlx_model)
        # One manual forward materialises the whole prefix into the cache. Chunked to
        # bound peak memory on very long custom prompts.
        step = 2048
        for start in range(0, len(prefix), step):
            chunk = prefix[start : start + step]
            self._mlx_model(mx.array(chunk)[None], cache=cache)
            mx.eval([c.state for c in cache])
        mx.clear_cache()

        self._cache = cache
        self._prefix_tokens = prefix
        self._prefix_text = system_prompt
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        self._set_state(warmed_prompt=True)
        log.info("system prompt warmed: %d tokens in %d ms", len(prefix), elapsed_ms)
        return True, len(prefix), elapsed_ms

    # -- correction --------------------------------------------------------------

    def correct(
        self,
        system_prompt: str,
        payload: str,
        max_tokens: int = 0,
        is_cancelled: Callable[[], bool] | None = None,
    ) -> CorrectionOutput:
        """Runs one correction. The system-prompt KV cache is reused when it matches
        and rebuilt when it does not; either way the cache is rewound to the prompt
        boundary before returning, so requests never see each other."""
        if not self.snapshot().ready:
            raise ModelNotLoadedError("model is not loaded")

        from mlx_lm import stream_generate

        self.warm(system_prompt)
        assert self._prefix_tokens is not None

        full = list(
            self._tokenize_messages(
                [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": payload},
                ],
                add_generation_prompt=True,
            )
        )
        prefix_len = len(self._prefix_tokens)
        if full[:prefix_len] != self._prefix_tokens:
            # A chat template where system+user does not extend the system-only render
            # would silently corrupt the cache; fall back to an uncached full prompt.
            log.warning("chat template is not prefix-stable; running without the cache")
            from mlx_lm.models.cache import make_prompt_cache

            self._cache = make_prompt_cache(self._mlx_model)
            self._prefix_tokens = []
            self._prefix_text = None
            prefix_len = 0

        suffix = full[prefix_len:]
        cap = max_tokens if max_tokens > 0 else auto_max_tokens(len(suffix))
        cap = min(cap, MAX_GENERATION_TOKENS)

        started = time.perf_counter()
        pieces: list[str] = []
        generated = 0
        finish_reason = "stop"
        try:
            for response in stream_generate(
                self._mlx_model,
                self._tokenizer,
                prompt=suffix,
                max_tokens=cap,
                sampler=self._sampler,
                prompt_cache=self._cache,
            ):
                pieces.append(response.text)
                generated = response.generation_tokens
                if (
                    is_cancelled is not None
                    and generated % _CANCEL_CHECK_EVERY == 0
                    and is_cancelled()
                ):
                    finish_reason = "cancelled"
                    break
            else:
                if generated >= cap:
                    finish_reason = "length"
        finally:
            self._rewind_cache_to_prefix()

        return CorrectionOutput(
            text="".join(pieces).strip(),
            prompt_tokens=len(full),
            generation_tokens=generated,
            generation_ms=int((time.perf_counter() - started) * 1000),
            finish_reason=finish_reason,
        )
