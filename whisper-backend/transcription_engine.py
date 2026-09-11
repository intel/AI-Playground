"""Whisper transcription engine for the AI Playground standalone STT sidecar.

Runs OpenAI Whisper via the transformers `automatic-speech-recognition` pipeline
on the user-selected torch device (xpu / cuda / cpu). Unlike the OVMS engine this
needs no OpenVINO, so it works in every product mode (incl. NVIDIA).

Models are addressed by HuggingFace repo id (e.g. `openai/whisper-base`) but are
always loaded from the shared model dir (WHISPER_MODEL_DIR), where the app's
download popup writes them. The sidecar never fetches weights itself — it runs
with HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE set (see whisperBackendService.ts) — so a
repo id with no local directory is rejected outright instead of being handed to
transformers, which would fail later with an opaque offline-cache error.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any

logger = logging.getLogger("whisper-backend")

_load_lock = threading.Lock()
_infer_lock = threading.Lock()
# repo id -> transformers pipeline
_pipelines: dict[str, Any] = {}
_resolved_device: str | None = None

DEFAULT_MODEL_ID = os.environ.get("WHISPER_MODEL", "openai/whisper-base")


def _shared_model_dir() -> str | None:
    d = os.environ.get("WHISPER_MODEL_DIR", "").strip()
    return d or None


def local_dir_for(repo_id: str) -> str | None:
    """Local weights directory for a repo id, if present in the shared STT dir."""
    base = _shared_model_dir()
    if not base:
        return None
    candidate = os.path.join(base, repo_id.replace("/", "---"))
    return candidate if os.path.isdir(candidate) else None


def is_model_downloaded(repo_id: str) -> bool:
    return local_dir_for(repo_id) is not None


def _resolve_device() -> str:
    """Resolve the torch device string (xpu:N / cuda:N / cpu)."""
    device = os.environ.get("WHISPER_DEVICE", "auto").strip().lower()
    if device not in ("", "auto"):
        return device
    try:
        import torch

        if hasattr(torch, "xpu"):
            try:
                if torch.xpu.device_count() > 0:
                    return "xpu:0"
            except Exception:
                logger.debug("xpu probe failed", exc_info=True)
        if torch.cuda.is_available():
            return "cuda:0"
    except (ImportError, AttributeError, RuntimeError, OSError):
        logger.debug("Accelerator probe failed; falling back to CPU", exc_info=True)
    return "cpu"


def _torch_dtype(device: str):
    import torch

    # fp16 on accelerators, fp32 on CPU (half is slow/unsupported on many CPUs).
    if device.startswith("cuda") or device.startswith("xpu"):
        return torch.float16
    return torch.float32


def _pipeline_device_arg(device: str):
    """Map a device string to the transformers pipeline `device` argument."""
    import torch

    if device == "cpu":
        return torch.device("cpu")
    return torch.device(device)


def _load_pipeline(repo_id: str):
    with _load_lock:
        cached = _pipelines.get(repo_id)
        if cached is not None:
            return cached

        from transformers import pipeline

        global _resolved_device
        device = _resolve_device()
        _resolved_device = device
        local_dir = local_dir_for(repo_id)
        if local_dir is None:
            base = _shared_model_dir()
            raise ValueError(
                f"Whisper model '{repo_id}' is not downloaded"
                + (
                    f" (looked in {base})"
                    if base
                    else " (WHISPER_MODEL_DIR is not set)"
                )
                + ". Download it from the Speech To Text settings and try again."
            )
        logger.info(
            "loading whisper model %s on %s (source=%s)", repo_id, device, local_dir
        )

        asr = pipeline(
            task="automatic-speech-recognition",
            model=local_dir,
            dtype=_torch_dtype(device),
            device=_pipeline_device_arg(device),
        )
        _pipelines[repo_id] = asr
        return asr


def ensure_loaded(repo_id: str) -> None:
    _load_pipeline(repo_id)


def model_status() -> dict[str, Any]:
    return {
        "device": _resolved_device,
        "loadedModels": sorted(_pipelines.keys()),
    }


def transcribe(audio_bytes: bytes, repo_id: str, language: str | None = None) -> str:
    """Transcribe WAV/audio bytes with `repo_id`; returns the plain text."""
    if not audio_bytes:
        raise ValueError("audio is required")

    import io

    import numpy as np
    import soundfile as sf

    data, sample_rate = sf.read(io.BytesIO(audio_bytes), dtype="float32")
    # Downmix to mono.
    if getattr(data, "ndim", 1) > 1:
        data = np.mean(data, axis=1)
    # Whisper expects 16 kHz; resample if needed.
    if sample_rate != 16000:
        import librosa

        data = librosa.resample(data, orig_sr=sample_rate, target_sr=16000)
        sample_rate = 16000

    asr = _load_pipeline(repo_id)
    # Only pass `generate_kwargs` when we actually have generation options: the
    # pipeline captures extra kwargs via **generate_kwargs, so a literal
    # `generate_kwargs=None`/`{}` becomes `{"generate_kwargs": None}` and crashes in
    # _sanitize_parameters (`forward_params.update(None)`). Omitting it lets Whisper
    # auto-detect the language.
    call_kwargs: dict[str, Any] = {"return_timestamps": False}
    if language and language.lower() not in ("", "auto"):
        call_kwargs["generate_kwargs"] = {"language": language, "task": "transcribe"}

    with _infer_lock:
        result = asr({"raw": data, "sampling_rate": sample_rate}, **call_kwargs)
    text = result.get("text", "") if isinstance(result, dict) else str(result)
    return (text or "").strip()
