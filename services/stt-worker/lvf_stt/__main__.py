"""Entrypoint: ``python -m lvf_stt --model <id> [--no-warmup] [--log-level info]``."""

from __future__ import annotations

import argparse
import io
import logging
import os
import signal
import sys
from typing import TextIO

from . import DEFAULT_MODEL, __version__

log = logging.getLogger(__name__)

LOG_LEVELS = ("error", "warn", "info", "debug")

_LEVEL_MAP = {
    "error": logging.ERROR,
    "warn": logging.WARNING,
    "info": logging.INFO,
    "debug": logging.DEBUG,
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lvf_stt",
        description="LocalVoiceFlow MLX worker (JSON Lines over stdin/stdout).",
    )
    parser.add_argument(
        "--role",
        default="stt",
        choices=("stt", "llm"),
        help="stt: the Whisper transcription worker (default); llm: the local "
        "text-correction worker.",
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Hugging Face repo id of the MLX model. Defaults to the role's standard "
        f"model ({DEFAULT_MODEL} for stt).",
    )
    parser.add_argument(
        "--no-warmup",
        action="store_true",
        help="stt only: skip the warm-up decode; the first real phrase then pays MLX "
        "compilation.",
    )
    parser.add_argument(
        "--log-level",
        default="info",
        choices=LOG_LEVELS,
        help="Verbosity of the stderr log (default: info).",
    )
    parser.add_argument("--version", action="version", version=f"lvf_stt {__version__}")
    return parser


def _claim_stdout() -> TextIO:
    """Hand the protocol an exclusive stdout and point everything else at stderr.

    ``docs/STT_PROTOCOL.md`` makes any non-JSON byte on stdout a protocol violation,
    and third-party code (huggingface_hub progress bars, a stray ``print``) does not
    know that. Duplicating fd 1 and then aliasing fd 1 to stderr means such output is
    still visible in the log but can never corrupt the stream core is parsing.
    """
    try:
        sys.stdout.flush()
        protocol_fd = os.dup(1)
        os.dup2(2, 1)
        stream = io.TextIOWrapper(
            io.FileIO(protocol_fd, "w", closefd=True),
            encoding="utf-8",
            errors="replace",
            newline="\n",
            write_through=True,
        )
        # sys.stdout still wraps fd 1, which now points at stderr's target.
        return stream
    except OSError as exc:
        log.warning(
            "failed to shield protocol stdout (%s); stray non-JSON output on fd 1 "
            "can now corrupt the stream core is parsing",
            exc,
        )
        return sys.stdout


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    logging.basicConfig(
        stream=sys.stderr,
        level=_LEVEL_MAP[args.log_level],
        format="%(asctime)s %(levelname)-5s [lvf-stt] %(name)s: %(message)s",
    )
    # At --log-level debug these libraries dump TLS handshakes and full HTTP headers
    # into core's log file. That is noise, and the headers are not ours to record.
    for noisy in ("httpx", "httpcore", "urllib3", "filelock", "huggingface_hub", "numba"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    protocol_out = _claim_stdout()
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

    # Core owns the lifecycle and sends `shutdown`; a Ctrl-C in a terminal should
    # still end the process quietly rather than dumping a traceback on stderr.
    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    # Imported here so --help and --version never pay for numpy or MLX.
    worker: object
    if args.role == "llm":
        from .llm_engine import DEFAULT_LLM_MODEL, LlmEngine
        from .llm_worker import LlmWorker

        worker = LlmWorker(LlmEngine(args.model or DEFAULT_LLM_MODEL), sys.stdin, protocol_out)
    else:
        from .engine import WhisperEngine
        from .worker import Worker

        engine = WhisperEngine(args.model or DEFAULT_MODEL, warmup=not args.no_warmup)
        worker = Worker(engine, sys.stdin, protocol_out)
    try:
        return worker.run()  # type: ignore[attr-defined]
    finally:
        try:
            protocol_out.flush()
        except (OSError, ValueError):
            pass


if __name__ == "__main__":
    raise SystemExit(main())
