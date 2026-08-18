"""WAV loading and silence handling.

Only the stdlib ``wave`` module plus numpy — ffmpeg is a build-time convenience for
fixtures, never a runtime dependency of the worker.

The agent is contracted to send mono 16 kHz PCM (``docs/STT_PROTOCOL.md``), but a
capture that arrives stereo or at 48 kHz is repaired here rather than rejected: a
usable transcript beats a hard failure, and the deviation is reported as a warning
so the dashboard can surface a misconfigured input device.
"""

from __future__ import annotations

import wave
from dataclasses import dataclass, field

import numpy as np

TARGET_SAMPLE_RATE = 16_000

#: Hard ceiling on input duration, checked against the header before a single frame
#: is read. The product's settings cap ``maxRecordingSeconds`` at 1800
#: (packages/shared/src/settings.ts); one extra minute absorbs stop latency.
#: Anything longer is a stuck capture, and decoding it would cost hundreds of MB on
#: top of the resident model.
MAX_WAV_SECONDS = 1860

#: Peak below which a sample counts as silence. Deliberately low — quiet Russian
#: speech at arm's length from a MacBook mic peaks around 0.02-0.05, so anything
#: above ~0.01 starts clipping real words.
DEFAULT_SILENCE_THRESHOLD = 0.008

#: Padding kept around the detected speech region. Whisper's acoustic model needs a
#: little run-up; cutting exactly at the first loud sample eats plosives.
SILENCE_PAD_MS = 150

#: Below this much *voiced* audio (padding excluded) there is nothing to transcribe.
MIN_SPEECH_MS = 200


class AudioError(Exception):
    """The file is not decodable as PCM WAV. Maps to error_code ``audio_invalid``."""


@dataclass
class AudioClip:
    """Mono float32 PCM in [-1, 1] at :data:`TARGET_SAMPLE_RATE`."""

    samples: np.ndarray
    sample_rate: int = TARGET_SAMPLE_RATE
    warnings: list[str] = field(default_factory=list)

    @property
    def duration_ms(self) -> int:
        if self.sample_rate <= 0:
            return 0
        return int(round(self.samples.size * 1000 / self.sample_rate))


def _decode_frames(raw: bytes, sample_width: int, channels: int) -> np.ndarray:
    """Turn interleaved PCM bytes into a float32 array shaped (frames, channels)."""
    if sample_width == 1:
        # 8-bit WAV is unsigned by definition of the format.
        data = np.frombuffer(raw, dtype=np.uint8).astype(np.float32)
        data = (data - 128.0) / 128.0
    elif sample_width == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif sample_width == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    elif sample_width == 3:
        packed = np.frombuffer(raw, dtype=np.uint8)
        usable = (packed.size // 3) * 3
        triplets = packed[:usable].reshape(-1, 3).astype(np.int32)
        value = triplets[:, 0] | (triplets[:, 1] << 8) | (triplets[:, 2] << 16)
        value = np.where(value & 0x800000, value - 0x1000000, value)
        data = value.astype(np.float32) / 8388608.0
    else:
        raise AudioError(f"unsupported sample width: {sample_width * 8} bit")

    if channels < 1:
        raise AudioError(f"wav declares {channels} channels")
    usable_frames = data.size // channels
    if usable_frames == 0:
        return np.zeros((0, channels), dtype=np.float32)
    return data[: usable_frames * channels].reshape(usable_frames, channels)


def _resample_linear(samples: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    if src_rate == dst_rate or samples.size == 0:
        return samples
    duration = samples.size / src_rate
    dst_count = max(1, int(round(duration * dst_rate)))
    src_positions = np.arange(samples.size, dtype=np.float64)
    dst_positions = np.linspace(0.0, samples.size - 1, dst_count, dtype=np.float64)
    return np.interp(dst_positions, src_positions, samples).astype(np.float32)


def read_wav(path: str) -> AudioClip:
    """Read a PCM WAV into mono float32 at 16 kHz, repairing what can be repaired."""
    warnings: list[str] = []
    try:
        with wave.open(path, "rb") as handle:
            channels = handle.getnchannels()
            sample_width = handle.getsampwidth()
            sample_rate = handle.getframerate()
            frame_count = handle.getnframes()
            comp_type = handle.getcomptype()
            if comp_type != "NONE":
                raise AudioError(f"wav is compressed ({comp_type}), expected PCM")
            if sample_rate <= 0:
                raise AudioError(f"wav declares sample rate {sample_rate}")
            duration_s = frame_count / sample_rate
            if duration_s > MAX_WAV_SECONDS:
                raise AudioError(
                    f"wav is {duration_s:.0f} s long, over the {MAX_WAV_SECONDS} s limit"
                )
            raw = handle.readframes(frame_count)
    except AudioError:
        raise
    except (wave.Error, OSError, EOFError) as exc:
        raise AudioError(f"cannot read wav {path!r}: {exc}") from exc

    try:
        frames = _decode_frames(raw, sample_width, channels)
    except AudioError:
        raise
    except ValueError as exc:
        # A truncated data chunk leaves a byte count that is not a whole number of
        # samples; np.frombuffer reports that as a bare ValueError.
        raise AudioError(f"cannot decode wav {path!r}: {exc}") from exc
    if sample_width != 2:
        warnings.append(f"sample_width_{sample_width * 8}bit")

    if channels > 1:
        mono = frames.mean(axis=1).astype(np.float32)
        warnings.append(f"downmixed_from_{channels}ch")
    else:
        mono = frames[:, 0].astype(np.float32) if frames.size else frames.reshape(0)

    if sample_rate != TARGET_SAMPLE_RATE:
        mono = _resample_linear(mono, sample_rate, TARGET_SAMPLE_RATE)
        warnings.append(f"resampled_from_{sample_rate}hz")

    # Downmixing sums correlated channels; clamp so a hot stereo capture cannot
    # hand Whisper values outside its expected range.
    np.clip(mono, -1.0, 1.0, out=mono)
    return AudioClip(samples=mono, sample_rate=TARGET_SAMPLE_RATE, warnings=warnings)


def peak_amplitude(samples: np.ndarray) -> float:
    if samples.size == 0:
        return 0.0
    return float(np.max(np.abs(samples)))


def rms_amplitude(samples: np.ndarray) -> float:
    if samples.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))


