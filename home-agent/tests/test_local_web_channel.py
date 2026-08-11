"""Regression tests for the local-web (LAN chat) channel and the send dispatcher.

Stdlib only (mirroring `service/tests`), so it runs with:

    python -m unittest discover -s home-agent/tests

The channel is a real HTTP server, so these tests speak real HTTP to it on
loopback rather than mocking the transport away — every case below is one that
was broken and reported by a browser or the setup screen, not by a unit boundary.
"""

import http.client
import json
import socket
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from channels import local_web
from channels.actions import SEND_ACTIONS, send_method_name
from channels.local_web import LocalWebChannel

PASSWORD = "correct horse"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class LocalWebChannelTestCase(unittest.TestCase):
    """Starts a real channel on a free port and tears it down again."""

    def setUp(self) -> None:
        self.port = free_port()
        self.channel = LocalWebChannel(Path(tempfile.mkdtemp()))
        self.assertEqual(
            self.channel.set_config({"password": PASSWORD, "port": str(self.port)}),
            {"status": "started"},
        )

    def tearDown(self) -> None:
        self.channel.request_shutdown()

    # ── helpers ───────────────────────────────────────────────────────────
    def request(self, method, path, body=None, cookie=None, headers=None, timeout=10):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        raw = json.dumps(body).encode() if body is not None else None
        hdrs = dict(headers or {})
        if raw is not None:
            hdrs.setdefault("Content-Type", "application/json")
            hdrs.setdefault("Content-Length", str(len(raw)))
        if cookie:
            hdrs["Cookie"] = cookie
        conn.request(method, path, body=raw, headers=hdrs)
        res = conn.getresponse()
        payload = res.read().decode()
        out = (
            res.status,
            payload,
            res.getheader("Set-Cookie"),
            res.getheader("Connection"),
        )
        conn.close()
        return out

    def login(self, password=PASSWORD):
        status, _, set_cookie, _ = self.request(
            "POST", "/api/login", {"password": password}
        )
        return status, (set_cookie.split(";")[0] if set_cookie else None)

    def open_sse(self, cookie):
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        sock.sendall(
            b"GET /api/events HTTP/1.1\r\nHost: x\r\nCookie: "
            + cookie.encode()
            + b"\r\n\r\n"
        )
        return sock

    @staticmethod
    def sse_events(raw: str):
        return [
            json.loads(line[5:])
            for line in raw.splitlines()
            if line.startswith("data:")
        ]


class TestRestart(LocalWebChannelTestCase):
    def test_changing_the_password_rebinds_the_same_port(self):
        # The rebind used to race the previous server's socket close and fail with
        # EADDRINUSE, leaving the chat down and the wizard showing
        # "could not bind port".
        for password in ("second one", "third one", "fourth one"):
            self.assertEqual(
                self.channel.set_config({"password": password, "port": str(self.port)}),
                {"status": "started"},
                "restarting on the same port must succeed",
            )
        self.assertTrue(self.channel.is_running())
        self.assertEqual(self.login("fourth one")[0], 200)
        self.assertEqual(
            self.login("correct horse")[0], 401, "old password must stop working"
        )

    def test_toggling_lan_access_restarts_and_an_unchanged_config_does_not(self):
        changed = {"password": PASSWORD, "port": str(self.port), "allowLan": "true"}
        self.assertEqual(self.channel.set_config(changed), {"status": "started"})
        self.assertEqual(
            self.channel.set_config(changed), {"status": "already_running"}
        )

    def test_a_restart_invalidates_existing_sessions(self):
        _, cookie = self.login()
        self.assertIsNotNone(cookie)
        self.channel.set_config({"password": "brand new", "port": str(self.port)})
        status, _, _, _ = self.request(
            "POST", "/api/chat", {"text": "hi"}, cookie=cookie
        )
        self.assertEqual(status, 401)


class TestLoginThrottling(LocalWebChannelTestCase):
    def test_repeated_failures_lock_the_source_address_out(self):
        # Unthrottled, this route served ~2300 guesses/s to the whole LAN.
        statuses = [
            self.login(f"guess {i}")[0]
            for i in range(local_web._LOGIN_MAX_FAILURES + 3)
        ]
        self.assertIn(401, statuses)
        self.assertIn(429, statuses, "wrong guesses must start being refused outright")
        self.assertEqual(
            self.login()[0], 429, "even the right password waits out a lockout"
        )

    def test_a_lockout_advertises_retry_after_and_then_expires(self):
        original = local_web._LOGIN_LOCKOUT_SECONDS
        local_web._LOGIN_LOCKOUT_SECONDS = 0.5
        try:
            for i in range(local_web._LOGIN_MAX_FAILURES):
                self.login(f"guess {i}")
            status, payload, _, _ = self.request(
                "POST", "/api/login", {"password": PASSWORD}
            )
            self.assertEqual(status, 429)
            self.assertGreaterEqual(json.loads(payload)["retryAfter"], 1)
            time.sleep(0.7)
            self.assertEqual(self.login()[0], 200, "a lockout must not be permanent")
        finally:
            local_web._LOGIN_LOCKOUT_SECONDS = original

    def test_a_successful_login_forgets_earlier_failures(self):
        for i in range(local_web._LOGIN_MAX_FAILURES - 1):
            self.login(f"guess {i}")
        self.assertEqual(self.login()[0], 200)
        self.assertNotIn("127.0.0.1", self.channel._login_failures)

    def test_an_empty_password_is_never_accepted(self):
        self.assertEqual(self.login("")[0], 401)


