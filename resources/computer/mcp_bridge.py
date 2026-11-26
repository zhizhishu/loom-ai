#!/usr/bin/env python3
"""LOOM computer-agent MCP bridge (stdio JSON-RPC 2.0).

One process per grant. It exposes exactly five tools and forwards each call to the
LOOPBACK `POST /api/v1/computer-agent/rpc` endpoint of the Host that launched it.

Trust rules enforced here, not in the model's prompt:

* The bearer token is read from `LOOM_COMPUTER_AGENT_TOKEN_FILE` (a 0600/DACL-private
  file created by the Host). It is never an argument, never printed, never logged and
  never placed in a request body.
* The endpoint must be a literal loopback URL with the exact RPC path: no userinfo, no
  query, no fragment, no redirect, no proxy, no other host.
* The token file path is not a tool argument and can never be one: the tool schemas are
  closed and carry only screen coordinates, a key name, or bounded text.
* Every tool call carries the client's own JSON-RPC request id forward unchanged. The
  Host makes that id single-use per grant, so a retry can never duplicate input.
* stdout carries JSON lines and nothing else; diagnostics never reach it.

A `401`/`403`/`404` from the Host means the grant is gone: the bridge answers that calls
fail and exits non-zero so no further attempts are made.

Pi toolchain (ported from Mikka `packages/daemon/src/computer/driver.mjs@d59c85cb`):

* This process is the MCP server Pi's managed extension spawns. It is started with
  `inheritEnv: false` and exactly the environment the reviewed definition carries, so
  nothing here may depend on `PATH`, `HOME` or a locale.
* Authority identity is the one the Host derived and minted the definition for
  (`LOOM_COMPUTER_AGENT_RUNTIME`/`SUBJECT`/`SCOPE`). A definition minted for the disabled
  `claude-code-cli` runtime, or one with a missing or malformed identity, refuses to start
  at all — the same fail-closed shape as Mikka's `Invalid desktop lease` guard.
* Captures and synthetic input keep independent authorization. A `view` grant exposes and
  accepts only `screenshot`; a `control` grant exposes the four input tools too. An input
  call on a view grant is refused here, before any request leaves the process, so the
  narrower grant fails closed even if the Host were unreachable.
* The tool surface is the same closed five Mikka's driver exposes, mapped one to one:
  `get_desktop_state`->`screenshot`, `click`->`mouse_click`, `type_text`->`text`,
  `press_key`->`key`, `scroll`->`wheel`. Mikka's recording tools and its `step` wording
  have no LOOM counterpart and are not exposed.
"""

import json
import os
import sys
import urllib.error
import urllib.request

MAX_LINE_BYTES = 1024 * 1024
MAX_TEXT_CODEPOINTS = 2048
RPC_PATH = "/api/v1/computer-agent/rpc"
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
DEFAULT_TIMEOUT_SECONDS = 20

# The runtimes whose MCP projection can reach this bridge, kept identical to the Host's
# `RUNTIMES` (crates/rovai-web/src/computer_agent.rs). `claude-code-cli` is refused by
# product policy and is deliberately absent rather than merely gated.
RUNTIMES = ("pi", "codex-cli", "deepseek-harness")
DISABLED_RUNTIMES = frozenset({"claude-code-cli"})
RUNTIME_ENV = "LOOM_COMPUTER_AGENT_RUNTIME"
SUBJECT_ENV = "LOOM_COMPUTER_AGENT_SUBJECT"
SCOPE_ENV = "LOOM_COMPUTER_AGENT_SCOPE"
# Bounded like Mikka's lease identity: non-empty, no NUL, at most 128 characters.
MAX_SUBJECT_LENGTH = 128

