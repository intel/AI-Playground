"""Signal channel — drives a signal-cli JSON-RPC daemon.

Unlike Telegram and Slack, Signal has no hosted bot API. A Signal integration
needs a local `signal-cli` process bound to a real phone number, set up by
linking as a secondary device (QR scan) or registering a number. This channel
supervises that daemon — mirroring how `local_web.py` supervises its HTTP
server in a background thread — and speaks newline-delimited JSON-RPC 2.0 to it
over a loopback TCP socket.

The `signal-cli` binary and its data directory are provided by the Electron
main process via the AIPG_SIGNAL_CLI_PATH / AIPG_SIGNAL_CLI_HOME env vars (see
electron/subprocesses/signalCli.ts). A bare `signal-cli` on PATH is the dev
fallback.

Capability notes (deliberate, documented — not bugs):
  * Signal has no interactive buttons. `send_keyboard` renders the options as a
    numbered text list; yes/no confirmations still work because the renderer's
    dispatcher accepts typed replies (same as the LAN-web fallback).
  * Signal has no ephemeral message draft. `send_update` is a no-op — the typing
    indicator plus a single final reply cover the "working" state.
  * The bot locks onto the first number that messages it (persisted, like the
    Telegram chat-id) and only answers that number afterwards.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import shutil
import socket
import subprocess  # nosec B404
import sys
import tempfile
import threading
import time
from collections.abc import Iterable
from pathlib import Path

from .base import ChannelBase
from .types import SendResult

logger = logging.getLogger(__name__)

# signal-cli JSON-RPC method names. Centralized so a signal-cli API change is a
# one-line edit here. See the signal-cli-jsonrpc(5) man page.
_RPC_SEND = "send"
_RPC_SEND_TYPING = "sendTyping"
_RPC_START_LINK = "startLink"
_RPC_FINISH_LINK = "finishLink"

# Name shown under the phone's linked-devices list.
_DEVICE_NAME = "AI Playground"

# Signal device-link URIs embed a public key — scrub them from logs.
_SIGNAL_LINK_RE = re.compile(r"(?:sgnl|tsdevice)://[^\s\"']+")

# Document extensions the RAG ingestion pipeline accepts (mirrors telegram.py).
_SUPPORTED_DOC_EXTENSIONS = ("txt", "md", "doc", "docx", "pdf")
_MAX_DOC_BYTES = 25 * 1024 * 1024

_CONNECT_TIMEOUT_SECONDS = 20.0
_RPC_TIMEOUT_SECONDS = 60.0
_SEND_TIMEOUT_SECONDS = 180.0
# finishLink blocks until the user scans the QR with their phone.
_LINK_TIMEOUT_SECONDS = 300.0


def _free_tcp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class _JsonRpcClient:
    """Minimal newline-delimited JSON-RPC 2.0 client over a TCP socket.

    A background reader thread routes responses to the waiting caller (by id)
    and forwards server notifications (incoming Signal messages) to
    `on_notification`.
    """

    def __init__(self, sock: socket.socket, on_notification) -> None:
        self._sock = sock
        self._on_notification = on_notification
        self._write_lock = threading.Lock()
        self._id = 0
        self._id_lock = threading.Lock()
        self._pending: dict[int, tuple[threading.Event, dict]] = {}
        self._alive = True
        self._reader = threading.Thread(
            target=self._read_loop, name="signal-jsonrpc", daemon=True
        )
        self._reader.start()

    def close(self) -> None:
        self._alive = False
        try:
            self._sock.close()
        except OSError:
            pass

    def call(
        self,
        method: str,
        params: dict | None = None,
        timeout: float = _RPC_TIMEOUT_SECONDS,
    ):
        with self._id_lock:
            self._id += 1
            rid = self._id
        event = threading.Event()
        box: dict = {}
        self._pending[rid] = (event, box)
        request = json.dumps(
            {"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}
        )
        try:
            with self._write_lock:
                self._sock.sendall((request + "\n").encode("utf-8"))
        except OSError as exc:
            self._pending.pop(rid, None)
            raise RuntimeError(f"signal-cli connection lost: {exc}") from exc
        if not event.wait(timeout):
            self._pending.pop(rid, None)
            raise TimeoutError(
                f"signal-cli did not answer {method} within {timeout:.0f}s"
            )
        if "error" in box:
            err = box["error"]
            message = err.get("message") if isinstance(err, dict) else str(err)
            raise RuntimeError(f"signal-cli {method} failed: {message}")
        return box.get("result")

    def _read_loop(self) -> None:
        buffer = b""
        while self._alive:
            try:
                chunk = self._sock.recv(65536)
            except OSError as exc:
                if self._alive:
                    logger.warning("signal-cli socket recv error: %s", exc)
                break
            if not chunk:
                if self._alive:
                    logger.info("signal-cli socket closed by peer")
                break
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    message = json.loads(line.decode("utf-8"))
                except (ValueError, UnicodeDecodeError) as exc:
                    logger.debug("signal-cli sent a non-JSON line: %s", exc)
                    continue
                try:
                    self._dispatch(message)
                except Exception as exc:
                    logger.error("signal-cli dispatch error: %s", exc, exc_info=True)
        self._alive = False
        with self._id_lock:
            for event, box in self._pending.values():
                box["error"] = {"message": "signal-cli socket closed"}
                event.set()
            self._pending.clear()

    def _dispatch(self, message: dict | list) -> None:
        if isinstance(message, list):
            for item in message:
                self._dispatch(item)
            return
        if not isinstance(message, dict):
            logger.warning("signal-cli sent non-dict message: %r", message)
            return
        logger.info("signal-cli dispatch: method=%s id=%s", message.get("method"), message.get("id"))
        if message.get("id") is not None:
            entry = self._pending.pop(message["id"], None)
            if entry is not None:
                event, box = entry
                box.update(message)
                event.set()
            return
        if message.get("method") == "receive":
            try:
                self._on_notification(message.get("params") or {})
            except Exception as exc:
                logger.error("signal receive handler failed: %s", exc)


class SignalChannel(ChannelBase):
    """Single signal-cli daemon lifecycle + outbound primitives."""

    def __init__(self, base_dir: Path) -> None:
        super().__init__(kind="signal", identity_file=base_dir / ".signal_peer")
        self._account_file = base_dir / ".signal_account"
        # The bot's own linked/registered number (persisted across restarts).
        self._account: str = self._read_account()
        # Allow-listed contact + last-seen sender (mirrors Telegram's chat-id).
        self._allowed_peer: str = ""
        self._last_seen_peer: str | None = self.load_persisted_identity()
        self._proc: subprocess.Popen | None = None
        self._rpc: _JsonRpcClient | None = None
        self._data_dir = Path(
            os.environ.get("AIPG_SIGNAL_CLI_HOME") or (base_dir / ".signal-data")
        )
        self._cli_path = os.environ.get("AIPG_SIGNAL_CLI_PATH") or "signal-cli"
        self._seen_timestamps: set[int] = set()
        self._seen_lock = threading.Lock()

    # ── Channel protocol: lifecycle ───────────────────────────────────────
    def set_config(self, config: dict) -> dict:
        """Ensure the daemon is running and apply account / allowed peer.

        Unlike Telegram there is no token to change (the account is established
        by device-linking, not config), so this never restarts the daemon — it
        just (idempotently) starts it and updates the outbound target.
        """
        account = (config.get("account") or "").strip()
        peer = (config.get("peer") or config.get("allowed_peer") or "").strip()
        if account:
            self._account = account
            self._write_account(account)
        if peer:
            self._allowed_peer = peer
            self._last_seen_peer = peer
            self.persist_identity(peer)
        try:
            self._ensure_daemon()
            self._subscribe()
        except Exception as exc:
            return {"error": f"could not start signal-cli: {exc}", "_http_status": 500}
        return {"status": "started"}

    def request_shutdown(self) -> None:
        with self._start_lock:
            rpc, self._rpc = self._rpc, None
            proc, self._proc = self._proc, None
            self._app_instance = None
        if rpc is not None:
            rpc.close()
        if proc is not None:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception as exc:
                    logger.debug("signal-cli kill failed: %s", exc)

    def is_running(self) -> bool:
        proc = self._proc
        return self._rpc is not None and proc is not None and proc.poll() is None

    # ── Channel protocol: identity ────────────────────────────────────────
    def get_identity(self) -> str | None:
        return self._last_seen_peer or self.load_persisted_identity()

    # ── Channel protocol: outbound sends ──────────────────────────────────
    def _outbound_target(self, hint: str | None = None) -> str | None:
        for peer in (hint, self._allowed_peer, self._last_seen_peer):
            if peer and str(peer).strip():
                return str(peer).strip()
        return None

    def _send_message(
        self,
        text: str,
        target: str,
        attachments: list[str] | None = None,
        voice_note: bool = False,
    ) -> str | None:
        if self._rpc is None:
            raise RuntimeError("signal-cli daemon not running")
        params: dict = {"recipient": [target], "message": text or ""}
        if self._account:
            params["account"] = self._account
        if attachments:
            params["attachments"] = attachments
        if voice_note:
            # Ignored by signal-cli versions without voice-note support.
            params["voiceNote"] = True
        result = self._rpc.call(_RPC_SEND, params, timeout=_SEND_TIMEOUT_SECONDS)
        timestamp = result.get("timestamp") if isinstance(result, dict) else None
        return str(timestamp) if timestamp is not None else None

    def _attach_and_send(
        self,
        data_b64: str,
        filename: str,
        target: str,
        caption: str = "",
        voice_note: bool = False,
    ) -> str | None:
        """Write a base64 attachment to a temp file and send it.

        signal-cli takes attachments as file paths and shows the file's own
        name, so the payload is written into a scratch dir under the file's real
        name (e.g. model.glb) and the whole dir is removed after the send.
        """
        scratch = tempfile.mkdtemp(dir=str(self._data_dir))
        file_path = os.path.join(scratch, filename)
        try:
            with open(file_path, "wb") as fh:
                fh.write(base64.b64decode(data_b64))
            return self._send_message(
                caption, target, attachments=[file_path], voice_note=voice_note
            )
        finally:
            shutil.rmtree(scratch, ignore_errors=True)

    def send_reply(self, payload: dict) -> SendResult:
        target = self._outbound_target(payload.get("channel"))
        if not self.is_running() or not target:
            return {"error": "Signal not configured", "_http_status": 400}
        try:
            ts = self._send_message(payload.get("text", ""), target)
            return {"status": "ok", "ts": ts}
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    def send_update(self, payload: dict) -> SendResult:
        # Signal has no ephemeral draft; the final reply is the only message.
        return {"status": "skipped"}

    def send_photo(self, payload: dict) -> SendResult:
        photo_b64 = payload.get("photo", "") or payload.get("imageBase64", "")
        target = self._outbound_target(payload.get("channel"))
        if not self.is_running() or not target:
            return {"error": "Signal not configured", "_http_status": 400}
        try:
            ts = self._attach_and_send(
                photo_b64, "image.png", target, payload.get("caption", "")
            )
            return {"status": "ok", "ts": ts}
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    def send_video(self, payload: dict) -> SendResult:
        video_b64 = payload.get("video", "") or payload.get("videoBase64", "")
        filename = payload.get("filename") or "video.mp4"
        target = self._outbound_target(payload.get("channel"))
        if not self.is_running() or not target:
            return {"error": "Signal not configured", "_http_status": 400}
        try:
            ts = self._attach_and_send(
                video_b64, filename, target, payload.get("caption", "")
            )
            return {"status": "ok", "ts": ts}
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    def send_voice(self, payload: dict) -> SendResult:
        audio_b64 = payload.get("audio", "") or payload.get("audioBase64", "")
        mime = (payload.get("mime") or "").lower()
        ext = (
            "ogg"
            if ("ogg" in mime or "opus" in mime)
            else "m4a"
            if "mp4" in mime
            else "mp3"
        )
        target = self._outbound_target(payload.get("channel"))
        if not self.is_running() or not target:
            return {"error": "Signal not configured", "_http_status": 400}
        try:
            ts = self._attach_and_send(
                audio_b64, f"voice.{ext}", target, voice_note=True
            )
            return {"status": "ok", "ts": ts}
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    def send_document(self, payload: dict) -> SendResult:
        doc_b64 = payload.get("document", "") or payload.get("documentBase64", "")
        filename = payload.get("filename") or "file.bin"
        target = self._outbound_target(payload.get("channel"))
        if not self.is_running() or not target:
            return {"error": "Signal not configured", "_http_status": 400}
        try:
            ts = self._attach_and_send(
                doc_b64, filename, target, payload.get("caption", "")
            )
            return {"status": "ok", "ts": ts}
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    def send_typing(self, payload: dict) -> SendResult:
        action = str(payload.get("action") or "").strip().lower()
        target = self._outbound_target()
        if not self.is_running() or not target or self._rpc is None:
            return {"error": "Signal not configured", "_http_status": 400}
        try:
            params: dict = {"recipient": [target], "stop": action == "stop"}
            if self._account:
                params["account"] = self._account
            self._rpc.call(_RPC_SEND_TYPING, params, timeout=15)
            return {"status": "ok"}
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    def send_keyboard(self, payload: dict) -> SendResult:
        # Signal has no inline buttons: render the choices as a numbered list.
        # Callers still get a ref back so the prompt can be "settled" like the
        # other channels (see send_edit_message).
        target = self._outbound_target(payload.get("channel"))
        if not self.is_running() or not target:
            return {"error": "Signal not configured", "_http_status": 400}
        text = payload.get("text", "")
        lines = [text] if text else []
        index = 1
        for row in payload.get("buttons", []) or []:
            for btn in row:
                label = str(btn.get("text", "")).strip()
                if label:
                    lines.append(f"{index}. {label}")
                    index += 1
        try:
            ts = self._send_message("\n".join(lines), target)
            return {"status": "ok", "message_id": 0, "ts": ts}
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    def send_edit_message(self, payload: dict) -> SendResult:
        # No in-place edit over JSON-RPC here; settling a prompt just posts the
        # outcome text as a normal message (the buttons were plain text anyway).
        target = self._outbound_target(payload.get("channel"))
        if not self.is_running() or not target:
            return {"error": "Signal not configured", "_http_status": 400}
        try:
            self._send_message(payload.get("text", ""), target)
            return {"status": "ok"}
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    # ── Channel protocol: logging ─────────────────────────────────────────
    def redaction_patterns(self) -> Iterable[re.Pattern[str]]:
        return (_SIGNAL_LINK_RE,)

    # ── Channel commands (device linking) ─────────────────────────────────
    # Dispatched by the generic `/channel/<kind>/command/<name>` route. Signal
    # uses it for the QR device-linking flow the setup wizard drives.
    def channel_command(self, name: str, payload: dict) -> dict:
        if name == "startLink":
            return self._start_link()
        if name == "linkStatus":
            if not self._account:
                self._account = self._read_account()
            return {
                "status": "ok",
                "linked": bool(self._account),
                "account": self._account or None,
            }
        return {"error": f"unknown signal command: {name}", "_http_status": 404}

    def _start_link(self) -> dict:
        """Begin device linking: return the QR URI, finish the link in the bg.

        `finishLink` blocks until the phone scans the code, so it runs on a
        background thread and the URI is returned immediately for the UI to
        render as a QR. The setup screen then polls `get_identity` (once the
        user messages the bot) exactly like Telegram's chat-id detection.
        """
        self.request_shutdown()
        try:
            self._ensure_daemon()
        except Exception as exc:
            return {"error": f"could not start signal-cli: {exc}", "_http_status": 500}
        if self._rpc is None:
            return {"error": "signal-cli daemon not running", "_http_status": 500}
        try:
            result = self._rpc.call(_RPC_START_LINK, {}, timeout=30)
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}
        link_uri = result.get("deviceLinkUri") if isinstance(result, dict) else None
        if not link_uri:
            return {
                "error": "signal-cli returned no device link URI",
                "_http_status": 500,
            }
        try:
            (self._data_dir / "latest_link_uri.txt").write_text(link_uri)
        except Exception as exc:
            logger.debug("Could not write latest_link_uri.txt: %s", exc)
        sys.stderr.write(f"\n[Signal] Device link URI: {link_uri}\n\n")
        sys.stderr.flush()
        threading.Thread(
            target=self._finish_link, args=(link_uri,), name="signal-link", daemon=True
        ).start()
        return {"status": "ok", "linkUri": link_uri}

    def _finish_link(self, link_uri: str) -> None:
        if self._rpc is None:
            return
        try:
            result = self._rpc.call(
                _RPC_FINISH_LINK,
                {"deviceLinkUri": link_uri, "deviceName": _DEVICE_NAME},
                timeout=_LINK_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            logger.warning("Signal device linking did not complete: %s", exc)
            return
        number = None
        if isinstance(result, str):
            number = result
        elif isinstance(result, dict):
            number = result.get("number") or result.get("account") or result.get("uuid")
        if not number:
            number = self._read_account()
        if number:
            self._account = str(number)
            self._write_account(self._account)
            logger.info("Signal linked as a new device: %s", self._account)
            self._subscribe()

    # ── Daemon lifecycle ──────────────────────────────────────────────────
    def _ensure_daemon(self) -> None:
        with self._start_lock:
            if self.is_running():
                return
            self._app_instance = "starting"
            self._data_dir.mkdir(parents=True, exist_ok=True)
            port = _free_tcp_port()
            cmd = [
                self._cli_path,
                "--config",
                str(self._data_dir),
                "daemon",
                "--tcp",
                f"127.0.0.1:{port}",
                "--receive-mode",
                "on-start",
            ]
            logger.info("Starting signal-cli daemon on 127.0.0.1:%d", port)
            try:
                # A fixed command with the app-managed binary path; no shell
                # and no user-controlled argv.
                self._proc = subprocess.Popen(  # nosec B603
                    cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
                )
                def _drain_stderr(pipe):
                    try:
                        for line in iter(pipe.readline, b""):
                            logger.info("signal-cli: %s", line.decode(errors="replace").rstrip())
                    except Exception:
                        pass
                    finally:
                        try:
                            pipe.close()
                        except Exception:
                            pass

                threading.Thread(
                    target=_drain_stderr,
                    args=(self._proc.stderr,),
                    name="signal-stderr",
                    daemon=True,
                ).start()
            except FileNotFoundError as exc:
                self._app_instance = None
                raise RuntimeError(f"signal-cli not found at {self._cli_path}") from exc
            try:
                sock = self._connect_socket(port)
            except Exception:
                self._app_instance = None
                self.request_shutdown()
                raise
            self._rpc = _JsonRpcClient(sock, self._on_receive)
            self._app_instance = self._proc
            self._subscribe()

    def _subscribe(self) -> None:
        if self._rpc is not None and self._account:
            try:
                self._rpc.call("subscribeReceive", {"account": self._account}, timeout=10)
                logger.info("Subscribed to receive Signal messages for %s", self._account)
            except Exception as exc:
                logger.warning("Could not subscribe to receive: %s", exc)

    def _connect_socket(self, port: int) -> socket.socket:
        deadline = time.monotonic() + _CONNECT_TIMEOUT_SECONDS
        last_error: OSError | None = None
        while time.monotonic() < deadline:
            if self._proc is not None and self._proc.poll() is not None:
                raise RuntimeError("signal-cli exited before its socket opened")
            try:
                sock = socket.create_connection(("127.0.0.1", port), timeout=5)
                sock.settimeout(None)
                return sock
            except OSError as exc:
                last_error = exc
                time.sleep(0.25)
        raise RuntimeError(f"signal-cli daemon did not open its socket: {last_error}")

    # ── Inbound ────────────────────────────────────────────────────────────
    def _record_authorized_peer(self, number: str) -> None:
        allow = self._allowed_peer
        if allow and number != allow:
            return
        if self._last_seen_peer != number:
            self._last_seen_peer = number
            self.persist_identity(number)

    def _on_receive(self, params: dict) -> None:
        envelope = params.get("envelope")
        if not envelope and isinstance(params.get("result"), dict):
            envelope = params["result"].get("envelope")
        if not isinstance(envelope, dict):
            return

        ts = envelope.get("timestamp")
        if ts is not None:
            with self._seen_lock:
                if ts in self._seen_timestamps:
                    return
                self._seen_timestamps.add(ts)
                if len(self._seen_timestamps) > 1000:
                    self._seen_timestamps.clear()

        source = envelope.get("sourceNumber") or envelope.get("source") or ""
        data_message = envelope.get("dataMessage")

        # In a linked-device setup, messages the user sends to "Note to Self"
        # arrive via syncMessage -> sentMessage addressed to their own account.
        if not data_message:
            sync_message = envelope.get("syncMessage")
            if isinstance(sync_message, dict):
                sent_message = sync_message.get("sentMessage")
                if isinstance(sent_message, dict):
                    dest = (
                        sent_message.get("destinationNumber")
                        or sent_message.get("destination")
                        or ""
                    )
                    if dest and (dest == self._account or not self._account):
                        data_message = sent_message
                        source = dest or self._account

        if not source or not isinstance(data_message, dict):
            return
        self._record_authorized_peer(str(source))
        if not self._allowed_peer:
            logger.info("Signal detection mode: message from a new number: %s", source)
            return
        if str(source) != self._allowed_peer:
            logger.warning("Ignoring Signal message from unauthorized number: %s", source)
            return
        item: dict = {
            "text": data_message.get("message") or "",
            "chat_id": str(source),
            "channel": "signal",
        }
        images, audio, documents = self._collect_attachments(
            data_message.get("attachments") or []
        )
        if images:
            item["images"] = images
        if audio:
            item["audio"] = audio
        if documents:
            item["documents"] = documents
        self.queue_append(item)

    def _collect_attachments(self, attachments: list) -> tuple[list, list, list]:
        images: list = []
        audio: list = []
        documents: list = []
        for att in attachments:
            if not isinstance(att, dict):
                continue
            att_id = att.get("id") or att.get("attachmentId")
            content_type = (att.get("contentType") or "").lower()
            filename = att.get("filename") or att.get("fileName") or ""
            if not att_id:
                continue
            raw = self._read_attachment_file(str(att_id))
            if raw is None:
                continue
            data_b64 = base64.b64encode(raw).decode("ascii")
            if content_type.startswith("image/"):
                images.append({"mime": content_type, "data_base64": data_b64})
            elif content_type.startswith("audio/"):
                audio.append({"mime": content_type, "data_base64": data_b64})
            else:
                ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
                if ext in _SUPPORTED_DOC_EXTENSIONS and len(raw) <= _MAX_DOC_BYTES:
                    documents.append(
                        {
                            "filename": filename or f"file.{ext}",
                            "mime": content_type or "application/octet-stream",
                            "data_base64": data_b64,
                        }
                    )
        return images, audio, documents

    def _read_attachment_file(self, att_id: str) -> bytes | None:
        # signal-cli auto-downloads attachments into <config>/attachments/<id>.
        path = self._data_dir / "attachments" / att_id
        try:
            return path.read_bytes()
        except OSError as exc:
            logger.warning("Could not read Signal attachment %s: %s", att_id, exc)
            return None

    # ── Account persistence ──────────────────────────────────────────────
    def _read_account(self) -> str:
        try:
            val = self._account_file.read_text().strip()
            if val:
                return val
        except FileNotFoundError:
            pass
        try:
            accounts_file = self._data_dir / "data" / "accounts.json"
            if accounts_file.exists():
                data = json.loads(accounts_file.read_text())
                accs = data.get("accounts", [])
                if accs and isinstance(accs, list):
                    num = accs[0].get("number") or accs[0].get("uuid")
                    if num:
                        self._write_account(str(num))
                        return str(num)
        except Exception:
            pass
        return ""

    def _write_account(self, value: str) -> None:
        try:
            self._account_file.write_text(value)
        except Exception as exc:
            logger.warning("Could not persist Signal account: %s", exc)
