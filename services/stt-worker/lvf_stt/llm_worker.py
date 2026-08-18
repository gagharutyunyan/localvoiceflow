"""The stdin/stdout JSON Lines loop for the local text-correction worker.

Same threading model as :mod:`lvf_stt.worker`, and for the same reasons:

* the **main thread** only reads stdin, parses, and dispatches — ``health`` and
  ``cancel`` are answered in microseconds even while a generation is running;
* one **MLX thread** does the import, the model load, the prompt warm-up and every
  generation, strictly in that order (MLX streams are thread-local);
* the shared **watchdog** ends the process if a load or a generation wedges inside
  Metal, and core's supervisor restarts it with backoff.
"""

from __future__ import annotations

import collections
import logging
import queue
import threading
import time
from typing import Any, TextIO

from . import llm_protocol as protocol
from .llm_engine import ModelNotLoadedError
from .worker import Watchdog

log = logging.getLogger(__name__)

#: Budget for the model load. Generous because the first run downloads ~2.3 GB of
#: weights; huggingface_hub resumes the download across the restart core performs.
DEFAULT_LLM_LOAD_TIMEOUT_S = 600.0

#: Watchdog ceiling for one correction. Generation is bounded by the engine's token
#: cap (~2048 tokens, well under a minute); anything near this is a wedged Metal call.
CORRECT_WATCHDOG_S = 120.0

#: Bounded memory for cancels that arrive before their target request.
_CANCEL_HISTORY = 256


