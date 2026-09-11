"""Whisper (standalone) sidecar for AI Playground — OpenAI-compatible STT.

Serves POST /v1/audio/transcriptions so the frontend's shared transcribe helper
(@ai-sdk/openai `experimental_transcribe`) can hit it exactly like any other
OpenAI-compatible transcription server. Runs on torch (xpu/cuda/cpu), so it works
in every product mode including NVIDIA — no OpenVINO required.

Run: python web_api.py --port 56001
"""

from __future__ import annotations

import argparse
import hmac
import logging
import os

import transcription_engine as engine
from flask import Flask, jsonify, request
from flask_cors import CORS

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("whisper-backend")

app = Flask(__name__)
CORS(app)

_LOOPBACK_AUTH_TOKEN = os.environ.get("AIPG_LOOPBACK_TOKEN", "")
_LOOPBACK_REMOTE_ADDRS = frozenset({"127.0.0.1", "::1"})
_AUTH_EXEMPT_PATHS = frozenset({"/healthy"})


def _provided_token() -> str:
    """Accept the loopback token via X-AIPG-Auth or `Authorization: Bearer`.

    The AI SDK transcription client only sends `Authorization: Bearer <apiKey>`,
    so we accept that in addition to the X-AIPG-Auth header the other sidecars use.
    """
    header = request.headers.get("X-AIPG-Auth", "")
    if header:
        return header
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[len("bearer ") :].strip()
    return ""


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
    provided = _provided_token()
    if not provided or not hmac.compare_digest(provided, _LOOPBACK_AUTH_TOKEN):
        return jsonify({"error": "unauthorized"}), 401
    return None


@app.get("/healthy")
def healthy():
    return jsonify({"status": "ok"})


@app.get("/api/config")
def get_config():
    return jsonify({"code": 0, "data": {"status": engine.model_status()}})


@app.get("/v1/models")
def list_models():
    return jsonify(
        {"object": "list", "data": [{"id": engine.DEFAULT_MODEL_ID, "object": "model"}]}
    )


@app.post("/v1/audio/transcriptions")
def transcriptions():
    audio_file = request.files.get("file")
    if audio_file is None:
        return jsonify({"error": {"message": "file is required"}}), 400
    model = request.form.get("model") or engine.DEFAULT_MODEL_ID
    language = request.form.get("language")
    try:
        text = engine.transcribe(audio_file.read(), model, language)
        # OpenAI transcription JSON shape: {"text": "..."}.
        return jsonify({"text": text})
    # Broad on purpose: any engine failure is surfaced to the client as a 500 with
    # its message, rather than escaping as an opaque Flask error page.
    except Exception as exc:
        logger.exception("transcription failed")
        return jsonify({"error": {"message": str(exc)}}), 500


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=56001)
    args = parser.parse_args()
    app.run(host="127.0.0.1", port=args.port, threaded=True)


if __name__ == "__main__":
    main()
