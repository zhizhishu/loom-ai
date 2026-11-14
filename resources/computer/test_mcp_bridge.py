#!/usr/bin/env python3
"""Tests for the LOOM computer-agent MCP bridge.

No screen is captured, no input is injected and no model runs. The only network
traffic is to a loopback `http.server` fixture this file starts itself; it asserts the
exact bytes the bridge sends, that the token never appears on stdout/stderr/argv, and
that redirect and non-loopback endpoints are refused before any request is made.

Run: python -m unittest discover -s resources/computer -p 'test_mcp_bridge.py' -v
"""

import http.server
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("mcp_bridge.py")
SPEC = importlib.util.spec_from_file_location("loom_mcp_bridge", MODULE_PATH)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)

TOKEN = "0123456789abcdef" * 4
GRANT = "a" * 64
DIGEST = "ab" * 32


class Fixture:
    """A loopback HTTP server that records what the bridge sent."""

    def __init__(self, status=200, body=None, redirect_to=None):
        self.requests = []
        self.status = status
        self.body = body if body is not None else {"ok": True, "result": {"seq": 1}}
        self.redirect_to = redirect_to
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 - stdlib hook
                length = int(self.headers.get("Content-Length", "0"))
                payload = self.rfile.read(length)
                fixture.requests.append(
                    {
                        "path": self.path,
                        "headers": {key.lower(): value for key, value in self.headers.items()},
                        "body": payload,
                    }
                )
                if fixture.redirect_to:
                    self.send_response(302)
                    self.send_header("Location", fixture.redirect_to)
                    self.end_headers()
                    return
                encoded = json.dumps(fixture.body).encode("utf-8")
                self.send_response(fixture.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, *_args):  # silence the fixture
                return

        self.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    @property
    def endpoint(self):
        return "http://127.0.0.1:%d%s" % (self.port, bridge.RPC_PATH)

    @property
    def origin(self):
        return "http://127.0.0.1:%d" % self.port

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class EndpointAdmission(unittest.TestCase):
    def test_accepts_only_the_loopback_rpc_path_on_the_origin_authority(self):
        endpoint, origin = bridge.validate_endpoint(
            "http://127.0.0.1:8443/api/v1/computer-agent/rpc", "http://127.0.0.1:8443"
        )
        self.assertEqual(endpoint, "http://127.0.0.1:8443/api/v1/computer-agent/rpc")
        self.assertEqual(origin, "http://127.0.0.1:8443")
        for extra in [
            "http://127.0.0.1:8443/api/v1/computer-agent/rpc?x=1",
            "http://127.0.0.1:8443/api/v1/computer-agent/rpc#frag",
            "http://user:pw@127.0.0.1:8443/api/v1/computer-agent/rpc",
            "http://127.0.0.1:8443/other",
            "http://10.0.0.5:8443/api/v1/computer-agent/rpc",
            "http://evil.example:8443/api/v1/computer-agent/rpc",
            "http://127.0.0.1:9999/api/v1/computer-agent/rpc",
        ]:
            with self.assertRaises(bridge.BridgeError, msg=extra):
                bridge.validate_endpoint(extra, "http://127.0.0.1:8443")

    def test_origin_must_be_a_literal_loopback_origin(self):
        for rejected in [
            "https://example.com",
            "http://127.0.0.1:8443/path",
            "http://127.0.0.1:8443?x=1",
            "http://u@127.0.0.1:8443",
            "http://127.0.0.1",
            "file://127.0.0.1:8443",
        ]:
            with self.assertRaises(bridge.BridgeError, msg=rejected):
                bridge.split_origin(rejected)