class LlmWorker:
    def __init__(
        self,
        engine: Any,
        stdin: TextIO,
        stdout: TextIO,
        *,
        load_timeout_s: float = DEFAULT_LLM_LOAD_TIMEOUT_S,
        correct_timeout_s: float = CORRECT_WATCHDOG_S,
        watchdog: Watchdog | None = None,
    ) -> None:
        self._engine = engine
        self._stdin = stdin
        self._stdout = stdout
        self._load_timeout_s = load_timeout_s
        self._correct_timeout_s = correct_timeout_s
        self._watchdog = watchdog if watchdog is not None else Watchdog()

        self._stdout_lock = threading.Lock()
        self._state_lock = threading.Lock()
        #: Requests submitted to the MLX thread and not yet answered. Membership is
        #: the right to answer: whoever removes an id owns the single response.
        self._inflight: set[str] = set()
        self._cancelled: collections.deque[str] = collections.deque(maxlen=_CANCEL_HISTORY)
        self._running = True
        self._closed = False
        self._exit_code = 0
        self._load_finished = threading.Event()
        self._jobs: queue.Queue[protocol.CorrectRequest | protocol.WarmRequest | None] = (
            queue.Queue()
        )
        self._mlx_thread = threading.Thread(target=self._mlx_loop, name="lvf-llm", daemon=True)

    # -- output -----------------------------------------------------------------

    def _write(self, response: Any) -> None:
        line = protocol.encode_response(response)
        with self._stdout_lock:
            if self._closed:
                return
            try:
                self._stdout.write(line + "\n")
                self._stdout.flush()
            except (BrokenPipeError, ValueError):
                self._running = False

    def _emit_status(self, state: Any) -> None:
        self._write(
            protocol.StatusEvent(
                state=state.state,
                ready=state.ready,
                model=state.model,
                load_ms=state.load_ms,
                warmed_prompt=state.warmed_prompt,
                error=state.error,
            )
        )

    def _respond_once(self, request_id: str, response: Any) -> bool:
        with self._state_lock:
            if request_id not in self._inflight:
                return False
            self._inflight.discard(request_id)
        self._write(response)
        return True

    # -- cancellation -----------------------------------------------------------

    def _mark_cancelled(self, target_id: str) -> None:
        with self._state_lock:
            if target_id not in self._cancelled:
                self._cancelled.append(target_id)

    def _is_cancelled(self, request_id: str) -> bool:
        with self._state_lock:
            return request_id in self._cancelled

    # -- lifecycle --------------------------------------------------------------

    def run(self) -> int:
        self._write(
            protocol.StatusEvent(state="starting", ready=False, model=self._engine.model)
        )
        self._mlx_thread.start()
        try:
            self._read_loop()
        finally:
            self._running = False
            self._jobs.put(None)
        return self._exit_code

    def _mlx_loop(self) -> None:
        self._load()
        while True:
            job = self._jobs.get()
            if job is None:
                return
            try:
                if isinstance(job, protocol.WarmRequest):
                    self._run_warm(job)
                else:
                    self._run_correct(job)
            except Exception as exc:  # a job bug must not take the thread down
                log.error("llm job %s crashed: %s", job.id, exc, exc_info=True)
                self._respond_once(
                    job.id,
                    protocol.ErrorResponse(
                        id=job.id, op=job.op, error_code="internal", error=str(exc)
                    ),
                )

    def _load(self) -> None:
        self._watchdog.arm(
            self._load_timeout_s, f"llm model load exceeded {self._load_timeout_s:.0f} s"
        )
        try:
            self._engine.load(on_status=self._emit_status)
        except BaseException as exc:
            log.error("llm model load crashed: %s", exc, exc_info=True)
            self._write(
                protocol.StatusEvent(
                    state="error", ready=False, model=self._engine.model, error=str(exc)
                )
            )
        finally:
            self._watchdog.disarm()
            self._load_finished.set()

    def _read_loop(self) -> None:
        while self._running:
            try:
                line = self._stdin.readline()
            except (KeyboardInterrupt, OSError, ValueError):
                break
            if line == "":
                log.info("stdin closed, exiting")
                break
            if not line.strip():
                continue
            self._dispatch(line)

    # -- dispatch ---------------------------------------------------------------

    def _dispatch(self, line: str) -> None:
        try:
            request = protocol.decode_request(line)
        except protocol.ProtocolError as exc:
            log.warning("rejected request: %s", exc.message)
            self._write(protocol.error_from(exc))
            return

        try:
            if isinstance(request, (protocol.CorrectRequest, protocol.WarmRequest)):
                self._enqueue(request)
            elif isinstance(request, protocol.CancelRequest):
                self._handle_cancel(request)
            elif isinstance(request, protocol.HealthRequest):
                self._handle_health(request)
            elif isinstance(request, protocol.ShutdownRequest):
                self._handle_shutdown(request)
        except Exception as exc:
            log.error("dispatch failed for %s: %s", request.op, exc, exc_info=True)
            self._write(
                protocol.ErrorResponse(
                    id=request.id, op=request.op, error_code="internal", error=str(exc)
                )
            )

    def _enqueue(self, request: protocol.CorrectRequest | protocol.WarmRequest) -> None:
        with self._state_lock:
            if request.id in self._inflight:
                log.warning("duplicate llm request id %s ignored", request.id)
                return
            self._inflight.add(request.id)
        self._jobs.put(request)

    def _handle_health(self, request: protocol.HealthRequest) -> None:
        state = self._engine.snapshot()
        self._write(
            protocol.HealthResponse(
                id=request.id,
                state=state.state,
                ready=state.ready,
                model=state.model,
                load_ms=state.load_ms,
                warmed_prompt=state.warmed_prompt,
                error=state.error,
            )
        )

    def _handle_shutdown(self, request: protocol.ShutdownRequest) -> None:
        with self._state_lock:
            pending = sorted(self._inflight)
        for request_id in pending:
            self._respond_once(
                request_id,
                protocol.ErrorResponse(
                    id=request_id,
                    op="correct",
                    error_code="cancelled",
                    error="worker is shutting down",
                ),
            )
        self._write(protocol.ShutdownResponse(id=request.id))
        with self._stdout_lock:
            self._closed = True
        self._running = False
        self._exit_code = 0

    def _handle_cancel(self, request: protocol.CancelRequest) -> None:
        target = request.target_id
        self._mark_cancelled(target)
        # Answer the target immediately; the generation loop notices the flag and
        # stops emitting tokens shortly after.
        cancelled = self._respond_once(
            target,
            protocol.ErrorResponse(
                id=target, op="correct", error_code="cancelled", error="cancelled by core"
            ),
        )
        self._write(
            protocol.CancelResponse(id=request.id, target_id=target, cancelled=cancelled)
        )

    # -- the actual jobs ---------------------------------------------------------

    def _await_model(self, request_id: str, op: str) -> bool:
        if not self._load_finished.wait(self._load_timeout_s):
            self._respond_once(
                request_id,
                protocol.ErrorResponse(
                    id=request_id,
                    op=op,
                    error_code="model_not_loaded",
                    error="model did not finish loading in time",
                ),
            )
            return False
        state = self._engine.snapshot()
        if not state.ready:
            self._respond_once(
                request_id,
                protocol.ErrorResponse(
                    id=request_id,
                    op=op,
                    error_code="model_not_loaded",
                    error=state.error or "model is not ready",
                ),
            )
            return False
        return True

    def _run_warm(self, request: protocol.WarmRequest) -> None:
        if not self._await_model(request.id, "warm"):
            return
        started = time.perf_counter()
        self._watchdog.arm(self._correct_timeout_s, f"warm {request.id} wedged")
        try:
            did, tokens, _ = self._engine.warm(request.system_prompt)
        except ModelNotLoadedError as exc:
            self._respond_once(
                request.id,
                protocol.ErrorResponse(
                    id=request.id, op="warm", error_code="model_not_loaded", error=str(exc)
                ),
            )
            return
        finally:
            self._watchdog.disarm()
        self._respond_once(
            request.id,
            protocol.WarmResponse(
                id=request.id,
                warmed=did,
                prompt_tokens=tokens,
                warm_ms=int((time.perf_counter() - started) * 1000),
            ),
        )
        # The prompt cache state changed; let core's health display catch up.
        self._emit_status(self._engine.snapshot())

    def _run_correct(self, request: protocol.CorrectRequest) -> None:
        if self._is_cancelled(request.id):
            self._respond_once(
                request.id,
                protocol.ErrorResponse(
                    id=request.id,
                    op="correct",
                    error_code="cancelled",
                    error="cancelled before generation started",
                ),
            )
            return
        if not self._await_model(request.id, "correct"):
            return

        self._watchdog.arm(
            self._correct_timeout_s,
            f"correction {request.id} exceeded {self._correct_timeout_s:.0f} s",
        )
        try:
            output = self._engine.correct(
                request.system_prompt,
                request.payload,
                max_tokens=request.max_tokens,
                is_cancelled=lambda: self._is_cancelled(request.id),
            )
        except ModelNotLoadedError as exc:
            self._respond_once(
                request.id,
                protocol.ErrorResponse(
                    id=request.id, op="correct", error_code="model_not_loaded", error=str(exc)
                ),
            )
            return
        except Exception as exc:
            log.error("correction failed for %s: %s", request.id, exc, exc_info=True)
            self._respond_once(
                request.id,
                protocol.ErrorResponse(
                    id=request.id, op="correct", error_code="internal", error=str(exc)
                ),
            )
            return
        finally:
            self._watchdog.disarm()

        if output.finish_reason == "cancelled":
            # cancel() already answered this id; nothing more to say.
            self._respond_once(
                request.id,
                protocol.ErrorResponse(
                    id=request.id, op="correct", error_code="cancelled", error="cancelled"
                ),
            )
            return

        self._respond_once(
            request.id,
            protocol.CorrectResponse(
                id=request.id,
                text=output.text,
                model=self._engine.model,
                prompt_tokens=output.prompt_tokens,
                generation_tokens=output.generation_tokens,
                generation_ms=output.generation_ms,
                finish_reason=output.finish_reason,
            ),
        )
