#!/usr/bin/env python3
"""
openvino_client.py

Standalone Python client for talking to AI Playground's local inference
backends (OpenVINO via OVMS, and llama.cpp) using the exact parameters and
launch conventions found in this codebase, wired up to point at a real,
already-installed copy of AI Playground:

  * Device enumeration            -> OpenVINO/detect_devices.py
  * OVMS launch arguments         -> WebUI/electron/subprocesses/openVINOBackendService.ts
                                     (startOvmsLlmServer)
  * llama.cpp launch arguments    -> WebUI/electron/subprocesses/llamaCppBackendService.ts
                                     (startLlamaLlmServer, LLAMACPP_DEFAULT_PARAMETERS)
  * Chat/generation parameters    -> modes/base/presets/*.json + service/config.py

Configuration
-------------
All installation-specific values (host/port, sampling defaults, device,
and the absolute paths to the installed llama-server / ovms binaries and
model folders) live in one config dict, matching this JSON shape:

    {
      "server":     {"host": "0.0.0.0", "port": 8000},
      "generation": {"max_tokens": 1024, "temperature": 0, "top_p": 1.0},
      "llama":      {"port": 8008, "gpu_layers": 0},
      "openvino":   {"device": "GPU"},
      "paths": {
        "llama_server":   "C:/.../resources/LlamaCPP/llama-cpp/llama-server.exe",
        "gguf_root":      "C:/.../resources/models/LLM/ggufLLM",
        "openvino_root":  "C:/.../resources/models/LLM/openvino",
        "openvino_python": "C:/.../resources/OpenVINO/.venv/Scripts/python.exe"
      }
    }

The values above (matching a real AI Playground install under
`AppData/Local/Programs/AI Playground/resources`) are baked in as the
built-in defaults, so the script works out of the box. Override any of them
with `--config path/to/config.json` (same shape, partial overrides are
merged) or with the individual `--*` CLI flags, which always win.

Usage
-----
List OpenVINO devices using the *installed* OpenVINO venv (not whatever
Python happens to run this script):

    python openvino_client.py devices

Start the OVMS LLM server and leave it running:

    python openvino_client.py ov-serve --model "OpenVINO/Phi-3.5-mini-instruct-int4-ov"

Chat against an already-running OVMS server:

    python openvino_client.py ov-chat --prompt "Hello, who are you?"

Start OVMS, send one prompt, tear it down:

    python openvino_client.py ov-run --model "OpenVINO/Phi-3.5-mini-instruct-int4-ov" \
        --prompt "Write a haiku about GPUs"

Same three verbs for llama.cpp (model is the repo-style id used by AI
Playground, e.g. "unsloth/Qwen3-4B-Instruct-2507-GGUF/Qwen3-4B-Instruct-2507-Q5_K_S.gguf"):

    python openvino_client.py llama-serve --model "unsloth/Qwen3-4B-Instruct-2507-GGUF/Qwen3-4B-Instruct-2507-Q5_K_S.gguf"
    python openvino_client.py llama-chat --prompt "Hello"
    python openvino_client.py llama-run --model "..." --prompt "Hello"

Requirements
------------
* The `requests` pip package, for every command except `devices`.
* `paths.openvino_python` must point at a Python environment that has the
  `openvino` package installed (AI Playground's bundled `.venv`) -- this
  script *shells out* to that interpreter for device detection rather than
  importing `openvino` in-process, since the process running this script
  usually won't have it installed.
* `paths.llama_server` / `paths.openvino_root` must point at a real,
  installed AI Playground `resources` folder (or your own OVMS/llama.cpp
  install laid out the same way).
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

try:
    import requests
except ImportError:
    requests = None  # only required for anything that talks HTTP to a running server

# Model output can contain arbitrary Unicode (emoji, CJK, etc.), but on Windows
# a terminal's default stdout/stderr encoding is often a legacy codepage (e.g.
# cp1252) rather than UTF-8, which raises UnicodeEncodeError on print(). The
# real AI Playground UI never hits this (browsers are UTF-8 natively); force
# it here so this script doesn't crash on ordinary model output.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Built-in defaults: a real AI Playground installation. Override via --config
# or individual --* flags.
# ---------------------------------------------------------------------------

DEFAULT_CONFIG: dict[str, Any] = {
    "server": {"host": "0.0.0.0", "port": 8000},
    "generation": {"max_tokens": 1024, "temperature": 0, "top_p": 1.0},
    "llama": {"port": 8008, "gpu_layers": 0},
    "openvino": {"device": "GPU"},
    "paths": {
        "llama_server": "C:/Users/MatthiasWeiss/AppData/Local/Programs/AI Playground/resources/LlamaCPP/llama-cpp/llama-server.exe",
        "gguf_root": "C:/Users/MatthiasWeiss/AppData/Local/Programs/AI Playground/resources/models/LLM/ggufLLM",
        "openvino_root": "C:/Users/MatthiasWeiss/AppData/Local/Programs/AI Playground/resources/models/LLM/openvino",
        "openvino_python": "C:/Users/MatthiasWeiss/AppData/Local/Programs/AI Playground/resources/OpenVINO/.venv/Scripts/python.exe",
    },
}

# From modes/base/presets/basic-chat.json / service/config.py
DEFAULT_CONTEXT_SIZE = 8192
DEFAULT_SYSTEM_PROMPT = "You are a helpful AI assistant."
DEFAULT_OPENVINO_MODEL = "OpenVINO/Phi-3.5-mini-instruct-int4-ov"

# OVMS launch defaults (openVINOBackendService.ts -> startOvmsLlmServer)
DEFAULT_REST_WORKERS = "4"
DEFAULT_TASK = "text_generation"
DEFAULT_TOOL_PARSER = "hermes3"  # resolveToolParser() fallback when a model has no override
DEFAULT_REASONING_PARSER = "qwen3"
DEFAULT_CACHE_DIR = "cache"
DEFAULT_KV_CACHE_PRECISION = ""  # '' = OVMS default; 'u4' enables INT4 KV cache compression

# llama.cpp launch defaults (llamaCppBackendService.ts -> LLAMACPP_DEFAULT_PARAMETERS)
# NOTE: the repo's own default is '--gpu-layers 999 --log-prefix --jinja --no-mmap -fa off'.
# gpu_layers is pulled out as its own config knob (llama.gpu_layers) since that's the
# one users most commonly want to override (e.g. 0 to force CPU-only).
LLAMACPP_EXTRA_FLAGS = ["--log-prefix", "--jinja", "--no-mmap", "-fa", "off"]


def deep_merge(base: dict, override: dict) -> dict:
    result = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load_config(config_path: Optional[Path]) -> dict:
    if config_path is None:
        return copy.deepcopy(DEFAULT_CONFIG)
    with open(config_path, "r", encoding="utf-8") as f:
        override = json.load(f)
    return deep_merge(DEFAULT_CONFIG, override)


def loopback_host(bind_host: str) -> str:
    """A server bound to 0.0.0.0/:: still needs to be *dialed* on a concrete
    loopback address from the local machine."""
    return "127.0.0.1" if bind_host in ("0.0.0.0", "::", "") else bind_host


def ovms_servable_name(model: str) -> str:
    """OVMS registers the model under --source_model with '/' replaced by
    '---' (see startOvmsLlmServer()); chat/completions requests must use
    this same sanitized name or OVMS 404s with "graph definition not
    found" for the slash-containing repo id."""
    return model.replace("/", "---")


