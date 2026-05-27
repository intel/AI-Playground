"""
aiohttp middleware + handoff route for AI Playground's ComfyUI hardening.

Reads the per-launch token from `AIPG_LOOPBACK_TOKEN` (set by AI Playground's
Electron main process when spawning ComfyUI). All requests must present that
token via Bearer header, ?token= query, or a session cookie issued by the
/aipg/launch handoff route.
"""

from __future__ import annotations

import hmac
import logging
import os
import secrets
from typing import Set

from aiohttp import web

import server  # type: ignore[import-not-found]


_LOG = logging.getLogger("aipg-auth")

# Per-launch loopback auth token, provisioned by AI Playground.
# Empty string means: AI Playground did not provision a token (e.g. user
# launched ComfyUI manually) -> deny everything except health.
_TOKEN: str = os.environ.get("AIPG_LOOPBACK_TOKEN", "")

# Active session cookies. Reset on every ComfyUI process start (the set lives
# only in memory) so a leaked cookie cannot survive a restart.
_SESSIONS: Set[str] = set()

# Endpoints reachable without auth:
# - /queue is used by AI Playground's service registry as a health check
#   (see WebUI/electron/subprocesses/comfyUIBackendService.ts healthEndpointUrl).
# - /aipg/launch is the token-handoff route below.
# - / and /index.html are deliberately NOT exempt; an unauthenticated browser
#   visit redirects to /aipg/login (a friendly "open this from AI Playground"
#   page) instead of returning a 401 JSON blob.
_AUTH_EXEMPT_EXACT: Set[str] = {"/queue", "/aipg/launch", "/aipg/login"}

# Loopback host names accepted in the Host header. ComfyUI binds to
# 127.0.0.1 by default; we also accept localhost / IPv6 loopback variants.
_LOOPBACK_HOSTS: Set[str] = {"127.0.0.1", "localhost", "::1", "[::1]"}

_COOKIE_NAME = "aipg_session"


def _is_loopback_host(host_header: str) -> bool:
    """Validate a Host: header value is a loopback host (port-agnostic)."""
    if not host_header:
        return False
    # Strip port. IPv6 hosts come bracketed: `[::1]:1234`.
    if host_header.startswith("["):
        end = host_header.find("]")
        if end < 0:
            return False
        host = host_header[: end + 1]
    else:
        host = host_header.split(":", 1)[0]
    return host in _LOOPBACK_HOSTS


def _is_loopback_origin(origin: str) -> bool:
    """True for `null`, `file://...`, or any http(s) URL whose host is a
    loopback host. Used to decide whether we are willing to echo the
    request Origin back as Access-Control-Allow-Origin."""
    if not origin:
        return False
    if origin == "null":
        return True
    if origin.startswith("file://"):
        return True
    for scheme in ("http://", "https://"):
        if origin.startswith(scheme):
            rest = origin[len(scheme) :]
            rest = rest.split("/", 1)[0]
            if rest.startswith("["):
                end = rest.find("]")
                if end < 0:
                    return False
                host = rest[: end + 1]
            else:
                host = rest.split(":", 1)[0]
            return host in _LOOPBACK_HOSTS
    return False


def _is_static_asset(path: str) -> bool:
    """ComfyUI's UI loads many static assets that should not redirect to a
    login page on a misauthenticated browser hit; let them through so the
    /aipg/login HTML page itself can render."""
    if path == "/favicon.ico":
        return True
    for suffix in (".css", ".css.map", ".js", ".js.map", ".ico", ".png", ".svg", ".woff", ".woff2"):
        if path.endswith(suffix):
            return True
    return False


def _validate_token(provided: str) -> bool:
    if not _TOKEN or not provided:
        return False
    return hmac.compare_digest(provided, _TOKEN)


def _validate_cookie(cookie_value: str) -> bool:
    if not cookie_value:
        return False
    # Constant-time compare against each known session.
    matched = False
    for session in _SESSIONS:
        if hmac.compare_digest(session, cookie_value):
            matched = True
            # Don't break — keep timing constant across the set.
    return matched


