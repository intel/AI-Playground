"""Shared loopback + per-launch-token authentication for AI Playground's local
Python backends (ai-backend, home-agent, ...).

Each backend binds to 127.0.0.1, but on a shared host any local peer can still
reach the port. We therefore require requests to (a) originate from a loopback
address and (b) carry an `X-AIPG-Auth` header matching the per-launch token the
Electron main process injects via the `AIPG_LOOPBACK_TOKEN` env var. This is the
attack model documented in the CWE-494 report against the local API ports.

This module is intentionally transport-agnostic (no Flask/aiohttp import) and
stdlib-only, so it can be imported from every backend's isolated virtualenv. It
lives in a sibling `backend_shared/` directory that each backend adds to
`sys.path`; callers build their own HTTP response from the returned verdict.
"""

import hmac
import os
from collections.abc import Iterable

# Remote addresses we treat as loopback.
LOOPBACK_REMOTE_ADDRS = frozenset({"127.0.0.1", "::1"})

# Paths reachable without a token. `/healthy` must stay open so the Electron
# service registry can detect the service is up before it has the token.
DEFAULT_AUTH_EXEMPT_PATHS = frozenset({"/healthy"})


def get_loopback_token() -> str:
    """The per-launch token provisioned by the Electron main process (or "")."""
    return os.environ.get("AIPG_LOOPBACK_TOKEN", "")


def evaluate_loopback_auth(
    remote_addr: str | None,
    method: str,
    path: str,
    provided_token: str,
    *,
    expected_token: str,
    exempt_paths: Iterable[str] = DEFAULT_AUTH_EXEMPT_PATHS,
) -> tuple[int, str] | None:
    """Decide whether a request is allowed.

    Returns ``None`` when the request should be allowed to proceed, or a
    ``(status_code, error_message)`` tuple describing the rejection. CORS
    preflight (``OPTIONS``) requests pass the loopback check and then return
    ``None`` — the browser strips custom headers from preflight, so the caller
    is responsible for answering it (e.g. a 204) without requiring the token.
    The real request that follows is authenticated normally.
    """
    if remote_addr not in LOOPBACK_REMOTE_ADDRS:
        return 403, "loopback only"
    if method == "OPTIONS":
        return None
    if path in exempt_paths:
        return None
    if not expected_token:
        return 503, "service not provisioned"
    if not provided_token or not hmac.compare_digest(provided_token, expected_token):
        return 401, "unauthorized"
    return None
