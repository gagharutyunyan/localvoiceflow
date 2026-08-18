"""LLM worker dispatch over real pipes with a fake engine — no MLX involved."""

from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lvf_stt.llm_engine import (  # noqa: E402
    CorrectionOutput,
    LlmEngineState,
    ModelNotLoadedError,
    auto_max_tokens,
)
from lvf_stt.llm_worker import LlmWorker  # noqa: E402
from lvf_stt.worker import Watchdog  # noqa: E402

RECV_TIMEOUT = 10.0


class FakeLlmEngine:
    """Stands in for :class:`lvf_stt.llm_engine.LlmEngine` with the same surface."""

    def __init__(
        self,
        *,
        model: str = "fake/qwen",
        text: str = "Отредактированный текст.",
        load_gate: threading.Event | None = None,
        generate_gate: threading.Event | None = None,
        raises: Exception | None = None,
        fail_load: str | None = None,
    ) -> None:
        self.model = model
        self.text = text
        self.load_gate = load_gate
        self.generate_gate = generate_gate
        self.raises = raises
        self.fail_load = fail_load
        self.correct_calls: list[dict] = []
        self.warm_calls: list[str] = []
        self.generation_started = threading.Event()
        self._warmed_text: str | None = None
        self._state = LlmEngineState(model=model)

    def load(self, on_status=None) -> LlmEngineState:
        self._state = LlmEngineState(model=self.model, state="loading", ready=False)
        if on_status:
            on_status(self._state)
        if self.load_gate is not None:
            self.load_gate.wait(RECV_TIMEOUT)
        if self.fail_load:
            self._state = LlmEngineState(
                model=self.model, state="error", ready=False, error=self.fail_load
            )
        else:
            self._state = LlmEngineState(
                model=self.model, state="ready", ready=True, load_ms=42
            )
        if on_status:
            on_status(self._state)
        return self._state

    def snapshot(self) -> LlmEngineState:
        return self._state

    def warm(self, system_prompt: str) -> tuple[bool, int, int]:
        if not self._state.ready:
            raise ModelNotLoadedError("model is not loaded")
        self.warm_calls.append(system_prompt)
        if self._warmed_text == system_prompt:
            return False, len(system_prompt.split()), 0
        self._warmed_text = system_prompt
        self._state = LlmEngineState(
            model=self.model, state="ready", ready=True, load_ms=42, warmed_prompt=True
        )
        return True, len(system_prompt.split()), 7

    def correct(self, system_prompt, payload, max_tokens=0, is_cancelled=None):
        if not self._state.ready:
            raise ModelNotLoadedError("model is not loaded")
        self.correct_calls.append(
            {"system_prompt": system_prompt, "payload": payload, "max_tokens": max_tokens}
        )
        self.generation_started.set()
        if self.generate_gate is not None:
            self.generate_gate.wait(RECV_TIMEOUT)
        if self.raises is not None:
            raise self.raises
        if is_cancelled is not None and is_cancelled():
            return CorrectionOutput(
                text="", prompt_tokens=10, generation_tokens=3, generation_ms=5,
                finish_reason="cancelled",
            )
        return CorrectionOutput(
            text=self.text, prompt_tokens=10, generation_tokens=6, generation_ms=120,
            finish_reason="stop",
        )


