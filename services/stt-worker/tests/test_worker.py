"""Worker dispatch driven over real pipes with a fake engine — no MLX involved."""

from __future__ import annotations

import json
import os
import queue
import sys
import tempfile
import threading
import unittest
import wave
from unittest import mock

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lvf_stt import audio  # noqa: E402
from lvf_stt.engine import (  # noqa: E402
    EngineState,
    WhisperEngine,
    build_transcribe_kwargs,
    is_filler_hallucination,
    normalize_transcript,
)
from lvf_stt.worker import Worker  # noqa: E402

RECV_TIMEOUT = 10.0


def write_wav(path: str, samples: np.ndarray, sample_rate: int = 16_000) -> None:
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(
            np.clip(np.asarray(samples, dtype=np.float32) * 32767.0, -32768, 32767)
            .astype("<i2")
            .tobytes()
        )


def tone(duration_s: float, amplitude: float = 0.3, sample_rate: int = 16_000) -> np.ndarray:
    t = np.arange(int(duration_s * sample_rate), dtype=np.float32) / sample_rate
    return (np.sin(2 * np.pi * 220.0 * t) * amplitude).astype(np.float32)


class FakeEngine:
    """Stands in for :class:`lvf_stt.engine.WhisperEngine` with the same surface."""

    def __init__(
        self,
        *,
        model: str = "fake/whisper",
        text: str = "распознанный текст",
        language: str = "ru",
        load_gate: threading.Event | None = None,
        decode_gate: threading.Event | None = None,
        raises: Exception | None = None,
        fail_load: str | None = None,
    ) -> None:
        self.model = model
        self.text = text
        self.language = language
        self.load_gate = load_gate
        self.decode_gate = decode_gate
        self.raises = raises
        self.fail_load = fail_load
        self.calls: list[dict] = []
        self.decode_started = threading.Event()
        self._loaded = threading.Event()
        self._state = EngineState(state="starting", ready=False, model=model)

    def load(self, on_status=None) -> EngineState:
        self._state = EngineState(state="loading", ready=False, model=self.model)
        if on_status:
            on_status(self._state)
        if self.load_gate is not None:
            self.load_gate.wait(RECV_TIMEOUT)
        if self.fail_load:
            self._state = EngineState(
                state="error", ready=False, model=self.model, error=self.fail_load
            )
        else:
            self._state = EngineState(
                state="ready",
                ready=True,
                model=self.model,
                device="gpu",
                load_ms=42,
                warmed_up=True,
            )
        self._loaded.set()
        if on_status:
            on_status(self._state)
        return self._state

    def snapshot(self) -> EngineState:
        return self._state

    def wait_until_loaded(self, timeout: float | None = None) -> bool:
        return self._loaded.wait(timeout)

    def transcribe(self, audio_input, language="auto", initial_prompt=""):
        self.calls.append(
            {
                "samples": int(getattr(audio_input, "size", 0)),
                "language": language,
                "initial_prompt": initial_prompt,
            }
        )
        self.decode_started.set()
        if self.decode_gate is not None:
            self.decode_gate.wait(RECV_TIMEOUT)
        if self.raises is not None:
            raise self.raises
        return {"text": self.text, "language": self.language}