class TestRequestBodies(LocalWebChannelTestCase):
    def test_an_oversized_body_is_refused_before_it_is_read(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.putrequest("POST", "/api/login")
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Content-Length", str(local_web._MAX_BODY_BYTES + 1))
        conn.endheaders()  # deliberately send no body at all
        res = conn.getresponse()
        payload = res.read().decode()
        conn.close()
        self.assertEqual(res.status, 413)
        self.assertIn("body_too_large", payload)

    def test_a_chunked_body_is_rejected_rather_than_silently_dropped(self):
        # Reading only Content-Length made a chunked login with the *correct*
        # password fail as "invalid password".
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.putrequest("POST", "/api/login", skip_accept_encoding=True)
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Transfer-Encoding", "chunked")
        conn.endheaders()
        raw = json.dumps({"password": PASSWORD}).encode()
        conn.send(b"%x\r\n" % len(raw) + raw + b"\r\n0\r\n\r\n")
        res = conn.getresponse()
        payload = res.read().decode()
        conn.close()
        self.assertEqual(res.status, 411)
        self.assertIn("content_length_required", payload)

    def test_a_rejection_closes_the_connection_so_the_stream_stays_in_sync(self):
        # Answering before reading the body left those bytes to be parsed as the
        # next request line, which came back as "501 Unsupported method
        # '{\"password\":…}POST'".
        status, _, _, connection = self.request("POST", "/api/chat", {"text": "hi"})
        self.assertEqual(status, 401)
        self.assertEqual(connection, "close")
        self.assertEqual(self.request("POST", "/api/chat", {"text": "hi"})[0], 401)

    def test_a_malformed_content_length_is_a_bad_request(self):
        status, _, _, _ = self.request(
            "POST", "/api/login", headers={"Content-Length": "not-a-number"}
        )
        self.assertEqual(status, 400)


class TestSessions(LocalWebChannelTestCase):
    def test_concurrent_sessions_are_capped(self):
        for _ in range(local_web._MAX_SESSIONS + 8):
            self.login()
        self.assertLessEqual(len(self.channel._sessions), local_web._MAX_SESSIONS)

    def test_an_expired_session_is_rejected_and_dropped(self):
        _, cookie = self.login()
        token = cookie.split("=", 1)[1]
        self.assertTrue(self.channel._is_authenticated(token))
        self.channel._sessions[token] = time.monotonic() - 1
        self.assertFalse(self.channel._is_authenticated(token))
        self.assertNotIn(token, self.channel._sessions)

    def test_logging_out_invalidates_the_session(self):
        _, cookie = self.login()
        self.assertEqual(self.request("POST", "/api/logout", {}, cookie=cookie)[0], 200)
        self.assertEqual(
            self.request("POST", "/api/chat", {"text": "hi"}, cookie=cookie)[0], 401
        )

    def test_the_session_cookie_is_http_only(self):
        status, _, set_cookie, _ = self.request(
            "POST", "/api/login", {"password": PASSWORD}
        )
        self.assertEqual(status, 200)
        self.assertIn("HttpOnly", set_cookie)


class TestInbound(LocalWebChannelTestCase):
    def test_a_message_is_queued_with_the_peer_address_as_its_chat_id(self):
        _, cookie = self.login()
        self.assertEqual(
            self.request(
                "POST",
                "/api/chat",
                {"text": "hello"},
                cookie=cookie,
                # A spoofed forwarding header must not decide the chat id (or the
                # identity the login throttle counts against): nothing proxies this
                # server, so the peer address is the only trustworthy source.
                headers={"X-Forwarded-For": "10.9.9.9"},
            )[0],
            200,
        )
        queued = self.channel.poll()
        self.assertEqual(len(queued), 1)
        self.assertEqual(queued[0]["text"], "hello")
        self.assertEqual(queued[0]["chat_id"], "127.0.0.1")
        self.assertEqual(queued[0]["channel"], "local-web")

    def test_attachments_and_callbacks_are_carried_through(self):
        _, cookie = self.login()
        self.request(
            "POST",
            "/api/chat",
            {"images": [{"mime": "image/png", "data_base64": "AAAA"}]},
            cookie=cookie,
        )
        self.request(
            "POST", "/api/chat", {"callback": "imgGen:preset:Draft"}, cookie=cookie
        )
        queued = self.channel.poll()
        self.assertEqual(len(queued[0]["images"]), 1)
        self.assertEqual(queued[1]["callback"], "imgGen:preset:Draft")


class TestOutboundEvents(LocalWebChannelTestCase):
    def test_sse_is_not_framed_as_a_keep_alive_response(self):
        _, cookie = self.login()
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", "/api/events", headers={"Cookie": cookie})
        res = conn.getresponse()
        # An SSE body ends with the connection, so it must say so: with neither a
        # Content-Length nor chunked framing, "keep-alive" leaves a client unable
        # to tell where the body ends.
        self.assertEqual(res.getheader("Connection"), "close")
        self.assertIsNone(res.getheader("Content-Length"))
        self.assertIsNone(res.getheader("Transfer-Encoding"))
        conn.close()

    def test_typing_start_and_stop_are_distinguishable(self):
        # `_broadcast` owns the `action` key, so a stop sent as one was
        # indistinguishable from a start and the dots never cleared.
        _, cookie = self.login()
        sock = self.open_sse(cookie)
        time.sleep(0.3)
        self.channel.send_typing({"action": "typing"})
        self.channel.send_typing({"action": "stop"})
        time.sleep(0.3)
        events = self.sse_events(sock.recv(65536).decode())
        sock.close()
        self.assertEqual(
            events,
            [
                {"action": "typing", "state": "start"},
                {"action": "typing", "state": "stop"},
            ],
        )

    def test_settling_a_prompt_is_its_own_action(self):
        _, cookie = self.login()
        sock = self.open_sse(cookie)
        time.sleep(0.3)
        self.channel.send_edit_message({"text": "Cancelled."})
        time.sleep(0.3)
        events = self.sse_events(sock.recv(65536).decode())
        sock.close()
        # Sent as a plain reply, the page could not tell that the prompt above was
        # settled, and left its buttons live to fire the callback a second time.
        self.assertEqual(events, [{"action": "editMessage", "text": "Cancelled."}])

    def test_sending_without_a_connected_browser_is_not_an_error(self):
        self.assertEqual(
            self.channel.send_reply({"text": "into the void"}), {"status": "ok"}
        )

    def test_sending_while_stopped_is_an_error(self):
        self.channel.request_shutdown()
        self.assertIn("error", self.channel.send_reply({"text": "nope"}))

    def test_unauthenticated_clients_cannot_subscribe(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", "/api/events")
        self.assertEqual(conn.getresponse().status, 401)
        conn.close()


class TestConfigValidation(LocalWebChannelTestCase):
    def test_a_config_without_a_password_is_refused(self):
        result = self.channel.set_config({"port": str(self.port)})
        self.assertEqual(result["_http_status"], 400)

    def test_a_port_outside_the_allowed_range_is_refused(self):
        for port in ("80", "70000", "not-a-port"):
            result = self.channel.set_config({"password": PASSWORD, "port": port})
            self.assertEqual(
                result["_http_status"], 400, f"port {port} must be refused"
            )


class TestSendActionDispatch(unittest.TestCase):
    """How the send route resolves an action name to a channel method."""

    def test_camel_case_actions_map_to_snake_case_methods(self):
        self.assertEqual(send_method_name("reply"), "send_reply")
        self.assertEqual(send_method_name("typing"), "send_typing")
        self.assertEqual(send_method_name("history"), "send_history")
        # The one action that is not a single lowercase word — it silently 404ed,
        # so settling an interactive prompt in place never reached any channel.
        self.assertEqual(send_method_name("editMessage"), "send_edit_message")

    def test_an_unknown_action_resolves_to_nothing(self):
        # The result is used as an attribute name, so only known actions may pass.
        for action in ("", "poll", "set_config", "__class__", "reply; drop"):
            self.assertIsNone(send_method_name(action), f"{action!r} must not resolve")

    def test_every_action_the_renderer_sends_resolves_on_the_channel(self):
        channel = LocalWebChannel(Path(tempfile.mkdtemp()))
        for action in SEND_ACTIONS:
            name = send_method_name(action)
            self.assertIsNotNone(name)
            self.assertTrue(
                callable(getattr(channel, name, None)),
                f"the '{action}' action must resolve to a method on the local web channel",
            )


if __name__ == "__main__":
    unittest.main()