# ---------------------------------------------------------------------------
# Device detection (mirrors OpenVINO/detect_devices.py, but run via the
# installed OVMS Python venv instead of assuming `openvino` is importable
# in-process -- matches detectDevicesWithPython() in openVINOBackendService.ts)
# ---------------------------------------------------------------------------

_DETECT_DEVICES_SCRIPT = """
import json
try:
    import openvino as ov
    core = ov.Core()
    devices = []
    for device_id in core.available_devices:
        try:
            full_name = core.get_property(device_id, "FULL_DEVICE_NAME")
        except Exception:
            full_name = device_id
        devices.append({"id": device_id, "name": full_name})
    print(json.dumps({"success": True, "devices": devices}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
"""


def detect_devices(python_exe: Optional[Path] = None) -> dict:
    """Enumerate OpenVINO devices. Prefers shelling out to `python_exe` (the
    installed OpenVINO venv's interpreter); falls back to importing openvino
    in the current process if that interpreter doesn't exist."""
    if python_exe and Path(python_exe).exists():
        try:
            result = subprocess.run(
                [str(python_exe), "-c", _DETECT_DEVICES_SCRIPT],
                capture_output=True,
                text=True,
                timeout=30,
            )
            return json.loads(result.stdout.strip())
        except Exception as e:
            return {"success": False, "error": f"failed to run {python_exe}: {e}"}

    try:
        import openvino as ov

        core = ov.Core()
        devices = []
        for device_id in core.available_devices:
            try:
                full_name = core.get_property(device_id, "FULL_DEVICE_NAME")
            except Exception:
                full_name = device_id
            devices.append({"id": device_id, "name": full_name})
        return {"success": True, "devices": devices}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ---------------------------------------------------------------------------
