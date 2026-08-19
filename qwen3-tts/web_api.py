"""
Qwen3-TTS sidecar for AI Playground — synthesizes speech for the agent tool.

Run: python web_api.py --port 57001
"""

from __future__ import annotations

import argparse
import base64
import hmac
import logging
import os
import threading

from flask import Flask, jsonify, request
from flask_cors import CORS
from tts_engine import (
    CUSTOM_VOICE_SPEAKERS,
    LANGUAGES,
    default_model_id,
    ensure_loaded,
    is_model_downloaded,
    model_status,
    synthesize_wav,
    voice_design_model_id,
)

app = Flask(__name__)
CORS(app)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

_LOOPBACK_AUTH_TOKEN = os.environ.get("AIPG_LOOPBACK_TOKEN", "")
_LOOPBACK_REMOTE_ADDRS = frozenset({"127.0.0.1", "::1"})
_AUTH_EXEMPT_PATHS = frozenset({"/healthy"})

_warmup_started = False


@app.before_request
def _enforce_loopback_and_auth():
    if request.remote_addr not in _LOOPBACK_REMOTE_ADDRS:
        return jsonify({"error": "loopback only"}), 403
    if request.method == "OPTIONS":
        return None
    if request.path in _AUTH_EXEMPT_PATHS:
        return None
    if not _LOOPBACK_AUTH_TOKEN:
        return jsonify({"error": "service not provisioned"}), 503
    provided = request.headers.get("X-AIPG-Auth", "")
    if not provided or not hmac.compare_digest(provided, _LOOPBACK_AUTH_TOKEN):
        return jsonify({"error": "unauthorized"}), 401
    return None


@app.get("/healthy")
def healthy():
    return jsonify({"status": "ok"})


@app.get("/api/config")
def get_config():
    return jsonify(
        {
            "code": 0,
            "data": {
                "customVoiceModel": default_model_id(),
                "voiceDesignModel": voice_design_model_id(),
                "speakers": CUSTOM_VOICE_SPEAKERS,
                "languages": LANGUAGES,
                "status": model_status(),
            },
        }
    )


@app.post("/api/load")
def load_model():
    """Load the model for a mode without generating audio.

    Lets the UI show a distinct "loading model" phase before the (separate)
    "generating audio" phase, since the load otherwise happens invisibly inside
    the first /api/synthesize call. Fast no-op when the model is already resident.
    """
    body = request.get_json(silent=True) or {}
    mode = body.get("mode", "custom_voice")
    if mode not in ("custom_voice", "voice_design"):
        return jsonify({"code": -1, "message": f"unsupported mode: {mode}"}), 400
    try:
        ensure_loaded(mode)
        return jsonify({"code": 0, "data": model_status()})
    except Exception as exc:
        logger.exception("model load failed")
        return jsonify({"code": -1, "message": str(exc)}), 500


@app.post("/api/synthesize")
def synthesize():
    body = request.get_json(silent=True) or {}
    text = body.get("text", "")
    language = body.get("language", "Auto")
    speaker = body.get("speaker", "Ryan")
    instruct = body.get("instruct")
    mode = body.get("mode", "custom_voice")
    if mode not in ("custom_voice", "voice_design"):
        return jsonify({"code": -1, "message": f"unsupported mode: {mode}"}), 400
    # Optional sampler seed: the client pins one per saved voice so the voice is
    # reproducible across generations. Clamped to a torch-safe non-negative int;
    # anything unparsable just means "unseeded".
    seed_raw = body.get("seed")
    try:
        seed = abs(int(seed_raw)) % (2**31) if seed_raw is not None else None
    except (TypeError, ValueError):
        seed = None
    try:
        wav_bytes, sample_rate = synthesize_wav(
            text=str(text),
            language=str(language),
            speaker=str(speaker),
            instruct=str(instruct) if instruct is not None else None,
            mode=mode,
            seed=seed,
        )
        encoded = base64.b64encode(wav_bytes).decode("ascii")
        return jsonify(
            {
                "code": 0,
                "data": {
                    "audioBase64": encoded,
                    "sampleRate": sample_rate,
                    "mediaType": "audio/wav",
                    "speaker": speaker,
                    "language": language,
                    "mode": mode,
                },
            }
        )
    except ValueError as exc:
        return jsonify({"code": -1, "message": str(exc)}), 400
    except Exception as exc:
        logger.exception("synthesis failed")
        return jsonify({"code": -1, "message": str(exc)}), 500


def _warmup_model():
    global _warmup_started
    if _warmup_started:
        return
    _warmup_started = True
    if os.environ.get("QWEN3_TTS_WARMUP", "1") != "1":
        return
    # Only warm up when the weights are already downloaded locally. Otherwise a
    # warmup would try to fetch the model — exactly the silent auto-download we
    # now replace with the explicit install popup (and HF is offline anyway).
    if not is_model_downloaded("custom_voice"):
        logger.info("Qwen3-TTS warmup skipped: model not downloaded yet")
        return

    def _run():
        try:
            synthesize_wav(
                text="Ready.",
                language="English",
                speaker="Ryan",
                instruct=None,
                mode="custom_voice",
            )
        except (ImportError, OSError, RuntimeError, ValueError):
            # Warmup is best-effort; the first real request retries the load.
            logger.warning(
                "Qwen3-TTS warmup failed (first user request will retry load)"
            )

    threading.Thread(target=_run, name="qwen3-tts-warmup", daemon=True).start()


def main():
    parser = argparse.ArgumentParser()
    # Default only matters when running the sidecar by hand; the Electron service always
    # passes --port from the 57000-57999 range it allocates (apiServiceRegistry.ts). The
    # previous default of 69001 is above the TCP maximum and silently wrapped to 3465.
    parser.add_argument("--port", type=int, default=57001)
    args = parser.parse_args()
    _warmup_model()
    app.run(host="127.0.0.1", port=args.port, threaded=True)


if __name__ == "__main__":
    main()
