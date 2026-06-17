"""Channel registry package — see channels/base.py for the Channel protocol.

Each module under `channels/` implements a single chat-platform integration
(telegram, slack, …) behind the shared `Channel` interface. `registry.CHANNELS`
exposes them keyed by ChannelKind so `web_api.py` can dispatch generic routes
(`/channel/<kind>/...`) without knowing which platform is on the other side.
"""

from . import registry  # noqa: F401  (re-exported for callers doing `from channels import registry`)