# OVMS server launch config (mirrors startOvmsLlmServer in openVINOBackendService.ts)
# ---------------------------------------------------------------------------

@dataclass
class OvmsServerConfig:
    model: str
    ovms_exe: Path
    model_repository_path: Path
    rest_bind_address: str
    rest_port: int
    target_device: str
    rest_workers: str = DEFAULT_REST_WORKERS
    task: str = DEFAULT_TASK
    tool_parser: str = DEFAULT_TOOL_PARSER
    reasoning_parser: str = DEFAULT_REASONING_PARSER
    cache_dir: str = DEFAULT_CACHE_DIR
    context_size: Optional[int] = None  # only affects --max_prompt_len, and only on NPU
    kv_cache_precision: str = DEFAULT_KV_CACHE_PRECISION

    @property
    def base_url(self) -> str:
        # AI Playground's OpenVINOBackendService.baseUrl: http://<host>:<port>/v3
        return f"http://{loopback_host(self.rest_bind_address)}:{self.rest_port}/v3"

    @property
    def health_url(self) -> str:
        return f"http://{loopback_host(self.rest_bind_address)}:{self.rest_port}/v2/health/ready"

    @property
    def servable_name(self) -> str:
        return ovms_servable_name(self.model)

    def build_args(self) -> list[str]:
        """Reproduce the exact --flag ordering used by startOvmsLlmServer()."""
        args = [
            "--rest_bind_address",
            self.rest_bind_address,
            "--rest_port",
            str(self.rest_port),
            "--rest_workers",
            self.rest_workers,
            "--source_model",
            self.servable_name,
            "--model_repository_path",
            str(self.model_repository_path),
            "--target_device",
            self.target_device,
            "--task",
            self.task,
            "--tool_parser",
            self.tool_parser,
            "--reasoning_parser",
            self.reasoning_parser,
            "--cache_dir",
            self.cache_dir,
        ]

        # Only NPU needs an explicit max prompt length; matches:
        #   if (selectedDevice.startsWith('NPU')) args.push('--max_prompt_len', ...)
        if self.target_device.startswith("NPU"):
            max_prompt_len = self.context_size or DEFAULT_CONTEXT_SIZE
            args += ["--max_prompt_len", str(max_prompt_len)]

        # Only passed when explicitly set, matching:
        #   if (this.kvCachePrecision) args.push('--kv_cache_precision', ...)
        if self.kv_cache_precision:
            args += ["--kv_cache_precision", self.kv_cache_precision]

        return args


def resolve_ovms_exe(cfg: dict) -> Path:
    """Derive the ovms(.exe) path from paths.openvino_python, mirroring
    OpenVINOBackendService's serviceDir/ovmsDir layout:
        resources/OpenVINO/.venv/Scripts/python.exe  ->  resources/OpenVINO/ovms/ovms.exe
    """
    if cfg["paths"].get("ovms_exe"):
        return Path(cfg["paths"]["ovms_exe"])
    openvino_python = Path(cfg["paths"]["openvino_python"])
    # .../OpenVINO/.venv/Scripts/python.exe -> parents: Scripts, .venv, OpenVINO
    openvino_service_dir = openvino_python.parent.parent.parent
    exe_name = "ovms.exe" if sys.platform == "win32" else "bin/ovms"
    return openvino_service_dir / "ovms" / exe_name


