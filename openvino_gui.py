#!/usr/bin/env python3
"""
openvino_gui.py

A small Qt (PySide6) desktop GUI around openvino_client.py: pick a backend
(OVMS or llama.cpp) and one of the models already installed locally, start
the server, send prompts, and watch server + chat output live in a console
pane.

Also embeds a small unified OpenAI-compatible API server (FastAPI/uvicorn),
mirroring ai-platform/launcher/api_server.py's endpoint set, so other tools
can point at one stable local URL instead of the raw OVMS/llama-server port:
    GET  /health            -> {"status": "ok"}
    GET  /status             -> {"loaded_model", "loaded_type", "openvino_loaded"}
    GET  /current_model      -> {"loaded_model", "loaded_type"}
    GET  /v1/modelnames      -> {"data": [{"id", "object"}, ...]}  (all installed models)
    GET  /v1/models          -> {"data": [{"id", "object", "context_length"}]}
    POST /v1/chat/completions -> proxied to whichever backend/model is
                                 currently loaded in the GUI (the "model" in
                                 the request body is informational only --
                                 the GUI's active model always wins, same as
                                 api_server.py's "Hermes requested / Actual
                                 model" resolution)

Requires PySide6, fastapi and uvicorn (pip install PySide6 fastapi uvicorn).
Reuses every launch/chat helper from openvino_client.py rather than
reimplementing them, so the CLI and GUI stay in lockstep.

Usage:
    python openvino_gui.py [--config path/to/config.json]
"""

from __future__ import annotations

import argparse
import sys
import threading
import time
from pathlib import Path
from typing import Any, Optional

try:
    from PySide6.QtCore import QObject, QThread, Signal
    from PySide6.QtGui import QFont, QTextCursor
    from PySide6.QtWidgets import (
        QApplication,
        QCheckBox,
        QComboBox,
        QDoubleSpinBox,
        QGroupBox,
        QHBoxLayout,
        QLabel,
        QLineEdit,
        QMainWindow,
        QMessageBox,
        QPlainTextEdit,
        QPushButton,
        QRadioButton,
        QSpinBox,
        QVBoxLayout,
        QWidget,
    )
except ImportError:
    print("PySide6 is required for the GUI: pip install PySide6", file=sys.stderr)
    sys.exit(1)

try:
    import requests
    import uvicorn
    from fastapi import FastAPI
    from pydantic import BaseModel
except ImportError:
    print("fastapi, uvicorn and requests are required for the GUI: pip install fastapi uvicorn requests", file=sys.stderr)
    sys.exit(1)

import openvino_client as ovc


class QtLogStream(QObject):
    """Writable stream that turns print()/stdout writes into a Qt signal, so
    output from ovc's server-log-drain thread and chat() reaches the GUI
    console regardless of which thread produced it."""

    text_written = Signal(str)

    def write(self, text: str) -> None:
        if text:
            self.text_written.emit(text)

    def flush(self) -> None:
        pass

    def isatty(self) -> bool:
        # Some libraries (uvicorn's default log formatter among them) probe
        # this before deciding whether to colorize output.
        return False


class ChatCompletionsRequest(BaseModel):
    model: str
    messages: list
    max_tokens: int = 1024
    temperature: float = 0
    top_p: float = 1.0
    stream: bool = False