class ToolSurface(unittest.TestCase):
    def test_exactly_five_closed_tools(self):
        self.assertEqual(
            [tool["name"] for tool in bridge.TOOLS],
            ["screenshot", "mouse_click", "wheel", "key", "text"],
        )
        for tool in bridge.TOOLS:
            self.assertFalse(tool["inputSchema"]["additionalProperties"])

    def test_no_tool_accepts_command_path_url_or_token_arguments(self):
        for key in ("command", "path", "url", "token", "tokenFile", "shell", "argv"):
            self.assertNotIn(key, bridge.SCHEMA_PROPERTIES["screenshot"])
            self.assertNotIn(key, bridge.SCHEMA_PROPERTIES["mouse_click"])
            self.assertNotIn(key, bridge.SCHEMA_PROPERTIES["text"])
        with self.assertRaises(bridge.BridgeError):
            bridge.call_body("1", "text", {"text": "hi", "path": "/etc/passwd"}, DIGEST)
        with self.assertRaises(bridge.BridgeError):
            bridge.call_body("1", "screenshot", {"url": "http://example.com"}, DIGEST)
        with self.assertRaises(bridge.BridgeError):
            bridge.call_body("1", "shell", {}, DIGEST)

    def test_wire_body_carries_the_request_id_and_no_secret(self):
        body = bridge.call_body("req-1", "mouse_click", {"x": 1, "y": 2, "button": "left"}, DIGEST)
        self.assertEqual(body["requestId"], "req-1")
        self.assertEqual(body["tool"], "mouse_click")
        self.assertEqual(body["expectedConfigDigest"], DIGEST)
        serialized = json.dumps(body)
        self.assertNotIn(TOKEN, serialized)
        self.assertNotIn("Bearer", serialized)


