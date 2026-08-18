"""Wire protocol for the core <-> llm-worker JSON Lines channel.

Mirrors the shape of :mod:`lvf_stt.protocol` (the STT channel) so core can supervise
both workers with the same machinery. Deliberately imports nothing beyond the standard
library — the worker must answer ``status: starting`` and reject malformed requests
before MLX has been imported, and the protocol tests must run on any machine.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Final

LLM_PROTOCOL_OPS: Final[tuple[str, ...]] = ("correct", "warm", "cancel", "health", "shutdown")
LLM_ERROR_CODES: Final[tuple[str, ...]] = (
    "model_not_loaded",
    "cancelled",
    "internal",
)
LLM_BACKEND_NAME: Final[str] = "mlx-lm"


class ProtocolError(Exception):
    """A request that could not be understood.

    Carries enough context for the worker to answer with a well-formed error line
    instead of dying: core supervises this process, and a crash costs a model reload.
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
class CorrectRequest:
    id: str
    system_prompt: str
    payload: str
    #: 0 means "let the worker pick a cap from the input length".
    max_tokens: int = 0
    op: str = "correct"


@dataclass(frozen=True)
class WarmRequest:
    """Pre-fill the KV cache for ``system_prompt`` so the first correct() is fast."""

    id: str
    system_prompt: str
    op: str = "warm"


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


Request = CorrectRequest | WarmRequest | CancelRequest | HealthRequest | ShutdownRequest


# ---------------------------------------------------------------------------
# Responses (worker -> core)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CorrectResponse:
    id: str
    text: str
    model: str
    prompt_tokens: int
    generation_tokens: int
    generation_ms: int
    #: "stop" for a natural end, "length" when the max-token cap cut the output.
    finish_reason: str = "stop"

    def to_json_obj(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "ok": True,
            "op": "correct",
            "text": self.text,
            "model": self.model,
            "prompt_tokens": int(self.prompt_tokens),
            "generation_tokens": int(self.generation_tokens),
            "generation_ms": int(self.generation_ms),
            "finish_reason": self.finish_reason,
        }


@dataclass(frozen=True)
class WarmResponse:
    id: str
    warmed: bool
    prompt_tokens: int
    warm_ms: int

    def to_json_obj(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "ok": True,
            "op": "warm",
            "warmed": bool(self.warmed),
            "prompt_tokens": int(self.prompt_tokens),
            "warm_ms": int(self.warm_ms),
        }


@dataclass(frozen=True)
class HealthResponse:
    id: str
    state: str
    ready: bool
    model: str
    backend: str = LLM_BACKEND_NAME
    load_ms: int | None = None
    warmed_prompt: bool = False
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
            "load_ms": self.load_ms,
            "warmed_prompt": bool(self.warmed_prompt),
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
            "error_code": self.error_code if self.error_code in LLM_ERROR_CODES else "internal",
            "error": self.error,
        }


@dataclass(frozen=True)
class StatusEvent:
    """Unsolicited progress push. Always carries ``id: null``."""

    state: str
    ready: bool
    model: str
    load_ms: int | None = None
    warmed_prompt: bool | None = None
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
        if self.warmed_prompt is not None:
            payload["warmed_prompt"] = bool(self.warmed_prompt)
        if self.error is not None:
            payload["error"] = self.error
        return payload


Response = (
    CorrectResponse
    | WarmResponse
    | HealthResponse
    | CancelResponse
    | ShutdownResponse
    | ErrorResponse
    | StatusEvent
)


# ---------------------------------------------------------------------------
# Parsing / serialisation
# ---------------------------------------------------------------------------


def _require_str(obj: dict[str, Any], key: str, *, request_id: str | None, op: str | None) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not value:
        raise ProtocolError(
            f"field {key!r} must be a non-empty string", request_id=request_id, op=op
        )
    return value


def _clamped_max_tokens(obj: dict[str, Any]) -> int:
    value = obj.get("max_tokens", 0)
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return min(8192, max(0, value))


def decode_request(line: str) -> Request:
    """Parse one JSON Lines request; raises :class:`ProtocolError` on anything malformed."""
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
    if op not in LLM_PROTOCOL_OPS:
        raise ProtocolError(f"unknown op {op!r}", request_id=request_id, op=op)

    if request_id is None:
        raise ProtocolError("field 'id' must be a non-empty string", op=op)

    if op == "correct":
        return CorrectRequest(
            id=request_id,
            system_prompt=_require_str(obj, "system_prompt", request_id=request_id, op=op),
            payload=_require_str(obj, "payload", request_id=request_id, op=op),
            max_tokens=_clamped_max_tokens(obj),
        )
    if op == "warm":
        return WarmRequest(
            id=request_id,
            system_prompt=_require_str(obj, "system_prompt", request_id=request_id, op=op),
        )
    if op == "cancel":
        return CancelRequest(
            id=request_id,
            target_id=_require_str(obj, "target_id", request_id=request_id, op=op),
        )
    if op == "health":
        return HealthRequest(id=request_id)
    return ShutdownRequest(id=request_id)


def encode_request(request: Request) -> str:
    """Serialise a request. Used by core's tests and the Python test harness."""
    if isinstance(request, CorrectRequest):
        obj: dict[str, Any] = {
            "id": request.id,
            "op": "correct",
            "system_prompt": request.system_prompt,
            "payload": request.payload,
            "max_tokens": request.max_tokens,
        }
    elif isinstance(request, WarmRequest):
        obj = {"id": request.id, "op": "warm", "system_prompt": request.system_prompt}
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
    obj = response if isinstance(response, dict) else response.to_json_obj()
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def error_from(exc: ProtocolError) -> ErrorResponse:
    return ErrorResponse(
        id=exc.request_id, op=exc.op, error_code=exc.error_code, error=exc.message
    )
