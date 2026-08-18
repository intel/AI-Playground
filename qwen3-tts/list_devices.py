"""Enumerate torch accelerators for the AI Playground TTS device selector.

Prints a JSON array of {"id", "name"} to stdout. Each `id` is a valid
QWEN3_TTS_DEVICE string so the Electron side can pass the user's choice
straight through to tts_engine (see `_resolve_device_map`). Always includes
CPU; adds every Intel GPU (XPU) and NVIDIA GPU (CUDA) that torch can see.

NOTE: the Qwen3-TTS model runs on PyTorch, whose device types are cpu / xpu /
cuda only. The Intel NPU is *not* a torch device (it is reachable only via
OpenVINO, which this engine doesn't use), so NPUs are intentionally not listed.

Diagnostics go to stderr so the JSON on stdout stays clean; the Electron logs
capture stderr, which makes "why is my GPU missing" answerable from the logs.
"""

from __future__ import annotations

import json
import sys


def _log(msg: str) -> None:
    print(f"[list_devices] {msg}", file=sys.stderr)


def _xpu_device_count(torch) -> int:
    """XPU device count, tolerant of drivers where is_available() lies.

    On some Windows/Linux driver stacks `torch.xpu.is_available()` returns False
    while `device_count()` still reports the GPUs — gating enumeration on
    is_available() is the usual reason integrated GPUs "disappear" from the list.
    """
    if not hasattr(torch, "xpu"):
        _log("torch has no xpu module")
        return 0
    try:
        count = torch.xpu.device_count()
    except Exception as exc:  # driver/runtime probe failure
        _log(f"torch.xpu.device_count() failed: {exc}")
        return 0
    try:
        available = torch.xpu.is_available()
    except Exception:
        available = None
    _log(f"xpu: is_available={available} device_count={count}")
    return count


def _xpu_name(torch, index: int) -> str:
    for getter in (
        lambda: torch.xpu.get_device_properties(index).name,
        lambda: torch.xpu.get_device_name(index),
    ):
        try:
            name = getter()
            if name:
                return str(name)
        except Exception as exc:  # driver without this accessor; try the next one
            _log(f"xpu name probe for device {index} failed: {exc}")
    return f"Intel GPU {index}"


def _cuda_name(torch, index: int) -> str:
    try:
        return str(torch.cuda.get_device_name(index))
    except Exception:
        return f"CUDA GPU {index}"


def enumerate_devices() -> list[dict[str, str]]:
    devices: list[dict[str, str]] = []
    try:
        import torch
    except Exception as exc:
        # No torch (env not set up) — the caller still offers "auto".
        _log(f"torch import failed: {exc}")
        return devices

    # Intel GPUs (XPU) — integrated and discrete both enumerate here.
    for i in range(_xpu_device_count(torch)):
        name = _xpu_name(torch, i)
        _log(f"xpu:{i} -> {name}")
        devices.append({"id": f"xpu:{i}", "name": name})

    # NVIDIA GPUs (CUDA).
    try:
        cuda_count = torch.cuda.device_count() if torch.cuda.is_available() else 0
    except Exception as exc:
        _log(f"cuda probe failed: {exc}")
        cuda_count = 0
    for i in range(cuda_count):
        name = _cuda_name(torch, i)
        _log(f"cuda:{i} -> {name}")
        devices.append({"id": f"cuda:{i}", "name": name})

    devices.append({"id": "cpu", "name": "CPU"})
    return devices


def main() -> None:
    json.dump(enumerate_devices(), sys.stdout)


if __name__ == "__main__":
    main()