class Harness:
    def __init__(self, engine: FakeEngine, *, load_timeout_s: float = 5.0) -> None:
        in_r, in_w = os.pipe()
        out_r, out_w = os.pipe()
        self._stdin_read = os.fdopen(in_r, "r", encoding="utf-8", newline="\n")
        self._stdin_write = os.fdopen(in_w, "w", encoding="utf-8", newline="\n")
        self._stdout_read = os.fdopen(out_r, "r", encoding="utf-8", newline="\n")
        self._stdout_write = os.fdopen(out_w, "w", encoding="utf-8", newline="\n")

        self.worker = Worker(
            engine, self._stdin_read, self._stdout_write, load_timeout_s=load_timeout_s
        )
        self.exit_code: int | None = None
        self.messages: queue.Queue = queue.Queue()
        self._reader = threading.Thread(target=self._pump, daemon=True)
        self._reader.start()
        self._runner = threading.Thread(target=self._run, daemon=True)
        self._runner.start()

    def _run(self) -> None:
        self.exit_code = self.worker.run()
        self._stdout_write.close()

    def _pump(self) -> None:
        for line in self._stdout_read:
            if line.strip():
                self.messages.put(json.loads(line))
        self.messages.put(None)

    def send(self, payload: dict) -> None:
        self._stdin_write.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self._stdin_write.flush()

    def send_raw(self, text: str) -> None:
        self._stdin_write.write(text + "\n")
        self._stdin_write.flush()

    def recv(self, timeout: float = RECV_TIMEOUT) -> dict:
        message = self.messages.get(timeout=timeout)
        if message is None:
            raise AssertionError("worker closed stdout")
        return message

    def recv_matching(self, predicate, timeout: float = RECV_TIMEOUT) -> dict:
        """Skip unsolicited status events until the awaited response shows up."""
        deadline = timeout
        while True:
            message = self.recv(timeout=deadline)
            if predicate(message):
                return message

    def await_ready(self) -> dict:
        return self.recv_matching(
            lambda m: m.get("op") == "status" and m.get("state") in ("ready", "error")
        )

    def close(self) -> None:
        try:
            self._stdin_write.close()
        except OSError:
            pass
        self._runner.join(timeout=RECV_TIMEOUT)
        for stream in (self._stdin_read, self._stdout_read):
            try:
                stream.close()
            except OSError:
                pass


class WorkerTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory(prefix="lvf-worker-test-")
        self.addCleanup(self._dir.cleanup)

    def path(self, name: str) -> str:
        return os.path.join(self._dir.name, name)

    def start(self, engine: FakeEngine, **kwargs) -> Harness:
        harness = Harness(engine, **kwargs)
        self.addCleanup(harness.close)
        return harness


class TestStatusEvents(WorkerTestCase):
    def test_starting_loading_ready_sequence(self) -> None:
        harness = self.start(FakeEngine())
        starting = harness.recv()
        self.assertEqual((starting["op"], starting["state"]), ("status", "starting"))
        self.assertIsNone(starting["id"])
        self.assertFalse(starting["ready"])

        loading = harness.recv()
        self.assertEqual(loading["state"], "loading")
        self.assertFalse(loading["ready"])

        ready = harness.recv()
        self.assertEqual(ready["state"], "ready")
        self.assertTrue(ready["ready"])
        self.assertEqual(ready["load_ms"], 42)
        self.assertTrue(ready["warmed_up"])


class TestHealth(WorkerTestCase):
    def test_health_reports_ready_state(self) -> None:
        harness = self.start(FakeEngine())
        harness.await_ready()
        harness.send({"id": "h1", "op": "health"})
        reply = harness.recv_matching(lambda m: m.get("id") == "h1")
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["op"], "health")
        self.assertEqual(reply["state"], "ready")
        self.assertEqual(reply["backend"], "mlx-whisper")
        self.assertEqual(reply["device"], "gpu")
        self.assertEqual(reply["model"], "fake/whisper")

    def test_health_is_answered_while_the_model_is_still_loading(self) -> None:
        gate = threading.Event()
        harness = self.start(FakeEngine(load_gate=gate))
        harness.recv_matching(lambda m: m.get("state") == "loading")
        harness.send({"id": "h1", "op": "health"})
        reply = harness.recv_matching(lambda m: m.get("id") == "h1")
        self.assertEqual(reply["state"], "loading")
        self.assertFalse(reply["ready"])
        gate.set()

    def test_health_is_answered_while_a_decode_is_in_flight(self) -> None:
        gate = threading.Event()
        engine = FakeEngine(decode_gate=gate)
        harness = self.start(engine)
        harness.await_ready()

        wav = self.path("speech.wav")
        write_wav(wav, tone(1.0))
        harness.send({"id": "t1", "op": "transcribe", "audio_path": wav, "language": "ru"})
        self.assertTrue(engine.decode_started.wait(RECV_TIMEOUT))

        harness.send({"id": "h1", "op": "health"})
        reply = harness.recv_matching(lambda m: m.get("id") == "h1")
        self.assertEqual(reply["op"], "health")

        gate.set()
        result = harness.recv_matching(lambda m: m.get("id") == "t1")
        self.assertTrue(result["ok"])


