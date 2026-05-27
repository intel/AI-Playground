"""
LLM proxy helper.

Forwards a Flask request to an upstream OpenAI-compatible /v1/chat/completions
endpoint, handling both streaming and non-streaming responses.
"""

import json
import logging
from typing import Iterator

import requests
from flask import Request, Response, jsonify, stream_with_context

logger = logging.getLogger(__name__)

# 10 s connect timeout for all upstream requests.
_CONNECT_TIMEOUT_S = 10
# Non-streaming requests cap the read at 5 minutes so a stalled upstream
# cannot block the proxy forever.
_NON_STREAM_READ_TIMEOUT_S = 300
# Streaming requests get a much larger but still finite read timeout. Long
# generations need room to breathe, but `None` would let a stalled upstream
# pin a Flask worker indefinitely.
_STREAM_READ_TIMEOUT_S = 600


def proxy_chat_completions(upstream_url: str, flask_request: Request) -> Response:
    """Forward flask_request to upstream_url/v1/chat/completions."""
    target = upstream_url.rstrip("/") + "/v1/chat/completions"

    body = flask_request.get_data()
    headers = {
        k: v
        for k, v in flask_request.headers
        if k.lower() not in ("host", "content-length", "x-upstream-url")
    }

    try:
        stream = json.loads(body).get("stream", False)
    except Exception:
        stream = False

    timeout = (
        (_CONNECT_TIMEOUT_S, _STREAM_READ_TIMEOUT_S)
        if stream
        else (_CONNECT_TIMEOUT_S, _NON_STREAM_READ_TIMEOUT_S)
    )
    try:
        upstream_resp = requests.post(
            target, data=body, headers=headers, stream=stream, timeout=timeout
        )
    except requests.exceptions.ConnectionError as exc:
        return jsonify({"error": f"Cannot reach upstream: {exc}"}), 502
    except Exception:
        # Log the full exception server-side, but return a generic message —
        # raw exception text can leak upstream hostnames or other internals
        # to the client.
        logger.exception("Upstream proxy request failed")
        return jsonify({"error": "proxy request failed"}), 500

    if stream:
        def generate() -> Iterator[bytes]:
            try:
                for chunk in upstream_resp.iter_content(chunk_size=None):
                    yield chunk
            finally:
                upstream_resp.close()

        return Response(
            stream_with_context(generate()),
            status=upstream_resp.status_code,
            content_type=upstream_resp.headers.get("Content-Type", "text/event-stream"),
        )

    return Response(
        upstream_resp.content,
        status=upstream_resp.status_code,
        content_type=upstream_resp.headers.get("Content-Type", "application/json"),
    )