def _apply_dynamic_cors(request: web.Request, response: web.StreamResponse) -> None:
    """Override the static `Access-Control-Allow-Origin` set by ComfyUI's
    cors_middleware with a dynamic value that echoes the request Origin
    when it is a loopback origin.

    Background: ComfyUI's `--enable-cors-header X` installs a middleware
    that sets `Access-Control-Allow-Origin: X` to a fixed string. AI
    Playground's renderer can be loaded via `http://127.0.0.1:25413`,
    `http://localhost:25413`, or `file://` depending on dev/prod and
    devtools, so a fixed value mismatches in some cases. This callback
    rewrites the header on the way out for any loopback origin we trust.
    """
    origin = request.headers.get("Origin", "")
    if origin and _is_loopback_origin(origin):
        response.headers["Access-Control-Allow-Origin"] = origin
        # Make sure the Allow-Headers list includes everything our renderer
        # actually sends. ComfyUI ships `Content-Type, Authorization` which
        # already covers the renderer fetch path; harmless to restate.
        response.headers["Access-Control-Allow-Headers"] = (
            "Content-Type, Authorization, X-AIPG-Auth"
        )
        existing_vary = response.headers.get("Vary", "")
        if existing_vary:
            if "Origin" not in existing_vary.split(","):
                response.headers["Vary"] = f"{existing_vary}, Origin"
        else:
            response.headers["Vary"] = "Origin"


@web.middleware
async def aipg_auth_middleware(request: web.Request, handler):
    # 1. Host header validation (DNS-rebinding hardening).
    host_header = request.headers.get("Host", "")
    if not _is_loopback_host(host_header):
        _LOG.warning(
            "rejecting request with non-loopback Host header %r to %s",
            host_header,
            request.path,
        )
        return web.json_response({"error": "loopback only"}, status=403)

    # 2. CORS preflight requests do not carry auth headers. Let the inner
    # cors_middleware short-circuit OPTIONS with the correct
    # Access-Control-Allow-Methods/Headers, and we override the Origin on
    # the way out below.
    if request.method == "OPTIONS":
        response = await handler(request)
        _apply_dynamic_cors(request, response)
        return response

    # 3. Allow always-public exempt endpoints (still subject to dynamic CORS).
    if request.path in _AUTH_EXEMPT_EXACT or _is_static_asset(request.path):
        response = await handler(request)
        _apply_dynamic_cors(request, response)
        return response

    # 4. Refuse if we have no provisioned token.
    if not _TOKEN:
        _LOG.warning(
            "AIPG_LOOPBACK_TOKEN is not set; rejecting %s %s",
            request.method,
            request.path,
        )
        response = web.json_response(
            {"error": "ComfyUI must be launched via AI Playground"}, status=503
        )
        _apply_dynamic_cors(request, response)
        return response

    authenticated = False
    # 5. Authorization: Bearer <token>
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        if _validate_token(auth_header[len("Bearer ") :]):
            authenticated = True

    # 6. ?token=<token>
    if not authenticated:
        query_token = request.rel_url.query.get("token", "")
        if query_token and _validate_token(query_token):
            authenticated = True

    # 7. Session cookie set by /aipg/launch.
    if not authenticated:
        cookie_value = request.cookies.get(_COOKIE_NAME, "")
        if _validate_cookie(cookie_value):
            authenticated = True

    if authenticated:
        response = await handler(request)
        _apply_dynamic_cors(request, response)
        return response

    # 8. Unauthenticated. Redirect HTML requests to a friendly landing page,
    # JSON for anything else.
    accept = request.headers.get("Accept", "")
    if "text/html" in accept:
        raise web.HTTPFound("/aipg/login")
    response = web.json_response({"error": "unauthorized"}, status=401)
    _apply_dynamic_cors(request, response)
    return response


