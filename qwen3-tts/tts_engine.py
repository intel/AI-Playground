"""Lazy-loaded Qwen3-TTS inference for the AI Playground sidecar."""

from __future__ import annotations

import contextlib
import io
import logging
import os
import threading
from typing import Any, Literal

logger = logging.getLogger(__name__)

SynthesisMode = Literal["custom_voice", "voice_design"]

CUSTOM_VOICE_SPEAKERS: list[dict[str, str]] = [
    {
        "id": "Vivian",
        "description": "Bright, slightly edgy young female voice.",
        "nativeLanguage": "Chinese",
    },
    {
        "id": "Serena",
        "description": "Warm, gentle young female voice.",
        "nativeLanguage": "Chinese",
    },
    {
        "id": "Uncle_Fu",
        "description": "Seasoned male voice with a low, mellow timbre.",
        "nativeLanguage": "Chinese",
    },
    {
        "id": "Dylan",
        "description": "Youthful Beijing male voice.",
        "nativeLanguage": "Chinese (Beijing Dialect)",
    },
    {
        "id": "Eric",
        "description": "Lively Chengdu male voice.",
        "nativeLanguage": "Chinese (Sichuan Dialect)",
    },
    {
        "id": "Ryan",
        "description": "Dynamic male voice with strong rhythmic drive.",
        "nativeLanguage": "English",
    },
    {
        "id": "Aiden",
        "description": "Sunny American male voice.",
        "nativeLanguage": "English",
    },
    {
        "id": "Ono_Anna",
        "description": "Playful Japanese female voice.",
        "nativeLanguage": "Japanese",
    },
    {
        "id": "Sohee",
        "description": "Warm Korean female voice.",
        "nativeLanguage": "Korean",
    },
]

LANGUAGES = [
    "Auto",
    "Chinese",
    "English",
    "Japanese",
    "Korean",
    "German",
    "French",
    "Russian",
    "Portuguese",
    "Spanish",
    "Italian",
]

# Serializes model loading (mutating the cache) …
_load_lock = threading.Lock()
# … and separately serializes inference. The models share a single accelerator
# and most torch generate paths are not thread-safe, so concurrent
# /api/synthesize requests must not hit a model object at the same time.
_infer_lock = threading.Lock()
# Two-slot cache: custom_voice and voice_design use different model ids, so we
# keep both resident once loaded instead of unloading/reloading on every mode
# switch. Keyed by model id.
_models: dict[str, Any] = {}
_load_error: str | None = None
_resolved_device: str | None = None

# Upper bound on input length. A single request that is too long can run for
# minutes or exhaust device memory; the agent should split long scripts.
MAX_TEXT_CHARS = int(os.environ.get("QWEN3_TTS_MAX_CHARS", "5000"))


def resolved_device_label() -> str | None:
    with _load_lock:
        return _resolved_device


def default_model_id() -> str:
    return os.environ.get(
        "QWEN3_TTS_MODEL",
        "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
    )


def voice_design_model_id() -> str:
    return os.environ.get(
        "QWEN3_TTS_VOICE_DESIGN_MODEL",
        "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
    )


def model_status() -> dict[str, object]:
    with _load_lock:
        return {
            "loaded": bool(_models),
            "loadedModelIds": sorted(_models.keys()),
            "loadError": _load_error,
            "device": _resolved_device,
        }


def model_id_for_mode(mode: SynthesisMode) -> str:
    return voice_design_model_id() if mode == "voice_design" else default_model_id()


def is_model_downloaded(mode: SynthesisMode = "custom_voice") -> bool:
    """Whether the weights for `mode` are present locally.

    Electron points `QWEN3_TTS_MODEL` / `QWEN3_TTS_VOICE_DESIGN_MODEL` at the
    downloaded directory, so a local dir means "installed". A bare HF repo id
    (the default when nothing is downloaded) is not — and with HF offline we must
    never try to fetch it.
    """
    return os.path.isdir(model_id_for_mode(mode))


def ensure_loaded(mode: SynthesisMode) -> None:
    """Load (and cache) the model for `mode`; a no-op once resident."""
    _load_model(model_id_for_mode(mode))


