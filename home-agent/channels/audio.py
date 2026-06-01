"""Audio transcoding helpers for outbound channel voice messages.

TTS servers (OVMS SpeechT5 and most OpenAI-compatible fallbacks) return WAV.
Telegram only renders a real voice bubble for OGG/Opus, so we transcode here —
at the channel boundary — rather than relying on the TTS server's
`response_format`, which is not reliably supported. PyAV bundles a full FFmpeg
(with libopus) as cross-platform wheels, so no system FFmpeg is required.
"""

from __future__ import annotations

import io
import logging

logger = logging.getLogger(__name__)

# Telegram voice notes: mono, 48 kHz Opus in an Ogg container.
_OPUS_RATE = 48000
_OPUS_LAYOUT = "mono"
# libopus uses a fixed frame size (20 ms @ 48 kHz = 960 samples). PyAV reports
# this via `stream.frame_size` once the encoder is open; fall back to 960.
_DEFAULT_FRAME_SIZE = 960


def is_ogg_opus(mime: str) -> bool:
    m = (mime or "").lower()
    return "ogg" in m or "opus" in m


def to_ogg_opus(data: bytes) -> bytes:
    """Transcode arbitrary audio bytes (typically WAV) to Ogg/Opus.

    Raises on failure so callers can fall back to sending the original audio.
    """
    import av
    from av.audio.fifo import AudioFifo
    from av.audio.resampler import AudioResampler

    in_buffer = io.BytesIO(data)
    out_buffer = io.BytesIO()

    in_container = av.open(in_buffer, mode="r")
    out_container = av.open(out_buffer, mode="w", format="ogg")
    try:
        out_stream = out_container.add_stream("libopus", rate=_OPUS_RATE, layout=_OPUS_LAYOUT)
        resampler = AudioResampler(format="s16", layout=_OPUS_LAYOUT, rate=_OPUS_RATE)
        fifo = AudioFifo()

        def drain(flush: bool) -> None:
            frame_size = out_stream.frame_size or _DEFAULT_FRAME_SIZE
            while True:
                # On flush, accept a final short frame; otherwise only full frames.
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