class TestTranscribeDispatch(WorkerTestCase):
    def test_successful_transcription(self) -> None:
        engine = FakeEngine(text=" Так смотри,  этот useEffect ")
        harness = self.start(engine)
        harness.await_ready()

        wav = self.path("speech.wav")
        write_wav(wav, np.concatenate([np.zeros(8000, dtype=np.float32), tone(1.0)]))
        harness.send(
            {
                "id": "t1",
                "op": "transcribe",
                "audio_path": wav,
                "language": "ru",
                "initial_prompt": "useEffect, React Query",
            }
        )
        reply = harness.recv_matching(lambda m: m.get("id") == "t1")
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["op"], "transcribe")
        self.assertEqual(reply["raw_transcript"], "Так смотри, этот useEffect")
        self.assertEqual(reply["detected_language"], "ru")
        self.assertFalse(reply["no_speech"])
        self.assertEqual(reply["model"], "fake/whisper")
        self.assertAlmostEqual(reply["audio_duration_ms"], 1500, delta=10)
        self.assertIn("silence_trimmed", reply["warnings"])
        self.assertGreaterEqual(reply["transcription_ms"], 0)

    def test_initial_prompt_and_language_reach_the_engine(self) -> None:
        engine = FakeEngine()
        harness = self.start(engine)
        harness.await_ready()

        wav = self.path("speech.wav")
        write_wav(wav, tone(1.0))
        harness.send(
            {
                "id": "t1",
                "op": "transcribe",
                "audio_path": wav,
                "language": "ru",
                "initial_prompt": "useEffect, Zod, юз эффект",
            }
        )
        harness.recv_matching(lambda m: m.get("id") == "t1")
        self.assertEqual(len(engine.calls), 1)
        self.assertEqual(engine.calls[0]["language"], "ru")
        self.assertEqual(engine.calls[0]["initial_prompt"], "useEffect, Zod, юз эффект")

    def test_silent_wav_is_no_speech_and_never_reaches_the_engine(self) -> None:
        engine = FakeEngine(text="Продолжение следует...")
        harness = self.start(engine)
        harness.await_ready()

        wav = self.path("silence.wav")
        write_wav(wav, np.zeros(16_000, dtype=np.float32))
        harness.send({"id": "t1", "op": "transcribe", "audio_path": wav})
        reply = harness.recv_matching(lambda m: m.get("id") == "t1")
        self.assertTrue(reply["ok"])
        self.assertTrue(reply["no_speech"])
        self.assertEqual(reply["raw_transcript"], "")
        self.assertEqual(reply["audio_duration_ms"], 1000)
        self.assertEqual(engine.calls, [])

    def test_empty_wav_is_no_speech(self) -> None:
        engine = FakeEngine()
        harness = self.start(engine)
        harness.await_ready()
        wav = self.path("empty.wav")
        write_wav(wav, np.zeros(0, dtype=np.float32))
        harness.send({"id": "t1", "op": "transcribe", "audio_path": wav})
        reply = harness.recv_matching(lambda m: m.get("id") == "t1")
        self.assertTrue(reply["no_speech"])
        self.assertEqual(reply["audio_duration_ms"], 0)
        self.assertEqual(engine.calls, [])

    def test_hallucinated_filler_on_a_quiet_capture_is_dropped(self) -> None:
        engine = FakeEngine(text="Продолжение следует...")
        harness = self.start(engine)
        harness.await_ready()
        wav = self.path("quiet.wav")
        write_wav(wav, tone(0.6, amplitude=0.02))
        harness.send({"id": "t1", "op": "transcribe", "audio_path": wav})
        reply = harness.recv_matching(lambda m: m.get("id") == "t1")
        self.assertTrue(reply["no_speech"])
        self.assertEqual(reply["raw_transcript"], "")
        self.assertIn("hallucination_filtered", reply["warnings"])

    def test_the_same_phrase_on_real_speech_is_kept(self) -> None:
        engine = FakeEngine(text="Продолжение следует...")
        harness = self.start(engine)
        harness.await_ready()
        wav = self.path("loud.wav")
        write_wav(wav, tone(3.0, amplitude=0.4))
        harness.send({"id": "t1", "op": "transcribe", "audio_path": wav})
        reply = harness.recv_matching(lambda m: m.get("id") == "t1")
        self.assertFalse(reply["no_speech"])
        self.assertEqual(reply["raw_transcript"], "Продолжение следует...")

    def test_empty_engine_output_is_no_speech(self) -> None:
        engine = FakeEngine(text="   ")
        harness = self.start(engine)
        harness.await_ready()
        wav = self.path("speech.wav")
        write_wav(wav, tone(1.0))
        harness.send({"id": "t1", "op": "transcribe", "audio_path": wav})
        reply = harness.recv_matching(lambda m: m.get("id") == "t1")
        self.assertTrue(reply["no_speech"])
        self.assertIn("empty_transcript", reply["warnings"])

    def test_missing_audio_file_is_audio_invalid(self) -> None:
        harness = self.start(FakeEngine())
        harness.await_ready()
        harness.send({"id": "t1", "op": "transcribe", "audio_path": self.path("nope.wav")})
        reply = harness.recv_matching(lambda m: m.get("id") == "t1")
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["error_code"], "audio_invalid")
        self.assertEqual(reply["op"], "transcribe")

    def test_engine_failure_becomes_an_internal_error(self) -> None:
        engine = FakeEngine(raises=RuntimeError("mlx exploded"))
        harness = self.start(engine)
        harness.await_ready()
        wav = self.path("speech.wav")
        write_wav(wav, tone(1.0))
        harness.send({"id": "t1", "op": "transcribe", "audio_path": wav})
        reply = harness.recv_matching(lambda m: m.get("id") == "t1")
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["error_code"], "internal")
        self.assertIn("mlx exploded", reply["error"])

    def test_failed_load_yields_model_not_loaded(self) -> None:
        engine = FakeEngine(fail_load="no such repo")
        harness = self.start(engine)
        harness.await_ready()
        wav = self.path("speech.wav")
        write_wav(wav, tone(1.0))
        harness.send({"id": "t1", "op": "transcribe", "audio_path": wav})
        reply = harness.recv_matching(lambda m: m.get("id") == "t1")
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["error_code"], "model_not_loaded")