TOOLS = (
    {
        "name": "screenshot",
        "description": "Capture the user-granted desktop once and return a PNG image plus its screen bounds.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "mouse_click",
        "description": "Click one mouse button at a screen coordinate inside the granted desktop.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "x": {"type": "integer"},
                "y": {"type": "integer"},
                "button": {"type": "string", "enum": ["left", "right", "middle"]},
            },
            "required": ["x", "y", "button"],
            "additionalProperties": False,
        },
    },
    {
        "name": "wheel",
        "description": "Scroll the wheel at a screen coordinate inside the granted desktop.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "x": {"type": "integer"},
                "y": {"type": "integer"},
                "delta": {"type": "integer", "minimum": -1000, "maximum": 1000},
            },
            "required": ["x", "y", "delta"],
            "additionalProperties": False,
        },
    },
    {
        "name": "key",
        "description": "Tap one whitelisted key.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "key": {
                    "type": "string",
                    "enum": [
                        "enter", "tab", "escape", "backspace", "delete", "space",
                        "left", "right", "up", "down", "home", "end", "pageup",
                        "pagedown", "shift", "ctrl", "alt", "meta",
                        "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9",
                        "f10", "f11", "f12",
                    ],
                }
            },
            "required": ["key"],
            "additionalProperties": False,
        },
    },
    {
        "name": "text",
        "description": "Type bounded text. No control characters, no astral-plane characters.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": MAX_TEXT_CODEPOINTS,
                }
            },
            "required": ["text"],
            "additionalProperties": False,
        },
    },
)
TOOL_NAMES = frozenset(tool["name"] for tool in TOOLS)
SCHEMA_PROPERTIES = {
    tool["name"]: frozenset(tool["inputSchema"]["properties"]) for tool in TOOLS
}
# Independent authorization: the capture scope is exactly `screenshot`, the control scope
# adds the four synthetic-input tools. Order follows TOOLS, which is what `tools/list`
# returns.
SCOPE_TOOLS = {
    "view": frozenset({"screenshot"}),
    "control": frozenset(tool["name"] for tool in TOOLS),
}


class BridgeError(Exception):
    """A refusal the model sees as a tool error, never as Host detail."""

    def __init__(self, message, fatal=False):
        super().__init__(message)
        self.message = message
        self.fatal = fatal


def split_origin(value):
    """Literal loopback origin -> (scheme, host, port). Anything else is refused."""
    for scheme in ("http://", "https://"):
        if value.startswith(scheme):
            rest = value[len(scheme):]
            break
    else:
        raise BridgeError("invalid_origin", fatal=True)
    if any(character in rest for character in "/?#@\\"):
        raise BridgeError("invalid_origin", fatal=True)
    if ":" not in rest:
        raise BridgeError("invalid_origin", fatal=True)
    host, raw_port = rest.rsplit(":", 1)
    if not raw_port.isdigit() or not 0 < int(raw_port) < 65536:
        raise BridgeError("invalid_origin", fatal=True)
    if host not in LOOPBACK_HOSTS:
        raise BridgeError("invalid_origin", fatal=True)
    return scheme, host, int(raw_port)


def validate_endpoint(endpoint, origin):
    """The endpoint must be our loopback RPC path on the same authority as the origin."""
    scheme, host, port = split_origin(origin)
    if not endpoint.startswith(scheme):
        raise BridgeError("invalid_endpoint", fatal=True)
    rest = endpoint[len(scheme):]
    if any(character in rest for character in "?#@\\"):
        raise BridgeError("invalid_endpoint", fatal=True)
    if "/" not in rest:
        raise BridgeError("invalid_endpoint", fatal=True)
    authority, path = rest.split("/", 1)
    if "/" + path != RPC_PATH:
        raise BridgeError("invalid_endpoint", fatal=True)
    if ":" not in authority:
        raise BridgeError("invalid_endpoint", fatal=True)
    host_part, raw_port = authority.rsplit(":", 1)
    if host_part not in LOOPBACK_HOSTS:
        raise BridgeError("invalid_endpoint", fatal=True)
    if raw_port != str(port):
        raise BridgeError("invalid_endpoint", fatal=True)
    return endpoint, origin


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):  # noqa: N802 - stdlib hook
        raise BridgeError("redirect_refused")


def endpoint_opener(endpoint):
    """build_opener's handlers minus the schemes the endpoint never uses."""
    handlers = [
        urllib.request.ProxyHandler({}),
        urllib.request.UnknownHandler(),
        urllib.request.HTTPHandler(),
        urllib.request.HTTPDefaultErrorHandler(),
        NoRedirect(),
        urllib.request.HTTPErrorProcessor(),
    ]
    if endpoint.startswith("https://"):
        handlers.append(urllib.request.HTTPSHandler())
    opener = urllib.request.OpenerDirector()
    for handler in handlers:
        opener.add_handler(handler)
    return opener