class Protocol(unittest.TestCase):
    def call(self, fixture, request_id, tool, arguments, token=TOKEN):
        instance = bridge.Bridge(fixture.endpoint, fixture.origin, token, 10, DIGEST)
        return bridge.handle(
            instance,
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "tools/call",
                "params": {"name": tool, "arguments": arguments},
            },
        )

    def test_initialize_and_tools_list_are_protocol_correct(self):
        instance = bridge.Bridge("http://127.0.0.1:1/x", "http://127.0.0.1:1", TOKEN, 1, DIGEST)
        initialized = bridge.handle(instance, {"jsonrpc": "2.0", "id": 1, "method": "initialize"})
        self.assertEqual(initialized["result"]["protocolVersion"], "2024-11-05")
        self.assertIn("tools", initialized["result"]["capabilities"])
        listed = bridge.handle(instance, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        self.assertEqual(len(listed["result"]["tools"]), 5)
        # Notifications produce no output at all.
        self.assertIsNone(
            bridge.handle(instance, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        )
        unknown = bridge.handle(instance, {"jsonrpc": "2.0", "id": 3, "method": "resources/list"})
        self.assertEqual(unknown["error"]["code"], -32601)

    def test_tool_call_forwards_id_bearer_and_origin(self):
        fixture = Fixture()
        try:
            response = self.call(fixture, "req-abc", "key", {"key": "enter"})
            self.assertFalse(response["result"]["isError"])
            self.assertEqual(len(fixture.requests), 1)
            sent = fixture.requests[0]
            self.assertEqual(sent["path"], bridge.RPC_PATH)
            self.assertEqual(sent["headers"]["authorization"], "Bearer " + TOKEN)
            self.assertEqual(sent["headers"]["origin"], fixture.origin)
            body = json.loads(sent["body"])
            self.assertEqual(body["requestId"], "req-abc")
            self.assertEqual(body["tool"], "key")
            self.assertEqual(body["expectedConfigDigest"], DIGEST)
            self.assertEqual(body["arguments"], {"key": "enter"})
            self.assertNotIn(TOKEN, sent["body"].decode("utf-8"))
        finally:
            fixture.close()

    def test_screenshot_returns_an_image_content_block(self):
        fixture = Fixture(
            body={
                "ok": True,
                "result": {
                    "pngBase64": "iVBORw0KGgo=",
                    "width": 1280,
                    "height": 720,
                    "originX": -1920,
                    "originY": 0,
                    "screenWidth": 3840,
                    "screenHeight": 1080,
                    "scale": 0.33,
                },
            }
        )
        try:
            response = self.call(fixture, "shot-1", "screenshot", {})
            content = response["result"]["content"]
            self.assertEqual(content[0]["type"], "image")
            self.assertEqual(content[0]["mimeType"], "image/png")
            self.assertEqual(json.loads(content[1]["text"])["originX"], -1920)
        finally:
            fixture.close()

    def test_host_refusals_surface_public_codes_only(self):
        fixture = Fixture(status=409, body={"ok": False, "error": {"code": "computer_agent_request_replayed"}})
        try:
            response = self.call(fixture, "req-dup", "text", {"text": "hi"})
            self.assertTrue(response["result"]["isError"])
            self.assertEqual(response["result"]["content"][0]["text"], "computer_agent_request_replayed")
        finally:
            fixture.close()

    def test_a_revoked_grant_is_fatal_and_stops_further_calls(self):
        fixture = Fixture(status=401, body={"ok": False, "error": {"code": "computer_agent_grant_revoked"}})
        try:
            instance = bridge.Bridge(fixture.endpoint, fixture.origin, TOKEN, 10, DIGEST)
            first = bridge.handle(
                instance,
                {"jsonrpc": "2.0", "id": "r1", "method": "tools/call", "params": {"name": "key", "arguments": {"key": "tab"}}},
            )
            self.assertTrue(first["result"]["isError"])
            self.assertTrue(instance.fatal)
            self.assertEqual(len(fixture.requests), 1)
        finally:
            fixture.close()

    def test_redirect_is_refused_instead_of_followed(self):
        fixture = Fixture(redirect_to="http://127.0.0.1:1/api/v1/computer-agent/rpc")
        try:
            response = self.call(fixture, "req-redirect", "key", {"key": "tab"})
            self.assertTrue(response["result"]["isError"])
            self.assertEqual(response["result"]["content"][0]["text"], "redirect_refused")
            self.assertEqual(len(fixture.requests), 1, "the redirect must not be followed")
        finally:
            fixture.close()


class Subprocess(unittest.TestCase):
    """End-to-end over real stdio: JSON lines out, nothing else."""

    def run_bridge(self, payload, environment):
        return subprocess.run(
            [sys.executable, str(MODULE_PATH)],
            input=payload,
            capture_output=True,
            timeout=60,
            env=environment,
        )

    def test_stdio_round_trip_never_leaks_the_token(self):
        fixture = Fixture()
        root = tempfile.mkdtemp(prefix="loom-mcp-bridge-")
        token_file = pathlib.Path(root) / "grant-token"
        token_file.write_text(TOKEN, encoding="utf-8")
        os.chmod(token_file, 0o600)
        environment = {
            "PATH": os.environ.get("PATH", ""),
            "LOOM_COMPUTER_AGENT_ENDPOINT": fixture.endpoint,
            "LOOM_COMPUTER_AGENT_ORIGIN": fixture.origin,
            "LOOM_COMPUTER_AGENT_TOKEN_FILE": str(token_file),
            "LOOM_COMPUTER_AGENT_DIGEST": DIGEST,
        }
        if "SYSTEMROOT" in os.environ:
            environment["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
        payload = (
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize"})
            + "\n"
            + json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
            + "\n"
            + json.dumps(
                {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "key", "arguments": {"key": "enter"}}}
            )
            + "\n"
        )
        try:
            completed = self.run_bridge(payload.encode("utf-8"), environment)
        finally:
            fixture.close()
            shutil.rmtree(root, ignore_errors=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotIn(TOKEN.encode(), completed.stdout)
        self.assertNotIn(TOKEN.encode(), completed.stderr)
        self.assertNotIn(str(token_file).encode(), completed.stderr)
        lines = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
        self.assertEqual([line["id"] for line in lines], [1, 2, 3])
        self.assertEqual(len(lines[1]["result"]["tools"]), 5)
        self.assertFalse(lines[2]["result"]["isError"])

    def test_missing_token_file_fails_closed_without_output(self):
        environment = {
            "PATH": os.environ.get("PATH", ""),
            "LOOM_COMPUTER_AGENT_ENDPOINT": "http://127.0.0.1:1/api/v1/computer-agent/rpc",
            "LOOM_COMPUTER_AGENT_ORIGIN": "http://127.0.0.1:1",
            "LOOM_COMPUTER_AGENT_TOKEN_FILE": "/nonexistent/grant-token",
            "LOOM_COMPUTER_AGENT_DIGEST": DIGEST,
        }
        completed = self.run_bridge(b'{"jsonrpc":"2.0","id":1,"method":"initialize"}\n', environment)
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, b"")
        self.assertIn(b"token_unavailable", completed.stderr)

    def test_non_loopback_endpoint_fails_closed(self):
        environment = {
            "PATH": os.environ.get("PATH", ""),
            "LOOM_COMPUTER_AGENT_ENDPOINT": "http://10.0.0.5:1/api/v1/computer-agent/rpc",
            "LOOM_COMPUTER_AGENT_ORIGIN": "http://10.0.0.5:1",
            "LOOM_COMPUTER_AGENT_TOKEN_FILE": "/nonexistent/grant-token",
            "LOOM_COMPUTER_AGENT_DIGEST": DIGEST,
        }
        completed = self.run_bridge(b'{"jsonrpc":"2.0","id":1,"method":"initialize"}\n', environment)
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, b"")


if __name__ == "__main__":
    unittest.main()