class ApiServer:
    """Unified OpenAI-compatible endpoint set (mirrors ai-platform's
    launcher/api_server.py) backed by whatever the GUI currently has
    running. Runs uvicorn on a background thread so it never blocks the Qt
    event loop; reads GUI state directly since these are plain attribute
    reads/writes and CPython's GIL makes that safe enough for this scope."""

    def __init__(self, gui: "MainWindow", host: str, port: int):
        self.gui = gui
        self.host = host
        self.port = port
        self._server: Optional[uvicorn.Server] = None
        self._thread: Optional[threading.Thread] = None
        self.app = FastAPI()
        self._register_routes()

    def _register_routes(self) -> None:
        app = self.app
        gui = self.gui

        @app.get("/health")
        def health() -> dict:
            return {"status": "ok"}

        @app.get("/status")
        def status() -> dict:
            return {
                "loaded_model": gui.loaded_model,
                "loaded_type": gui.loaded_type,
                "openvino_loaded": gui.loaded_type == "openvino" and gui.server_ready,
            }

        @app.get("/current_model")
        def current_model() -> dict:
            return {"loaded_model": gui.loaded_model, "loaded_type": gui.loaded_type}

        @app.get("/v1/modelnames")
        def modelnames() -> dict:
            return {"data": [{"id": name, "object": "model"} for name in gui.all_available_models()]}

        @app.get("/v1/models")
        def models() -> dict:
            return {
                "data": [
                    {
                        "id": "AI-Playground-GUI",
                        "object": "model",
                        "context_length": ovc.DEFAULT_CONTEXT_SIZE,
                    }
                ]
            }

        @app.post("/v1/chat/completions")
        def completions(req: ChatCompletionsRequest) -> Any:
            if not gui.server_ready or not gui.loaded_model:
                return {"error": {"message": "No model loaded"}}

            print()
            print("=" * 60)
            print(f"API server requested: {req.model}")
            print(f"Actual model        : {gui.loaded_model}")
            print("=" * 60)
            print()

            payload = req.model_dump()
            payload["model"] = gui.active_model_id

            print(f"[{time.strftime('%H:%M:%S')}] Request received")
            print(f"[{time.strftime('%H:%M:%S')}] Forwarding to {gui.active_endpoint_url}")

            start = time.time()
            try:
                resp = requests.post(gui.active_endpoint_url, json=payload, timeout=600)
                resp.raise_for_status()
                result = resp.json()
            except requests.exceptions.RequestException as e:
                return {"error": {"message": str(e)}}

            print(f"[{time.strftime('%H:%M:%S')}] Done in {time.time() - start:.2f}s")
            return result

    def start(self) -> None:
        if self._thread is not None:
            return
        # log_config=None: skip uvicorn's own logging.config.dictConfig setup,
        # which reaches into sys.stderr for a formatter and breaks against
        # our QtLogStream redirection ("Unable to configure formatter
        # 'default'"). We already print our own request-level lines.
        config = uvicorn.Config(
            self.app, host=self.host, port=self.port, log_level="warning", log_config=None
        )
        self._server = uvicorn.Server(config)
        self._thread = threading.Thread(target=self._server.run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._server is not None:
            self._server.should_exit = True
        if self._thread is not None:
            self._thread.join(timeout=5)
        self._server = None
        self._thread = None

    @property
    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()


class ServerStartWorker(QThread):
    finished_ok = Signal()
    finished_err = Signal(str)

    def __init__(self, server, timeout_s: int):
        super().__init__()
        self.server = server
        self.timeout_s = timeout_s

    def run(self) -> None:
        try:
            self.server.start(timeout_s=self.timeout_s)
            self.finished_ok.emit()
        except Exception as e:  # noqa: BLE001 - surface any failure to the GUI
            self.finished_err.emit(str(e))


class ChatWorker(QThread):
    finished_ok = Signal(str)
    finished_err = Signal(str)

    def __init__(self, prompt: str, chat_cfg: ovc.ChatRequestConfig, cancel_event: threading.Event):
        super().__init__()
        self.prompt = prompt
        self.chat_cfg = chat_cfg
        self.cancel_event = cancel_event

    def run(self) -> None:
        try:
            result = ovc.chat(self.prompt, self.chat_cfg, cancel_event=self.cancel_event)
            self.finished_ok.emit(result)
        except Exception as e:  # noqa: BLE001
            if self.cancel_event.is_set():
                self.finished_ok.emit("")  # connection error from closing mid-stream is expected
            else:
                self.finished_err.emit(str(e))


class MainWindow(QMainWindow):
    def __init__(self, cfg: dict):
        super().__init__()
        self.cfg = cfg
        self.server: Optional[object] = None  # ovc.OvmsServer | ovc.LlamaServer
        self.server_worker: Optional[ServerStartWorker] = None
        self.chat_worker: Optional[ChatWorker] = None
        self.chat_cancel_event: Optional[threading.Event] = None
        self._active_base_url = ""
        self._active_model = ""
        self._active_endpoint = "/chat/completions"
        self._active_backend_type: Optional[str] = None  # "openvino" | "gguf"
        self._server_ready = False
        self.api_server: Optional[ApiServer] = None

        self.setWindowTitle("AI Playground - Local LLM Console")
        self.resize(900, 650)

        self._build_ui()
        self._redirect_stdio()
        self._on_backend_changed()

    # ---- state read by ApiServer's routes ------------------------------
    @property
    def loaded_model(self) -> Optional[str]:
        return self._active_model if self._server_ready else None

    @property
    def loaded_type(self) -> Optional[str]:
        return self._active_backend_type if self._server_ready else None

    @property
    def server_ready(self) -> bool:
        return self._server_ready

    @property
    def active_model_id(self) -> str:
        return self._active_model

    @property
    def active_endpoint_url(self) -> str:
        return f"{self._active_base_url}{self._active_endpoint}"

    def all_available_models(self) -> list[str]:
        ovms_models = ovc.list_ovms_models(Path(self.cfg["paths"]["openvino_root"]))
        llama_models = ovc.list_llama_models(Path(self.cfg["paths"]["gguf_root"]))
        return ovms_models + llama_models

    # ---- UI construction ----------------------------------------------
    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)

        select_box = QGroupBox("Server")
        select_layout = QVBoxLayout(select_box)

        backend_row = QHBoxLayout()
        self.ovms_radio = QRadioButton("OpenVINO (OVMS)")
        self.llama_radio = QRadioButton("llama.cpp")
        self.ovms_radio.setChecked(True)
        self.ovms_radio.toggled.connect(self._on_backend_changed)
        backend_row.addWidget(self.ovms_radio)
        backend_row.addWidget(self.llama_radio)
        backend_row.addStretch(1)
        select_layout.addLayout(backend_row)

        model_row = QHBoxLayout()
        model_row.addWidget(QLabel("Model:"))
        self.model_combo = QComboBox()
        self.model_combo.setMinimumWidth(350)
        model_row.addWidget(self.model_combo, 1)
        self.refresh_button = QPushButton("Refresh")
        self.refresh_button.clicked.connect(self._populate_models)
        model_row.addWidget(self.refresh_button)
        model_row.addWidget(QLabel("Device:"))
        self.device_combo = QComboBox()
        self.device_combo.addItems(["AUTO", "CPU", "GPU", "NPU"])
        default_device = self.cfg.get("openvino", {}).get("device", "GPU")
        idx = self.device_combo.findText(default_device)
        if idx >= 0:
            self.device_combo.setCurrentIndex(idx)
        model_row.addWidget(self.device_combo)
        select_layout.addLayout(model_row)

        server_btn_row = QHBoxLayout()
        self.start_button = QPushButton("Start Server")
        self.start_button.clicked.connect(self._start_server)
        self.stop_button = QPushButton("Stop Server")
        self.stop_button.clicked.connect(self._stop_server)
        self.stop_button.setEnabled(False)
        self.status_label = QLabel("Stopped")
        server_btn_row.addWidget(self.start_button)
        server_btn_row.addWidget(self.stop_button)
        server_btn_row.addWidget(QLabel("Status:"))
        server_btn_row.addWidget(self.status_label)
        server_btn_row.addStretch(1)
        select_layout.addLayout(server_btn_row)

        root.addWidget(select_box)

        api_box = QGroupBox("Unified API Server (OpenAI-compatible passthrough)")
        api_layout = QHBoxLayout(api_box)
        api_layout.addWidget(QLabel("Host:"))
        self.api_host_edit = QLineEdit("127.0.0.1")
        self.api_host_edit.setMaximumWidth(120)
        api_layout.addWidget(self.api_host_edit)
        api_layout.addWidget(QLabel("Port:"))
        self.api_port_spin = QSpinBox()
        self.api_port_spin.setRange(1, 65535)
        self.api_port_spin.setValue(8100)
        api_layout.addWidget(self.api_port_spin)
        self.api_start_button = QPushButton("Start API Server")
        self.api_start_button.clicked.connect(self._start_api_server)
        self.api_stop_button = QPushButton("Stop API Server")
        self.api_stop_button.clicked.connect(self._stop_api_server)
        self.api_stop_button.setEnabled(False)
        api_layout.addWidget(self.api_start_button)
        api_layout.addWidget(self.api_stop_button)
        self.api_status_label = QLabel("Stopped")
        api_layout.addWidget(QLabel("Status:"))
        api_layout.addWidget(self.api_status_label)
        api_layout.addStretch(1)
        root.addWidget(api_box)

        gen_box = QGroupBox("Generation")
        gen_layout = QHBoxLayout(gen_box)
        gen = self.cfg.get("generation", {})
        gen_layout.addWidget(QLabel("Max tokens:"))
        self.max_tokens_spin = QSpinBox()
        self.max_tokens_spin.setRange(1, 32768)
        self.max_tokens_spin.setValue(int(gen.get("max_tokens", 1024)))
        gen_layout.addWidget(self.max_tokens_spin)
        gen_layout.addWidget(QLabel("Temperature:"))
        self.temperature_spin = QDoubleSpinBox()
        self.temperature_spin.setRange(0.0, 2.0)
        self.temperature_spin.setSingleStep(0.1)
        self.temperature_spin.setValue(float(gen.get("temperature", 0)))
        gen_layout.addWidget(self.temperature_spin)
        self.no_thinking_check = QCheckBox("Disable thinking (Qwen3 / gemma4)")
        gen_layout.addWidget(self.no_thinking_check)
        self.stream_check = QCheckBox("Stream response")
        self.stream_check.setChecked(True)
        gen_layout.addWidget(self.stream_check)
        gen_layout.addStretch(1)
        root.addWidget(gen_box)

        self.console = QPlainTextEdit()
        self.console.setReadOnly(True)
        self.console.setFont(QFont("Consolas", 9))
        self.console.setMaximumBlockCount(20000)
        root.addWidget(self.console, 1)

        prompt_row = QHBoxLayout()
        self.prompt_edit = QLineEdit()
        self.prompt_edit.setPlaceholderText("Type a prompt and press Enter...")
        self.prompt_edit.returnPressed.connect(self._send_prompt)
        self.send_button = QPushButton("Send")
        self.send_button.clicked.connect(self._send_prompt)
        self.send_button.setEnabled(False)
        self.stop_chat_button = QPushButton("Stop")
        self.stop_chat_button.clicked.connect(self._stop_chat)
        self.stop_chat_button.setEnabled(False)
        prompt_row.addWidget(self.prompt_edit, 1)
        prompt_row.addWidget(self.send_button)
        prompt_row.addWidget(self.stop_chat_button)
        root.addLayout(prompt_row)

        self._populate_models()

    def _redirect_stdio(self) -> None:
        # Every ovc print() (server launch line, drained OVMS/llama-server
        # log lines, streamed chat deltas) lands here instead of the real
        # console, no matter which worker thread produced it.
        self.log_stream = QtLogStream()
        self.log_stream.text_written.connect(self._append_console)
        sys.stdout = self.log_stream
        sys.stderr = self.log_stream

    # ---- helpers ---------------------------------------------------------
    def _append_console(self, text: str) -> None:
        cursor = self.console.textCursor()
        cursor.movePosition(QTextCursor.MoveOperation.End)
        cursor.insertText(text)
        self.console.setTextCursor(cursor)
        self.console.ensureCursorVisible()

    def _on_backend_changed(self) -> None:
        is_ovms = self.ovms_radio.isChecked()
        self.device_combo.setEnabled(is_ovms)
        self._populate_models()

    def _populate_models(self) -> None:
        self.model_combo.clear()
        root: Optional[Path] = None
        models: list[str] = []
        try:
            if self.ovms_radio.isChecked():
                root = Path(self.cfg["paths"]["openvino_root"])
                models = ovc.list_ovms_models(root)
            else:
                root = Path(self.cfg["paths"]["gguf_root"])
                models = ovc.list_llama_models(root)
        except Exception as e:  # noqa: BLE001
            self._append_console(f"[gui] failed to list models: {e}\n")
        if not models:
            where = f" under {root}" if root else ""
            self._append_console(f"[gui] no models found{where}\n")
        self.model_combo.addItems(models)

    # ---- server lifecycle --------------------------------------------
    def _start_server(self) -> None:
        if not self.model_combo.currentText():
            QMessageBox.warning(self, "No model", "No model selected.")
            return

        self.start_button.setEnabled(False)
        self.status_label.setText("Starting...")
        model = self.model_combo.currentText()

        try:
            if self.ovms_radio.isChecked():
                ov_cfg = ovc.OvmsServerConfig(
                    model=model,
                    ovms_exe=ovc.resolve_ovms_exe(self.cfg),
                    model_repository_path=Path(self.cfg["paths"]["openvino_root"]),
                    rest_bind_address=self.cfg["server"]["host"],
                    rest_port=self.cfg["server"]["port"],
                    target_device=self.device_combo.currentText(),
                )
                self.server = ovc.OvmsServer(ov_cfg)
                self._active_base_url = ov_cfg.base_url
                self._active_model = ov_cfg.servable_name
                self._active_endpoint = "/chat/completions"
                self._active_backend_type = "openvino"
            else:
                llama_cfg = ovc.LlamaServerConfig(
                    model=model,
                    llama_server_exe=Path(self.cfg["paths"]["llama_server"]),
                    gguf_root=Path(self.cfg["paths"]["gguf_root"]),
                    port=self.cfg["llama"]["port"],
                    gpu_layers=self.cfg["llama"]["gpu_layers"],
                )
                self.server = ovc.LlamaServer(llama_cfg)
                self._active_base_url = llama_cfg.base_url
                self._active_model = llama_cfg.model
                self._active_endpoint = "/v1/chat/completions"
                self._active_backend_type = "gguf"
        except Exception as e:  # noqa: BLE001
            self._append_console(f"[gui] failed to configure server: {e}\n")
            self.start_button.setEnabled(True)
            self.status_label.setText("Error")
            return

        self.server_worker = ServerStartWorker(self.server, timeout_s=180)
        self.server_worker.finished_ok.connect(self._on_server_ready)
        self.server_worker.finished_err.connect(self._on_server_error)
        self.server_worker.start()

    def _on_server_ready(self) -> None:
        self._server_ready = True
        self.status_label.setText("Ready")
        self.stop_button.setEnabled(True)
        self.send_button.setEnabled(True)

    def _on_server_error(self, message: str) -> None:
        self._append_console(f"[gui] server failed to start: {message}\n")
        self.status_label.setText("Error")
        self.start_button.setEnabled(True)
        self.server = None
        self._server_ready = False
        self._active_backend_type = None

    def _stop_server(self) -> None:
        if self.server:
            try:
                self.server.stop()
            except Exception as e:  # noqa: BLE001
                self._append_console(f"[gui] error stopping server: {e}\n")
        self.server = None
        self._server_ready = False
        self._active_backend_type = None
        self.status_label.setText("Stopped")
        self.start_button.setEnabled(True)
        self.stop_button.setEnabled(False)
        self.send_button.setEnabled(False)

    # ---- unified API server lifecycle ----------------------------------
    def _start_api_server(self) -> None:
        host = self.api_host_edit.text().strip() or "127.0.0.1"
        port = self.api_port_spin.value()
        self.api_server = ApiServer(self, host, port)
        try:
            self.api_server.start()
        except Exception as e:  # noqa: BLE001
            self._append_console(f"[gui] failed to start API server: {e}\n")
            self.api_server = None
            return
        self.api_status_label.setText(f"Running at http://{host}:{port}")
        self._append_console(f"[gui] unified API server listening on http://{host}:{port}\n")
        self.api_start_button.setEnabled(False)
        self.api_stop_button.setEnabled(True)
        self.api_host_edit.setEnabled(False)
        self.api_port_spin.setEnabled(False)

    def _stop_api_server(self) -> None:
        if self.api_server:
            self.api_server.stop()
        self.api_server = None
        self.api_status_label.setText("Stopped")
        self.api_start_button.setEnabled(True)
        self.api_stop_button.setEnabled(False)
        self.api_host_edit.setEnabled(True)
        self.api_port_spin.setEnabled(True)

    # ---- chat -----------------------------------------------------------
    def _send_prompt(self) -> None:
        if self.chat_worker is not None and self.chat_worker.isRunning():
            return
        prompt = self.prompt_edit.text().strip()
        if not prompt or not self.server:
            return
        self.prompt_edit.clear()
        self.prompt_edit.setEnabled(False)
        self.send_button.setEnabled(False)
        self.stop_chat_button.setEnabled(True)
        self._append_console(f"\n> {prompt}\n")

        chat_cfg = ovc.ChatRequestConfig(
            base_url=self._active_base_url,
            model=self._active_model,
            endpoint=self._active_endpoint,
            max_tokens=self.max_tokens_spin.value(),
            temperature=self.temperature_spin.value(),
            stream=self.stream_check.isChecked(),
            enable_thinking=False if self.no_thinking_check.isChecked() else None,
        )
        self.chat_cancel_event = threading.Event()
        self.chat_worker = ChatWorker(prompt, chat_cfg, self.chat_cancel_event)
        self.chat_worker.finished_ok.connect(self._on_chat_ok)
        self.chat_worker.finished_err.connect(self._on_chat_err)
        self.chat_worker.start()

    def _stop_chat(self) -> None:
        if self.chat_cancel_event is not None:
            self.chat_cancel_event.set()
        self.stop_chat_button.setEnabled(False)
        if not self.stream_check.isChecked():
            # A non-streaming request can't be interrupted mid-flight (it's a
            # single blocking POST); detach from it instead so the UI is
            # responsive immediately. The request still finishes server-side
            # and its result is discarded when it eventually arrives.
            self._append_console("[gui] stop requested (non-streaming request will still finish server-side; response will be ignored)\n")
            self.prompt_edit.setEnabled(True)
            self.send_button.setEnabled(True)

    def _on_chat_ok(self, result: str) -> None:
        if self.sender() is not self.chat_worker:
            return  # a stale (detached, non-cancelable) request finishing late
        was_cancelled = self.chat_cancel_event is not None and self.chat_cancel_event.is_set()
        if not self.stream_check.isChecked() and result and not was_cancelled:
            self._append_console(f"{result}\n")
        elif was_cancelled:
            self._append_console("\n[gui] stopped.\n")
        # Streamed (non-cancelled) output already printed itself (with a
        # trailing newline) live via ovc.chat().
        self.stop_chat_button.setEnabled(False)
        self.prompt_edit.setEnabled(True)
        self.send_button.setEnabled(True)
        self.prompt_edit.setFocus()

    def _on_chat_err(self, message: str) -> None:
        if self.sender() is not self.chat_worker:
            return  # a stale (detached, non-cancelable) request finishing late
        self._append_console(f"[gui] chat request failed: {message}\n")
        self.stop_chat_button.setEnabled(False)
        self.prompt_edit.setEnabled(True)
        self.send_button.setEnabled(True)

    def closeEvent(self, event) -> None:  # noqa: N802 - Qt override
        if self.server:
            try:
                self.server.stop()
            except Exception:  # noqa: BLE001
                pass
        if self.api_server:
            try:
                self.api_server.stop()
            except Exception:  # noqa: BLE001
                pass
        super().closeEvent(event)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=None, help="Path to a JSON file overriding the built-in defaults")
    args = parser.parse_args()

    cfg = ovc.load_config(args.config)

    app = QApplication(sys.argv)
    window = MainWindow(cfg)
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
