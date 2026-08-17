"""Protocol tests. Import nothing that needs MLX — these must run anywhere."""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lvf_stt import protocol  # noqa: E402


class TestRequestDecoding(unittest.TestCase):
    def test_transcribe_round_trip(self) -> None:
        original = protocol.TranscribeRequest(
            id="req_01H",
            audio_path="/tmp/capture.wav",
            language="ru",
            initial_prompt="React Query, useEffect",
            silence_threshold=0.012,
        )
        decoded = protocol.decode_request(protocol.encode_request(original))
        self.assertEqual(decoded, original)

    def test_cancel_health_shutdown_round_trip(self) -> None:
        for original in (
            protocol.CancelRequest(id="req_ctl_1", target_id="req_01H"),
            protocol.HealthRequest(id="req_02H"),
            protocol.ShutdownRequest(id="req_03H"),
        ):
            with self.subTest(op=original.op):
                decoded = protocol.decode_request(protocol.encode_request(original))
                self.assertEqual(decoded, original)

    def test_transcribe_defaults(self) -> None:
        decoded = protocol.decode_request(
            '{"id":"a","op":"transcribe","audio_path":"/tmp/x.wav"}'
        )
        assert isinstance(decoded, protocol.TranscribeRequest)
        self.assertEqual(decoded.language, "auto")
        self.assertEqual(decoded.initial_prompt, "")
        self.assertEqual(decoded.silence_threshold, protocol.DEFAULT_SILENCE_THRESHOLD)

    def test_silence_threshold_is_clamped_and_type_checked(self) -> None:
        cases = {
            "-1": 0.0,
            "5": 1.0,
            '"loud"': protocol.DEFAULT_SILENCE_THRESHOLD,
            "true": protocol.DEFAULT_SILENCE_THRESHOLD,
            "null": protocol.DEFAULT_SILENCE_THRESHOLD,
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                decoded = protocol.decode_request(
                    '{"id":"a","op":"transcribe","audio_path":"/x.wav",'
                    f'"silence_threshold":{raw}}}'
                )
                assert isinstance(decoded, protocol.TranscribeRequest)
                self.assertEqual(decoded.silence_threshold, expected)

    def test_unicode_survives_the_wire(self) -> None:
        line = protocol.encode_request(
            protocol.TranscribeRequest(
                id="a", audio_path="/tmp/тест.wav", initial_prompt="useEffect, хук"
            )
        )
        decoded = protocol.decode_request(line)
        assert isinstance(decoded, protocol.TranscribeRequest)
        self.assertEqual(decoded.audio_path, "/tmp/тест.wav")
        self.assertEqual(decoded.initial_prompt, "useEffect, хук")


class TestRequestErrors(unittest.TestCase):
    def _expect_error(self, line: str) -> protocol.ProtocolError:
        with self.assertRaises(protocol.ProtocolError) as caught:
            protocol.decode_request(line)
        return caught.exception

    def test_unknown_op_is_an_error_not_a_crash(self) -> None:
        exc = self._expect_error('{"id":"req_9","op":"selfdestruct"}')
        self.assertEqual(exc.request_id, "req_9")
        self.assertEqual(exc.op, "selfdestruct")
        self.assertEqual(exc.error_code, "internal")

        payload = json.loads(protocol.encode_response(protocol.error_from(exc)))
        self.assertEqual(payload["ok"], False)
        self.assertEqual(payload["id"], "req_9")
        self.assertEqual(payload["op"], "selfdestruct")
        self.assertEqual(payload["error_code"], "internal")
        self.assertIn("selfdestruct", payload["error"])

    def test_malformed_json(self) -> None:
        exc = self._expect_error("{not json")
        self.assertIsNone(exc.request_id)
        self.assertEqual(exc.error_code, "internal")

    def test_empty_line(self) -> None:
        self._expect_error("   \n")

    def test_non_object_payload(self) -> None:
        self._expect_error("[1, 2, 3]")

    def test_missing_op(self) -> None:
        exc = self._expect_error('{"id":"a"}')
        self.assertEqual(exc.request_id, "a")

    def test_missing_id(self) -> None:
        exc = self._expect_error('{"op":"health"}')
        self.assertIsNone(exc.request_id)
        self.assertEqual(exc.op, "health")

    def test_transcribe_without_audio_path_is_audio_invalid(self) -> None:
        exc = self._expect_error('{"id":"a","op":"transcribe"}')
        self.assertEqual(exc.error_code, "audio_invalid")
        self.assertEqual(exc.op, "transcribe")

    def test_cancel_without_target(self) -> None:
        exc = self._expect_error('{"id":"a","op":"cancel"}')
        self.assertEqual(exc.op, "cancel")


class TestResponseEncoding(unittest.TestCase):
    def test_transcribe_response_shape(self) -> None:
        payload = json.loads(
            protocol.encode_response(
                protocol.TranscribeResponse(
                    id="req_01H",
                    raw_transcript="Так смотри, этот useEffect",
                    detected_language="ru",
                    audio_duration_ms=6188,
                    transcription_ms=781,
                    model="mlx-community/whisper-large-v3-turbo",
                    no_speech=False,
                    warnings=["silence_trimmed"],
                )
            )
        )
        self.assertEqual(
            set(payload),
            {
                "id",
                "ok",
                "op",
                "raw_transcript",
                "detected_language",
                "audio_duration_ms",
                "transcription_ms",
                "model",
                "no_speech",
                "warnings",
            },
        )
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["op"], "transcribe")
        self.assertEqual(payload["raw_transcript"], "Так смотри, этот useEffect")

    def test_health_response_shape(self) -> None:
        payload = json.loads(
            protocol.encode_response(
                protocol.HealthResponse(
                    id="req_02H",
                    state="ready",
                    ready=True,
                    model="m",
                    device="gpu",
                    load_ms=3120,
                    warmed_up=True,
                )
            )
        )
        self.assertEqual(payload["state"], "ready")
        self.assertEqual(payload["backend"], "mlx-whisper")
        self.assertTrue(payload["ready"])
        self.assertNotIn("error", payload)

    def test_status_event_has_null_id(self) -> None:
        payload = json.loads(
            protocol.encode_response(
                protocol.StatusEvent(state="loading", ready=False, model="m")
            )
        )
        self.assertIsNone(payload["id"])
        self.assertEqual(payload["op"], "status")
        self.assertNotIn("load_ms", payload)

    def test_unknown_error_code_is_normalised(self) -> None:
        payload = json.loads(
            protocol.encode_response(
                protocol.ErrorResponse(id="a", op="transcribe", error_code="boom", error="x")
            )
        )
        self.assertEqual(payload["error_code"], "internal")

    def test_responses_never_contain_a_raw_newline(self) -> None:
        line = protocol.encode_response(
            protocol.TranscribeResponse(
                id="a",
                raw_transcript="строка\nвторая\tтабом",
                audio_duration_ms=1,
                transcription_ms=1,
                model="m",
            )
        )
        self.assertNotIn("\n", line)
        self.assertEqual(json.loads(line)["raw_transcript"], "строка\nвторая\tтабом")


if __name__ == "__main__":
    unittest.main()
