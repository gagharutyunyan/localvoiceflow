"""The stdin/stdout JSON Lines loop.

Threading model:

* the **main thread** only reads stdin, parses, and dispatches — so ``health`` and
  ``cancel`` are answered in microseconds even while a decode is running;
* one **MLX thread** does everything else: the import, the model load, the warm-up
  and every decode, strictly in that order.

The single MLX thread is not a simplification, it is a requirement. MLX streams are
thread-local, so weights materialised on one thread cannot be decoded on another —
the failure is ``RuntimeError: There is no Stream(gpu, 1) in current thread``. It is
also a daemon thread, so ``shutdown`` returns control immediately instead of waiting
out a decode that nobody is going to read.

Every stdout write goes through :meth:`Worker._write` under a lock, so a status
event pushed during loading can never interleave with a response, and nothing at all
is written after the ``shutdown`` acknowledgement.

A **watchdog thread** guards the two places the MLX thread can block forever — the
load (including a first-run weight download) and each decode. A thread wedged inside
a C extension cannot be interrupted from Python, so on overrun the watchdog ends the
process; core's worker-client sees the exit and restarts with backoff, which is the
one recovery path that actually works.
"""

from __future__ import annotations

import collections
import logging
import os
import queue
import sys
import threading
import time
from typing import Any, Callable, TextIO

from . import audio as audio_mod
from . import protocol
from .engine import (
    ModelNotLoadedError,
    is_filler_hallucination,
    normalize_transcript,
)

log = logging.getLogger(__name__)

#: Budget for the model load, applied twice: a decode request waits at most this
#: long for loading to finish before giving up with ``model_not_loaded``, and the
#: watchdog ends the process if the load call itself has not returned by then. A
#: cold load measures ~4 s on an M1 Pro; the slack covers a first-run weight
#: download, which huggingface_hub resumes across the restart core performs.
DEFAULT_LOAD_TIMEOUT_S = 180.0

#: Watchdog floor for a single decode. Core has already failed the request at its
#: own ``requestTimeoutMs`` (120 s by default), so a decode still running this far
#: past any realistic finish is a wedged Metal call, not slow work.
DECODE_WATCHDOG_BASE_S = 120.0

#: Extra decode budget per second of trimmed audio. large-v3-turbo decodes at well
#: over 10x realtime on Apple Silicon, so 1x realtime of slack never fires on a
#: legitimate decode even for the longest configurable capture.
DECODE_WATCHDOG_PER_AUDIO_SECOND = 1.0

#: Bounded memory for cancels that arrive before their target request.
_CANCEL_HISTORY = 256


def _exit_on_timeout(reason: str) -> None:
    log.critical("watchdog: %s; exiting so core can restart the worker", reason)
    try:
        sys.stderr.flush()
    except OSError:
        pass
    # os._exit, not sys.exit: the stuck thread would survive a SystemExit raised
    # here, and nothing may run after the log line anyway.
    os._exit(3)


class Watchdog:
    """Hard deadline around blocking MLX calls.

    A Python thread stuck inside a C extension (a wedged Metal call, a download
    stalled mid-transfer) cannot be interrupted or timed out from Python. The only
    recovery that works is ending the process and letting core's supervisor
    restart the worker, so the default ``on_timeout`` logs the reason and calls
    ``os._exit``. Tests inject a recording handler instead.
    """

    def __init__(self, on_timeout: Callable[[str], None] | None = None) -> None:
        self._on_timeout = on_timeout or _exit_on_timeout
        self._cond = threading.Condition()
        self._deadline: float | None = None
        self._reason = ""
        self._thread: threading.Thread | None = None

    def arm(self, timeout_s: float, reason: str) -> None:
        with self._cond:
            self._deadline = time.monotonic() + timeout_s
            self._reason = reason
            if self._thread is None:
                self._thread = threading.Thread(
                    target=self._loop, name="lvf-watchdog", daemon=True
                )
                self._thread.start()
            self._cond.notify()

    def disarm(self) -> None:
        with self._cond:
            self._deadline = None
            self._reason = ""
            self._cond.notify()

    def _loop(self) -> None:
        while True:
            with self._cond:
                while self._deadline is None:
                    self._cond.wait()
                remaining = self._deadline - time.monotonic()
                if remaining > 0:
                    self._cond.wait(remaining)
                    continue
                reason = self._reason
                self._deadline = None
                self._reason = ""
            # Outside the lock: the default handler never returns, and a test
            # handler must be free to re-arm without deadlocking.
            self._on_timeout(reason)


