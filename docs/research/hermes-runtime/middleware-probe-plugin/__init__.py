"""Research only: public plugin APIs, no credentials and no automatic Run binding.

The harness selects exact native sessions for harmless marker experiments. That
selection is NOT an authorization mapping. No mode accepts a real CLI context.
"""

import json
import os
from pathlib import Path
import shlex
import time


IDENTIFIERS = (
    "session_id", "task_id", "turn_id", "api_request_id", "tool_call_id",
    "platform", "parent_session_id", "sender_id",
)


def register(ctx):
    root = Path(ctx.get_config("probe_root", ""))
    if not root.is_absolute() or not (root / "probe-state.json").is_file():
        raise ValueError("This research plugin requires an explicit isolated probe root")

    def record(phase, payload, **extra):
        # Never serialize args, requests, conversation content, tokens or credentials.
        row = {
            "phase": phase, "pid": os.getpid(), "monotonic_ns": time.monotonic_ns(),
            "available_fields": sorted(payload),
            **{key: payload.get(key) for key in IDENTIFIERS}, **extra,
        }
        fd = os.open(root / "observations.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, (json.dumps(row) + "\n").encode())
        finally:
            os.close(fd)

    record("register", {})

    def on_tool_request(**payload):
        args = payload.get("args") or {}
        state = json.loads((root / "probe-state.json").read_text())
        selected = payload.get("session_id") in state.get("marker_sessions", [])
        mode = state.get("mode", "observe") if selected else "observe"
        record("tool_request", payload, mode=mode, argument_keys=sorted(args),
               background=args.get("background"), timeout=args.get("timeout"),
               has_workdir="workdir" in args)
        if payload.get("tool_name") != "terminal" or not isinstance(args.get("command"), str):
            return None
        if mode == "raise":
            raise RuntimeError("intentional authority-free middleware probe failure")
        if mode not in {"marker_export", "marker_subshell"}:
            return None
        turn = payload.get("turn_id")
        if not isinstance(turn, str) or not turn:
            return None
        # Deliberately unusable authority: no real context file or Core grant exists.
        value = turn + " | quote:' dollar:$HOME newline:\nend"
        marker_env = {
            "ROVAI_MIDDLEWARE_PROBE": value,
            "ROVAI_CLI_CONTEXT": str(root / "no-authority" / turn / "context.json"),
            "ROVAI_AGENT_CLI": str(root / "no-authority" / "rovai"),
            "ROVAI_RUN_TMP": str(root / "no-authority" / turn / "run-tmp"),
        }
        prefix = "\n".join(f"export {key}={shlex.quote(val)}" for key, val in marker_env.items())
        prefix += "\nexport PATH=" + shlex.quote(str(root / "no-authority" / "bin")) + ':"$PATH"'
        command = prefix + "\n" + args["command"]
        if mode == "marker_subshell":
            # Experimental alternative only: contains exports, but also contains cd,
            # exports/functions/aliases deliberately performed by the original command.
            command = "(\n" + command + "\n)"
        record("rewrite", payload, mode=mode)
        return {"args": {**args, "command": command}, "source": "rovai-middleware-probe",
                "reason": "authority-free marker experiment"}

    ctx.register_middleware("tool_request", on_tool_request)
    for phase in ("pre_llm_call", "post_llm_call", "pre_api_request", "post_api_request",
                  "pre_tool_call", "post_tool_call", "post_compaction"):
        def observe(_phase=phase, **payload):
            record(_phase, payload)
        ctx.register_hook(phase, observe)
