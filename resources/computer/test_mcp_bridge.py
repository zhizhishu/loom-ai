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
# The non-secret authority identity the Host mints into every definition.
IDENTITY = {
    "LOOM_COMPUTER_AGENT_RUNTIME": "pi",
    "LOOM_COMPUTER_AGENT_SUBJECT": "assistant-1",
    "LOOM_COMPUTER_AGENT_SCOPE": "control",
}


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
        instance = bridge.Bridge(
            fixture.endpoint, fixture.origin, token, 10, DIGEST, scope="control"
        )
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
        instance = bridge.Bridge(
            "http://127.0.0.1:1/x", "http://127.0.0.1:1", TOKEN, 1, DIGEST, scope="control"
        )
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
            instance = bridge.Bridge(
                fixture.endpoint, fixture.origin, TOKEN, 10, DIGEST, scope="control"
            )
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


class PiAuthority(unittest.TestCase):
    """The authority a definition was minted for, ported from Mikka's lease guard."""

    def test_the_pi_family_is_accepted_and_claude_is_refused(self):
        for runtime in ("pi", "codex-cli", "deepseek-harness"):
            authority = bridge.read_authority(
                dict(IDENTITY, LOOM_COMPUTER_AGENT_RUNTIME=runtime)
            )
            self.assertEqual(authority["runtime"], runtime)
        # The Claude runtime is disabled by product policy: a definition minted for it
        # must not start the toolchain at all.
        with self.assertRaises(bridge.BridgeError) as refused:
            bridge.read_authority(
                dict(IDENTITY, LOOM_COMPUTER_AGENT_RUNTIME="claude-code-cli")
            )
        self.assertEqual(refused.exception.message, "runtime_disabled")
        self.assertTrue(refused.exception.fatal)
        # Missing, empty and unknown runtimes are refused too, never defaulted.
        for raw in (None, "", "  ", "PI", "gemini-cli", "codex_cli", "dsh"):
            environment = dict(IDENTITY)
            if raw is None:
                environment.pop("LOOM_COMPUTER_AGENT_RUNTIME")
            else:
                environment["LOOM_COMPUTER_AGENT_RUNTIME"] = raw
            with self.assertRaises(bridge.BridgeError) as refused:
                bridge.read_authority(environment)
            self.assertEqual(refused.exception.message, "runtime_unsupported", raw)

    def test_the_identity_is_bounded_like_the_upstream_lease(self):
        self.assertEqual(
            bridge.read_authority(
                dict(IDENTITY, LOOM_COMPUTER_AGENT_SUBJECT="s" * 128)
            )["subject"],
            "s" * 128,
        )
        for subject in (None, "", "s" * 129, "has\0nul"):
            environment = dict(IDENTITY)
            if subject is None:
                environment.pop("LOOM_COMPUTER_AGENT_SUBJECT")
            else:
                environment["LOOM_COMPUTER_AGENT_SUBJECT"] = subject
            with self.assertRaises(bridge.BridgeError) as refused:
                bridge.read_authority(environment)
            self.assertEqual(refused.exception.message, "authority_unavailable", repr(subject))
            self.assertTrue(refused.exception.fatal)
        for scope in (None, "", "root", "VIEW", "control+view"):
            environment = dict(IDENTITY)
            if scope is None:
                environment.pop("LOOM_COMPUTER_AGENT_SCOPE")
            else:
                environment["LOOM_COMPUTER_AGENT_SCOPE"] = scope
            with self.assertRaises(bridge.BridgeError) as refused:
                bridge.read_authority(environment)
            self.assertEqual(refused.exception.message, "authority_unavailable", repr(scope))
        for scope in ("view", "control"):
            self.assertEqual(
                bridge.read_authority(
                    dict(IDENTITY, LOOM_COMPUTER_AGENT_SCOPE=scope)
                )["scope"],
                scope,
            )


class ScopeSurface(unittest.TestCase):
    """Captures and input keep independent authorization, from the tool list onwards."""

    def listed(self, scope):
        instance = bridge.Bridge(
            "http://127.0.0.1:1/x", "http://127.0.0.1:1", TOKEN, 1, DIGEST, scope=scope
        )
        response = bridge.handle(
            instance, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        )
        return [tool["name"] for tool in response["result"]["tools"]]

    def test_a_view_grant_exposes_only_the_capture_tool(self):
        self.assertEqual(self.listed("view"), ["screenshot"])

    def test_a_control_grant_exposes_the_five_tools_in_order(self):
        self.assertEqual(
            self.listed("control"),
            ["screenshot", "mouse_click", "wheel", "key", "text"],
        )

    def test_a_view_grant_refuses_input_before_any_request_leaves(self):
        fixture = Fixture()
        try:
            instance = bridge.Bridge(
                fixture.endpoint, fixture.origin, TOKEN, 10, DIGEST, scope="view"
            )
            for tool, arguments in [
                ("mouse_click", {"x": 1, "y": 2, "button": "left"}),
                ("wheel", {"x": 1, "y": 2, "delta": 1}),
                ("key", {"key": "enter"}),
                ("text", {"text": "hi"}),
            ]:
                response = bridge.handle(
                    instance,
                    {
                        "jsonrpc": "2.0",
                        "id": tool,
                        "method": "tools/call",
                        "params": {"name": tool, "arguments": arguments},
                    },
                )
                self.assertTrue(response["result"]["isError"], tool)
                self.assertEqual(response["result"]["content"][0]["text"], "scope_denied")
                self.assertFalse(instance.fatal, "a scope refusal is not a revoked grant")
            self.assertEqual(
                fixture.requests, [], "no input scope request may reach the Host"
            )
            # The capture itself is still authorized under the same view grant.
            capture = bridge.handle(
                instance,
                {
                    "jsonrpc": "2.0",
                    "id": "shot",
                    "method": "tools/call",
                    "params": {"name": "screenshot", "arguments": {}},
                },
            )
            self.assertFalse(capture["result"]["isError"])
            self.assertEqual(len(fixture.requests), 1)
        finally:
            fixture.close()