class TestCancellation(WorkerTestCase):
    def test_cancel_answers_immediately_and_discards_the_result(self) -> None:
        gate = threading.Event()
        engine = FakeEngine(decode_gate=gate)
        harness = self.start(engine)
        harness.await_ready()

        wav = self.path("speech.wav")
        write_wav(wav, tone(2.0))
        harness.send({"id": "t1", "op": "transcribe", "audio_path": wav})
        self.assertTrue(engine.decode_started.wait(RECV_TIMEOUT))

        harness.send({"id": "c1", "op": "cancel", "target_id": "t1"})
        cancelled = harness.recv_matching(lambda m: m.get("id") == "t1")
        self.assertFalse(cancelled["ok"])
        self.assertEqual(cancelled["error_code"], "cancelled")
        self.assertEqual(cancelled["op"], "transcribe")

        ack = harness.recv_matching(lambda m: m.get("id") == "c1")
        self.assertTrue(ack["ok"])
        self.assertEqual(ack["op"], "cancel")
        self.assertEqual(ack["target_id"], "t1")
        self.assertTrue(ack["cancelled"])

        # Let the decode finish; its result must not be emitted.
        gate.set()
        harness.send({"id": "h1", "op": "health"})
        follow_up = harness.recv_matching(lambda m: m.get("id") in ("h1", "t1"))
        self.assertEqual(follow_up["id"], "h1")

    def test_cancel_of_an_unknown_request_is_acknowledged(self) -> None:
        harness = self.start(FakeEngine())
        harness.await_ready()
        harness.send({"id": "c1", "op": "cancel", "target_id": "never-existed"})
        ack = harness.recv_matching(lambda m: m.get("id") == "c1")
        self.assertTrue(ack["ok"])
        self.assertFalse(ack["cancelled"])

    def test_cancel_arriving_before_the_decode_starts(self) -> None:
        gate = threading.Event()
        engine = FakeEngine(decode_gate=gate)
        harness = self.start(engine)
        harness.await_ready()

        wav = self.path("speech.wav")
        write_wav(wav, tone(2.0))
        # Occupy the single decoder thread so t2 stays queued.
        harness.send({"id": "t1", "op": "transcribe", "audio_path": wav})
        self.assertTrue(engine.decode_started.wait(RECV_TIMEOUT))
        harness.send({"id": "t2", "op": "transcribe", "audio_path": wav})
        harness.send({"id": "c1", "op": "cancel", "target_id": "t2"})

        cancelled = harness.recv_matching(lambda m: m.get("id") == "t2")
        self.assertEqual(cancelled["error_code"], "cancelled")
        gate.set()


