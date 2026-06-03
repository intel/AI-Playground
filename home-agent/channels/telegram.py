"""Telegram channel — wraps python-telegram-bot polling + outbound API calls.

Ports the standalone `_start_telegram_bot` and all `send_telegram_*` Flask
route bodies from `web_api.py` into a single cohesive object that satisfies
the `Channel` protocol. The Flask layer becomes a thin generic dispatcher.
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import re
import threading
from pathlib import Path
from typing import Iterable

from .base import ChannelBase
from .types import SendResult


logger = logging.getLogger(__name__)


# Token shape: `<numeric_id>:<base64-ish>` — no word boundary on the digit side
# because tokens embed inside URLs (`…/bot<id>:<token>/…`).
_TELEGRAM_TOKEN_RE = re.compile(r"\d{6,}:[A-Za-z0-9_-]{20,}")

# Document extensions the RAG ingestion pipeline (langchain loaders) accepts.
# Mirrors the desktop uploader (WebUI/src/components/Rag.vue).
_SUPPORTED_DOC_EXTENSIONS = ("txt", "md", "doc", "docx", "pdf")
# Cap inbound document payload size to avoid bloating the poll/IPC channel.
_MAX_DOC_BYTES = 25 * 1024 * 1024


class TelegramChannel(ChannelBase):
    """Single Telegram bot lifecycle + outbound primitives."""

    def __init__(self, base_dir: Path) -> None:
        super().__init__(kind="telegram", identity_file=base_dir / ".chat_id")
        self._token: str = ""
        # Renderer-supplied chat id (allow-list) and last-seen value (used in
        # detection mode and for fallback outbound). They diverge briefly
        # during /Detect when the user has not yet picked an allow-list.
        self._allowed_chat_id: str = ""
        self._bot_chat_id: str = ""
        self._loop: asyncio.AbstractEventLoop | None = None
        self._shutdown_event: asyncio.Event | None = None
        # Mirror the previous `_last_seen_chat_id` global to preserve the
        # behavior of persisting the first chat that messages the bot during
        # detection. Set from `_record_authorized_chat_id`.
        self._last_seen_chat_id: str | None = self.load_persisted_identity()

    # ── Channel protocol: lifecycle ───────────────────────────────────────
    def set_config(self, config: dict) -> dict:
        """Inject token (and optional chatId). Restart bot if token changed.

        Mirrors the legacy `/set-telegram-token` Flask handler exactly so the
        renderer's behavior — including the `already_running` short-circuit
        for unchanged tokens — is preserved.
        """
        token = (config.get("token") or "").strip()
        raw_chat = config.get("chatId")
        cleaned_chat = (
            str(raw_chat).strip() if raw_chat is not None and str(raw_chat).strip() else ""
        )
        if not token:
            return {"error": "token required", "_http_status": 400}

        thread_to_join: threading.Thread | None = None
        with self._start_lock:
            if self._app_instance == "starting":
                return {"status": "starting", "_http_status": 409}
            if self._app_instance is not None:
                if self._token == token:
                    if cleaned_chat:
                        self._allowed_chat_id = cleaned_chat
                        self._bot_chat_id = cleaned_chat
                        logger.info(
                            "Telegram bot already running — applied chat_id=%s", cleaned_chat
                        )
                    return {
                        "status": "already_running",
                        "chatUpdated": bool(cleaned_chat),
                    }
                logger.info("Telegram bot token changed — restarting bot")
                loop = self._loop
                ev = self._shutdown_event
                if loop is not None and ev is not None:
                    try:
                        loop.call_soon_threadsafe(ev.set)
                    except Exception as exc:
                        logger.warning("Could not signal bot shutdown: %s", exc)
                thread_to_join = self._thread
            self._app_instance = "starting"

        if thread_to_join is not None and thread_to_join.is_alive():
            thread_to_join.join(timeout=10)
            if thread_to_join.is_alive():
                logger.warning("Previous Telegram bot thread did not exit within 10s")

        t = threading.Thread(target=self._run_bot, args=(token, cleaned_chat), daemon=True)
        self._thread = t
        t.start()
        logger.info("Started Telegram bot via channel.set_config")
        return {"status": "started"}

    # ── Channel protocol: identity ───────────────────────────────────────
    def get_identity(self) -> str | None:
        return self._last_seen_chat_id or self.load_persisted_identity()

    # ── Channel protocol: outbound sends ─────────────────────────────────
    def _outbound_chat_id(self, hint: str | None = None) -> str | None:
        for cid in (hint, self._bot_chat_id, self._allowed_chat_id, self._last_seen_chat_id):
            if cid and str(cid).strip():
                return str(cid).strip()
        return None

    def _run_coro(self, coro, timeout: float = 10.0):
        if self._loop is None or self._app_instance in (None, "starting"):
            raise RuntimeError("Telegram bot not running")
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=timeout)

    def send_reply(self, payload: dict) -> SendResult:
        text = payload.get("text", "")
        parse_mode = payload.get("parse_mode") or payload.get("parseMode") or None
        target = self._outbound_chat_id(payload.get("channel"))
        if not self.is_running() or not target:
            return {"error": "Telegram not configured", "_http_status": 400}
        try:
            self._run_coro(
                self._app_instance.bot.send_message(  # type: ignore[union-attr]
                    chat_id=target, text=text, parse_mode=parse_mode
                )
            )
            return {"status": "ok"}
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    def send_update(self, payload: dict) -> SendResult:
        """Telegram uses sendMessageDraft for streaming updates (no chat.update)."""
        raw_draft_id = payload.get("draft_id") if "draft_id" in payload else payload.get("draftId")
        text = payload.get("text", "") or ""
        parse_mode = payload.get("parse_mode") or payload.get("parseMode") or None
        try:
            draft_id = int(raw_draft_id) if raw_draft_id is not None else 0
        except (TypeError, ValueError):
            return {"error": "draft_id must be a non-zero integer", "_http_status": 400}
        if draft_id == 0:
            return {"error": "draft_id must be a non-zero integer", "_http_status": 400}
        target = self._outbound_chat_id()
        if not self.is_running() or not target:
            return {"error": "Telegram not configured", "_http_status": 400}
        try:
            chat_id_int = int(target)
        except (TypeError, ValueError):
            return {"error": "Configured chat id is not numeric", "_http_status": 400}
        try:
            self._run_coro(
                self._app_instance.bot.send_message_draft(  # type: ignore[union-attr]
                    chat_id=chat_id_int,
                    draft_id=draft_id,
                    text=text,
                    parse_mode=parse_mode,
                )
            )
            return {"status": "ok"}
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    def send_photo(self, payload: dict) -> SendResult:
        photo_b64 = payload.get("photo", "") or payload.get("imageBase64", "")
        caption = payload.get("caption", "")
        target = self._outbound_chat_id(payload.get("channel"))
        if not self.is_running() or not target:
            return {"error": "Telegram not configured", "_http_status": 400}
        try:
            photo_bytes = base64.b64decode(photo_b64)
            self._run_coro(
                self._app_instance.bot.send_photo(  # type: ignore[union-attr]
                    chat_id=target,
                    photo=photo_bytes,
                    caption=caption or None,
                ),
                timeout=120,
            )
            return {"status": "ok"}
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    def send_video(self, payload: dict) -> SendResult:
        video_b64 = payload.get("video", "") or payload.get("videoBase64", "")
        caption = payload.get("caption", "")
        target = self._outbound_chat_id(payload.get("channel"))
        if not self.is_running() or not target:
            return {"error": "Telegram not configured", "_http_status": 400}
        try:
            video_bytes = base64.b64decode(video_b64)
            self._run_coro(
                self._app_instance.bot.send_video(  # type: ignore[union-attr]
                    chat_id=target,
                    video=video_bytes,
                    caption=caption or None,
                    supports_streaming=True,
                ),
                timeout=180,
            )
            return {"status": "ok"}
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    def send_voice(self, payload: dict) -> SendResult:
        audio_b64 = payload.get("audio", "") or payload.get("audioBase64", "")
        mime = (payload.get("mime") or "").lower()
        target = self._outbound_chat_id(payload.get("channel"))
        if not self.is_running() or not target:
            return {"error": "Telegram not configured", "_http_status": 400}
        try:
            from .audio import is_ogg_opus, to_ogg_opus

            audio_bytes = base64.b64decode(audio_b64)
            # Telegram only renders a real voice bubble for OGG/Opus. TTS servers
            # return WAV, so transcode here (PyAV bundles FFmpeg + libopus). If
            # transcoding is unavailable/fails, fall back to a playable audio file.
            voice_bytes: bytes | None = audio_bytes if is_ogg_opus(mime) else None
            if voice_bytes is None:
                try:
                    voice_bytes = to_ogg_opus(audio_bytes)
                except Exception as exc:  # noqa: BLE001 - best-effort transcode
                    logger.warning("Opus transcode failed, sending as audio file: %s", exc)
            if voice_bytes is not None:
                self._run_coro(
                    self._app_instance.bot.send_voice(  # type: ignore[union-attr]
                        chat_id=target,
                        voice=voice_bytes,
                    ),
                    timeout=180,
                )
            else:
                self._run_coro(
                    self._app_instance.bot.send_audio(  # type: ignore[union-attr]
                        chat_id=target,
                        audio=audio_bytes,
                    ),
                    timeout=180,
                )
            return {"status": "ok"}
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    def send_document(self, payload: dict) -> SendResult:
        doc_b64 = payload.get("document", "") or payload.get("documentBase64", "")
        filename = payload.get("filename") or "file.bin"
        caption = payload.get("caption", "")
        target = self._outbound_chat_id(payload.get("channel"))
        if not self.is_running() or not target:
            return {"error": "Telegram not configured", "_http_status": 400}
        try:
            from telegram import InputFile

            doc_bytes = base64.b64decode(doc_b64)
            # Wrap in InputFile so Telegram clients show the real filename
            # (e.g. model.glb) instead of a random hash.
            input_file = InputFile(io.BytesIO(doc_bytes), filename=filename)
            self._run_coro(
                self._app_instance.bot.send_document(  # type: ignore[union-attr]
                    chat_id=target,
                    document=input_file,
                    caption=caption or None,
                ),
                timeout=180,
            )
            return {"status": "ok"}
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    def send_typing(self, payload: dict) -> SendResult:
        action = payload.get("action") or "typing"
        target = self._outbound_chat_id()
        if not self.is_running() or not target:
            return {"error": "Telegram not configured", "_http_status": 400}
        try:
            self._run_coro(
                self._app_instance.bot.send_chat_action(chat_id=target, action=action)  # type: ignore[union-attr]
            )
            return {"status": "ok"}
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    def send_keyboard(self, payload: dict) -> SendResult:
        from telegram import InlineKeyboardButton, InlineKeyboardMarkup

        text = payload.get("text", "")
        parse_mode = payload.get("parse_mode") or payload.get("parseMode") or None
        rows = payload.get("buttons", []) or []
        target = self._outbound_chat_id(payload.get("channel"))
        if not self.is_running() or not target:
            return {"error": "Telegram not configured", "_http_status": 400}
        try:
            keyboard = [
                [
                    InlineKeyboardButton(
                        text=str(btn.get("text", "")),
                        callback_data=str(btn.get("callback_data") or btn.get("callbackData") or ""),
                    )
                    for btn in row
                ]
                for row in rows
            ]
            markup = InlineKeyboardMarkup(keyboard) if keyboard else None
            self._run_coro(
                self._app_instance.bot.send_message(  # type: ignore[union-attr]
                    chat_id=target,
                    text=text,
                    parse_mode=parse_mode,
                    reply_markup=markup,
                )
            )
            return {"status": "ok"}
        except Exception as exc:
            return {"error": str(exc), "_http_status": 500}

    # ── Channel protocol: logging ────────────────────────────────────────
    def redaction_patterns(self) -> Iterable[re.Pattern[str]]:
        return (_TELEGRAM_TOKEN_RE,)

    # ── Bot lifecycle implementation ─────────────────────────────────────
    def _record_authorized_chat_id(self, chat_id: str) -> None:
        """Update last-seen + persist on disk only when the incoming chat is
        authorized — same logic as the original `_record_authorized_chat_id`.
        """
        allow = self._allowed_chat_id
        if allow and chat_id != allow:
            return
        if self._last_seen_chat_id != chat_id:
            self._last_seen_chat_id = chat_id
            self.persist_identity(chat_id)

    def _run_bot(self, token: str, initial_chat_id: str) -> None:
        """Run the bot in its own asyncio loop (this runs in a daemon thread)."""
        from telegram import Update
        from telegram.ext import Application, MessageHandler, filters, ContextTypes

        self._token = token
        self._allowed_chat_id = (initial_chat_id or "").strip()
        self._bot_chat_id = self._allowed_chat_id

        async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
            if update.message is None:
                return
            chat_id = str(update.message.chat_id)
            allow = self._allowed_chat_id
            self._record_authorized_chat_id(chat_id)
            if not allow:
                logger.info(
                    "Detection mode: received message from chat_id=%s (not yet configured)", chat_id
                )
                return
            if chat_id != allow:
                logger.warning("Ignoring message from unauthorized chat_id: %s", chat_id)
                return
            user_text = update.message.text or ""
            logger.info(
                "Telegram message received: chat_id=%s message_id=%s length=%d",
                chat_id,
                update.message.message_id,
                len(user_text),
            )
            self.queue_append({"text": user_text, "chat_id": chat_id})

        def make_command_handler(command_name: str, full_text_builder=None):
            """Factory: build a /command handler that queues a uniform message.

            `full_text_builder` is called with `context.args` to assemble the
            queued text (defaults to `/<command_name>` for arg-less commands).
            """

            async def handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
                if update.message is None:
                    return
                chat_id = str(update.message.chat_id)
                allow = self._allowed_chat_id
                self._record_authorized_chat_id(chat_id)
                if not allow:
                    return
                if chat_id != allow:
                    logger.warning(
                        "Ignoring /%s from unauthorized chat_id: %s", command_name, chat_id
                    )
                    return
                args = context.args or []
                if full_text_builder is None:
                    full_text = f"/{command_name}"
                else:
                    full_text = full_text_builder(args)
                logger.info(
                    "Telegram /%s command received: chat_id=%s args=%r",
                    command_name,
                    chat_id,
                    args,
                )
                self.queue_append({"text": full_text, "chat_id": chat_id})

            return handler

        async def handle_imggen_callback(
            update: Update, context: ContextTypes.DEFAULT_TYPE
        ) -> None:
            cq = update.callback_query
            if cq is None or cq.message is None:
                return
            chat_id = str(cq.message.chat_id)
            allow = self._allowed_chat_id
            self._record_authorized_chat_id(chat_id)
            if allow and chat_id != allow:
                logger.warning("Ignoring imgGen callback from unauthorized chat_id: %s", chat_id)
                try:
                    await cq.answer()
                except Exception as exc:
                    logger.debug("imgGen unauthorized ack failed: %s", exc)
                return
            data = cq.data or ""
            try:
                await cq.answer()
            except Exception as exc:
                logger.warning("Failed to ack imgGen callback_query: %s", exc)
            if not data.startswith("imgGen:"):
                return
            logger.info("Telegram imgGen callback: chat_id=%s data=%r", chat_id, data)
            self.queue_append({"chat_id": chat_id, "callback": data})

        async def handle_load_callback(
            update: Update, context: ContextTypes.DEFAULT_TYPE
        ) -> None:
            cq = update.callback_query
            if cq is None or cq.message is None:
                return
            chat_id = str(cq.message.chat_id)
            allow = self._allowed_chat_id
            self._record_authorized_chat_id(chat_id)
            if allow and chat_id != allow:
                logger.warning("Ignoring callback from unauthorized chat_id: %s", chat_id)
                try:
                    await cq.answer()
                except Exception as exc:
                    logger.debug("loadConv unauthorized ack failed: %s", exc)
                return
            data = cq.data or ""
            try:
                await cq.answer()
            except Exception as exc:
                logger.warning("Failed to ack callback_query: %s", exc)
            if not data.startswith("loadConv:"):
                return
            key = data[len("loadConv:"):]
            full_text = f"/load {key}".strip()
            logger.info("Telegram load-menu callback: chat_id=%s key=%r", chat_id, key)
            self.queue_append({"text": full_text, "chat_id": chat_id})

        async def handle_photo(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
            if update.message is None or not update.message.photo:
                return
            chat_id = str(update.message.chat_id)
            allow = self._allowed_chat_id
            self._record_authorized_chat_id(chat_id)
            if not allow:
                logger.info(
                    "Detection mode: received photo from chat_id=%s (not yet configured)", chat_id
                )
                return
            if chat_id != allow:
                logger.warning("Ignoring photo from unauthorized chat_id: %s", chat_id)
                return
            photo = update.message.photo[-1]
            try:
                tg_file = await context.bot.get_file(photo.file_id)
                raw = await tg_file.download_as_bytearray()
            except Exception as exc:
                logger.error("Failed to download Telegram photo: %s", exc)
                return

            data_b64 = base64.b64encode(bytes(raw)).decode("ascii")
            caption = update.message.caption or ""
            text_payload = caption if caption else "[image]"
            logger.info(
                "Telegram photo received: chat_id=%s message_id=%s caption_len=%d size_bytes=%d",
                chat_id,
                update.message.message_id,
                len(caption),
                len(raw),
            )
            self.queue_append(
                {
                    "text": text_payload,
                    "chat_id": chat_id,
                    "images": [{"mime": "image/jpeg", "data_base64": data_b64}],
                }
            )

        async def handle_voice(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
            if update.message is None:
                return
            # Voice notes (OGG/Opus) and uploaded audio files both land here.
            voice = update.message.voice
            audio = update.message.audio
            media = voice or audio
            if media is None:
                return
            chat_id = str(update.message.chat_id)
            allow = self._allowed_chat_id
            self._record_authorized_chat_id(chat_id)
            if not allow:
                logger.info(
                    "Detection mode: received audio from chat_id=%s (not yet configured)", chat_id
                )
                return
            if chat_id != allow:
                logger.warning("Ignoring audio from unauthorized chat_id: %s", chat_id)
                return
            try:
                tg_file = await context.bot.get_file(media.file_id)
                raw = await tg_file.download_as_bytearray()
            except Exception as exc:
                logger.error("Failed to download Telegram audio: %s", exc)
                return

            data_b64 = base64.b64encode(bytes(raw)).decode("ascii")
            # Telegram voice notes are OGG/Opus; uploaded audio carries its own mime.
            mime = getattr(media, "mime_type", None) or "audio/ogg"
            caption = update.message.caption or ""
            logger.info(
                "Telegram audio received: chat_id=%s message_id=%s mime=%s size_bytes=%d",
                chat_id,
                update.message.message_id,
                mime,
                len(raw),
            )
            self.queue_append(
                {
                    "text": caption,
                    "chat_id": chat_id,
                    "audio": [{"mime": mime, "data_base64": data_b64}],
                }
            )

        async def handle_document(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
            if update.message is None or update.message.document is None:
                return
            doc = update.message.document
            chat_id = str(update.message.chat_id)
            allow = self._allowed_chat_id
            self._record_authorized_chat_id(chat_id)
            if not allow:
                logger.info(
                    "Detection mode: received document from chat_id=%s (not yet configured)",
                    chat_id,
                )
                return
            if chat_id != allow:
                logger.warning("Ignoring document from unauthorized chat_id: %s", chat_id)
                return

            filename = doc.file_name or "document"
            ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
            if ext not in _SUPPORTED_DOC_EXTENSIONS:
                try:
                    await update.message.reply_text(
                        "Unsupported document type. Send a "
                        f"{', '.join(_SUPPORTED_DOC_EXTENSIONS)} file to add it to the "
                        "knowledge base."
                    )
                except Exception:
                    pass
                return
            if doc.file_size and doc.file_size > _MAX_DOC_BYTES:
                try:
                    await update.message.reply_text(
                        "That document is too large to add to the knowledge base."
                    )
                except Exception:
                    pass
                return
            try:
                tg_file = await context.bot.get_file(doc.file_id)
                raw = await tg_file.download_as_bytearray()
            except Exception as exc:
                logger.error("Failed to download Telegram document: %s", exc)
                return

            data_b64 = base64.b64encode(bytes(raw)).decode("ascii")
            mime = doc.mime_type or "application/octet-stream"
            caption = update.message.caption or ""
            logger.info(
                "Telegram document received: chat_id=%s message_id=%s name=%s size_bytes=%d",
                chat_id,
                update.message.message_id,
                filename,
                len(raw),
            )
            self.queue_append(
                {
                    "text": caption,
                    "chat_id": chat_id,
                    "documents": [
                        {"filename": filename, "mime": mime, "data_base64": data_b64}
                    ],
                }
            )

        async def run() -> None:
            from telegram import BotCommand
            from telegram.ext import CallbackQueryHandler, CommandHandler

            self._loop = asyncio.get_event_loop()
            self._shutdown_event = asyncio.Event()
            application = Application.builder().token(token).build()
            self._app_instance = application
            application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
            application.add_handler(MessageHandler(filters.PHOTO, handle_photo))
            application.add_handler(MessageHandler(filters.VOICE | filters.AUDIO, handle_voice))
            application.add_handler(MessageHandler(filters.Document.ALL, handle_document))
            # CommandHandler matches case-sensitively and Telegram's setMyCommands
            # menu entries must be lowercase, so we register both spellings for
            # /imgGen to keep the historical text trigger working and surface a
            # lowercase autocomplete entry.
            application.add_handler(
                CommandHandler(
                    ["imggen", "imgGen"],
                    make_command_handler(
                        "imgGen", lambda args: f"/imgGen {' '.join(args)}".strip()
                    ),
                )
            )
            application.add_handler(CommandHandler("help", make_command_handler("help")))
            application.add_handler(CommandHandler("start", make_command_handler("help")))
            application.add_handler(
                CommandHandler(
                    "chat",
                    make_command_handler("chat", lambda args: f"/chat {' '.join(args)}".strip()),
                )
            )
            application.add_handler(CommandHandler("cancel", make_command_handler("cancel")))
            application.add_handler(CommandHandler("new", make_command_handler("new")))
            application.add_handler(CommandHandler("history", make_command_handler("history")))
            application.add_handler(
                CommandHandler(
                    "load",
                    make_command_handler("load", lambda args: f"/load {' '.join(args)}".strip()),
                )
            )
            application.add_handler(
                CallbackQueryHandler(handle_load_callback, pattern=r"^loadConv:")
            )
            application.add_handler(
                CallbackQueryHandler(handle_imggen_callback, pattern=r"^imgGen:")
            )
            await application.initialize()
            await application.start()
            await application.bot.delete_webhook(drop_pending_updates=False)

            try:
                await application.bot.set_my_commands(
                    [
                        BotCommand("help", "Show available commands"),
                        BotCommand("chat", "Force a text chat reply (no image generation)"),
                        BotCommand("imggen", "Pick a preset and generate an image"),
                        BotCommand("cancel", "Cancel a pending image-generation prompt"),
                        BotCommand("new", "Start a new Home Agent chat thread"),
                        BotCommand("history", "List your saved Home Agent chats"),
                        BotCommand("load", "Resume a chat (no id = pick from menu)"),
                    ]
                )
                logger.info("Registered Telegram bot command menu")
            except Exception as exc:
                logger.warning("Failed to register Telegram command menu: %s", exc)

            # Pre-populate chat ID from any pending updates before polling starts,
            # then acknowledge them so start_polling does not re-deliver them.
            try:
                updates = await application.bot.get_updates(limit=100, timeout=0)
                if updates:
                    cid = next(
                        (str(u.message.chat_id) for u in updates if u.message),
                        None,
                    )
                    if cid:
                        self._last_seen_chat_id = cid
                        self.persist_identity(cid)
                        logger.info("Pre-populated chat_id from pending updates: %s", cid)
                    highest_update_id = max(u.update_id for u in updates)
                    await application.bot.get_updates(
                        offset=highest_update_id + 1, limit=1, timeout=0
                    )
                    logger.info("Acknowledged updates up to update_id=%d", highest_update_id)
                if not self._last_seen_chat_id:
                    self._last_seen_chat_id = self.load_persisted_identity()
            except Exception as exc:
                logger.warning("Could not pre-populate chat_id: %s", exc)

            await application.updater.start_polling(drop_pending_updates=False)
            try:
                await self._shutdown_event.wait()
            finally:
                try:
                    await application.updater.stop()
                except Exception as exc:
                    logger.warning("application.updater.stop() failed: %s", exc)
                try:
                    await application.stop()
                except Exception as exc:
                    logger.warning("application.stop() failed: %s", exc)
                try:
                    await application.shutdown()
                except Exception as exc:
                    logger.warning("application.shutdown() failed: %s", exc)

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        try:
            loop.run_until_complete(run())
        except Exception as exc:
            logger.error("Telegram bot crashed: %s", exc)
        finally:
            self._app_instance = None
            self._loop = None
            self._shutdown_event = None
            try:
                loop.close()
            except Exception:
                pass