class Subprocess(unittest.TestCase):
    """End-to-end over real stdio, in the environment Pi actually provides.

    Pi's managed extension spawns the bridge with `inheritEnv: false`, so the environment
    below is exactly the definition's `env`: no `PATH`, no `HOME`, no locale.
    """

    def run_bridge(self, payload, environment):
        return subprocess.run(
            [sys.executable, str(MODULE_PATH)],
            input=payload,
            capture_output=True,
            timeout=60,
            env=environment,
        )

    def document_environment(self, fixture, token_file, **overrides):
        environment = {
            "LOOM_COMPUTER_AGENT_ENDPOINT": fixture.endpoint,
            "LOOM_COMPUTER_AGENT_ORIGIN": fixture.origin,
            "LOOM_COMPUTER_AGENT_TOKEN_FILE": str(token_file),
            "LOOM_COMPUTER_AGENT_DIGEST": DIGEST,
        }
        environment.update(IDENTITY)
        environment.update(overrides)
        if "SYSTEMROOT" in os.environ:
            # Windows process creation only; never a bridge input.
            environment["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
        return {key: value for key, value in environment.items() if value is not None}

    def token_file(self, root):
        path = pathlib.Path(root) / "grant-token"
        path.write_text(TOKEN, encoding="utf-8")
        os.chmod(path, 0o600)
        return path

    def test_stdio_round_trip_never_leaks_the_token(self):
        fixture = Fixture()
        root = tempfile.mkdtemp(prefix="loom-mcp-bridge-")
        token_file = self.token_file(root)
        environment = self.document_environment(fixture, token_file)
        self.assertNotIn("PATH", environment, "the Pi toolchain needs no PATH")
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

    def test_a_view_definition_serves_only_the_capture_tool(self):
        fixture = Fixture()
        root = tempfile.mkdtemp(prefix="loom-mcp-bridge-")
        token_file = self.token_file(root)
        environment = self.document_environment(
            fixture, token_file, LOOM_COMPUTER_AGENT_SCOPE="view"
        )
        payload = (
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
            + "\n"
            + json.dumps(
                {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "key", "arguments": {"key": "enter"}}}
            )
            + "\n"
        )
        try:
            completed = self.run_bridge(payload.encode("utf-8"), environment)
        finally:
            fixture.close()
            shutil.rmtree(root, ignore_errors=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        lines = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
        self.assertEqual([tool["name"] for tool in lines[0]["result"]["tools"]], ["screenshot"])
        self.assertEqual(lines[1]["result"]["content"][0]["text"], "scope_denied")
        self.assertEqual(fixture.requests, [])

    def test_a_claude_definition_cannot_start_the_bridge(self):
        fixture = Fixture()
        root = tempfile.mkdtemp(prefix="loom-mcp-bridge-")
        token_file = self.token_file(root)
        environment = self.document_environment(
            fixture, token_file, LOOM_COMPUTER_AGENT_RUNTIME="claude-code-cli"
        )
        try:
            completed = self.run_bridge(
                b'{"jsonrpc":"2.0","id":1,"method":"initialize"}\n', environment
            )
        finally:
            fixture.close()
            shutil.rmtree(root, ignore_errors=True)
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, b"", "a refused runtime serves no tools")
        self.assertIn(b"runtime_disabled", completed.stderr)
        self.assertNotIn(TOKEN.encode(), completed.stderr)
        self.assertEqual(fixture.requests, [])

    def test_a_malformed_authority_cannot_start_the_bridge(self):
        fixture = Fixture()
        root = tempfile.mkdtemp(prefix="loom-mcp-bridge-")
        token_file = self.token_file(root)
        for overrides in (
            {"LOOM_COMPUTER_AGENT_SUBJECT": None},
            {"LOOM_COMPUTER_AGENT_SUBJECT": "s" * 129},
            {"LOOM_COMPUTER_AGENT_SCOPE": None},
            {"LOOM_COMPUTER_AGENT_SCOPE": "root"},
        ):
            environment = self.document_environment(fixture, token_file, **overrides)
            completed = self.run_bridge(
                b'{"jsonrpc":"2.0","id":1,"method":"initialize"}\n', environment
            )
            self.assertNotEqual(completed.returncode, 0, overrides)
            self.assertEqual(completed.stdout, b"", overrides)
            self.assertIn(b"authority_unavailable", completed.stderr, overrides)
        shutil.rmtree(root, ignore_errors=True)
        fixture.close()

    def test_missing_token_file_fails_closed_without_output(self):
        environment = {
            "LOOM_COMPUTER_AGENT_ENDPOINT": "http://127.0.0.1:1/api/v1/computer-agent/rpc",
            "LOOM_COMPUTER_AGENT_ORIGIN": "http://127.0.0.1:1",
            "LOOM_COMPUTER_AGENT_TOKEN_FILE": "/nonexistent/grant-token",
            "LOOM_COMPUTER_AGENT_DIGEST": DIGEST,
            **IDENTITY,
        }
        completed = self.run_bridge(b'{"jsonrpc":"2.0","id":1,"method":"initialize"}\n', environment)
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, b"")
        self.assertIn(b"token_unavailable", completed.stderr)

    def test_non_loopback_endpoint_fails_closed(self):
        environment = {
            "LOOM_COMPUTER_AGENT_ENDPOINT": "http://10.0.0.5:1/api/v1/computer-agent/rpc",
            "LOOM_COMPUTER_AGENT_ORIGIN": "http://10.0.0.5:1",
            "LOOM_COMPUTER_AGENT_TOKEN_FILE": "/nonexistent/grant-token",
            "LOOM_COMPUTER_AGENT_DIGEST": DIGEST,
            **IDENTITY,
        }
        completed = self.run_bridge(b'{"jsonrpc":"2.0","id":1,"method":"initialize"}\n', environment)
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, b"")


