"""Slack channel — wraps slack-bolt Socket Mode + chat.* / reactions.* / files.upload_v2.

Ports the standalone `_start_slack_bot` and all `send_slack_*` Flask route
bodies from `web_api.py` into a single cohesive object that satisfies the
`Channel` protocol.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import re
import threading
import time
from pathlib import Path
from typing import Iterable

from .base import ChannelBase
from .commands import HOME_AGENT_COMMANDS
from .types import SendResult


logger = logging.getLogger(__name__)


_SLACK_TOKEN_RE = re.compile(r"xox[abporsb]-[A-Za-z0-9-]{10,}|xapp-\d+-[A-Za-z0-9-]{20,}")

# Document extensions the RAG ingestion pipeline (langchain loaders) accepts.
# Mirrors the desktop uploader (WebUI/src/components/Rag.vue).
_SUPPORTED_DOC_EXTENSIONS = ("txt", "md", "doc", "docx", "pdf")
# Cap inbound document payload size to avoid bloating the poll/IPC channel.
_MAX_DOC_BYTES = 25 * 1024 * 1024


class SlackChannel(ChannelBase):
    """Socket Mode bot lifecycle + outbound primitives for Slack."""

    def __init__(self, base_dir: Path) -> None:
        super().__init__(kind="slack", identity_file=base_dir / ".slack_user_id")
        self._bot_token: str = ""
        self._app_token: str = ""
        self._allowed_user_id: str = ""
        # Cached IM channel id (D…) for outbound chat.postMessage. Captured
        # on first inbound DM and reused; falling back to user_id works for
        # postMessage but not for reactions in some workspaces.
        self._im_channel: str = ""
        self._loop: asyncio.AbstractEventLoop | None = None
        self._shutdown_event: asyncio.Event | None = None
        self._last_seen_user_id: str | None = self.load_persisted_identity()

    # ── Channel protocol: lifecycle ───────────────────────────────────────
    def set_config(self, config: dict) -> dict:
        bot_token = (config.get("botToken") or "").strip()
        app_token = (config.get("appToken") or "").strip()
        raw_user = config.get("userId")
        cleaned_user = (
            str(raw_user).strip() if raw_user is not None and str(raw_user).strip() else ""
        )
        if not bot_token or not app_token:
            return {"error": "botToken and appToken are required", "_http_status": 400}

        thread_to_join: threading.Thread | None = None
        with self._start_lock:
            if self._app_instance == "starting":
                return {"status": "starting", "_http_status": 409}
            if self._app_instance is not None:
                same_tokens = self._bot_token == bot_token and self._app_token == app_token
                if same_tokens:
                    if cleaned_user:
                        self._allowed_user_id = cleaned_user
                        logger.info(
                            "Slack bot already running — applied user_id=%s", cleaned_user
                        )
                    return {
                        "status": "already_running",
                        "userUpdated": bool(cleaned_user),
                    }
                logger.info("Slack tokens changed — restarting bot")
                loop = self._loop
                ev = self._shutdown_event
                if loop is not None and ev is not None:
                    try:
                        loop.call_soon_threadsafe(ev.set)
                    except Exception as exc:
                        logger.warning("Could not signal slack bot shutdown: %s", exc)
                thread_to_join = self._thread
            self._app_instance = "starting"

        if thread_to_join is not None and thread_to_join.is_alive():
            thread_to_join.join(timeout=10)
            if thread_to_join.is_alive():
                logger.warning("Previous Slack bot thread did not exit within 10s")

        t = threading.Thread(
            target=self._run_bot, args=(bot_token, app_token, cleaned_user), daemon=True
        )
        self._thread = t
        t.start()
        logger.info("Started Slack bot via channel.set_config")
        return {"status": "started"}

    # ── Channel protocol: identity ───────────────────────────────────────
    def get_identity(self) -> str | None:
        return self._last_seen_user_id or self.load_persisted_identity()

    # ── Channel protocol: outbound sends ─────────────────────────────────
    def _outbound_target(self, hint: str | None = None) -> str | None:
        for cand in (hint, self._im_channel, self._allowed_user_id, self._last_seen_user_id):
            if cand and str(cand).strip():
                return str(cand).strip()
        return None

    def _run_coro(self, coro, timeout: float = 30.0):
        if self._loop is None or self._app_instance in (None, "starting"):
            raise RuntimeError("Slack bot not running")
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=timeout)

    def send_reply(self, payload: dict) -> SendResult:
        text = payload.get("text", "")
        blocks = payload.get("blocks")
        thread_ts = payload.get("thread_ts") or payload.get("threadTs")
        target = self._outbound_target(payload.get("channel"))
        if not self.is_running() or not target:
            return {"error": "Slack not configured", "_http_status": 400}
        try:
            kwargs: dict = {"channel": target, "text": text}
            if blocks:
                kwargs["blocks"] = blocks
            if thread_ts:
                kwargs["thread_ts"] = thread_ts
            resp = self._run_coro(self._app_instance.client.chat_postMessage(**kwargs))  # type: ignore[union-attr]
            return {
                "status": "ok",
                "ts": resp.get("ts"),
                "channel": resp.get("channel") or target,
            }
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    def send_update(self, payload: dict) -> SendResult:
        channel = (payload.get("channel") or "").strip()
        ts = (payload.get("ts") or "").strip()
        text = payload.get("text", "")
        blocks = payload.get("blocks")
        if not channel or not ts:
            return {"error": "channel and ts are required", "_http_status": 400}
        if not self.is_running():
            return {"error": "Slack not configured", "_http_status": 400}
        try:
            kwargs: dict = {"channel": channel, "ts": ts, "text": text}
            if blocks:
                kwargs["blocks"] = blocks
            self._run_coro(self._app_instance.client.chat_update(**kwargs))  # type: ignore[union-attr]
            return {"status": "ok"}
        except Exception as exc:
            # Drafts/updates are best-effort; surface so the throttle can skip.
            return {"error": str(exc), "_http_status": 500}

    def send_photo(self, payload: dict) -> SendResult:
        photo_b64 = payload.get("photo", "") or payload.get("imageBase64", "")
        caption = payload.get("caption", "") or ""
        thread_ts = payload.get("thread_ts") or payload.get("threadTs")
        target = self._outbound_target(payload.get("channel"))
        if not self.is_running() or not target:
            return {"error": "Slack not configured", "_http_status": 400}
        try:
            photo_bytes = base64.b64decode(photo_b64)
            kwargs: dict = {
                "channel": target,
                "file": photo_bytes,
                "filename": f"aipg-{int(time.time() * 1000)}.png",
            }
            if caption:
                kwargs["initial_comment"] = caption
            if thread_ts:
                kwargs["thread_ts"] = thread_ts
            self._run_coro(self._app_instance.client.files_upload_v2(**kwargs))  # type: ignore[union-attr]
            return {"status": "ok"}
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    def send_video(self, payload: dict) -> SendResult:
        video_b64 = payload.get("video", "") or payload.get("videoBase64", "")
        caption = payload.get("caption", "") or ""
        filename = payload.get("filename") or f"aipg-{int(time.time() * 1000)}.mp4"
        thread_ts = payload.get("thread_ts") or payload.get("threadTs")
        target = self._outbound_target(payload.get("channel"))
        if not self.is_running() or not target:
            return {"error": "Slack not configured", "_http_status": 400}
        try:
            video_bytes = base64.b64decode(video_b64)
            kwargs: dict = {"channel": target, "file": video_bytes, "filename": filename}
            if caption:
                kwargs["initial_comment"] = caption
            if thread_ts:
                kwargs["thread_ts"] = thread_ts
            self._run_coro(self._app_instance.client.files_upload_v2(**kwargs))  # type: ignore[union-attr]
            return {"status": "ok"}
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    def send_voice(self, payload: dict) -> SendResult:
        audio_b64 = payload.get("audio", "") or payload.get("audioBase64", "")
        mime = (payload.get("mime") or "").lower()
        caption = payload.get("caption", "") or ""
        thread_ts = payload.get("thread_ts") or payload.get("threadTs")
        target = self._outbound_target(payload.get("channel"))
        if not self.is_running() or not target:
            return {"error": "Slack not configured", "_http_status": 400}
        try:
            from .audio import to_mp3

            audio_bytes = base64.b64decode(audio_b64)
            # Slack has no voice-note primitive and does not give Opus-in-Ogg a
            # playable inline player (it mis-detects it as "Ogg Vorbis"). MP3 is
            # reliably rendered with an inline audio player, so transcode to MP3.
            ext = "mp3"
            is_mp3 = "mpeg" in mime or "mp3" in mime
            if not is_mp3:
                try:
                    audio_bytes = to_mp3(audio_bytes)
                except Exception as exc:  # noqa: BLE001 - best-effort transcode
                    logger.warning("MP3 transcode failed, sending original audio: %s", exc)
                    if "ogg" in mime or "opus" in mime:
                        ext = "ogg"
                    elif "wav" in mime:
                        ext = "wav"
            filename = f"aipg-{int(time.time() * 1000)}.{ext}"
            kwargs: dict = {"channel": target, "file": audio_bytes, "filename": filename}
            if caption:
                kwargs["initial_comment"] = caption
            if thread_ts:
                kwargs["thread_ts"] = thread_ts
            self._run_coro(self._app_instance.client.files_upload_v2(**kwargs))  # type: ignore[union-attr]
            return {"status": "ok"}
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    def send_document(self, payload: dict) -> SendResult:
        doc_b64 = payload.get("document", "") or payload.get("documentBase64", "")
        caption = payload.get("caption", "") or ""
        filename = payload.get("filename") or f"aipg-{int(time.time() * 1000)}.bin"
        thread_ts = payload.get("thread_ts") or payload.get("threadTs")
        target = self._outbound_target(payload.get("channel"))
        if not self.is_running() or not target:
            return {"error": "Slack not configured", "_http_status": 400}
        try:
            doc_bytes = base64.b64decode(doc_b64)
            kwargs: dict = {"channel": target, "file": doc_bytes, "filename": filename}
            if caption:
                kwargs["initial_comment"] = caption
            if thread_ts:
                kwargs["thread_ts"] = thread_ts
            self._run_coro(self._app_instance.client.files_upload_v2(**kwargs))  # type: ignore[union-attr]
            return {"status": "ok"}
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    def send_typing(self, payload: dict) -> SendResult:
        """Slack has no DM "typing…" indicator equivalent to Telegram's chat
        actions, so we follow OpenClaw's pattern and use reactions.add /
        reactions.remove on the inbound message to signal that the bot is
        processing.
        """
        channel = (payload.get("channel") or "").strip()
        ts = (payload.get("ts") or "").strip()
        name = (payload.get("name") or "eyes").strip()
        action = (payload.get("action") or "add").strip()
        if not channel or not ts:
            return {"error": "channel and ts are required", "_http_status": 400}
        if not self.is_running():
            return {"error": "Slack not configured", "_http_status": 400}
        try:
            if action == "remove":
                self._run_coro(
                    self._app_instance.client.reactions_remove(  # type: ignore[union-attr]
                        channel=channel, timestamp=ts, name=name
                    )
                )
            else:
                self._run_coro(
                    self._app_instance.client.reactions_add(  # type: ignore[union-attr]
                        channel=channel, timestamp=ts, name=name
                    )
                )
            return {"status": "ok"}
        except Exception as exc:
            # `already_reacted` / `no_reaction` benignly fail here.
            return {"error": str(exc), "_http_status": 500}

    def send_keyboard(self, payload: dict) -> SendResult:
        text = payload.get("text", "")
        blocks = payload.get("blocks") or []
        target = self._outbound_target(payload.get("channel"))
        if not self.is_running() or not target:
            return {"error": "Slack not configured", "_http_status": 400}
        try:
            resp = self._run_coro(
                self._app_instance.client.chat_postMessage(  # type: ignore[union-attr]
                    channel=target, text=text, blocks=blocks
                )
            )
            return {
                "status": "ok",
                "ts": resp.get("ts"),
                "channel": resp.get("channel") or target,
            }
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    # ── Channel protocol: logging ────────────────────────────────────────
    def redaction_patterns(self) -> Iterable[re.Pattern[str]]:
        return (_SLACK_TOKEN_RE,)

    # ── Bot lifecycle implementation ─────────────────────────────────────
    def _run_bot(self, bot_token: str, app_token: str, initial_user_id: str) -> None:
        # slack-bolt imports are deferred so the rest of the Flask app boots
        # even when the package is missing (e.g. legacy installs that have
        # not yet run `uv sync`). Slack endpoints just refuse with
        # `Slack not configured`.
        try:
            from slack_bolt.async_app import AsyncApp
            from slack_bolt.adapter.socket_mode.aiohttp import AsyncSocketModeHandler
        except ImportError as exc:
            logger.error("slack-bolt is not installed: %s", exc)
            self._app_instance = None
            return

        self._bot_token = bot_token
        self._app_token = app_token
        self._allowed_user_id = (initial_user_id or "").strip()

        async def _maybe_remember_user(user_id: str, channel: str | None) -> None:
            if user_id and user_id != self._last_seen_user_id:
                self._last_seen_user_id = user_id
                self.persist_identity(user_id)
            if channel and channel.startswith("D"):
                self._im_channel = channel

        async def _enqueue_command(command_text: str, user_id: str, channel: str) -> None:
            if not self._allowed_user_id:
                logger.info(
                    "Detection mode: slack command from user_id=%s (not yet configured)", user_id
                )
                return
            if user_id != self._allowed_user_id:
                logger.warning(
                    "Ignoring slack command from unauthorized user_id: %s", user_id
                )
                return
            self.queue_append(
                {"text": command_text, "chat_id": user_id, "channel": channel}
            )

        async def _download_slack_files(
            files: list[dict], client_token: str
        ) -> tuple[list[dict], list[dict], list[dict]]:
            """Download supported Slack file uploads.

            Returns an ``(images, audio, documents)`` tuple. ``image/*`` and
            ``audio/*`` files are collected by mime; document uploads are matched
            by file extension (txt/md/doc/docx/pdf) for RAG ingestion. Everything
            else is ignored.
            """
            import aiohttp

            images: list[dict] = []
            audio: list[dict] = []
            documents: list[dict] = []
            async with aiohttp.ClientSession(
                headers={"Authorization": f"Bearer {client_token}"}
            ) as session:
                for f in files[:8]:
                    mime = f.get("mimetype") or ""
                    is_image = mime.startswith("image/")
                    is_audio = mime.startswith("audio/")
                    filename = f.get("name") or "document"
                    # Prefer the real extension from the filename. Slack's
                    # `filetype` is a display code (e.g. "text" for .txt,
                    # "markdown" for .md) that does not match a file extension,
                    # so it must not gate document detection on its own.
                    if "." in filename:
                        ext = filename.rsplit(".", 1)[-1].lower()
                    else:
                        ext = (f.get("filetype") or "").lower()
                    is_document = ext in _SUPPORTED_DOC_EXTENSIONS
                    if not is_image and not is_audio and not is_document:
                        continue
                    size = f.get("size") or 0
                    if is_document and size and size > _MAX_DOC_BYTES:
                        logger.warning("slack document too large, skipping: %s", filename)
                        continue
                    url = f.get("url_private_download") or f.get("url_private")
                    if not url:
                        continue
                    try:
                        async with session.get(url) as resp:
                            if resp.status != 200:
                                logger.warning(
                                    "slack file download failed: status=%d", resp.status
                                )
                                continue
                            raw = await resp.read()
                    except Exception as exc:
                        logger.error("slack file download error: %s", exc)
                        continue
                    data_b64 = base64.b64encode(raw).decode("ascii")
                    if is_image:
                        images.append({"mime": mime, "data_base64": data_b64})
                    elif is_audio:
                        audio.append({"mime": mime, "data_base64": data_b64})
                    else:
                        documents.append(
                            {
                                "filename": filename,
                                "mime": mime or "application/octet-stream",
                                "data_base64": data_b64,
                            }
                        )
            return images, audio, documents

        async def run() -> None:
            self._loop = asyncio.get_event_loop()
            self._shutdown_event = asyncio.Event()

            bolt_app = AsyncApp(token=bot_token)
            self._app_instance = bolt_app

            @bolt_app.event("message")
            async def on_message(event, say, body):  # type: ignore[no-untyped-def]
                if event.get("channel_type") != "im":
                    return
                if event.get("subtype") in (
                    "message_changed",
                    "message_deleted",
                    "bot_message",
                ):
                    return
                if event.get("bot_id"):
                    return
                user_id = event.get("user") or ""
                channel = event.get("channel") or ""
                await _maybe_remember_user(user_id, channel)

                allow = self._allowed_user_id
                if not allow:
                    logger.info(
                        "Detection mode: slack DM from user_id=%s (not yet configured)", user_id
                    )
                    return
                if user_id != allow:
                    logger.warning("Ignoring slack DM from unauthorized user_id: %s", user_id)
                    return

                text = event.get("text") or ""
                ts = event.get("ts") or ""
                files = event.get("files") or []
                images, audio, documents = (
                    await _download_slack_files(files, bot_token) if files else ([], [], [])
                )
                if text:
                    text_payload = text
                elif images:
                    text_payload = "[image]"
                else:
                    text_payload = ""
                logger.info(
                    "Slack DM received: user_id=%s channel=%s ts=%s len=%d images=%d audio=%d docs=%d",
                    user_id,
                    channel,
                    ts,
                    len(text),
                    len(images),
                    len(audio),
                    len(documents),
                )
                self.queue_append(
                    {
                        "text": text_payload,
                        "chat_id": user_id,
                        "channel": channel,
                        "ts": ts,
                        **({"images": images} if images else {}),
                        **({"audio": audio} if audio else {}),
                        **({"documents": documents} if documents else {}),
                    }
                )

            async def _handle_slash(ack, command, full_text: str) -> None:
                await ack()
                await _maybe_remember_user(
                    command.get("user_id") or "", command.get("channel_id")
                )
                await _enqueue_command(
                    full_text,
                    command.get("user_id") or "",
                    command.get("channel_id") or "",
                )

            # Slash commands are derived from the shared HOME_AGENT_COMMANDS
            # source of truth (see channels/commands.py) so they stay in lockstep
            # with the Telegram transport. The matching Slack app manifest
            # (WebUI/src/components/SlackSetupSteps.vue) must declare the same set.
            def _make_slash_handler(cmd):  # type: ignore[no-untyped-def]
                async def handler(ack, command):  # type: ignore[no-untyped-def]
                    text = (command.get("text") or "").strip() if cmd.takes_args else ""
                    full_text = f"{cmd.queued_text} {text}".strip() if text else cmd.queued_text
                    await _handle_slash(ack, command, full_text)

                return handler

            for cmd in HOME_AGENT_COMMANDS:
                bolt_app.command(cmd.slash)(_make_slash_handler(cmd))

            @bolt_app.action(re.compile(r"^imgGen:"))
            async def on_imggen_action(ack, body, action):  # type: ignore[no-untyped-def]
                await ack()
                user = (body.get("user") or {}).get("id") or ""
                channel = (body.get("channel") or {}).get("id") or ""
                await _maybe_remember_user(user, channel)
                if self._allowed_user_id and user != self._allowed_user_id:
                    logger.warning(
                        "Ignoring imgGen action from unauthorized user_id: %s", user
                    )
                    return
                value = action.get("value") or action.get("action_id") or ""
                logger.info("Slack imgGen action: user=%s value=%s", user, value)
                self.queue_append(
                    {"chat_id": user, "channel": channel, "callback": value}
                )

            @bolt_app.action(re.compile(r"^confirm:"))
            async def on_confirm_action(ack, body, action):  # type: ignore[no-untyped-def]
                await ack()
                user = (body.get("user") or {}).get("id") or ""
                channel = (body.get("channel") or {}).get("id") or ""
                await _maybe_remember_user(user, channel)
                if self._allowed_user_id and user != self._allowed_user_id:
                    logger.warning(
                        "Ignoring confirm action from unauthorized user_id: %s", user
                    )
                    return
                value = action.get("value") or action.get("action_id") or ""
                logger.info("Slack confirm action: user=%s value=%s", user, value)
                self.queue_append(
                    {"chat_id": user, "channel": channel, "callback": value}
                )

            @bolt_app.action(re.compile(r"^loadConv:"))
            async def on_loadconv_action(ack, body, action):  # type: ignore[no-untyped-def]
                await ack()
                user = (body.get("user") or {}).get("id") or ""
                channel = (body.get("channel") or {}).get("id") or ""
                await _maybe_remember_user(user, channel)
                if self._allowed_user_id and user != self._allowed_user_id:
                    logger.warning(
                        "Ignoring loadConv action from unauthorized user_id: %s", user
                    )
                    return
                value = action.get("value") or action.get("action_id") or ""
                key = value[len("loadConv:") :] if value.startswith("loadConv:") else value
                logger.info("Slack loadConv action: user=%s key=%s", user, key)
                self.queue_append(
                    {"text": f"/load {key}".strip(), "chat_id": user, "channel": channel}
                )

            handler = AsyncSocketModeHandler(bolt_app, app_token)
            try:
                await handler.connect_async()
                logger.info("Slack Socket Mode bot connected")
            except Exception as exc:
                logger.error("Slack Socket Mode connect failed: %s", exc)
                raise

            try:
                await self._shutdown_event.wait()
            finally:
                try:
                    await handler.close_async()
                except Exception as exc:
                    logger.warning("Slack handler.close_async() failed: %s", exc)
                try:
                    await bolt_app.async_stop()
                except Exception as exc:
                    logger.warning("Slack bolt_app.async_stop() failed: %s", exc)

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        try:
            loop.run_until_complete(run())
        except Exception as exc:
            logger.error("Slack bot crashed: %s", exc)
        finally:
            self._app_instance = None
            self._loop = None
            self._shutdown_event = None
            try:
                loop.close()
            except Exception:
                pass