def build_ovms_env(ovms_dir: Path) -> dict:
    """Reproduce buildOvmsEnv() from openVINOBackendService.ts.

    ovms.exe needs this to find its Python runtime -- on Windows it ships a
    fully self-contained CPython under ovms/python (used for jinja2 chat
    template rendering), and without PYTHONHOME/PATH pointed at it, ovms.exe
    fails to start with STATUS_DLL_NOT_FOUND (0xC0000135 / exit code
    3221225781), reported by Windows as "python3XX.dll cannot be found".
    """
    env = dict(os.environ)
    env["OVMS_DIR"] = str(ovms_dir)

    if sys.platform == "win32":
        python_dir = ovms_dir / "python"
        scripts_dir = python_dir / "Scripts"
        env["PYTHONHOME"] = str(python_dir)
        env["PATH"] = os.pathsep.join(
            p for p in [str(ovms_dir), str(python_dir), str(scripts_dir), env.get("PATH", "")] if p
        )
    else:
        lib_dir = ovms_dir / "lib"
        env["LD_LIBRARY_PATH"] = ":".join(
            p for p in [str(lib_dir), env.get("LD_LIBRARY_PATH", "")] if p
        )

    return env


def _drain_subprocess_output(process: subprocess.Popen, prefix: str) -> None:
    """Continuously read the child's stdout so it never blocks on a full pipe.

    Node's child_process (used by the real Electron backend services this
    script mirrors) drains stdout/stderr automatically via 'data' events.
    subprocess.PIPE has no such behavior -- if nobody reads it, the OS pipe
    buffer fills once the child logs enough (OVMS's continuous-batching
    executor logs periodically), and the child blocks on write() forever,
    which looks like a hang/timeout in wait_ready() even though the server
    would otherwise have started fine.
    """
    assert process.stdout is not None
    for line in process.stdout:
        print(f"{prefix} {line}", end="")


