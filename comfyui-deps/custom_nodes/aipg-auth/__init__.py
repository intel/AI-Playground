"""
AI Playground loopback auth middleware for ComfyUI.

This custom_node ships with AI Playground (NOT a ComfyUI extension intended
for general consumption) and registers an aiohttp middleware on the running
PromptServer that requires every request to carry one of:

  * `Authorization: Bearer <AIPG_LOOPBACK_TOKEN>` header  (renderer → ComfyUI)
  * `?token=<AIPG_LOOPBACK_TOKEN>` query parameter       (WebSocket / handoff)
  * `aipg_session=<random>` cookie                        (browser tab post-handoff)

Without this middleware every local process on the box (including low-IL
processes and host-networked containers) can hit ComfyUI's API on
127.0.0.1:<port> and trigger code execution via custom-node install or
Manager endpoints. See CWE-494 / the AI Playground security advisory for
the matching ai-backend fix.

The middleware also validates the `Host:` header to guard against DNS
rebinding attacks even if other layers fail.

A handoff route at `GET /aipg/launch?launch_token=<env token>` validates the
env token and sets a `Set-Cookie: aipg_session=<random>; HttpOnly;
SameSite=Strict; Path=/` so the user's default browser (opened via the
"Open ComfyUI" button in AI Playground's settings) can drive the full
ComfyUI UI without re-authenticating.
"""

from . import middleware  # noqa: F401  (side effect: register middleware/route)

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
