"""Wire protocol for the core <-> stt-worker JSON Lines channel.

This module deliberately imports nothing beyond the standard library. Two reasons:

* the worker must be able to emit ``status: starting`` and answer a malformed request
  *before* MLX has been imported (the import alone costs seconds);
* the protocol tests then run on any machine, with or without Apple Silicon.

See ``docs/STT_PROTOCOL.md`` for the authoritative description of every field.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Final

PROTOCOL_OPS: Final[tuple[str, ...]] = ("transcribe", "cancel", "health", "shutdown")
ERROR_CODES: Final[tuple[str, ...]] = (
    "audio_invalid",
    "model_not_loaded",
    "cancelled",
    "internal",
)
WORKER_STATES: Final[tuple[str, ...]] = ("starting", "loading", "ready", "error")
DEFAULT_SILENCE_THRESHOLD: Final[float] = 0.008
BACKEND_NAME: Final[str] = "mlx-whisper"


class ProtocolError(Exception):
    """A request that could not be understood.

    Carries enough context for the worker to answer with a well-formed error line
    instead of dying, which is the whole point: core supervises this process and a
    crash costs a 1.6 GB model reload.
    """

    def __init__(
        self,
        message: str,
        *,
        request_id: str | None = None,
        op: str | None = None,
        error_code: str = "internal",
    ) -> None:
        super().__init__(message)
        self.message = message
        self.request_id = request_id
        self.op = op
        self.error_code = error_code


# ---------------------------------------------------------------------------
# Requests (core -> worker)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TranscribeRequest:
    id: str
    audio_path: str
    language: str = "auto"
    initial_prompt: str = ""
    silence_threshold: float = DEFAULT_SILENCE_THRESHOLD
    op: str = "transcribe"


@dataclass(frozen=True)
class CancelRequest:
    id: str
    target_id: str
    op: str = "cancel"


@dataclass(frozen=True)
class HealthRequest:
    id: str
    op: str = "health"


@dataclass(frozen=True)
class ShutdownRequest:
    id: str
    op: str = "shutdown"


Request = TranscribeRequest | CancelRequest | HealthRequest | ShutdownRequest


# ---------------------------------------------------------------------------
# Responses (worker -> core)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TranscribeResponse:
    id: str
    raw_transcript: str
    audio_duration_ms: int
    transcription_ms: int
    model: str
    no_speech: bool = False
    detected_language: str | None = None
    warnings: list[str] = field(default_factory=list)

    def to_json_obj(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "ok": True,
            "op": "transcribe",
            "raw_transcript": self.raw_transcript,
            "detected_language": self.detected_language,
            "audio_duration_ms": int(self.audio_duration_ms),
            "transcription_ms": int(self.transcription_ms),
            "model": self.model,
            "no_speech": bool(self.no_speech),
            "warnings": list(self.warnings),
        }


@dataclass(frozen=True)
class HealthResponse:
    id: str
    state: str
    ready: bool
    model: str
    backend: str = BACKEND_NAME
    device: str | None = None
    load_ms: int | None = None
    warmed_up: bool = False
    error: str | None = None

    def to_json_obj(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.id,
            "ok": True,
            "op": "health",
            "state": self.state,
            "ready": bool(self.ready),
            "backend": self.backend,
            "model": self.model,
            "device": self.device,
            "load_ms": self.load_ms,
            "warmed_up": bool(self.warmed_up),
        }
        if self.error is not None:
            payload["error"] = self.error
        return payload


@dataclass(frozen=True)
class CancelResponse:
    id: str
    target_id: str
    cancelled: bool

    def to_json_obj(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "ok": True,
            "op": "cancel",
            "target_id": self.target_id,
            "cancelled": bool(self.cancelled),
        }


@dataclass(frozen=True)
class ShutdownResponse:
    id: str

    def to_json_obj(self) -> dict[str, Any]:
        return {"id": self.id, "ok": True, "op": "shutdown"}


@dataclass(frozen=True)
class ErrorResponse:
    id: str | None
    op: str | None
    error_code: str
    error: str

    def to_json_obj(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "ok": False,
            "op": self.op,
            "error_code": self.error_code if self.error_code in ERROR_CODES else "internal",
            "error": self.error,
        }


@dataclass(frozen=True)
class StatusEvent:
    """Unsolicited progress push. Always carries ``id: null``."""

    state: str
    ready: bool
    model: str
    load_ms: int | None = None
    warmed_up: bool | None = None
    error: str | None = None

    def to_json_obj(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": None,
            "ok": True,
            "op": "status",
            "state": self.state,
            "ready": bool(self.ready),
            "model": self.model,
        }
        if self.load_ms is not None:
            payload["load_ms"] = int(self.load_ms)
        if self.warmed_up is not None:
            payload["warmed_up"] = bool(self.warmed_up)
        if self.error is not None:
            payload["error"] = self.error
        return payload


Response = (
    TranscribeResponse
    | HealthResponse
    | CancelResponse
    | ShutdownResponse
    | ErrorResponse
    | StatusEvent
)


# ---------------------------------------------------------------------------
# Parsing / serialisation
# ---------------------------------------------------------------------------


def _require_str(obj: dict[str, Any], key: str, *, request_id: str | None, op: str | None,
                 error_code: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not value:
        raise ProtocolError(
            f"field {key!r} must be a non-empty string",
            request_id=request_id,
            op=op,
            error_code=error_code,
        )
    return value


def _optional_str(obj: dict[str, Any], key: str, default: str) -> str:
    value = obj.get(key, default)
    return value if isinstance(value, str) else default


def _clamped_threshold(obj: dict[str, Any]) -> float:
    value = obj.get("silence_threshold", DEFAULT_SILENCE_THRESHOLD)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return DEFAULT_SILENCE_THRESHOLD
    return min(1.0, max(0.0, float(value)))


def decode_request(line: str) -> Request:
    """Parse one JSON Lines request.

    Raises :class:`ProtocolError` for anything malformed — never a bare exception,
    so the caller can always answer with a protocol-shaped error line.
    """
    text = line.strip()
    if not text:
        raise ProtocolError("empty request line")

    try:
        obj = json.loads(text)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ProtocolError(f"invalid JSON: {exc}") from exc

    if not isinstance(obj, dict):
        raise ProtocolError("request must be a JSON object")

    raw_id = obj.get("id")
    request_id = raw_id if isinstance(raw_id, str) and raw_id else None

    raw_op = obj.get("op")
    op = raw_op if isinstance(raw_op, str) else None
    if op is None:
        raise ProtocolError("field 'op' must be a string", request_id=request_id)
    if op not in PROTOCOL_OPS:
        raise ProtocolError(f"unknown op {op!r}", request_id=request_id, op=op)

    if request_id is None:
        raise ProtocolError("field 'id' must be a non-empty string", op=op)

    if op == "transcribe":
        return TranscribeRequest(
            id=request_id,
            audio_path=_require_str(
                obj, "audio_path", request_id=request_id, op=op, error_code="audio_invalid"
            ),
            language=_optional_str(obj, "language", "auto") or "auto",
            initial_prompt=_optional_str(obj, "initial_prompt", ""),
            silence_threshold=_clamped_threshold(obj),
        )
    if op == "cancel":
        return CancelRequest(
            id=request_id,
            target_id=_require_str(
                obj, "target_id", request_id=request_id, op=op, error_code="internal"
            ),
        )
    if op == "health":
        return HealthRequest(id=request_id)
    return ShutdownRequest(id=request_id)


def encode_request(request: Request) -> str:
    """Serialise a request. Used by the test harness and by core's integration tests."""
    if isinstance(request, TranscribeRequest):
        obj: dict[str, Any] = {
            "id": request.id,
            "op": "transcribe",
            "audio_path": request.audio_path,
            "language": request.language,
            "initial_prompt": request.initial_prompt,
            "silence_threshold": request.silence_threshold,
        }
    elif isinstance(request, CancelRequest):
        obj = {"id": request.id, "op": "cancel", "target_id": request.target_id}
    elif isinstance(request, HealthRequest):
        obj = {"id": request.id, "op": "health"}
    elif isinstance(request, ShutdownRequest):
        obj = {"id": request.id, "op": "shutdown"}
    else:  # pragma: no cover - exhaustive over the union
        raise TypeError(f"not a request: {type(request)!r}")
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def encode_response(response: Response | dict[str, Any]) -> str:
    """Serialise a response to a single line (no trailing newline)."""
    obj = response if isinstance(response, dict) else response.to_json_obj()
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def error_from(exc: ProtocolError) -> ErrorResponse:
    return ErrorResponse(
        id=exc.request_id, op=exc.op, error_code=exc.error_code, error=exc.message
    )