class Worker:
    def __init__(
        self,
        engine: Any,
        stdin: TextIO,
        stdout: TextIO,
        *,
        load_timeout_s: float = DEFAULT_LOAD_TIMEOUT_S,
        decode_timeout_base_s: float = DECODE_WATCHDOG_BASE_S,
        decode_timeout_per_audio_s: float = DECODE_WATCHDOG_PER_AUDIO_SECOND,
        watchdog: Watchdog | None = None,
    ) -> None:
        self._engine = engine
        self._stdin = stdin
        self._stdout = stdout
        self._load_timeout_s = load_timeout_s
        self._decode_timeout_base_s = decode_timeout_base_s
        self._decode_timeout_per_audio_s = decode_timeout_per_audio_s
        self._watchdog = watchdog if watchdog is not None else Watchdog()

        self._stdout_lock = threading.Lock()
        self._state_lock = threading.Lock()
        #: Requests submitted for decoding and not yet answered. Membership is the
        #: right to answer: whoever removes an id owns the single response for it.
        self._inflight: set[str] = set()
        self._cancelled: collections.deque[str] = collections.deque(maxlen=_CANCEL_HISTORY)
        self._running = True
        self._closed = False
        self._exit_code = 0
        self._load_finished = threading.Event()
        self._jobs: queue.Queue[protocol.TranscribeRequest | None] = queue.Queue()
        self._mlx_thread = threading.Thread(
            target=self._mlx_loop, name="lvf-mlx", daemon=True
        )

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
                # Core died or closed the pipe; nothing left to talk to.
                self._running = False

    def _emit_status(self, state: Any) -> None:
        self._write(
            protocol.StatusEvent(
                state=state.state,
                ready=state.ready,
                model=state.model,
                load_ms=state.load_ms,
                warmed_up=state.warmed_up,
                error=state.error,
            )
        )

    def _respond_once(self, request_id: str, response: Any) -> bool:
        """Answer ``request_id`` exactly once. Returns False if already answered."""
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
        """The one thread MLX is ever touched from: load first, then decode forever."""
        self._load()
        while True:
            job = self._jobs.get()
            if job is None:
                return
            try:
                self._run_transcribe(job)
            except Exception as exc:  # a decode bug must not take the thread down
                log.error("decode job %s crashed: %s", job.id, exc, exc_info=True)
                self._respond_once(
                    job.id,
                    protocol.ErrorResponse(
                        id=job.id, op="transcribe", error_code="internal", error=str(exc)
                    ),
                )

    def _load(self) -> None:
        self._watchdog.arm(
            self._load_timeout_s,
            f"model load exceeded {self._load_timeout_s:.0f} s",
        )
        try:
            self._engine.load(on_status=self._emit_status)
        except BaseException as exc:  # engine.load already traps its own failures
            log.error("model load crashed: %s", exc, exc_info=True)
            self._write(
                protocol.StatusEvent(
                    state="error", ready=False, model=self._engine.model, error=str(exc)
                )
            )
        finally:
            self._watchdog.disarm()
            # Release waiting decodes even after a catastrophic failure, so they fail
            # fast with model_not_loaded instead of hanging until the timeout.
            self._load_finished.set()

    def _read_loop(self) -> None:
        while self._running:
            try:
                line = self._stdin.readline()
            except (KeyboardInterrupt, OSError, ValueError):
                # A torn-down stdin (EIO once core is gone) must end the loop the
                # same way a closed pipe does, not crash with a traceback.
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
            if isinstance(request, protocol.TranscribeRequest):
                self._handle_transcribe(request)
            elif isinstance(request, protocol.CancelRequest):
                self._handle_cancel(request)
            elif isinstance(request, protocol.HealthRequest):
                self._handle_health(request)
            elif isinstance(request, protocol.ShutdownRequest):
                self._handle_shutdown(request)
        except Exception as exc:  # a dispatch bug must not kill the process
            log.error("dispatch failed for %s: %s", request.op, exc, exc_info=True)
            self._write(
                protocol.ErrorResponse(
                    id=request.id, op=request.op, error_code="internal", error=str(exc)
                )
            )

    def _handle_health(self, request: protocol.HealthRequest) -> None:
        state = self._engine.snapshot()
        self._write(
            protocol.HealthResponse(
                id=request.id,
                state=state.state,
                ready=state.ready,
                model=state.model,
                device=state.device,
                load_ms=state.load_ms,
                warmed_up=state.warmed_up,
                error=state.error,
            )
        )

    def _handle_shutdown(self, request: protocol.ShutdownRequest) -> None:
        # Answer anything still queued before saying goodbye, so core never waits on
        # a request whose worker has already gone.
        with self._state_lock:
            pending = sorted(self._inflight)
        for request_id in pending:
            self._respond_once(
                request_id,
                protocol.ErrorResponse(
                    id=request_id,
                    op="transcribe",
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
        # Answer the target immediately rather than waiting for MLX to finish its
        # frame: core must not block on a decode it has already given up on.
        cancelled = self._respond_once(
            target,
            protocol.ErrorResponse(
                id=target,
                op="transcribe",
                error_code="cancelled",
                error="cancelled by core",
            ),
        )
        self._write(
            protocol.CancelResponse(id=request.id, target_id=target, cancelled=cancelled)
        )

    def _handle_transcribe(self, request: protocol.TranscribeRequest) -> None:
        with self._state_lock:
            if request.id in self._inflight:
                # A second job would burn GPU for a response nobody can receive:
                # membership in _inflight is the right to the single answer, so the
                # duplicate is dropped rather than answered with an error line that
                # core would take as the original request's terminal response.
                log.warning(
                    "duplicate transcribe id %s ignored; the original is still in flight",
                    request.id,
                )
                return
            self._inflight.add(request.id)
        self._jobs.put(request)

    # -- the actual decode ------------------------------------------------------

    def _run_transcribe(self, request: protocol.TranscribeRequest) -> None:
        started = time.perf_counter()

        def elapsed_ms() -> int:
            return int((time.perf_counter() - started) * 1000)

        def fail(code: str, message: str) -> None:
            self._respond_once(
                request.id,
                protocol.ErrorResponse(
                    id=request.id, op="transcribe", error_code=code, error=message
                ),
            )

        if self._is_cancelled(request.id):
            fail("cancelled", "cancelled before decode started")
            return

        try:
            clip = audio_mod.read_wav(request.audio_path)
        except audio_mod.AudioError as exc:
            fail("audio_invalid", str(exc))
            return
        except Exception as exc:
            log.error("unexpected error reading %r: %s", request.audio_path, exc, exc_info=True)
            fail("internal", f"failed to read audio: {exc}")
            return

        warnings = list(clip.warnings)
        audio_duration_ms = clip.duration_ms

        trim = audio_mod.trim_silence(
            clip.samples,
            clip.sample_rate,
            threshold=request.silence_threshold,
        )
        if trim.trimmed:
            warnings.append("silence_trimmed")

        if trim.no_speech:
            self._respond_once(
                request.id,
                protocol.TranscribeResponse(
                    id=request.id,
                    raw_transcript="",
                    detected_language=None,
                    audio_duration_ms=audio_duration_ms,
                    transcription_ms=elapsed_ms(),
                    model=self._engine.model,
                    no_speech=True,
                    warnings=warnings,
                ),
            )
            return

        if not self._load_finished.wait(self._load_timeout_s):
            fail("model_not_loaded", "model did not finish loading in time")
            return
        state = self._engine.snapshot()
        if not state.ready:
            fail("model_not_loaded", state.error or "model is not ready")
            return

        # Re-check: the model may have taken seconds to load and core may have
        # abandoned this request in the meantime.
        if self._is_cancelled(request.id):
            fail("cancelled", "cancelled while waiting for the model")
            return

        decode_budget_s = (
            self._decode_timeout_base_s
            + (trim.samples.size / audio_mod.TARGET_SAMPLE_RATE)
            * self._decode_timeout_per_audio_s
        )
        self._watchdog.arm(
            decode_budget_s,
            f"decode of request {request.id} exceeded {decode_budget_s:.0f} s",
        )
        try:
            result = self._engine.transcribe(
                trim.samples, request.language, request.initial_prompt
            )
        except ModelNotLoadedError as exc:
            fail("model_not_loaded", str(exc))
            return
        except Exception as exc:
            log.error("decode failed for %s: %s", request.id, exc, exc_info=True)
            fail("internal", f"decode failed: {exc}")
            return
        finally:
            self._watchdog.disarm()

        text = normalize_transcript(str(result.get("text", "") or ""))
        detected = result.get("language")
        detected_language = detected if isinstance(detected, str) and detected else None

        no_speech = False
        if not text:
            no_speech = True
            warnings.append("empty_transcript")
        elif is_filler_hallucination(
            text,
            duration_ms=trim.voiced_ms,
            peak=audio_mod.peak_amplitude(trim.samples),
        ):
            log.info("dropped filler hallucination for %s", request.id)
            warnings.append("hallucination_filtered")
            text = ""
            no_speech = True

        self._respond_once(
            request.id,
            protocol.TranscribeResponse(
                id=request.id,
                raw_transcript=text,
                detected_language=detected_language,
                audio_duration_ms=audio_duration_ms,
                transcription_ms=elapsed_ms(),
                model=self._engine.model,
                no_speech=no_speech,
                warnings=warnings,
            ),
        )
