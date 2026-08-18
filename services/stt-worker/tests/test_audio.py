"""Audio reading, repair and silence handling. Needs numpy but never MLX."""

from __future__ import annotations

import os
import struct
import sys
import tempfile
import unittest
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lvf_stt import audio  # noqa: E402


def write_wav(
    path: str,
    samples: np.ndarray,
    sample_rate: int = 16_000,
    channels: int = 1,
    sample_width: int = 2,
) -> None:
    """Write float samples in [-1, 1] as PCM with the requested layout."""
    flat = np.asarray(samples, dtype=np.float32).reshape(-1)
    with wave.open(path, "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(sample_width)
        handle.setframerate(sample_rate)
        if sample_width == 2:
            handle.writeframes(np.clip(flat * 32767.0, -32768, 32767).astype("<i2").tobytes())
        elif sample_width == 1:
            handle.writeframes(
                np.clip(flat * 127.0 + 128.0, 0, 255).astype(np.uint8).tobytes()
            )
        elif sample_width == 3:
            packed = np.clip(flat * 8388607.0, -8388608, 8388607).astype("<i4")
            handle.writeframes(packed.view(np.uint8).reshape(-1, 4)[:, :3].tobytes())
        elif sample_width == 4:
            handle.writeframes(
                np.clip(flat * 2147483647.0, -2147483648, 2147483647)
                .astype("<i4")
                .tobytes()
            )
        else:  # pragma: no cover - only used by the widths above
            raise ValueError(sample_width)


def tone(duration_s: float, sample_rate: int = 16_000, amplitude: float = 0.3) -> np.ndarray:
    t = np.arange(int(duration_s * sample_rate), dtype=np.float32) / sample_rate
    return (np.sin(2 * np.pi * 220.0 * t) * amplitude).astype(np.float32)


class AudioTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory(prefix="lvf-audio-test-")
        self.addCleanup(self._dir.cleanup)

    def path(self, name: str) -> str:
        return os.path.join(self._dir.name, name)


class TestReadWav(AudioTestCase):
    def test_mono_16k_has_no_warnings(self) -> None:
        p = self.path("mono.wav")
        write_wav(p, tone(0.5))
        clip = audio.read_wav(p)
        self.assertEqual(clip.warnings, [])
        self.assertEqual(clip.sample_rate, 16_000)
        self.assertEqual(clip.samples.dtype, np.float32)
        self.assertEqual(clip.duration_ms, 500)
        self.assertAlmostEqual(audio.peak_amplitude(clip.samples), 0.3, places=2)

    def test_stereo_is_downmixed_with_a_warning(self) -> None:
        p = self.path("stereo.wav")
        left = tone(0.4, amplitude=0.4)
        right = np.zeros_like(left)
        interleaved = np.empty(left.size * 2, dtype=np.float32)
        interleaved[0::2] = left
        interleaved[1::2] = right
        write_wav(p, interleaved, channels=2)
        clip = audio.read_wav(p)
        self.assertIn("downmixed_from_2ch", clip.warnings)
        self.assertEqual(clip.samples.size, left.size)
        # Averaging a loud channel with a silent one halves the peak.
        self.assertAlmostEqual(audio.peak_amplitude(clip.samples), 0.2, places=2)

    def test_other_sample_rate_is_resampled_with_a_warning(self) -> None:
        p = self.path("48k.wav")
        write_wav(p, tone(0.5, sample_rate=48_000), sample_rate=48_000)
        clip = audio.read_wav(p)
        self.assertIn("resampled_from_48000hz", clip.warnings)
        self.assertEqual(clip.sample_rate, 16_000)
        self.assertAlmostEqual(clip.duration_ms, 500, delta=5)

    def test_8bit_24bit_and_32bit_are_converted_with_a_warning(self) -> None:
        for width in (1, 3, 4):
            with self.subTest(width=width):
                p = self.path(f"w{width}.wav")
                write_wav(p, tone(0.3), sample_width=width)
                clip = audio.read_wav(p)
                self.assertIn(f"sample_width_{width * 8}bit", clip.warnings)
                self.assertAlmostEqual(audio.peak_amplitude(clip.samples), 0.3, places=1)

    def test_empty_file_yields_an_empty_clip(self) -> None:
        p = self.path("empty.wav")
        write_wav(p, np.zeros(0, dtype=np.float32))
        clip = audio.read_wav(p)
        self.assertEqual(clip.samples.size, 0)
        self.assertEqual(clip.duration_ms, 0)
        self.assertEqual(audio.peak_amplitude(clip.samples), 0.0)
        self.assertEqual(audio.rms_amplitude(clip.samples), 0.0)

    def test_missing_file_raises_audio_error(self) -> None:
        with self.assertRaises(audio.AudioError):
            audio.read_wav(self.path("nope.wav"))

    def test_non_wav_bytes_raise_audio_error(self) -> None:
        p = self.path("garbage.wav")
        with open(p, "wb") as handle:
            handle.write(b"this is definitely not RIFF")
        with self.assertRaises(audio.AudioError):
            audio.read_wav(p)

    def test_truncated_data_chunk_raises_audio_error(self) -> None:
        # Chopping one byte off the tail leaves a data chunk that is not a whole
        # number of 16-bit samples — the classic interrupted capture.
        p = self.path("truncated.wav")
        write_wav(p, tone(0.2))
        with open(p, "rb") as handle:
            blob = handle.read()
        with open(p, "wb") as handle:
            handle.write(blob[:-1])
        with self.assertRaises(audio.AudioError):
            audio.read_wav(p)

    def test_overlong_wav_is_rejected_from_the_header_alone(self) -> None:
        # The data chunk declares far more audio than the file holds; the reader
        # must reject on the declared duration without trying to materialise it.
        p = self.path("overlong.wav")
        rate = 16_000
        declared_bytes = int((audio.MAX_WAV_SECONDS + 60) * rate) * 2
        fmt = struct.pack("<HHIIHH", 1, 1, rate, rate * 2, 2, 16)
        body = (
            b"WAVE"
            + b"fmt "
            + struct.pack("<I", len(fmt))
            + fmt
            + b"data"
            + struct.pack("<I", declared_bytes)
            + b"\x00" * 64
        )
        with open(p, "wb") as handle:
            handle.write(b"RIFF" + struct.pack("<I", len(body)) + body)
        with self.assertRaises(audio.AudioError) as caught:
            audio.read_wav(p)
        self.assertIn("limit", str(caught.exception))

    def test_compressed_wav_raises_audio_error(self) -> None:
        # A hand-built RIFF header declaring µ-law (format tag 7).
        p = self.path("ulaw.wav")
        payload = b"\x00" * 64
        fmt = struct.pack("<HHIIHH", 7, 1, 8000, 8000, 1, 8)
        body = (
            b"WAVE"
            + b"fmt "
            + struct.pack("<I", len(fmt))
            + fmt
            + b"data"
            + struct.pack("<I", len(payload))
            + payload
        )
        with open(p, "wb") as handle:
            handle.write(b"RIFF" + struct.pack("<I", len(body)) + body)
        with self.assertRaises(audio.AudioError):
            audio.read_wav(p)


class TestTrimSilence(unittest.TestCase):
    def _clip_with_speech(self, speech_ms: int, lead_ms: int = 1000, tail_ms: int = 1000,
                          amplitude: float = 0.3) -> np.ndarray:
        rate = 16_000
        lead = np.zeros(int(lead_ms * rate / 1000), dtype=np.float32)
        tail = np.zeros(int(tail_ms * rate / 1000), dtype=np.float32)
        speech = tone(speech_ms / 1000.0, amplitude=amplitude)
        return np.concatenate([lead, speech, tail])

    def test_pure_silence_is_no_speech(self) -> None:
        result = audio.trim_silence(np.zeros(16_000, dtype=np.float32))
        self.assertTrue(result.no_speech)
        self.assertEqual(result.samples.size, 0)
        self.assertEqual(result.voiced_ms, 0)

    def test_empty_input_is_no_speech(self) -> None:
        result = audio.trim_silence(np.zeros(0, dtype=np.float32))
        self.assertTrue(result.no_speech)

    def test_short_click_is_no_speech(self) -> None:
        # 50 ms of signal is a keyboard click, not a word.
        result = audio.trim_silence(self._clip_with_speech(50))
        self.assertTrue(result.no_speech)
        self.assertLess(result.voiced_ms, audio.MIN_SPEECH_MS)

    def test_speech_is_kept_with_padding(self) -> None:
        result = audio.trim_silence(self._clip_with_speech(600))
        self.assertFalse(result.no_speech)
        self.assertTrue(result.trimmed)
        self.assertAlmostEqual(result.voiced_ms, 600, delta=10)
        expected_ms = 600 + 2 * audio.SILENCE_PAD_MS
        actual_ms = result.samples.size * 1000 / 16_000
        self.assertAlmostEqual(actual_ms, expected_ms, delta=15)

    def test_quiet_speech_is_not_clipped(self) -> None:
        # 0.012 peak is a whisper into a MacBook mic; it must survive the default
        # 0.008 threshold rather than being reported as silence.
        result = audio.trim_silence(self._clip_with_speech(800, amplitude=0.012))
        self.assertFalse(result.no_speech)
        self.assertAlmostEqual(result.voiced_ms, 800, delta=20)

    def test_signal_below_threshold_is_no_speech(self) -> None:
        result = audio.trim_silence(self._clip_with_speech(800, amplitude=0.002))
        self.assertTrue(result.no_speech)

    def test_no_padding_beyond_the_buffer(self) -> None:
        speech = tone(0.5)
        result = audio.trim_silence(speech)
        self.assertFalse(result.no_speech)
        self.assertEqual(result.samples.size, speech.size)
        self.assertFalse(result.trimmed)

    def test_threshold_is_honoured(self) -> None:
        clip = self._clip_with_speech(800, amplitude=0.05)
        self.assertFalse(audio.trim_silence(clip, threshold=0.01).no_speech)
        self.assertTrue(audio.trim_silence(clip, threshold=0.2).no_speech)


class TestWarmupAudio(unittest.TestCase):
    def test_near_silence_is_quiet_but_not_zero(self) -> None:
        block = audio.near_silence(1.0)
        self.assertEqual(block.size, 16_000)
        self.assertEqual(block.dtype, np.float32)
        peak = audio.peak_amplitude(block)
        self.assertGreater(peak, 0.0)
        self.assertLess(peak, 0.001)
        # Pure zeros would send Whisper down its no-speech branch and leave the real
        # decode path uncompiled, which is the whole point of the warm-up.
        self.assertGreater(audio.rms_amplitude(block), 0.0)


if __name__ == "__main__":
    unittest.main()