def call_body(request_id, tool, arguments, digest):
    """The exact wire body. No token, no path, no url, no prefix juggling."""
    if tool not in TOOL_NAMES:
        raise BridgeError("unsupported_tool")
    if not isinstance(arguments, dict):
        raise BridgeError("invalid_arguments")
    if not digest or len(digest) > 128:
        raise BridgeError("digest_unavailable", fatal=True)
    for key in arguments:
        if key not in SCHEMA_PROPERTIES[tool]:
            raise BridgeError("invalid_arguments")
    return {
        "requestId": str(request_id),
        "tool": tool,
        # The configuration the user reviewed; the Host refuses a mismatch.
        "expectedConfigDigest": digest,
        "arguments": arguments,
    }


def read_authority(environment):
    """The reviewed authority this definition was minted for.

    Ported from the identity checks Mikka's driver applies before it spawns a driver
    invocation (`driver.mjs`: a non-empty, at-most-128-character `botId`/`ownerId` with no
    NUL, or the desktop lease is invalid). LOOM adds the runtime, which is where the Claude
    refusal lives: `claude-code-cli` is disabled by product policy, so a definition minted
    for it may not start even if it exists in a configuration.
    """
    runtime = (environment.get(RUNTIME_ENV) or "").strip()
    if runtime in DISABLED_RUNTIMES:
        raise BridgeError("runtime_disabled", fatal=True)
    if runtime not in RUNTIMES:
        raise BridgeError("runtime_unsupported", fatal=True)
    subject = environment.get(SUBJECT_ENV) or ""
    if not subject or len(subject) > MAX_SUBJECT_LENGTH or "\0" in subject:
        raise BridgeError("authority_unavailable", fatal=True)
    scope = (environment.get(SCOPE_ENV) or "").strip()
    if scope not in SCOPE_TOOLS:
        raise BridgeError("authority_unavailable", fatal=True)
    return {"runtime": runtime, "subject": subject, "scope": scope}


def configure_stdio():
    """Pin the line protocol to UTF-8 JSON lines.

    Pi's managed extension spawns this bridge with `inheritEnv: false`, so no locale is
    inherited. The protocol must not depend on one.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="strict", newline="\n")
        except (AttributeError, ValueError):  # pragma: no cover - exotic streams
            continue


class Bridge:
    def __init__(self, endpoint, origin, token, timeout, digest, *, scope, opener=None):
        self.endpoint = endpoint
        self.origin = origin
        self.token = token
        self.timeout = timeout
        self.digest = digest
        # There is no default: the caller must state which permission this grant carries,
        # so a missing scope can never widen the surface.
        self.scope = scope
        self.fatal = False
        self.opener = opener or endpoint_opener(endpoint)

    def tools(self):
        """Exactly the tools this grant's scope exposes, in declaration order."""
        allowed = SCOPE_TOOLS[self.scope]
        return [tool for tool in TOOLS if tool["name"] in allowed]

    def allows(self, tool):
        return tool in SCOPE_TOOLS[self.scope]

    def call(self, request_id, tool, arguments):
        body = json.dumps(call_body(request_id, tool, arguments, self.digest)).encode("utf-8")
        request = urllib.request.Request(
            self.endpoint,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + self.token,
                "Origin": self.origin,
            },
        )
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                payload = response.read(8 * 1024 * 1024)
        except BridgeError:
            raise
        except urllib.error.HTTPError as error:
            # Only the Host's own public code is surfaced; the rest of the body is
            # dropped so no Core detail can reach the model.
            code = None
            try:
                parsed = json.loads(error.read(64 * 1024).decode("utf-8"))
                inner = parsed.get("error")
                if isinstance(inner, dict) and isinstance(inner.get("code"), str):
                    code = inner["code"]
            except Exception:  # noqa: BLE001 - an unreadable body is just a refusal
                code = None
            if error.code in (401, 403, 404):
                raise BridgeError("grant_unavailable", fatal=True)
            raise BridgeError(code or "host_refused")
        except Exception:  # noqa: BLE001 - transport failure is a tool error
            raise BridgeError("host_unreachable")
        try:
            parsed = json.loads(payload.decode("utf-8"))
        except Exception:  # noqa: BLE001
            raise BridgeError("invalid_response")
        if not isinstance(parsed, dict):
            raise BridgeError("invalid_response")
        if parsed.get("ok") is not True:
            error = parsed.get("error")
            code = error.get("code") if isinstance(error, dict) else None
            raise BridgeError(code if isinstance(code, str) else "host_refused")
        result = parsed.get("result")
        return result if isinstance(result, dict) else {}