class PiLifecycle(unittest.TestCase):
    """Revocation, expiry and replay as the Pi process actually observes them."""

    def run_bridge(self, payload, environment):
        return subprocess.run(
            [sys.executable, str(MODULE_PATH)],
            input=payload,
            capture_output=True,
            timeout=60,
            env=environment,
        )

    def launch(self, fixture, status, body, requests=2):
        root = tempfile.mkdtemp(prefix="loom-mcp-bridge-")
        token_file = pathlib.Path(root) / "grant-token"
        token_file.write_text(TOKEN, encoding="utf-8")
        os.chmod(token_file, 0o600)
        fixture.status = status
        fixture.body = body
        environment = {
            "LOOM_COMPUTER_AGENT_ENDPOINT": fixture.endpoint,
            "LOOM_COMPUTER_AGENT_ORIGIN": fixture.origin,
            "LOOM_COMPUTER_AGENT_TOKEN_FILE": str(token_file),
            "LOOM_COMPUTER_AGENT_DIGEST": DIGEST,
            **IDENTITY,
        }
        payload = ""
        for index in range(requests):
            payload += json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": "req-%d" % index,
                    "method": "tools/call",
                    "params": {"name": "key", "arguments": {"key": "enter"}},
                }
            ) + "\n"
        try:
            completed = self.run_bridge(payload.encode("utf-8"), environment)
        finally:
            shutil.rmtree(root, ignore_errors=True)
        return completed

    def test_a_revoked_grant_ends_the_pi_toolchain(self):
        fixture = Fixture()
        try:
            completed = self.launch(
                fixture,
                401,
                {"ok": False, "error": {"code": "computer_agent_grant_revoked"}},
            )
        finally:
            fixture.close()
        # The first call learns the grant is gone; the process stops instead of retrying
        # into a dead grant, and the second request is never sent.
        self.assertEqual(completed.returncode, 1, completed.stderr)
        self.assertEqual(len(fixture.requests), 1)
        lines = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0]["result"]["isError"])
        self.assertEqual(lines[0]["result"]["content"][0]["text"], "grant_unavailable")
        self.assertNotIn(TOKEN.encode(), completed.stdout + completed.stderr)

    def test_an_expired_grant_ends_the_pi_toolchain(self):
        fixture = Fixture()
        try:
            completed = self.launch(
                fixture,
                403,
                {"ok": False, "error": {"code": "computer_agent_grant_expired"}},
            )
        finally:
            fixture.close()
        self.assertEqual(completed.returncode, 1, completed.stderr)
        self.assertEqual(len(fixture.requests), 1)
        self.assertIn(b"grant_unavailable", completed.stdout)

    def test_a_replayed_request_is_a_tool_error_and_is_never_retried(self):
        fixture = Fixture()
        try:
            completed = self.launch(
                fixture,
                409,
                {"ok": False, "error": {"code": "computer_agent_request_replayed"}},
                requests=1,
            )
        finally:
            fixture.close()
        # A refusal the Host proved is reported verbatim, the process stays usable, and
        # exactly one request was sent: there is no automatic replay.
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(len(fixture.requests), 1)
        lines = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
        self.assertEqual(
            lines[0]["result"]["content"][0]["text"], "computer_agent_request_replayed"
        )
        self.assertTrue(lines[0]["result"]["isError"])


if __name__ == "__main__":
    unittest.main()