class Harness:
    def __init__(self, engine: FakeLlmEngine, *, watchdog: Watchdog | None = None, **kwargs) -> None:
        in_r, in_w = os.pipe()
        out_r, out_w = os.pipe()
        self._stdin_read = os.fdopen(in_r, "r", encoding="utf-8", newline="\n")
        self._stdin_write = os.fdopen(in_w, "w", encoding="utf-8", newline="\n")
        self._stdout_read = os.fdopen(out_r, "r", encoding="utf-8", newline="\n")
        self._stdout_write = os.fdopen(out_w, "w", encoding="utf-8", newline="\n")

        # A recording watchdog by default: a stray firing must not os._exit the
        # test process, and tests can assert nothing fired.
        self.watchdog_fires: list[str] = []
        if watchdog is None:
            watchdog = Watchdog(on_timeout=self.watchdog_fires.append)
        self.worker = LlmWorker(
            engine, self._stdin_read, self._stdout_write, watchdog=watchdog, **kwargs
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
        while True:
            message = self.recv(timeout=timeout)
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


class LlmWorkerTestCase(unittest.TestCase):
    def start(self, engine: FakeLlmEngine, **kwargs) -> Harness:
        harness = Harness(engine, **kwargs)
        self.addCleanup(harness.close)
        return harness


class TestStatusEvents(LlmWorkerTestCase):
    def test_starting_loading_ready_sequence(self) -> None:
        harness = self.start(FakeLlmEngine())
        starting = harness.recv()
        self.assertEqual((starting["op"], starting["state"]), ("status", "starting"))
        self.assertIsNone(starting["id"])

        loading = harness.recv()
        self.assertEqual(loading["state"], "loading")

        ready = harness.recv()
        self.assertEqual(ready["state"], "ready")
        self.assertTrue(ready["ready"])
        self.assertEqual(ready["load_ms"], 42)


class TestHealth(LlmWorkerTestCase):
    def test_health_reports_ready_state(self) -> None:
        harness = self.start(FakeLlmEngine())
        harness.await_ready()
        harness.send({"id": "h1", "op": "health"})
        reply = harness.recv_matching(lambda m: m.get("id") == "h1")
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["op"], "health")
        self.assertEqual(reply["state"], "ready")
        self.assertEqual(reply["backend"], "mlx-lm")
        self.assertEqual(reply["model"], "fake/qwen")
        self.assertFalse(reply["warmed_prompt"])

    def test_health_is_answered_while_the_model_is_still_loading(self) -> None:
        gate = threading.Event()
        harness = self.start(FakeLlmEngine(load_gate=gate))
        harness.recv_matching(lambda m: m.get("state") == "loading")
        harness.send({"id": "h1", "op": "health"})
        reply = harness.recv_matching(lambda m: m.get("id") == "h1")
        self.assertEqual(reply["state"], "loading")
        self.assertFalse(reply["ready"])
        gate.set()

    def test_health_is_answered_while_a_generation_is_in_flight(self) -> None:
        gate = threading.Event()
        engine = FakeLlmEngine(generate_gate=gate)
        harness = self.start(engine)
        harness.await_ready()
        harness.send({"id": "c1", "op": "correct", "system_prompt": "s", "payload": "p"})
        self.assertTrue(engine.generation_started.wait(RECV_TIMEOUT))

        harness.send({"id": "h1", "op": "health"})
        reply = harness.recv_matching(lambda m: m.get("id") == "h1")
        self.assertEqual(reply["op"], "health")

        gate.set()
        result = harness.recv_matching(lambda m: m.get("id") == "c1")
        self.assertTrue(result["ok"])


class TestWarm(LlmWorkerTestCase):
    def test_warm_prefills_then_reports_no_op_for_the_same_prompt(self) -> None:
        engine = FakeLlmEngine()
        harness = self.start(engine)
        harness.await_ready()

        harness.send({"id": "w1", "op": "warm", "system_prompt": "Ты — редактор."})
        first = harness.recv_matching(lambda m: m.get("id") == "w1")
        self.assertTrue(first["ok"])
        self.assertTrue(first["warmed"])
        self.assertGreater(first["prompt_tokens"], 0)

        # The cache state changed; an unsolicited status must follow.
        status = harness.recv_matching(lambda m: m.get("op") == "status")
        self.assertTrue(status["warmed_prompt"])

        harness.send({"id": "w2", "op": "warm", "system_prompt": "Ты — редактор."})
        second = harness.recv_matching(lambda m: m.get("id") == "w2")
        self.assertFalse(second["warmed"])
        self.assertEqual(engine.warm_calls, ["Ты — редактор.", "Ты — редактор."])


class TestCorrectDispatch(LlmWorkerTestCase):
    def test_successful_correction(self) -> None:
        engine = FakeLlmEngine(text="Сделай рефакторинг этого метода.")
        harness = self.start(engine)
        harness.await_ready()

        harness.send(
            {
                "id": "c1",
                "op": "correct",
                "system_prompt": "Ты — редактор.",
                "payload": '{"dictation": "эм ну сделай рефакторинг"}',
                "max_tokens": 128,
            }
        )
        reply = harness.recv_matching(lambda m: m.get("id") == "c1")
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["op"], "correct")
        self.assertEqual(reply["text"], "Сделай рефакторинг этого метода.")
        self.assertEqual(reply["model"], "fake/qwen")
        self.assertEqual(reply["finish_reason"], "stop")
        self.assertGreaterEqual(reply["generation_ms"], 0)
        self.assertEqual(len(engine.correct_calls), 1)
        self.assertEqual(engine.correct_calls[0]["max_tokens"], 128)

    def test_duplicate_correct_id_is_dropped_while_in_flight(self) -> None:
        gate = threading.Event()
        engine = FakeLlmEngine(generate_gate=gate)
        harness = self.start(engine)
        harness.await_ready()

        harness.send({"id": "c1", "op": "correct", "system_prompt": "s", "payload": "p"})
        self.assertTrue(engine.generation_started.wait(RECV_TIMEOUT))

        with self.assertLogs("lvf_stt.llm_worker", level="WARNING") as captured:
            harness.send({"id": "c1", "op": "correct", "system_prompt": "s", "payload": "p"})
            harness.send({"id": "h1", "op": "health"})
            harness.recv_matching(lambda m: m.get("id") == "h1")
        self.assertTrue(any("duplicate" in line for line in captured.output))

        gate.set()
        reply = harness.recv_matching(lambda m: m.get("id") == "c1")
        self.assertTrue(reply["ok"])
        harness.send({"id": "h2", "op": "health"})
        follow_up = harness.recv_matching(lambda m: m.get("id") in ("h2", "c1"))
        self.assertEqual(follow_up["id"], "h2")
        self.assertEqual(len(engine.correct_calls), 1)

    def test_engine_failure_becomes_an_internal_error(self) -> None:
        engine = FakeLlmEngine(raises=RuntimeError("metal exploded"))
        harness = self.start(engine)
        harness.await_ready()
        harness.send({"id": "c1", "op": "correct", "system_prompt": "s", "payload": "p"})
        reply = harness.recv_matching(lambda m: m.get("id") == "c1")
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["error_code"], "internal")
        self.assertIn("metal exploded", reply["error"])

    def test_failed_load_yields_model_not_loaded(self) -> None:
        engine = FakeLlmEngine(fail_load="no such repo")
        harness = self.start(engine)
        harness.await_ready()
        harness.send({"id": "c1", "op": "correct", "system_prompt": "s", "payload": "p"})
        reply = harness.recv_matching(lambda m: m.get("id") == "c1")
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["error_code"], "model_not_loaded")