def describe(result):
    """Model-facing content: a PNG image or a short acknowledgement."""
    if "pngBase64" in result:
        return {
            "content": [
                {"type": "image", "data": result["pngBase64"], "mimeType": "image/png"},
                {
                    "type": "text",
                    "text": json.dumps(
                        {
                            "width": result.get("width"),
                            "height": result.get("height"),
                            "originX": result.get("originX"),
                            "originY": result.get("originY"),
                            "screenWidth": result.get("screenWidth"),
                            "screenHeight": result.get("screenHeight"),
                            "scale": result.get("scale"),
                        },
                        sort_keys=True,
                    ),
                },
            ],
            "isError": False,
        }
    return {"content": [{"type": "text", "text": "ok"}], "isError": False}


def tool_error(message):
    return {"content": [{"type": "text", "text": message}], "isError": True}


def handle(bridge, message):
    """One JSON-RPC message -> one response dict, or None for a notification."""
    if not isinstance(message, dict):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "invalid_request"}}
    method = message.get("method")
    request_id = message.get("id")
    if "id" not in message:
        # Notifications (initialized/cancelled) are acknowledged by silence.
        return None
    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "loom-computer-agent", "version": "1"},
            },
        }
    if method == "ping":
        return {"jsonrpc": "2.0", "id": request_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": bridge.tools()}}
    if method == "tools/call":
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        tool = params.get("name")
        arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        if tool not in TOOL_NAMES:
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": tool_error("unsupported_tool"),
            }
        if not bridge.allows(tool):
            # Refused before any request leaves the process: a capture grant can never be
            # widened by the model calling an input tool.
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": tool_error("scope_denied"),
            }
        try:
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": describe(bridge.call(request_id, tool, arguments)),
            }
        except BridgeError as failure:
            if failure.fatal:
                # The grant is gone: refuse and stop, so nothing retries into a dead
                # grant from this process.
                bridge.fatal = True
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": tool_error(failure.message),
            }
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": -32601, "message": "method_not_found"},
    }


def read_token(path):
    try:
        with open(path, "rb") as handle_file:
            token = handle_file.read(129)
    except Exception:  # noqa: BLE001 - any read problem means "no token"
        raise BridgeError("token_unavailable", fatal=True)
    if len(token) > 128:
        raise BridgeError("token_unavailable", fatal=True)
    text = token.decode("utf-8", "strict").strip()
    if len(text) != 64 or any(character not in "0123456789abcdef" for character in text):
        raise BridgeError("token_unavailable", fatal=True)
    return text


def main():
    configure_stdio()
    endpoint = os.environ.get("LOOM_COMPUTER_AGENT_ENDPOINT", "")
    origin = os.environ.get("LOOM_COMPUTER_AGENT_ORIGIN", "")
    token_path = os.environ.get("LOOM_COMPUTER_AGENT_TOKEN_FILE", "")
    digest = os.environ.get("LOOM_COMPUTER_AGENT_DIGEST", "").strip()
    timeout = DEFAULT_TIMEOUT_SECONDS
    if os.environ.get("LOOM_COMPUTER_AGENT_TIMEOUT_SECONDS", "").isdigit():
        timeout = max(1, min(60, int(os.environ["LOOM_COMPUTER_AGENT_TIMEOUT_SECONDS"])))
    try:
        if not token_path:
            raise BridgeError("token_unavailable", fatal=True)
        if not digest or len(digest) > 128:
            raise BridgeError("digest_unavailable", fatal=True)
        authority = read_authority(os.environ)
        endpoint, origin = validate_endpoint(endpoint, origin)
        token = read_token(token_path)
    except BridgeError as failure:
        # Fail closed without ever printing the token or the path.
        sys.stderr.write(json.dumps({"bridge": "unavailable", "reason": failure.message}) + "\n")
        return 2
    # The runtime was admitted above; only the permission decides the exposed surface.
    bridge = Bridge(endpoint, origin, token, timeout, digest, scope=authority["scope"])
    for line in sys.stdin.buffer:
        if len(line) > MAX_LINE_BYTES:
            sys.stdout.write(
                json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "request_too_large"}})
                + "\n"
            )
            sys.stdout.flush()
            continue
        if not line.strip():
            continue
        try:
            message = json.loads(line.decode("utf-8"))
        except Exception:  # noqa: BLE001
            sys.stdout.write(
                json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse_error"}})
                + "\n"
            )
            sys.stdout.flush()
            continue
        response = handle(bridge, message)
        if response is None:
            continue
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()
        if bridge.fatal:
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