class OvmsServer:
    """Thin process wrapper around the OVMS binary, mirroring
    start/stopOvmsLlmServer() in openVINOBackendService.ts (minus the extra
    Linux-only ldd/symlink self-healing, which only matters for AI
    Playground's bundled cross-distro install)."""

    def __init__(self, config: OvmsServerConfig):
        self.config = config
        self.process: Optional[subprocess.Popen] = None

    def start(self, wait_ready: bool = True, timeout_s: int = 120) -> None:
        args = self.config.build_args()
        ovms_dir = self.config.ovms_exe.parent
        print(f"[ovms] launching: {self.config.ovms_exe} {' '.join(args)}")
        self.process = subprocess.Popen(
            [str(self.config.ovms_exe), *args],
            cwd=str(ovms_dir),
            env=build_ovms_env(ovms_dir),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        threading.Thread(
            target=_drain_subprocess_output, args=(self.process, "[ovms]"), daemon=True
        ).start()
        if wait_ready:
            self.wait_ready(timeout_s=timeout_s)

    def wait_ready(self, timeout_s: int = 120) -> None:
        if requests is None:
            raise RuntimeError("The 'requests' package is required to poll server readiness.")
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if self.process is not None and self.process.poll() is not None:
                raise RuntimeError(
                    f"OVMS process exited early with code {self.process.returncode}"
                )
            try:
                resp = requests.get(self.config.health_url, timeout=2)
                if resp.status_code == 200:
                    print("[ovms] server ready")
                    return
            except requests.exceptions.RequestException:
                pass
            time.sleep(1)
        raise TimeoutError(f"OVMS server did not become ready within {timeout_s}s")

    def stop(self) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()


# ---------------------------------------------------------------------------
# llama.cpp server launch config (mirrors startLlamaLlmServer in
# llamaCppBackendService.ts + LLAMACPP_DEFAULT_PARAMETERS)
# ---------------------------------------------------------------------------

@dataclass
class LlamaServerConfig:
    model: str  # repo-style id, e.g. "unsloth/Qwen3-4B-Instruct-2507-GGUF/Qwen3-4B-Instruct-2507-Q5_K_S.gguf"
    llama_server_exe: Path
    gguf_root: Path
    port: int
    gpu_layers: int
    context_size: int = DEFAULT_CONTEXT_SIZE
    host: str = "127.0.0.1"  # llama-server is always forced to 127.0.0.1 in this codebase

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    @property
    def health_url(self) -> str:
        return f"{self.base_url}/health"

    def resolve_model_path(self) -> Path:
        """Mirrors resolveModelPath() in llamaCppBackendService.ts:
        gguf_root/<namespace>---<repo>/<remaining path segments>"""
        namespace, repo, *rest = self.model.split("/")
        return self.gguf_root / f"{namespace}---{repo}" / Path(*rest)

    def build_args(self) -> list[str]:
        model_path = self.resolve_model_path()
        args = [
            "--model",
            str(model_path),
            "--port",
            str(self.port),
            "--ctx-size",
            str(self.context_size),
            "--gpu-layers",
            str(self.gpu_layers),
            *LLAMACPP_EXTRA_FLAGS,
            # Forced last, matching the repo's "always wins" comment.
            "--host",
            self.host,
        ]

        model_folder = model_path.parent
        if model_folder.exists():
            mmproj = next(
                (f for f in model_folder.glob("mmproj*.gguf")),
                None,
            )
            if mmproj:
                args += ["--mmproj", str(mmproj)]

        return args


class LlamaServer:
    """Thin process wrapper around llama-server.exe, mirroring
    start/stopLlamaLlmServer() in llamaCppBackendService.ts."""

    def __init__(self, config: LlamaServerConfig):
        self.config = config
        self.process: Optional[subprocess.Popen] = None

    def start(self, wait_ready: bool = True, timeout_s: int = 120) -> None:
        args = self.config.build_args()
        print(f"[llama] launching: {self.config.llama_server_exe} {' '.join(args)}")
        self.process = subprocess.Popen(
            [str(self.config.llama_server_exe), *args],
            cwd=str(self.config.llama_server_exe.parent),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        threading.Thread(
            target=_drain_subprocess_output, args=(self.process, "[llama]"), daemon=True
        ).start()
        if wait_ready:
            self.wait_ready(timeout_s=timeout_s)

    def wait_ready(self, timeout_s: int = 120) -> None:
        if requests is None:
            raise RuntimeError("The 'requests' package is required to poll server readiness.")
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if self.process is not None and self.process.poll() is not None:
                raise RuntimeError(
                    f"llama-server process exited early with code {self.process.returncode}"
                )
            try:
                resp = requests.get(self.config.health_url, timeout=2)
                if resp.status_code == 200:
                    print("[llama] server ready")
                    return
            except requests.exceptions.RequestException:
                pass
            time.sleep(1)
        raise TimeoutError(f"llama-server did not become ready within {timeout_s}s")

    def stop(self) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()


# ---------------------------------------------------------------------------
# Chat completion request (OpenAI-compatible; both OVMS and llama-server
# implement this). Sampling defaults come from config["generation"].
# ---------------------------------------------------------------------------

@dataclass
class ChatRequestConfig:
    base_url: str
    model: str
    system_prompt: str = DEFAULT_SYSTEM_PROMPT
    temperature: float = 0
    max_tokens: int = 1024
    top_p: float = 1.0
    stream: bool = False
    endpoint: str = "/chat/completions"
    # Mirrors textInference.thinkingEnabled in openAiCompatibleChat.ts: for
    # Qwen3-family/gemma4 models, forwarded as chat_template_kwargs.enable_thinking
    # so both llama-server (--jinja) and OVMS (--reasoning_parser qwen3) honor it.
    # None means "don't send it" (model/template default applies).
    enable_thinking: Optional[bool] = None


def chat(prompt: str, config: ChatRequestConfig) -> str:
    if requests is None:
        raise RuntimeError("The 'requests' package is required for chat completions.")

    payload = {
        "model": config.model,
        "messages": [
            {"role": "system", "content": config.system_prompt},
            {"role": "user", "content": prompt},
        ],
        "temperature": config.temperature,
        "max_tokens": config.max_tokens,
        "top_p": config.top_p,
        "stream": config.stream,
    }
    if config.enable_thinking is not None:
        payload["chat_template_kwargs"] = {"enable_thinking": config.enable_thinking}

    url = f"{config.base_url}{config.endpoint}"
    resp = requests.post(url, json=payload, stream=config.stream, timeout=300)
    resp.raise_for_status()

    if not config.stream:
        data = resp.json()
        return data["choices"][0]["message"]["content"]

    chunks = []
    for line in resp.iter_lines():
        if not line:
            continue
        line = line.decode("utf-8")
        if line.startswith("data: "):
            line = line[len("data: "):]
        if line.strip() == "[DONE]":
            break
        try:
            delta = json.loads(line)["choices"][0]["delta"].get("content", "")
        except (KeyError, IndexError, json.JSONDecodeError):
            continue
        print(delta, end="", flush=True)
        chunks.append(delta)
    print()
    return "".join(chunks)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def add_generation_args(p: argparse.ArgumentParser, cfg: dict) -> None:
    gen = cfg["generation"]
    p.add_argument("--prompt", required=True)
    p.add_argument("--system-prompt", default=DEFAULT_SYSTEM_PROMPT)
    p.add_argument("--temperature", type=float, default=gen["temperature"])
    p.add_argument("--max-tokens", type=int, default=gen["max_tokens"])
    p.add_argument("--top-p", type=float, default=gen["top_p"])
    p.add_argument("--stream", action="store_true")
    p.add_argument(
        "--no-thinking",
        dest="enable_thinking",
        action="store_const",
        const=False,
        default=None,
        help="Disable reasoning/thinking mode (Qwen3-family, gemma4) via "
        "chat_template_kwargs.enable_thinking, matching the thinking toggle "
        "in the AI Playground UI. Without this flag the model/template default applies.",
    )


def add_ov_server_args(p: argparse.ArgumentParser, cfg: dict) -> None:
    p.add_argument("--model", default=DEFAULT_OPENVINO_MODEL)
    p.add_argument("--ovms-exe", type=Path, default=None)
    p.add_argument("--model-repository-path", type=Path, default=Path(cfg["paths"]["openvino_root"]))
    p.add_argument("--device", default=cfg["openvino"]["device"], help="AUTO | CPU | GPU | NPU (or GPU.0, etc.)")
    p.add_argument("--host", default=cfg["server"]["host"])
    p.add_argument("--port", type=int, default=cfg["server"]["port"])
    p.add_argument("--rest-workers", default=DEFAULT_REST_WORKERS)
    p.add_argument("--task", default=DEFAULT_TASK)
    p.add_argument("--tool-parser", default=DEFAULT_TOOL_PARSER)
    p.add_argument("--reasoning-parser", default=DEFAULT_REASONING_PARSER)
    p.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR)
    p.add_argument("--context-size", type=int, default=DEFAULT_CONTEXT_SIZE, help="Also used as --max_prompt_len when --device is NPU")
    p.add_argument("--kv-cache-precision", default=DEFAULT_KV_CACHE_PRECISION)


def add_llama_server_args(p: argparse.ArgumentParser, cfg: dict) -> None:
    p.add_argument("--model", required=True, help="Repo-style id, e.g. 'unsloth/Qwen3-4B-Instruct-2507-GGUF/Qwen3-4B-Instruct-2507-Q5_K_S.gguf'")
    p.add_argument("--llama-server-exe", type=Path, default=Path(cfg["paths"]["llama_server"]))
    p.add_argument("--gguf-root", type=Path, default=Path(cfg["paths"]["gguf_root"]))
    p.add_argument("--port", type=int, default=cfg["llama"]["port"])
    p.add_argument("--gpu-layers", type=int, default=cfg["llama"]["gpu_layers"])
    p.add_argument("--context-size", type=int, default=DEFAULT_CONTEXT_SIZE)


def ov_config_from_args(args: argparse.Namespace) -> OvmsServerConfig:
    cfg = args._cfg
    return OvmsServerConfig(
        model=args.model,
        ovms_exe=args.ovms_exe or resolve_ovms_exe(cfg),
        model_repository_path=args.model_repository_path,
        rest_bind_address=args.host,
        rest_port=args.port,
        target_device=args.device,
        rest_workers=args.rest_workers,
        task=args.task,
        tool_parser=args.tool_parser,
        reasoning_parser=args.reasoning_parser,
        cache_dir=args.cache_dir,
        context_size=args.context_size,
        kv_cache_precision=args.kv_cache_precision,
    )


def llama_config_from_args(args: argparse.Namespace) -> LlamaServerConfig:
    return LlamaServerConfig(
        model=args.model,
        llama_server_exe=args.llama_server_exe,
        gguf_root=args.gguf_root,
        port=args.port,
        gpu_layers=args.gpu_layers,
        context_size=args.context_size,
    )


def build_parser(cfg: dict) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", type=Path, default=None, help="Path to a JSON file overriding the built-in defaults")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("devices", help="List OpenVINO devices via the installed OpenVINO venv")

    ov_serve = sub.add_parser("ov-serve", help="Start the OVMS LLM server and leave it running")
    add_ov_server_args(ov_serve, cfg)

    ov_chat = sub.add_parser("ov-chat", help="Send a chat completion to an already-running OVMS server")
    ov_chat.add_argument("--host", default=cfg["server"]["host"])
    ov_chat.add_argument("--port", type=int, default=cfg["server"]["port"])
    ov_chat.add_argument("--model", default=DEFAULT_OPENVINO_MODEL)
    add_generation_args(ov_chat, cfg)

    ov_run = sub.add_parser("ov-run", help="Start OVMS, send one prompt, then stop it")
    add_ov_server_args(ov_run, cfg)
    add_generation_args(ov_run, cfg)

    llama_serve = sub.add_parser("llama-serve", help="Start the llama.cpp LLM server and leave it running")
    add_llama_server_args(llama_serve, cfg)

    llama_chat = sub.add_parser("llama-chat", help="Send a chat completion to an already-running llama-server")
    llama_chat.add_argument("--port", type=int, default=cfg["llama"]["port"])
    llama_chat.add_argument("--model", default="local-model")
    add_generation_args(llama_chat, cfg)

    llama_run = sub.add_parser("llama-run", help="Start llama-server, send one prompt, then stop it")
    add_llama_server_args(llama_run, cfg)
    add_generation_args(llama_run, cfg)

    return parser


def main() -> None:
    # Parse just --config first so its defaults can feed the rest of the parser.
    pre = argparse.ArgumentParser(add_help=False)
    pre.add_argument("--config", type=Path, default=None)
    pre_args, _ = pre.parse_known_args()
    cfg = load_config(pre_args.config)

    parser = build_parser(cfg)
    args = parser.parse_args()
    args._cfg = cfg

    if args.command == "devices":
        print(json.dumps(detect_devices(Path(cfg["paths"]["openvino_python"])), indent=2))
        return

    if args.command == "ov-serve":
        ov_cfg = ov_config_from_args(args)
        server = OvmsServer(ov_cfg)
        server.start()
        print(f"[ovms] base_url = {ov_cfg.base_url}")
        print("[ovms] press Ctrl+C to stop")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            server.stop()
        return

    if args.command == "ov-chat":
        chat_cfg = ChatRequestConfig(
            base_url=f"http://{loopback_host(args.host)}:{args.port}/v3",
            model=ovms_servable_name(args.model),
            system_prompt=args.system_prompt,
            temperature=args.temperature,
            max_tokens=args.max_tokens,
            top_p=args.top_p,
            stream=args.stream,
            enable_thinking=args.enable_thinking,
        )
        result = chat(args.prompt, chat_cfg)
        if not args.stream:
            print(result)
        return

    if args.command == "ov-run":
        ov_cfg = ov_config_from_args(args)
        server = OvmsServer(ov_cfg)
        server.start()
        try:
            chat_cfg = ChatRequestConfig(
                base_url=ov_cfg.base_url,
                model=ov_cfg.servable_name,
                system_prompt=args.system_prompt,
                temperature=args.temperature,
                max_tokens=args.max_tokens,
                top_p=args.top_p,
                stream=args.stream,
                enable_thinking=args.enable_thinking,
            )
            result = chat(args.prompt, chat_cfg)
            if not args.stream:
                print(result)
        finally:
            server.stop()
        return

    if args.command == "llama-serve":
        llama_cfg = llama_config_from_args(args)
        server = LlamaServer(llama_cfg)
        server.start()
        print(f"[llama] base_url = {llama_cfg.base_url}")
        print("[llama] press Ctrl+C to stop")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            server.stop()
        return

    if args.command == "llama-chat":
        chat_cfg = ChatRequestConfig(
            base_url=f"http://127.0.0.1:{args.port}",
            model=args.model,
            system_prompt=args.system_prompt,
            temperature=args.temperature,
            max_tokens=args.max_tokens,
            top_p=args.top_p,
            stream=args.stream,
            enable_thinking=args.enable_thinking,
            endpoint="/v1/chat/completions",
        )
        result = chat(args.prompt, chat_cfg)
        if not args.stream:
            print(result)
        return

    if args.command == "llama-run":
        llama_cfg = llama_config_from_args(args)
        server = LlamaServer(llama_cfg)
        server.start()
        try:
            chat_cfg = ChatRequestConfig(
                base_url=llama_cfg.base_url,
                model=llama_cfg.model,
                system_prompt=args.system_prompt,
                temperature=args.temperature,
                max_tokens=args.max_tokens,
                top_p=args.top_p,
                stream=args.stream,
                enable_thinking=args.enable_thinking,
                endpoint="/v1/chat/completions",
            )
            result = chat(args.prompt, chat_cfg)
            if not args.stream:
                print(result)
        finally:
            server.stop()
        return


if __name__ == "__main__":
    main()