class TestCancellation(LlmWorkerTestCase):
    def test_cancel_answers_immediately_and_discards_the_result(self) -> None:
        gate = threading.Event()
        engine = FakeLlmEngine(generate_gate=gate)
        harness = self.start(engine)
        harness.await_ready()

        harness.send({"id": "c1", "op": "correct", "system_prompt": "s", "payload": "p"})
        self.assertTrue(engine.generation_started.wait(RECV_TIMEOUT))

        harness.send({"id": "k1", "op": "cancel", "target_id": "c1"})
        cancelled = harness.recv_matching(lambda m: m.get("id") == "c1")
        self.assertFalse(cancelled["ok"])
        self.assertEqual(cancelled["error_code"], "cancelled")

        ack = harness.recv_matching(lambda m: m.get("id") == "k1")
        self.assertTrue(ack["ok"])
        self.assertTrue(ack["cancelled"])

        # The engine finishes (and reports "cancelled"); no second c1 line follows.
        gate.set()
        harness.send({"id": "h1", "op": "health"})
        follow_up = harness.recv_matching(lambda m: m.get("id") in ("h1", "c1"))
        self.assertEqual(follow_up["id"], "h1")

    def test_cancel_of_an_unknown_request_is_acknowledged(self) -> None:
        harness = self.start(FakeLlmEngine())
        harness.await_ready()
        harness.send({"id": "k1", "op": "cancel", "target_id": "never-existed"})
        ack = harness.recv_matching(lambda m: m.get("id") == "k1")
        self.assertTrue(ack["ok"])
        self.assertFalse(ack["cancelled"])

    def test_cancel_arriving_before_the_generation_starts(self) -> None:
        gate = threading.Event()
        engine = FakeLlmEngine(generate_gate=gate)
        harness = self.start(engine)
        harness.await_ready()

        # Occupy the single MLX thread so c2 stays queued.
        harness.send({"id": "c1", "op": "correct", "system_prompt": "s", "payload": "p"})
        self.assertTrue(engine.generation_started.wait(RECV_TIMEOUT))
        harness.send({"id": "c2", "op": "correct", "system_prompt": "s", "payload": "p"})
        harness.send({"id": "k1", "op": "cancel", "target_id": "c2"})

        cancelled = harness.recv_matching(lambda m: m.get("id") == "c2")
        self.assertEqual(cancelled["error_code"], "cancelled")
        gate.set()
        # c2 must never reach the engine.
        harness.recv_matching(lambda m: m.get("id") == "c1")
        harness.send({"id": "h1", "op": "health"})
        harness.recv_matching(lambda m: m.get("id") == "h1")
        self.assertEqual(len(engine.correct_calls), 1)


class TestProtocolViolations(LlmWorkerTestCase):
    def test_unknown_op_gets_an_error_and_the_worker_survives(self) -> None:
        harness = self.start(FakeLlmEngine())
        harness.await_ready()
        harness.send({"id": "x1", "op": "transcribe"})
        reply = harness.recv_matching(lambda m: m.get("id") == "x1")
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["error_code"], "internal")

        harness.send({"id": "h1", "op": "health"})
        self.assertTrue(harness.recv_matching(lambda m: m.get("id") == "h1")["ok"])

    def test_garbage_line_gets_an_error_and_the_worker_survives(self) -> None:
        harness = self.start(FakeLlmEngine())
        harness.await_ready()
        harness.send_raw("{definitely not json")
        reply = harness.recv_matching(lambda m: m.get("ok") is False)
        self.assertIsNone(reply["id"])

        harness.send({"id": "h1", "op": "health"})
        self.assertTrue(harness.recv_matching(lambda m: m.get("id") == "h1")["ok"])


