"""The LLM channel's wire protocol — pure stdlib, runs on any machine."""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lvf_stt import llm_protocol as protocol  # noqa: E402


def decode(line: str) -> protocol.Request:
    return protocol.decode_request(line)


class TestDecodeRequest(unittest.TestCase):
    def test_correct_round_trip(self) -> None:
        request = protocol.CorrectRequest(
            id="c1", system_prompt="Ты — редактор.", payload='{"dictation": "эм ну привет"}'
        )
        decoded = decode(protocol.encode_request(request))
        self.assertEqual(decoded, request)

    def test_all_ops_round_trip(self) -> None:
        requests: list[protocol.Request] = [
            protocol.CorrectRequest(id="a", system_prompt="s", payload="p", max_tokens=64),
            protocol.WarmRequest(id="b", system_prompt="s"),
            protocol.CancelRequest(id="c", target_id="a"),
            protocol.HealthRequest(id="d"),
            protocol.ShutdownRequest(id="e"),
        ]
        for request in requests:
            with self.subTest(op=request.op):
                self.assertEqual(decode(protocol.encode_request(request)), request)

    def test_missing_op_is_rejected(self) -> None:
        with self.assertRaises(protocol.ProtocolError):
            decode(json.dumps({"id": "x"}))

    def test_unknown_op_is_rejected_with_context(self) -> None:
        with self.assertRaises(protocol.ProtocolError) as caught:
            decode(json.dumps({"id": "x", "op": "transcribe"}))
        self.assertEqual(caught.exception.request_id, "x")
        self.assertEqual(caught.exception.op, "transcribe")

    def test_missing_id_is_rejected_but_keeps_the_op(self) -> None:
        with self.assertRaises(protocol.ProtocolError) as caught:
            decode(json.dumps({"op": "health"}))
        self.assertIsNone(caught.exception.request_id)
        self.assertEqual(caught.exception.op, "health")

    def test_correct_requires_prompt_and_payload(self) -> None:
        for missing in ("system_prompt", "payload"):
            with self.subTest(missing=missing):
                obj = {"id": "x", "op": "correct", "system_prompt": "s", "payload": "p"}
                del obj[missing]
                with self.assertRaises(protocol.ProtocolError):
                    decode(json.dumps(obj))

    def test_cancel_requires_target_id(self) -> None:
        with self.assertRaises(protocol.ProtocolError):
            decode(json.dumps({"id": "x", "op": "cancel"}))

    def test_garbage_and_non_objects_are_rejected(self) -> None:
        for line in ("{not json", "[1, 2]", '"string"', "", "   "):
            with self.subTest(line=line):
                with self.assertRaises(protocol.ProtocolError):
                    decode(line)

    def test_max_tokens_is_clamped_and_defaults_to_zero(self) -> None:
        cases = {
            json.dumps({"id": "x", "op": "correct", "system_prompt": "s", "payload": "p"}): 0,
            json.dumps(
                {"id": "x", "op": "correct", "system_prompt": "s", "payload": "p", "max_tokens": -5}
            ): 0,
            json.dumps(
                {
                    "id": "x",
                    "op": "correct",
                    "system_prompt": "s",
                    "payload": "p",
                    "max_tokens": 99_999,
                }
            ): 8192,
            json.dumps(
                {
                    "id": "x",
                    "op": "correct",
                    "system_prompt": "s",
                    "payload": "p",
                    "max_tokens": True,
                }
            ): 0,
            json.dumps(
                {
                    "id": "x",
                    "op": "correct",
                    "system_prompt": "s",
                    "payload": "p",
                    "max_tokens": "many",
                }
            ): 0,
        }
        for line, expected in cases.items():
            with self.subTest(expected=expected):
                request = decode(line)
                assert isinstance(request, protocol.CorrectRequest)
                self.assertEqual(request.max_tokens, expected)


class TestEncodeResponse(unittest.TestCase):
    def test_correct_response_shape(self) -> None:
        obj = json.loads(
            protocol.encode_response(
                protocol.CorrectResponse(
                    id="c1",
                    text="Привет!",
                    model="fake/qwen",
                    prompt_tokens=1300,
                    generation_tokens=12,
                    generation_ms=850,
                )
            )
        )
        self.assertEqual(
            obj,
            {
                "id": "c1",
                "ok": True,
                "op": "correct",
                "text": "Привет!",
                "model": "fake/qwen",
                "prompt_tokens": 1300,
                "generation_tokens": 12,
                "generation_ms": 850,
                "finish_reason": "stop",
            },
        )

    def test_status_event_has_null_id_and_omits_absent_fields(self) -> None:
        obj = json.loads(
            protocol.encode_response(
                protocol.StatusEvent(state="loading", ready=False, model="fake/qwen")
            )
        )
        self.assertIsNone(obj["id"])
        self.assertNotIn("load_ms", obj)
        self.assertNotIn("warmed_prompt", obj)
        self.assertNotIn("error", obj)

    def test_unknown_error_code_is_coerced_to_internal(self) -> None:
        obj = json.loads(
            protocol.encode_response(
                protocol.ErrorResponse(id="x", op="correct", error_code="weird", error="boom")
            )
        )
        self.assertEqual(obj["error_code"], "internal")

    def test_error_from_protocol_error(self) -> None:
        exc = protocol.ProtocolError("bad", request_id="x", op="warm")
        obj = json.loads(protocol.encode_response(protocol.error_from(exc)))
        self.assertEqual((obj["id"], obj["op"], obj["ok"]), ("x", "warm", False))

    def test_responses_are_single_line_utf8(self) -> None:
        line = protocol.encode_response(
            protocol.CorrectResponse(
                id="c1",
                text="строка раз\nстрока два",
                model="m",
                prompt_tokens=1,
                generation_tokens=1,
                generation_ms=1,
            )
        )
        self.assertNotIn("\n", line)
        self.assertIn("строка раз", line)  # ensure_ascii=False keeps Cyrillic readable


if __name__ == "__main__":
    unittest.main()