class TestProtocolViolations(WorkerTestCase):
    def test_unknown_op_gets_an_error_and_the_worker_survives(self) -> None:
        harness = self.start(FakeEngine())
        harness.await_ready()
        harness.send({"id": "x1", "op": "explode"})
        reply = harness.recv_matching(lambda m: m.get("id") == "x1")
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["error_code"], "internal")
        self.assertEqual(reply["op"], "explode")

        harness.send({"id": "h1", "op": "health"})
        self.assertTrue(harness.recv_matching(lambda m: m.get("id") == "h1")["ok"])

    def test_garbage_line_gets_an_error_and_the_worker_survives(self) -> None:
        harness = self.start(FakeEngine())
        harness.await_ready()
        harness.send_raw("{definitely not json")
        reply = harness.recv_matching(lambda m: m.get("ok") is False)
        self.assertIsNone(reply["id"])

        harness.send({"id": "h1", "op": "health"})
        self.assertTrue(harness.recv_matching(lambda m: m.get("id") == "h1")["ok"])

    def test_blank_lines_are_ignored(self) -> None:
        harness = self.start(FakeEngine())
        harness.await_ready()
        harness.send_raw("")
        harness.send_raw("   ")
        harness.send({"id": "h1", "op": "health"})
        self.assertEqual(harness.recv_matching(lambda m: m.get("id") == "h1")["op"], "health")


class TestShutdown(WorkerTestCase):
    def test_shutdown_replies_then_exits_zero(self) -> None:
        harness = self.start(FakeEngine())
        harness.await_ready()
        harness.send({"id": "s1", "op": "shutdown"})
        reply = harness.recv_matching(lambda m: m.get("id") == "s1")
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["op"], "shutdown")
        harness.close()
        self.assertEqual(harness.exit_code, 0)

    def test_closed_stdin_exits_zero(self) -> None:
        harness = self.start(FakeEngine())
        harness.await_ready()
        harness.close()
        self.assertEqual(harness.exit_code, 0)

    def test_shutdown_answers_in_flight_requests_and_writes_nothing_after(self) -> None:
        gate = threading.Event()
        engine = FakeEngine(decode_gate=gate)
        harness = self.start(engine)
        harness.await_ready()

        wav = self.path("speech.wav")
        write_wav(wav, tone(1.0))
        harness.send({"id": "t1", "op": "transcribe", "audio_path": wav})
        self.assertTrue(engine.decode_started.wait(RECV_TIMEOUT))
        harness.send({"id": "s1", "op": "shutdown"})

        abandoned = harness.recv_matching(lambda m: m.get("id") == "t1")
        self.assertEqual(abandoned["error_code"], "cancelled")
        ack = harness.recv_matching(lambda m: m.get("id") == "s1")
        self.assertEqual(ack["op"], "shutdown")

        # Releasing the decode must not produce a line after the goodbye.
        gate.set()
        harness.close()
        self.assertEqual(harness.exit_code, 0)
        remaining = []
        while not harness.messages.empty():
            message = harness.messages.get_nowait()
            if message is not None:
                remaining.append(message)
        self.assertEqual(remaining, [])