class TestShutdown(LlmWorkerTestCase):
    def test_shutdown_replies_then_exits_zero(self) -> None:
        harness = self.start(FakeLlmEngine())
        harness.await_ready()
        harness.send({"id": "s1", "op": "shutdown"})
        reply = harness.recv_matching(lambda m: m.get("id") == "s1")
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["op"], "shutdown")
        harness.close()
        self.assertEqual(harness.exit_code, 0)

    def test_closed_stdin_exits_zero(self) -> None:
        harness = self.start(FakeLlmEngine())
        harness.await_ready()
        harness.close()
        self.assertEqual(harness.exit_code, 0)

    def test_shutdown_answers_in_flight_requests_and_writes_nothing_after(self) -> None:
        gate = threading.Event()
        engine = FakeLlmEngine(generate_gate=gate)
        harness = self.start(engine)
        harness.await_ready()

        harness.send({"id": "c1", "op": "correct", "system_prompt": "s", "payload": "p"})
        self.assertTrue(engine.generation_started.wait(RECV_TIMEOUT))
        harness.send({"id": "s1", "op": "shutdown"})

        abandoned = harness.recv_matching(lambda m: m.get("id") == "c1")
        self.assertEqual(abandoned["error_code"], "cancelled")
        ack = harness.recv_matching(lambda m: m.get("id") == "s1")
        self.assertEqual(ack["op"], "shutdown")

        gate.set()
        harness.close()
        self.assertEqual(harness.exit_code, 0)
        remaining = []
        while not harness.messages.empty():
            message = harness.messages.get_nowait()
            if message is not None:
                remaining.append(message)
        self.assertEqual(remaining, [])


class TestWatchdogIntegration(LlmWorkerTestCase):
    def _recording_watchdog(self) -> tuple[Watchdog, threading.Event, list[str]]:
        fired = threading.Event()
        reasons: list[str] = []

        def on_timeout(reason: str) -> None:
            reasons.append(reason)
            fired.set()

        return Watchdog(on_timeout=on_timeout), fired, reasons

    def test_hung_load_trips_the_watchdog(self) -> None:
        watchdog, fired, reasons = self._recording_watchdog()
        gate = threading.Event()
        self.start(FakeLlmEngine(load_gate=gate), load_timeout_s=0.3, watchdog=watchdog)
        self.assertTrue(fired.wait(RECV_TIMEOUT))
        self.assertIn("load", reasons[0])
        gate.set()

    def test_hung_generation_trips_the_watchdog(self) -> None:
        watchdog, fired, reasons = self._recording_watchdog()
        gate = threading.Event()
        engine = FakeLlmEngine(generate_gate=gate)
        harness = self.start(engine, correct_timeout_s=0.3, watchdog=watchdog)
        harness.await_ready()
        harness.send({"id": "c1", "op": "correct", "system_prompt": "s", "payload": "p"})
        self.assertTrue(engine.generation_started.wait(RECV_TIMEOUT))
        self.assertTrue(fired.wait(RECV_TIMEOUT))
        self.assertIn("c1", reasons[0])
        gate.set()

    def test_watchdog_stays_quiet_across_a_healthy_lifecycle(self) -> None:
        engine = FakeLlmEngine()
        harness = self.start(engine, load_timeout_s=1.0, correct_timeout_s=1.0)
        harness.await_ready()
        harness.send({"id": "w1", "op": "warm", "system_prompt": "s"})
        harness.recv_matching(lambda m: m.get("id") == "w1")
        harness.send({"id": "c1", "op": "correct", "system_prompt": "s", "payload": "p"})
        self.assertTrue(harness.recv_matching(lambda m: m.get("id") == "c1")["ok"])

        time.sleep(1.5)
        self.assertEqual(harness.watchdog_fires, [])
        harness.send({"id": "h1", "op": "health"})
        self.assertTrue(harness.recv_matching(lambda m: m.get("id") == "h1")["ok"])


class TestAutoMaxTokens(unittest.TestCase):
    def test_scales_with_input_and_is_capped(self) -> None:
        self.assertEqual(auto_max_tokens(0), 256)
        self.assertEqual(auto_max_tokens(100), 456)
        self.assertEqual(auto_max_tokens(10_000), 2048)


if __name__ == "__main__":
    unittest.main()
