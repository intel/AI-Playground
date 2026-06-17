"""Audio transcoding helpers for outbound channel voice messages.

TTS servers (OVMS SpeechT5 and most OpenAI-compatible fallbacks) return WAV, but
each chat platform wants something different for a nice inline player:

- Telegram renders a real voice bubble only for OGG/Opus.
- Slack does not give Opus-in-Ogg a playable inline player (it mis-detects it as
  "Ogg Vorbis"); it reliably plays MP3.

So we transcode here, at the channel boundary, rather than relying on the TTS
server's `response_format`. PyAV bundles a full FFmpeg (with libopus and
libmp3lame) as cross-platform wheels, so no system FFmpeg is required.
"""

from __future__ import annotations

import io
import logging

logger = logging.getLogger(__name__)

# Opus uses a fixed 20 ms frame (960 samples @ 48 kHz); MP3 uses 1152 samples.
# PyAV reports the real value via `stream.frame_size` once the encoder is open,
# but it can be 0 before the first encode call, so we seed a codec-correct
# default for the initial FIFO read.
_OPUS_RATE = 48000
_MP3_RATE = 48000
_LAYOUT = "mono"


def is_ogg_opus(mime: str) -> bool:
    m = (mime or "").lower()
    return "ogg" in m or "opus" in m


def to_ogg_opus(data: bytes) -> bytes:
    """Transcode arbitrary audio bytes (typically WAV) to Ogg/Opus (Telegram).

    Raises on failure so callers can fall back to sending the original audio.
    """
    return _encode(data, container="ogg", codec="libopus", rate=_OPUS_RATE, default_frame_size=960)


def to_mp3(data: bytes) -> bytes:
    """Transcode arbitrary audio bytes (typically WAV) to MP3 (Slack).

    Raises on failure so callers can fall back to sending the original audio.
    """
    return _encode(
        data, container="mp3", codec="libmp3lame", rate=_MP3_RATE, default_frame_size=1152
    )


def _encode(data: bytes, *, container: str, codec: str, rate: int, default_frame_size: int) -> bytes:
    import av
    from av.audio.fifo import AudioFifo
    from av.audio.resampler import AudioResampler

    in_buffer = io.BytesIO(data)
    out_buffer = io.BytesIO()

    in_container = av.open(in_buffer, mode="r")
    out_container = av.open(out_buffer, mode="w", format=container)
    try:
        out_stream = out_container.add_stream(codec, rate=rate, layout=_LAYOUT)
        resampler = AudioResampler(format="s16", layout=_LAYOUT, rate=rate)
        fifo = AudioFifo()

        def drain(flush: bool) -> None:
            # Fixed-frame encoders (opus, mp3) require exact frame sizes; pull
            # full frames from the FIFO and only emit a short final frame on flush.
            frame_size = out_stream.frame_size or default_frame_size
            while True:
                frame = fifo.read(frame_size) if not flush else fifo.read(frame_size, partial=True)
                if frame is None:
                    break
                frame.pts = None
                for packet in out_stream.encode(frame):
                    out_container.mux(packet)
                if flush and frame.samples < frame_size:
                    break

        for frame in in_container.decode(audio=0):
            for resampled in resampler.resample(frame):
                fifo.write(resampled)
                drain(flush=False)
        # Flush the resampler, then the fifo, then the encoder.
        for resampled in resampler.resample(None):
            fifo.write(resampled)
        drain(flush=True)
        for packet in out_stream.encode(None):
            out_container.mux(packet)
    finally:
        out_container.close()
        in_container.close()

    return out_buffer.getvalue()
