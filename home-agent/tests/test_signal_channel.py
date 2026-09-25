"""Regression tests for the Signal channel and the send dispatcher.

Stdlib only (mirroring `service/tests`), so it runs with:

    python -m unittest discover -s home-agent/tests

signal-cli is a heavy external binary, so — unlike the local-web tests which
speak real HTTP — these tests inject a fake JSON-RPC client and a fake daemon
process, exercising the message shaping / dispatch without launching anything.
"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from channels.actions import SEND_ACTIONS, send_method_name
from channels.signal import SignalChannel


class _FakeProc:
    """Stands in for the signal-cli Popen: always 'alive'."""

    def poll(self):
        return None


class _FakeRpc:
    """Records JSON-RPC calls and returns a canned send result."""

    def __init__(self):
        self.calls = []

    def call(self, method, params=None, timeout=None):
        self.calls.append((method, params or {}))
        return {"timestamp": 1700000000000}


class SignalChannelTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.channel = SignalChannel(Path(self._tmp.name))
        # Fake a running daemon + linked account + allowed contact.
        self.rpc = _FakeRpc()
        self.channel._rpc = self.rpc
        self.channel._proc = _FakeProc()
        self.channel._account = "+15550000001"
        self.channel._allowed_peer = "+15550000002"

    def tearDown(self):
        self._tmp.cleanup()

    def test_every_send_action_resolves_to_a_method(self):
        # Mirrors the local-web dispatch test: every action the renderer can
        # send must resolve to a callable on the Signal channel — except
        # `history`, the LAN-web-only transcript repaint (Signal keeps native
        # history, so the route 404s gracefully, like Slack).
        for action in SEND_ACTIONS:
            if action == "history":
                continue
            name = send_method_name(action)
            self.assertIsNotNone(name, action)
            self.assertTrue(
                callable(getattr(self.channel, name, None)),
                f"Signal channel missing {name} for action {action}",
            )

    def test_reply_sends_to_the_allowed_peer(self):
        result = self.channel.send_reply({"text": "hello"})
        self.assertEqual(result.get("status"), "ok")
        method, params = self.rpc.calls[-1]
        self.assertEqual(method, "send")
        self.assertEqual(params["recipient"], ["+15550000002"])
        self.assertEqual(params["account"], "+15550000001")
        self.assertEqual(params["message"], "hello")

    def test_keyboard_renders_as_numbered_text(self):
        result = self.channel.send_keyboard(
            {
                "text": "Pick a preset",
                "buttons": [
                    [{"text": "Flux"}, {"text": "SDXL"}],
                    [{"text": "Cancel"}],
                ],
            }
        )
        self.assertEqual(result.get("status"), "ok")
        _method, params = self.rpc.calls[-1]
        self.assertEqual(
            params["message"], "Pick a preset\n1. Flux\n2. SDXL\n3. Cancel"
        )

    def test_update_is_a_noop(self):
        # Signal has no ephemeral draft; update must not hit the wire.
        result = self.channel.send_update({"text": "partial"})
        self.assertEqual(result.get("status"), "skipped")
        self.assertEqual(self.rpc.calls, [])

    def test_inbound_data_message_is_queued(self):
        self.channel._on_receive(
            {
                "envelope": {
                    "sourceNumber": "+15550000002",
                    "dataMessage": {"message": "hi there"},
                }
            }
        )
        queued = self.channel.poll()
        self.assertEqual(len(queued), 1)
        self.assertEqual(queued[0]["text"], "hi there")
        self.assertEqual(queued[0]["chat_id"], "+15550000002")
        self.assertEqual(queued[0]["channel"], "signal")

    def test_inbound_from_unauthorized_number_is_ignored(self):
        self.channel._on_receive(
            {
                "envelope": {
                    "sourceNumber": "+19999999999",
                    "dataMessage": {"message": "let me in"},
                }
            }
        )
        self.assertEqual(self.channel.poll(), [])

    def test_unknown_command_is_404(self):
        result = self.channel.channel_command("bogus", {})
        self.assertEqual(result.get("_http_status"), 404)


if __name__ == "__main__":
    unittest.main()