_LOGIN_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>AI Playground &mdash; ComfyUI</title>
  <style>
    body { font-family: -apple-system, Segoe UI, Roboto, sans-serif;
           background: #0e1117; color: #e6edf3;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; }
    .card { max-width: 32rem; padding: 2rem 2.5rem; background: #161b22;
            border: 1px solid #30363d; border-radius: 8px; line-height: 1.5; }
    h1 { margin-top: 0; font-size: 1.4rem; }
    code { background: #22272e; padding: 0.1rem 0.3rem; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>This ComfyUI instance is locked</h1>
    <p>Open ComfyUI from the AI Playground app:</p>
    <p><strong>Image Gen / Edit / Video Settings &rarr; Scroll Down &rarr; Open ComfyUI</strong></p>
    <p>That button issues a single-use launch token that this server
       exchanges for a session cookie in your browser. Bookmarking or sharing
       the URL won&rsquo;t work.</p>
  </div>
</body>
</html>
"""


def _register_routes(routes: web.RouteTableDef) -> None:
    @routes.get("/aipg/launch")
    async def _aipg_launch(request: web.Request):
        provided = request.rel_url.query.get("launch_token", "")
        if not _validate_token(provided):
            _LOG.warning("rejecting /aipg/launch with bad launch_token")
            raise web.HTTPFound("/aipg/login")
        session_id = secrets.token_urlsafe(32)
        _SESSIONS.add(session_id)
        # Bound the in-memory session set. Cap is generous; sessions don't
        # expire on their own (process restart wipes the set). 256 keeps
        # memory trivial while still tolerating many "Open ComfyUI" clicks.
        if len(_SESSIONS) > 256:
            # Drop one arbitrary old session to keep the cap.
            _SESSIONS.pop()
            _SESSIONS.add(session_id)
        response = web.HTTPFound("/")
        # Secure=False because ComfyUI runs over plain http on loopback.
        # SameSite=Strict + HttpOnly + Path=/ block cross-site abuse.
        response.set_cookie(
            _COOKIE_NAME,
            session_id,
            httponly=True,
            samesite="Strict",
            path="/",
        )
        return response

    @routes.get("/aipg/login")
    async def _aipg_login(_request: web.Request):
        return web.Response(
            text=_LOGIN_HTML,
            content_type="text/html",
            headers={"Cache-Control": "no-store"},
        )


def _install() -> None:
    prompt_server = getattr(server, "PromptServer", None)
    if prompt_server is None:
        _LOG.error("server.PromptServer not available; aipg-auth NOT installed")
        return
    instance = getattr(prompt_server, "instance", None)
    if instance is None:
        _LOG.error("server.PromptServer.instance not available; aipg-auth NOT installed")
        return
    app_obj = getattr(instance, "app", None)
    routes = getattr(instance, "routes", None)
    if app_obj is None or routes is None:
        _LOG.error("PromptServer.instance.app/routes not available; aipg-auth NOT installed")
        return

    if any(getattr(m, "_aipg_auth", False) for m in app_obj.middlewares):
        # Already installed (re-import on hot reload); skip.
        return

    setattr(aipg_auth_middleware, "_aipg_auth", True)
    # Install at index 0 (outermost) so we run BEFORE ComfyUI's
    # cors_middleware on responses. That lets us:
    #   - reject non-loopback Host headers before any other handler runs, and
    #   - override the static Access-Control-Allow-Origin with a per-request
    #     value that matches whatever loopback origin the renderer used
    #     (127.0.0.1 vs localhost vs file://).
    app_obj.middlewares.insert(0, aipg_auth_middleware)
    _register_routes(routes)
    if _TOKEN:
        _LOG.info("aipg-auth middleware installed (token provisioned via env)")
    else:
        _LOG.warning(
            "aipg-auth middleware installed but AIPG_LOOPBACK_TOKEN is empty; "
            "all non-/queue requests will be denied"
        )


_install()