@dataclass
class TrimResult:
    samples: np.ndarray
    #: Milliseconds between the first and last sample above threshold, padding excluded.
    voiced_ms: int
    trimmed: bool
    no_speech: bool


def trim_silence(
    samples: np.ndarray,
    sample_rate: int = TARGET_SAMPLE_RATE,
    threshold: float = DEFAULT_SILENCE_THRESHOLD,
    pad_ms: int = SILENCE_PAD_MS,
    min_speech_ms: int = MIN_SPEECH_MS,
) -> TrimResult:
    """Cut leading/trailing silence, keeping ``pad_ms`` on each side.

    The no-speech decision is made on the *voiced span* rather than on the padded
    output, otherwise the padding alone would always clear the 200 ms bar.
    """
    if samples.size == 0 or sample_rate <= 0:
        return TrimResult(samples=samples, voiced_ms=0, trimmed=False, no_speech=True)

    loud = np.flatnonzero(np.abs(samples) >= threshold)
    if loud.size == 0:
        return TrimResult(
            samples=samples[:0], voiced_ms=0, trimmed=True, no_speech=True
        )

    first = int(loud[0])
    last = int(loud[-1])
    voiced_ms = int(round((last - first + 1) * 1000 / sample_rate))
    if voiced_ms < min_speech_ms:
        return TrimResult(
            samples=samples[:0], voiced_ms=voiced_ms, trimmed=True, no_speech=True
        )

    pad = max(0, int(pad_ms * sample_rate / 1000))
    start = max(0, first - pad)
    end = min(samples.size, last + 1 + pad)
    trimmed_samples = samples[start:end]
    return TrimResult(
        samples=trimmed_samples,
        voiced_ms=voiced_ms,
        trimmed=trimmed_samples.size != samples.size,
        no_speech=False,
    )


def near_silence(duration_s: float = 1.0, sample_rate: int = TARGET_SAMPLE_RATE) -> np.ndarray:
    """Warm-up audio: dithered near-silence, never pure zeros.

    A block of exact zeros sends Whisper straight down its no-speech branch, so the
    decoder loop that the first real phrase will use never gets compiled and the
    warm-up buys nothing. A tiny deterministic dither keeps the same code path warm
    while still transcribing to nothing.
    """
    count = max(1, int(duration_s * sample_rate))
    rng = np.random.default_rng(0x10CA1)
    return (rng.standard_normal(count) * 1e-4).astype(np.float32)
