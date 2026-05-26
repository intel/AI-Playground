"""
LLM proxy helper.

Forwards a Flask request to an upstream OpenAI-compatible /v1/chat/completions
endpoint, handling both streaming and non-streaming responses.
"""

import json
from typing import Iterator

import requests
from flask import Request, Response, jsonify, stream_with_context


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

    try:
        upstream_resp = requests.post(
            target, data=body, headers=headers, stream=stream, timeout=(10, None)  # 10 s connect, no read timeout for streaming
        )
    except requests.exceptions.ConnectionError as exc:
        return jsonify({"error": f"Cannot reach upstream: {exc}"}), 502
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500

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