def _xpu_usable() -> bool:
    try:
        import torch

        if not hasattr(torch, "xpu"):
            return False
        if not torch.xpu.is_available():
            return False
        return torch.xpu.device_count() > 0
    except (ImportError, AttributeError, RuntimeError, OSError):
        # torch missing, an unexpected API surface, or a driver/runtime probe
        # failure all just mean "no usable XPU".
        logger.debug("XPU probe failed; treating XPU as unavailable", exc_info=True)
        return False


def _resolve_device_map() -> str:
    device = os.environ.get("QWEN3_TTS_DEVICE", "auto").strip().lower()
    if device not in ("", "auto"):
        return device
    try:
        import torch

        if _xpu_usable():
            return "xpu"
        if torch.cuda.is_available():
            return "cuda:0"
    except (ImportError, AttributeError, RuntimeError, OSError):
        # Any import/API/driver probe failure falls back to CPU.
        logger.debug("Accelerator probe failed; falling back to CPU", exc_info=True)
    return "cpu"


def _load_model(model_id: str) -> Any:
    global _load_error, _resolved_device
    with _load_lock:
        cached = _models.get(model_id)
        if cached is not None:
            return cached
        _load_error = None
        device_map = _resolve_device_map()
        _resolved_device = device_map
        logger.info("Loading Qwen3-TTS model %s on device %s …", model_id, device_map)
        import torch

        dtype_name = os.environ.get("QWEN3_TTS_DTYPE", "bfloat16")
        dtype = torch.bfloat16 if dtype_name == "bfloat16" else torch.float16
        attn = os.environ.get("QWEN3_TTS_ATTN", "sdpa").strip()
        kwargs: dict[str, Any] = {
            "device_map": device_map,
            "dtype": dtype,
        }
        if attn and attn.lower() != "none":
            kwargs["attn_implementation"] = attn
        try:
            # qwen_tts prints a flash-attn install banner on import; we use SDPA instead.
            with contextlib.redirect_stdout(io.StringIO()):
                from vendor.qwen_tts import Qwen3TTSModel

            model = Qwen3TTSModel.from_pretrained(model_id, **kwargs)
            # Cache under its id; any already-loaded model for the other mode
            # stays resident so we never reload on a mode switch.
            _models[model_id] = model
            logger.info(
                "Qwen3-TTS model loaded: %s (device=%s, attn=%s)",
                model_id,
                device_map,
                attn or "default",
            )
            return model
        except Exception as exc:
            _load_error = str(exc)
            logger.exception("Failed to load Qwen3-TTS model")
            raise


def synthesize_wav(
    *,
    text: str,
    language: str,
    speaker: str,
    instruct: str | None,
    mode: SynthesisMode,
) -> tuple[bytes, int]:
    import numpy as np
    import soundfile as sf

    trimmed = (text or "").strip()
    if not trimmed:
        raise ValueError("text is required")
    if len(trimmed) > MAX_TEXT_CHARS:
        raise ValueError(
            f"text is too long ({len(trimmed)} characters); the maximum is {MAX_TEXT_CHARS}. "
            "Split it into smaller segments and synthesize them separately."
        )

    lang = language.strip() if language else "Auto"
    if lang.lower() == "auto":
        lang = "Auto"

    model_id = voice_design_model_id() if mode == "voice_design" else default_model_id()
    model = _load_model(model_id)

    # Serialize inference: the cached models share one accelerator and the
    # generate paths are not thread-safe, so only one synthesis runs at a time.
    with _infer_lock:
        if mode == "voice_design":
            wavs, sr = model.generate_voice_design(
                text=trimmed,
                language=lang,
                instruct=(instruct or "").strip() or "Natural, clear narration.",
            )
        else:
            spk = speaker.strip() or "Ryan"
            inst = (instruct or "").strip()
            kwargs: dict[str, Any] = {
                "text": trimmed,
                "language": lang,
                "speaker": spk,
            }
            if inst:
                kwargs["instruct"] = inst
            wavs, sr = model.generate_custom_voice(**kwargs)

    waveform = wavs[0]
    if isinstance(waveform, np.ndarray):
        buf = io.BytesIO()
        sf.write(buf, waveform, sr, format="WAV")
        return buf.getvalue(), int(sr)
    raise RuntimeError("Unexpected waveform type from Qwen3-TTS")