class TestEnginePureFunctions(unittest.TestCase):
    """These live in engine.py but import no MLX, so they run everywhere."""

    def test_normalize_strips_whispers_leading_space(self) -> None:
        self.assertEqual(normalize_transcript(" привет"), "привет")

    def test_normalize_collapses_whitespace_runs(self) -> None:
        self.assertEqual(
            normalize_transcript("Так  смотри,\n\tэтот   useEffect  "),
            "Так смотри, этот useEffect",
        )

    def test_normalize_composes_to_nfc(self) -> None:
        decomposed = "й"  # и + combining breve
        self.assertEqual(len(decomposed), 2)
        composed = normalize_transcript(decomposed)
        self.assertEqual(composed, "й")
        self.assertEqual(len(composed), 1)

    def test_normalize_handles_empty(self) -> None:
        self.assertEqual(normalize_transcript(""), "")
        self.assertEqual(normalize_transcript("   \n  "), "")

    def test_normalize_keeps_nonbreaking_content_intact(self) -> None:
        self.assertEqual(normalize_transcript("ё — тире"), "ё — тире")

    def test_build_kwargs_passes_initial_prompt_through(self) -> None:
        kwargs = build_transcribe_kwargs("m", "ru", "useEffect, Zod")
        self.assertEqual(kwargs["initial_prompt"], "useEffect, Zod")
        self.assertEqual(kwargs["language"], "ru")
        self.assertEqual(kwargs["path_or_hf_repo"], "m")
        # Only verbose=None is silent in mlx-whisper 0.4.3; verbose=False turns the
        # progress bar on and prints the detected language to stdout.
        self.assertIsNone(kwargs["verbose"])
        self.assertTrue(kwargs["fp16"])
        self.assertFalse(kwargs["condition_on_previous_text"])

    def test_build_kwargs_omits_an_empty_prompt(self) -> None:
        self.assertNotIn("initial_prompt", build_transcribe_kwargs("m", "ru", "   "))

    def test_build_kwargs_maps_auto_to_none(self) -> None:
        self.assertIsNone(build_transcribe_kwargs("m", "auto", "")["language"])
        self.assertIsNone(build_transcribe_kwargs("m", "", "")["language"])
        self.assertEqual(build_transcribe_kwargs("m", "EN", "")["language"], "en")

    def test_build_kwargs_fp32(self) -> None:
        self.assertFalse(build_transcribe_kwargs("m", "ru", "", fp16=False)["fp16"])

    def test_filler_guard_fires_only_on_short_or_quiet_audio(self) -> None:
        phrases = ("Продолжение следует...", "Thank you.", "you", "Субтитры сделал DimaTorzok")
        for phrase in phrases:
            with self.subTest(phrase=phrase):
                self.assertTrue(
                    is_filler_hallucination(phrase, duration_ms=500, peak=0.02)
                )
                self.assertFalse(
                    is_filler_hallucination(phrase, duration_ms=5000, peak=0.4)
                )

    def test_filler_guard_never_touches_real_sentences(self) -> None:
        self.assertFalse(
            is_filler_hallucination(
                "Продолжение следует за этим коммитом", duration_ms=400, peak=0.01
            )
        )
        self.assertFalse(
            is_filler_hallucination("Thank you for the review", duration_ms=400, peak=0.01)
        )


class TestWhisperEngineState(unittest.TestCase):
    """The real engine's state machine, exercised without importing MLX."""

    def _load_with_stub(self, engine: WhisperEngine, side_effect) -> tuple[list, bool]:
        seen: list = []
        done = threading.Event()

        def run() -> None:
            with mock.patch("importlib.import_module", side_effect=side_effect):
                engine.load(on_status=seen.append)
            done.set()

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        # A regression guard: state transitions used to re-enter a non-reentrant lock
        # and hang here forever, which only showed up against the real engine.
        return seen, done.wait(10.0)

    def test_starting_state_before_load(self) -> None:
        engine = WhisperEngine("fake/model", warmup=False)
        state = engine.snapshot()
        self.assertEqual(state.state, "starting")
        self.assertFalse(state.ready)
        self.assertEqual(state.model, "fake/model")
        self.assertFalse(engine.wait_until_loaded(0.01))

    def test_load_failure_is_reported_not_raised(self) -> None:
        engine = WhisperEngine("fake/model", warmup=False)
        seen, finished = self._load_with_stub(engine, ImportError("mlx is not installed"))
        self.assertTrue(finished, "engine.load deadlocked")
        self.assertEqual([s.state for s in seen], ["loading", "error"])
        final = engine.snapshot()
        self.assertEqual(final.state, "error")
        self.assertFalse(final.ready)
        self.assertIn("mlx is not installed", final.error or "")
        # A failed load must still release waiters, otherwise every decode hangs.
        self.assertTrue(engine.wait_until_loaded(0.01))

    def test_transcribe_before_load_raises_model_not_loaded(self) -> None:
        from lvf_stt.engine import ModelNotLoadedError

        engine = WhisperEngine("fake/model", warmup=False)
        with self.assertRaises(ModelNotLoadedError):
            engine.transcribe(tone(0.2), "ru", "")


class TestAudioHelpersUsedByWorker(unittest.TestCase):
    def test_peak_and_rms_of_a_known_tone(self) -> None:
        signal = tone(1.0, amplitude=0.5)
        self.assertAlmostEqual(audio.peak_amplitude(signal), 0.5, places=2)
        self.assertAlmostEqual(audio.rms_amplitude(signal), 0.5 / np.sqrt(2), places=2)


if __name__ == "__main__":
    unittest.main()
