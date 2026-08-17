"""LocalVoiceFlow speech-to-text worker.

A single long-lived process that keeps an MLX Whisper model resident and speaks
JSON Lines over stdin/stdout. See ``docs/STT_PROTOCOL.md``.

Importing this package must stay cheap and MLX-free: ``lvf_stt.protocol`` has to be
usable before (and without) the MLX import.
"""

__version__ = "0.1.0"

DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"

__all__ = ["DEFAULT_MODEL", "__version__"]
