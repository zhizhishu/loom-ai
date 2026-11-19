#!/usr/bin/env python3
"""Tests for the LOOM Computer helper: pure contract plus real desktop acceptance.

The pure tests never capture a screen, never inject input and never need Pillow.
They own the closed input whitelist, the coordinate/origin arithmetic, the
Windows INPUT plan, device identity and the stdin-only request framing.

The real desktop acceptance (`LiveDesktopAcceptance`) is opt-in through
`LOOM_COMPUTER_LIVE_ACCEPTANCE=1` and needs a private Xvfb display plus
`xdotool`, `xmessage` and `xterm` (installed by `scripts/bero/loom-dev-setup.sh`).
It drives the shipped one-shot helper over stdin, one process per operation.

Run pure only:
    python3 -m unittest discover -s resources/computer -p test_host_desktop.py -v
Run pure + real desktop:
    LOOM_COMPUTER_LIVE_ACCEPTANCE=1 xvfb-run -a python3 -m unittest discover \
        -s resources/computer -p test_host_desktop.py -v
"""

import ctypes
import importlib.util
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

MODULE_PATH = pathlib.Path(__file__).with_name("host_desktop.py")
SPEC = importlib.util.spec_from_file_location("loom_host_desktop", MODULE_PATH)
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)

# A deliberate multi-monitor layout with a negative origin.
BOUNDS = (-1920, 0, 3840, 1080)


class TextWhitelist(unittest.TestCase):
    def test_accepts_bounded_typed_text(self):
        self.assertEqual(helper.validate_text("hi"), "hi")
        self.assertEqual(helper.validate_text("a" * helper.MAX_TEXT_CODEPOINTS),
                         "a" * helper.MAX_TEXT_CODEPOINTS)
        self.assertEqual(helper.validate_text("中文 ok"), "中文 ok")

    def test_rejects_overlong_empty_and_control_text(self):
        for value in [
            "",
            "a" * (helper.MAX_TEXT_CODEPOINTS + 1),
            "line\nbreak",
            "tab\there",
            "nul\x00",
            "del\x7f",
            "carriage\r",
        ]:
            with self.assertRaises(helper.Failure) as raised:
                helper.validate_text(value)
            self.assertEqual(raised.exception.code, "invalid_request", value[:8])

    def test_rejects_non_string_and_astral_text(self):
        for value in [None, 5, b"bytes", ["a"]]:
            with self.assertRaises(helper.Failure):
                helper.validate_text(value)
        # Surrogate pairs would have to be synthesised by the unicode key path.
        with self.assertRaises(helper.Failure):
            helper.validate_text("emoji \U0001F600")
        with self.assertRaises(helper.Failure):
            helper.validate_text("lone \ud800")


class PointerWhitelist(unittest.TestCase):
    def test_click_is_one_atomic_down_up_pair(self):
        plan = helper.plan_input(
            {"op": "pointer", "x": 10, "y": 20, "button": "left", "action": "click"},
            BOUNDS,
            unicode_text=True,
        )
        self.assertEqual(
            plan,
            [("button", 10, 20, "left", "down"), ("button", 10, 20, "left", "up")],
        )

    def test_move_carries_no_button(self):
        plan = helper.plan_input(
            {"op": "pointer", "x": -10, "y": 5, "action": "move"}, BOUNDS, unicode_text=True
        )
        self.assertEqual(plan, [("move", -10, 5)])
        with self.assertRaises(helper.Failure):
            helper.plan_input(
                {"op": "pointer", "x": 1, "y": 1, "button": "left", "action": "move"},
                BOUNDS,
                unicode_text=True,
            )

    def test_signed_origins_are_checked_against_the_device_bounds(self):
        for x, y in [(-1920, 0), (-1, 1079), (1919, 1079), (0, 0)]:
            self.assertEqual(
                helper.plan_input(
                    {"op": "pointer", "x": x, "y": y, "action": "move"},
                    BOUNDS,
                    unicode_text=True,
                ),
                [("move", x, y)],
            )
        for x, y in [(-1921, 0), (1920, 0), (0, 1080), (0, -1)]:
            with self.assertRaises(helper.Failure) as raised:
                helper.plan_input(
                    {"op": "pointer", "x": x, "y": y, "action": "move"},
                    BOUNDS,
                    unicode_text=True,
                )
            self.assertEqual(raised.exception.code, "invalid_request")

    def test_malformed_pointer_fields_are_refused(self):
        for request in [
            {"op": "pointer", "y": 1, "action": "move"},
            {"op": "pointer", "x": 1, "action": "move"},
            {"op": "pointer", "x": True, "y": 1, "action": "move"},
            {"op": "pointer", "x": 1.5, "y": 1, "action": "move"},
            {"op": "pointer", "x": 1, "y": 1, "action": "teleport"},
            {"op": "pointer", "x": 1, "y": 1, "button": "left"},
            {"op": "pointer", "x": 1, "y": 1, "button": "side", "action": "click"},
            {"op": "pointer", "x": 1, "y": 1, "action": "down"},
        ]:
            with self.assertRaises(helper.Failure):
                helper.plan_input(request, BOUNDS, unicode_text=True)

    def test_wheel_bounds(self):
        self.assertEqual(
            helper.plan_input({"op": "wheel", "x": 1, "y": 2, "delta": -3}, BOUNDS,
                              unicode_text=True),
            [("wheel", 1, 2, -3)],
        )
        for delta in [0, helper.MAX_WHEEL + 1, -helper.MAX_WHEEL - 1, True]:
            with self.assertRaises(helper.Failure):
                helper.plan_input({"op": "wheel", "x": 1, "y": 2, "delta": delta},
                                  BOUNDS, unicode_text=True)


class KeyWhitelist(unittest.TestCase):
    def test_keys_are_always_taps(self):
        for name in sorted(helper.KEYS):
            plan = helper.plan_input({"op": "key", "key": name}, BOUNDS, unicode_text=True)
            self.assertEqual(plan, [("key", name, "down"), ("key", name, "up")])

    def test_unknown_keys_and_smuggled_fields_are_refused(self):
        for request in [
            {"op": "key", "key": "a"},
            {"op": "key", "key": "keydown"},
            {"op": "key"},
            {"op": "shell", "command": "calc.exe"},
            {"op": "key", "key": "enter", "command": "calc.exe"},
        ]:
            with self.assertRaises(helper.Failure) as raised:
                helper.plan_input(request, BOUNDS, unicode_text=True)
            self.assertEqual(raised.exception.code, "invalid_request")

    def test_text_planning_depends_on_backend_encoder(self):
        plan = helper.plan_input({"op": "text", "text": "Ok"}, BOUNDS, unicode_text=True)
        self.assertEqual(plan, [("unicode", ord("O")), ("unicode", ord("k"))])
        ansi = helper.plan_input({"op": "text", "text": "Ok"}, BOUNDS, unicode_text=False)
        self.assertEqual(ansi, [("keysym", ord("O")), ("keysym", ord("k"))])
        # X11 keysyms only map Latin-1 without an input-method round trip.
        with self.assertRaises(helper.Failure) as raised:
            helper.plan_input({"op": "text", "text": "中文"}, BOUNDS, unicode_text=False)
        self.assertEqual(raised.exception.code, "unsupported_input")


class WindowsInputPlan(unittest.TestCase):
    def test_normalize_maps_signed_origins_onto_the_absolute_space(self):
        self.assertEqual(helper.normalize(-1920, 0, BOUNDS), (0, 0))
        self.assertEqual(helper.normalize(1919, 1079, BOUNDS), (65535, 65535))
        # The middle of the device stays strictly inside the absolute range.
        middle = helper.normalize(0, 0, BOUNDS)[0]
        self.assertTrue(0 < middle < 65535, middle)
        # A degenerate one-pixel axis must not divide by zero.
        self.assertEqual(helper.normalize(7, 9, (7, 9, 1, 1)), (0, 0))

    def test_button_and_unicode_flags(self):
        steps = helper.build_send_input(
            [
                ("button", 0, 0, "left", "down"),
                ("button", 0, 0, "left", "up"),
                ("key", "enter", "down"),
                ("key", "enter", "up"),
                ("unicode", ord("A")),
                ("wheel", 0, 0, 2),
            ],
            BOUNDS,
        )
        move = (helper.MOUSEEVENTF_MOVE | helper.MOUSEEVENTF_ABSOLUTE
                | helper.MOUSEEVENTF_VIRTUALDESK)
        placed = helper.MOUSEEVENTF_ABSOLUTE | helper.MOUSEEVENTF_VIRTUALDESK
        # Every button and wheel step is preceded by an absolute move, so a
        # click lands where the client asked even on a multi-monitor layout.
        self.assertEqual(len(steps), 10)
        self.assertEqual(steps[0][:2], (0, move))
        self.assertEqual(steps[1][1], placed | helper.BUTTON_FLAGS[("left", "down")])
        self.assertEqual(steps[2][:2], (0, move))
        self.assertEqual(steps[3][1], placed | helper.BUTTON_FLAGS[("left", "up")])
        # Keyboard entries are their own INPUT type, taps differ only by KEYUP.
        self.assertEqual(steps[4][0], 1)
        self.assertEqual(steps[4][1], 0)
        self.assertEqual(steps[4][5], helper.WINDOWS_VK["enter"])
        self.assertEqual(steps[5][1], helper.KEYEVENTF_KEYUP)
        # A unicode character is a down *and* a matching up for its code unit.
        self.assertEqual(steps[6][1], helper.KEYEVENTF_UNICODE)
        self.assertEqual(steps[6][6], ord("A"))
        self.assertEqual(steps[7][1], helper.KEYEVENTF_UNICODE | helper.KEYEVENTF_KEYUP)
        self.assertEqual(steps[7][6], ord("A"))
        self.assertEqual(steps[8][:2], (0, move))
        self.assertEqual(steps[9][1], placed | helper.MOUSEEVENTF_WHEEL)
        self.assertEqual(steps[9][4], 240)

    def test_release_never_moves_the_pointer(self):
        steps = helper.build_button_release()
        self.assertEqual(len(steps), 3)
        for step in steps:
            self.assertEqual(step[0], 0)
            self.assertFalse(step[1] & helper.MOUSEEVENTF_MOVE)
        self.assertEqual({step[1] & 0x00FF for step in steps},
                         {0x0004, 0x0010, 0x0040})


class WindowsUnicodeText(unittest.TestCase):
    """Typed text must arrive whole: one down *and* one up per UTF-16 code unit.

    Pure plan construction only; no `user32` call, no window, no injected keystroke.
    """

    def test_repeated_characters_each_get_a_paired_tap(self):
        steps = helper.build_send_input(
            [("unicode", ord(character)) for character in "LLOOM"], BOUNDS
        )
        self.assertEqual(len(steps), 2 * len("LLOOM"))
        # The observed native bug produced "LOM" from "LLOOM": every unit pairs now.
        for index in range(0, len(steps), 2):
            down, up = steps[index], steps[index + 1]
            self.assertEqual(down[0], 1)
            self.assertEqual(down[1], helper.KEYEVENTF_UNICODE)
            self.assertEqual(up[0], 1)
            self.assertEqual(up[1], helper.KEYEVENTF_UNICODE | helper.KEYEVENTF_KEYUP)
            self.assertEqual(down[6], up[6], "the up must target the same code unit")
            self.assertEqual(down[5], 0, "wVk must be zero for unicode input")
            self.assertEqual(up[5], 0)
        self.assertEqual(
            [down[6] for down in steps[0::2]],
            [ord(character) for character in "LLOOM"],
        )

    def test_supplementary_plane_is_sent_as_its_surrogate_pair(self):
        self.assertEqual(helper.unicode_units(0x1F600), (0xD83D, 0xDE00))
        steps = helper.build_send_input([("unicode", 0x1F600)], BOUNDS)
        self.assertEqual(len(steps), 4)
        self.assertEqual([step[6] for step in steps], [0xD83D, 0xD83D, 0xDE00, 0xDE00])
        self.assertEqual(
            [step[1] for step in steps],
            [
                helper.KEYEVENTF_UNICODE,
                helper.KEYEVENTF_UNICODE | helper.KEYEVENTF_KEYUP,
                helper.KEYEVENTF_UNICODE,
                helper.KEYEVENTF_UNICODE | helper.KEYEVENTF_KEYUP,
            ],
        )
        # Every unit fits the WORD that KEYBDINPUT.wScan actually is.
        self.assertTrue(all(step[6] <= 0xFFFF for step in steps))

    def test_unicode_units_refuse_invalid_code_points(self):
        self.assertEqual(helper.unicode_units(ord("A")), (ord("A"),))
        self.assertEqual(helper.unicode_units(0xFFFF), (0xFFFF,))
        for rejected in [-1, 0x110000, 0xD800, 0xDFFF, True, 1.5, "A"]:
            with self.assertRaises(helper.Failure, msg=repr(rejected)):
                helper.unicode_units(rejected)


class PartialSendCleanup(unittest.TestCase):
    """A partial native send must release what it pressed and never press again.

    Pure mock: `ctypes` only builds structures here, no `user32` symbol is loaded and no
    button or key is ever injected into this desktop.
    """

    class FakeUser32:
        def __init__(self, accepted):
            self.accepted = accepted
            self.batches = []

        def SendInput(self, count, _pointer, _size):  # noqa: N802 - Windows name
            self.batches.append(count)
            if len(self.batches) == 1:
                return self.accepted
            return count

    def steps(self):
        return helper.build_send_input(
            [
                ("button", 0, 0, "left", "down"),
                ("button", 0, 0, "left", "up"),
                ("key", "enter", "down"),
                ("key", "enter", "up"),
            ],
            BOUNDS,
        )

    def test_partial_prefix_triggers_one_up_only_cleanup_batch(self):
        fake = self.FakeUser32(accepted=1)
        with self.assertRaises(helper.Failure):
            helper._deliver(ctypes, fake, self.steps())
        self.assertEqual(len(fake.batches), 2, "the failed send plus exactly one cleanup")
        releases = helper.build_release_steps(self.steps())
        self.assertTrue(releases)
        for kind, flags, _dx, _dy, _data, _virtual_key, _scan in releases:
            if kind == 0:
                for down_flag in (helper.BUTTON_FLAGS[("left", "down")],
                                  helper.BUTTON_FLAGS[("right", "down")],
                                  helper.BUTTON_FLAGS[("middle", "down")]):
                    self.assertFalse(flags & down_flag, "cleanup must never press")
            else:
                self.assertTrue(flags & helper.KEYEVENTF_KEYUP)

    def test_cleanup_has_no_button_step_for_a_wheel_send(self):
        wheel_only = helper.build_send_input([("wheel", 5, 5, 2)], BOUNDS)
        self.assertEqual(helper.build_release_steps(wheel_only), [])

    def test_a_synchronous_exception_also_cleans_up(self):
        class Raising:
            def __init__(self):
                self.batches = 0

            def SendInput(self, *_args):  # noqa: N802 - Windows name
                self.batches += 1
                raise OSError("native failure")

        fake = Raising()
        with self.assertRaises(OSError):
            helper._deliver(ctypes, fake, self.steps())
        # The cleanup attempt is counted; the original error is what propagates.
        self.assertEqual(fake.batches, 2)

    def test_partial_unicode_send_releases_with_unicode_keyup_only(self):
        steps = helper.build_send_input(
            [("unicode", ord("A")), ("unicode", ord("B"))], BOUNDS
        )
        self.assertEqual(len(steps), 4)
        # Only the first down was accepted by the native call.
        fake = self.FakeUser32(accepted=1)
        with self.assertRaises(helper.Failure):
            helper._deliver(ctypes, fake, steps)
        self.assertEqual(len(fake.batches), 2, "one failed send plus one cleanup")
        releases = helper.build_release_steps(steps)
        self.assertEqual([release[6] for release in releases], [ord("A"), ord("B")])
        for kind, flags, dx, dy, data, virtual_key, _scan in releases:
            self.assertEqual(kind, 1)
            self.assertTrue(flags & helper.KEYEVENTF_KEYUP, "cleanup must be an up")
            self.assertTrue(
                flags & helper.KEYEVENTF_UNICODE,
                "a unicode key-up without the unicode flag addresses a different key",
            )
            self.assertEqual((dx, dy, data, virtual_key), (0, 0, 0, 0))

    def test_cleanup_never_synthesises_a_press(self):
        for plan in [
            self.steps(),
            helper.build_send_input([("unicode", ord("L"))], BOUNDS),
            helper.build_send_input([("unicode", 0x1F600)], BOUNDS),
            helper.build_send_input(
                [("key", "enter", "down"), ("key", "enter", "up")], BOUNDS
            ),
        ]:
            for kind, flags, _dx, _dy, _data, _virtual_key, _scan in helper.build_release_steps(plan):
                if kind == 0:
                    for down_flag in (
                        helper.BUTTON_FLAGS[("left", "down")],
                        helper.BUTTON_FLAGS[("right", "down")],
                        helper.BUTTON_FLAGS[("middle", "down")],
                    ):
                        self.assertFalse(flags & down_flag)
                else:
                    self.assertTrue(flags & helper.KEYEVENTF_KEYUP)


class CaptureRefusals(unittest.TestCase):
    def test_capture_requires_explicit_consent_before_any_backend(self):
        with self.assertRaises(helper.Failure) as raised:
            helper.capture("linux", {"op": "capture"}, 100, 100)
        self.assertEqual(raised.exception.code, "invalid_request")
        with self.assertRaises(helper.Failure):
            helper.capture("win32", {"op": "capture", "consent": "yes"}, 100, 100)

    def test_missing_encoder_is_reported_not_faked(self):
        with mock.patch.dict(sys.modules, {"PIL": None}):
            with self.assertRaises(helper.Failure) as raised:
                helper._load_pillow()
        self.assertEqual(raised.exception.code, "encoder_unavailable")

    def test_missing_display_is_its_own_refusal(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(helper.Failure) as raised:
                helper.linux_display()
        self.assertEqual(raised.exception.code, "no_display")
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(helper.Failure) as raised:
                helper.handle({"op": "pointer", "x": 1, "y": 1, "action": "move"},
                              "linux", None)
        self.assertEqual(raised.exception.code, "no_display")

    def test_bounds_and_scaling_limits(self):
        self.assertEqual(helper.validate_bounds(BOUNDS), BOUNDS)
        for bounds in [(0, 0, 0, 10), (0, 0, 10, 0),
                       (helper.OFFSET_LIMIT + 1, 0, 10, 10),
                       (0, 0, helper.MAX_DIMENSION * 4 + 1, 10)]:
            with self.assertRaises(helper.Failure):
                helper.validate_bounds(bounds)
        self.assertEqual(helper.scaled(3840, 2160, 1920, 1080)[:2], (1920, 1080))
        self.assertEqual(helper.scaled(800, 600, 1920, 1080)[:2], (800, 600))
        self.assertEqual(helper.scaled(10000, 10, 100, 100)[:2], (100, 1))


class DeviceIdentity(unittest.TestCase):
    def test_device_id_is_stable_and_layout_specific(self):
        first = helper.device_id("windows-gdi", BOUNDS)
        self.assertEqual(first, helper.device_id("windows-gdi", BOUNDS))
        self.assertTrue(first.startswith("sha256:"))
        self.assertEqual(len(first), len("sha256:") + 64)
        self.assertNotEqual(first, helper.device_id("windows-gdi", (0, 0, 3840, 1080)))
        self.assertNotEqual(first, helper.device_id("linux-x11", BOUNDS))


class StdinProtocol(unittest.TestCase):
    """The request must travel on stdin; malformed input never reaches a device."""

    def run_helper(self, payload, clear_display=False):
        environment = dict(os.environ)
        if clear_display:
            environment.pop("DISPLAY", None)
        return subprocess.run(
            [sys.executable, str(MODULE_PATH)],
            input=payload,
            capture_output=True,
            timeout=60,
            env=environment,
        )

    def test_malformed_stdin_is_refused_without_a_backend(self):
        for payload in [b"", b"not json\n", b"[]\n", b"{\"op\":\"\"}\n"]:
            completed = self.run_helper(payload)
            self.assertNotEqual(completed.returncode, 0, payload)
            header = json.loads(completed.stdout.split(b"\n", 1)[0])
            self.assertFalse(header["ok"])
            self.assertEqual(header["error"], "invalid_request")

    def test_capture_without_consent_is_refused(self):
        completed = self.run_helper(
            b'{"op":"capture","consent":false,"maxWidth":10,"maxHeight":10}\n'
        )
        self.assertNotEqual(completed.returncode, 0)
        header = json.loads(completed.stdout.split(b"\n", 1)[0])
        self.assertEqual(header["error"], "invalid_request")
        self.assertEqual(completed.stdout.split(b"\n", 1)[1], b"")

    @unittest.skipIf(sys.platform == "win32", "POSIX display check only")
    def test_linux_without_display_reports_no_display(self):
        completed = self.run_helper(b'{"op":"info"}\n', clear_display=True)
        self.assertNotEqual(completed.returncode, 0)
        header = json.loads(completed.stdout.split(b"\n", 1)[0])
        self.assertEqual(header["error"], "no_display")


# ------------------------------------------------- real desktop acceptance
#
# Ported from Mikka's isolated computer-use fixture
# (`packages/daemon/src/computer/xvfb.test.mjs`, mikka-full d59c85cb): a private
# Xvfb display, one dedicated window per observation, and the
# screenshot -> click -> typed input -> re-observe sequence. The upstream fixture
# drives a pinned JS driver through a broker; here the same sequence drives
# LOOM's shipped `host_desktop.py` one-shot helper over stdin, so the acceptance
# covers the real protocol, the real X server and real injected events.
#
# Every observation is made outside the helper: the X server is asked whether the
# window still exists, the fixture process exit status is read, and the text the
# target application received is compared with the marker.

LIVE_ENV = "LOOM_COMPUTER_LIVE_ACCEPTANCE"
LIVE_SCREENSHOT_ENV = "LOOM_COMPUTER_LIVE_ACCEPTANCE_SCREENSHOT"
LIVE_SCREEN = (1024, 768)
# The X11 text path is a bare keysym tap with no held shift, so only unshifted
# characters can be delivered: the marker is deliberately lowercase ASCII.
LIVE_MARKER = "loom isolated desktop input"
LIVE_TOOLS = ("Xvfb", "xdpyinfo", "xdotool", "xmessage", "xterm")
# The bottom-left default button, as measured in the upstream fixture.
BUTTON_INSET = (16, 14)


def live_acceptance_enabled(value=None):
    """The real desktop fixture is opt-in: only the literal "1" enables it."""
    if value is None:
        value = os.environ.get(LIVE_ENV, "")
    return value == "1"


def call_helper(request, environment=None, timeout=60):
    """One helper round trip on stdin; returns (status, header, body)."""
    completed = subprocess.run(
        [sys.executable, str(MODULE_PATH)],
        input=json.dumps(request).encode("utf-8") + b"\n",
        capture_output=True,
        timeout=timeout,
        env=environment,
    )
    header_line, separator, body = completed.stdout.partition(b"\n")
    header = json.loads(header_line) if header_line.strip() else {}
    return completed.returncode, header, (body if separator else b"")


def free_display_number(lock_dir="/tmp", socket_dir="/tmp/.X11-unix",
                        candidates=range(101, 201)):
    """First private display number with neither an X lock file nor a socket."""
    for number in candidates:
        if os.path.exists(os.path.join(lock_dir, ".X%d-lock" % number)):
            continue
        if os.path.exists(os.path.join(socket_dir, "X%d" % number)):
            continue
        return number
    return None


def dedicated_title(label):
    """A per-test window title, so one fixture can never match another."""
    return "loom %s %s" % (label, os.urandom(3).hex())


def find_window(environment, name, only_visible=False):
    command = ["xdotool", "search"]
    if only_visible:
        command.append("--onlyvisible")
    command += ["--name", name]
    completed = subprocess.run(command, env=environment, capture_output=True, text=True)
    if completed.returncode != 0:
        return ""
    for window in completed.stdout.split():
        return window
    return ""


def await_window(environment, name, process=None, only_visible=False, attempts=100):
    for _ in range(attempts):
        if process is not None and process.poll() is not None:
            raise AssertionError(
                "fixture window %r exited with %s before it was observed"
                % (name, process.returncode)
            )
        window = find_window(environment, name, only_visible)
        if window:
            return window
        time.sleep(0.1)
    raise AssertionError("fixture window %r never appeared on the isolated display" % name)


def window_geometry(environment, window):
    """(x, y, width, height) of a real mapped window, from the X server."""
    completed = subprocess.run(
        ["xdotool", "getwindowgeometry", "--shell", window],
        env=environment, capture_output=True, text=True, check=True,
    )
    values = {}
    for line in completed.stdout.splitlines():
        key, _, value = line.partition("=")
        if key and value.strip().lstrip("-").isdigit():
            values[key] = int(value)
    return values["X"], values["Y"], values["WIDTH"], values["HEIGHT"]


def button_point(geometry):
    """Click point of the default bottom-left button inside `geometry`.

    Derived instead of hard-coded: for the upstream 400x140+200+200 dialog this
    reproduces the fixture's known-good (216, 326) desktop point.
    """
    x, y, _width, height = geometry
    return x + BUTTON_INSET[0], y + height - BUTTON_INSET[1]


class IsolatedDisplay:
    """A private Xvfb display: never the ambient desktop, never a fixed number."""

    def __init__(self, width, height, lock_dir="/tmp", socket_dir="/tmp/.X11-unix"):
        self.width = width
        self.height = height
        self.lock_dir = lock_dir
        self.socket_dir = socket_dir
        self.name = ""
        self.process = None

    def start(self, attempts=3):
        if shutil.which("Xvfb") is None:
            raise RuntimeError(
                "Xvfb is missing; scripts/bero/loom-dev-setup.sh installs the fixture tools"
            )
        tried = []
        for _ in range(attempts):
            number = free_display_number(
                self.lock_dir, self.socket_dir,
                candidates=[n for n in range(101, 201) if n not in tried],
            )
            if number is None:
                break
            tried.append(number)
            self.name = ":%d" % number
            if self.spawn(number):
                return self.name
        raise RuntimeError(
            "isolated X display did not become ready (tried %s)" % (tried or "nothing")
        )

    def spawn(self, number):
        """Try the display number already selected; a lost race is retried."""
        self.process = subprocess.Popen(
            ["Xvfb", ":%d" % number, "-screen", "0", "%dx%dx24" % (self.width, self.height),
             "-nolisten", "tcp"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        for _ in range(100):
            if self.process.poll() is not None:
                break
            if self.ready():
                return True
            time.sleep(0.1)
        self.stop()
        return False

    def environment(self):
        return dict(os.environ, DISPLAY=self.name)

    def ready(self):
        completed = subprocess.run(
            ["xdpyinfo"], env=self.environment(),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        return completed.returncode == 0

    def stop(self):
        process, self.process = self.process, None
        if process is None:
            return
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)


class LiveFixtureContract(unittest.TestCase):
    """Pure contract of the live fixture; runs under plain discovery too."""

    def test_the_live_gate_requires_an_explicit_one(self):
        self.assertTrue(live_acceptance_enabled("1"))
        for value in ["", "0", "true", "yes", "on", "01", " "]:
            self.assertFalse(live_acceptance_enabled(value), value)

    def test_the_marker_is_deliverable_by_the_x11_text_path(self):
        # A held shift cannot be expressed, so the marker must stay unshifted.
        self.assertEqual(LIVE_MARKER, LIVE_MARKER.lower())
        self.assertTrue(all(ord(character) < 0x100 for character in LIVE_MARKER))
        self.assertEqual(
            helper.plan_input({"op": "text", "text": LIVE_MARKER}, BOUNDS,
                              unicode_text=False),
            [("keysym", ord(character)) for character in LIVE_MARKER],
        )

    def test_button_point_reproduces_the_ported_upstream_click(self):
        self.assertEqual(button_point((200, 200, 400, 140)), (216, 326))
        self.assertEqual(button_point((0, 0, 400, 140)), (16, 126))
        self.assertEqual(button_point((10, 20, 800, 300)), (26, 306))

    def test_free_display_numbers_skip_locks_and_sockets(self):
        with tempfile.TemporaryDirectory() as root:
            locks = os.path.join(root, "locks")
            sockets = os.path.join(root, "sockets")
            os.makedirs(locks)
            os.makedirs(sockets)
            for number in (101, 102, 104):
                pathlib.Path(locks, ".X%d-lock" % number).write_text("", encoding="utf-8")
            pathlib.Path(sockets, "X103").write_text("", encoding="utf-8")
            self.assertEqual(
                free_display_number(locks, sockets, candidates=range(101, 106)), 105
            )
            for number in range(101, 106):
                pathlib.Path(locks, ".X%d-lock" % number).write_text("", encoding="utf-8")
            self.assertIsNone(free_display_number(locks, sockets, candidates=range(101, 106)))

    @unittest.skipIf(sys.platform == "win32", "POSIX display check only")
    def test_the_shared_call_path_reports_a_refusal_without_a_body(self):
        environment = dict(os.environ)
        environment.pop("DISPLAY", None)
        status, header, body = call_helper({"op": "info"}, environment=environment)
        self.assertNotEqual(status, 0)
        self.assertFalse(header["ok"])
        self.assertEqual(header["error"], "no_display")
        self.assertEqual(body, b"")

    def test_the_display_refuses_to_start_without_xvfb(self):
        display = IsolatedDisplay(*LIVE_SCREEN)
        with mock.patch.object(shutil, "which", return_value=None):
            with self.assertRaises(RuntimeError):
                display.start()
        self.assertIsNone(display.process)
        display.stop()  # idempotent teardown

    def test_the_display_retries_a_display_number_it_lost(self):
        with tempfile.TemporaryDirectory() as root:
            locks = os.path.join(root, "locks")
            sockets = os.path.join(root, "sockets")
            os.makedirs(locks)
            os.makedirs(sockets)
            display = IsolatedDisplay(*LIVE_SCREEN, lock_dir=locks, socket_dir=sockets)
            spawned = []

            def spawn(_display, number):
                spawned.append(number)
                return len(spawned) == 2

            with mock.patch.object(shutil, "which", return_value="/usr/bin/Xvfb"), \
                    mock.patch.object(IsolatedDisplay, "spawn", spawn):
                self.assertEqual(display.start(attempts=3), ":102")
            self.assertEqual(spawned, [101, 102])


@unittest.skipUnless(
    live_acceptance_enabled(),
    "set LOOM_COMPUTER_LIVE_ACCEPTANCE=1 to run the real desktop acceptance",
)
class LiveDesktopAcceptance(unittest.TestCase):
    """Real pixels and real injected input on a private Xvfb display.

    Screenshot -> click -> observed window closure, and screenshot -> type ->
    observed application text. Both transitions are observed from outside the
    helper, so a command receipt can never stand in for a desktop change.
    """

    @classmethod
    def setUpClass(cls):
        missing = [tool for tool in LIVE_TOOLS if shutil.which(tool) is None]
        if missing:
            # A skipped real case would prove nothing, so this is a failure.
            raise AssertionError(
                "live desktop acceptance needs %s; run scripts/bero/loom-dev-setup.sh"
                % ", ".join(missing)
            )
        cls.display = IsolatedDisplay(*LIVE_SCREEN)
        cls.display.start()
        cls.environment = cls.display.environment()
        if os.environ.get("DISPLAY") == cls.display.name:
            raise AssertionError("the fixture must not run on the ambient display")

    @classmethod
    def tearDownClass(cls):
        cls.display.stop()

    # ------------------------------------------------------------ fixtures

    def reap(self, process):
        if process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)

    def dialog(self, title):
        process = subprocess.Popen(
            ["xmessage", "-title", title, "-geometry", "400x140+200+200",
             "-buttons", "OK:0", "LOOM isolated computer-use test"],
            env=self.environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.addCleanup(self.reap, process)
        return process

    def focus(self, window):
        completed = None
        for _ in range(20):
            completed = subprocess.run(
                ["xdotool", "windowfocus", "--sync", window],
                env=self.environment, capture_output=True, text=True,
            )
            if completed.returncode == 0:
                return
            # A window mapped a moment ago cannot take focus yet (X BadMatch).
            time.sleep(0.1)
        raise AssertionError("could not focus the fixture window: %s" % completed.stderr)

    def capture(self, label):
        status, header, body = call_helper(
            {"op": "capture", "consent": True, "maxWidth": 1920, "maxHeight": 1080},
            environment=self.environment,
        )
        self.assertEqual(status, 0, header)
        self.assertTrue(header.get("ok"), header)
        self.assertEqual(header["platform"], "linux-x11")
        self.assertEqual(header["bytes"], len(body))
        self.assertTrue(body.startswith(b"\x89PNG\r\n\x1a\n"), "a real PNG frame")
        self.assertEqual((header["width"], header["height"]), LIVE_SCREEN)
        self.assertEqual(header["scale"], 1.0)
        self.assertEqual((header["originX"], header["originY"]), (0, 0))
        self.assertEqual(
            (header["screenWidth"], header["screenHeight"]), LIVE_SCREEN
        )
        self.save_screenshot(label, body)
        return header, body

    def save_screenshot(self, label, data):
        target = os.environ.get(LIVE_SCREENSHOT_ENV)
        if not target:
            return
        path = pathlib.Path(target)
        path.parent.mkdir(parents=True, exist_ok=True)
        pathlib.Path("%s-%s.png" % (str(path.with_suffix("")), label)).write_bytes(data)

    def decode(self, data):
        try:
            from PIL import Image  # noqa: PLC0415 - the helper's own encoder dependency
        except Exception as error:  # noqa: BLE001 - report, never fake a pass
            raise AssertionError(
                "decoding a real frame needs Pillow (python3-pil): %s" % error
            )
        return Image.open(io.BytesIO(data))

    def changed_pixels(self, before, after, box):
        """How many pixels differ inside `box` between two real frames."""
        from PIL import ImageChops  # noqa: PLC0415 - same optional dependency
        difference = ImageChops.difference(before.crop(box), after.crop(box)).convert("L")
        return sum(1 for value in difference.getdata() if value)

    # -------------------------------------------------------------- checks

    def test_capture_observes_the_isolated_desktop(self):
        header, empty = self.capture("empty")
        self.assertTrue(header["deviceId"].startswith("sha256:"))
        title = dedicated_title("capture")
        process = self.dialog(title)
        window = await_window(self.environment, title, process)
        geometry = window_geometry(self.environment, window)
        self.assertEqual(geometry, (200, 200, 400, 140))
        same_header, picture = self.capture("dialog")
        self.assertEqual(same_header["deviceId"], header["deviceId"])
        self.assertNotEqual(empty, picture, "a mapped window must change the pixels")
        box = (geometry[0], geometry[1], geometry[0] + geometry[2],
               geometry[1] + geometry[3])
        with self.decode(empty) as before, self.decode(picture) as after:
            self.assertEqual(after.size, LIVE_SCREEN)
            changed = self.changed_pixels(before, after, box)
        # The window rectangle itself must be redrawn, not just a cursor or a border.
        self.assertGreater(changed, (box[2] - box[0]) * (box[3] - box[1]) // 4,
                           "the mapped dialog must cover its own desktop rectangle")

    def test_click_closes_the_dedicated_window(self):
        title = dedicated_title("click")
        process = self.dialog(title)
        window = await_window(self.environment, title, process)
        geometry = window_geometry(self.environment, window)
        point = button_point(geometry)
        _, before = self.capture("click-before")
        status, header, _ = call_helper(
            {"op": "pointer", "x": point[0], "y": point[1], "button": "left",
             "action": "click"},
            environment=self.environment,
        )
        self.assertEqual(status, 0, header)
        self.assertTrue(header.get("ok"), header)
        for _ in range(50):
            if process.poll() is not None:
                break
            time.sleep(0.1)
        self.assertEqual(process.returncode, 0, "the injected click dismissed the dialog")
        # The X server, not the helper, must report the window as gone.
        self.assertEqual(find_window(self.environment, title), "",
                         "the clicked window must disappear from the display")
        _, after = self.capture("click-after")
        self.assertNotEqual(before, after, "the desktop must be redrawn after the close")

    def test_typed_text_reaches_the_dedicated_window(self):
        workspace = pathlib.Path(tempfile.mkdtemp(prefix="loom-live-input-"))
        self.addCleanup(shutil.rmtree, workspace, True)
        typed = workspace / "typed.txt"
        reader = workspace / "reader.py"
        reader.write_text(
            "import pathlib, sys\n"
            "line = sys.stdin.readline()\n"
            "pathlib.Path(sys.argv[1]).write_text(line.rstrip('\\n'), encoding='utf-8')\n",
            encoding="utf-8",
        )
        title = dedicated_title("input")
        terminal = subprocess.Popen(
            ["xterm", "-title", title, "-geometry", "60x5+200+200", "-e",
             sys.executable, str(reader), str(typed)],
            env=self.environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.addCleanup(self.reap, terminal)
        window = await_window(self.environment, title, terminal, only_visible=True)
        self.focus(window)
        self.assertFalse(typed.exists(), "the application must not have the marker yet")
        for request in ({"op": "text", "text": LIVE_MARKER}, {"op": "key", "key": "enter"}):
            status, header, _ = call_helper(request, environment=self.environment)
            self.assertEqual(status, 0, header)
            self.assertTrue(header.get("ok"), header)
        for _ in range(50):
            if terminal.poll() is not None:
                break
            time.sleep(0.1)
        self.assertEqual(terminal.returncode, 0,
                         "the fixture application exits only after a complete line")
        self.assertEqual(typed.read_text(encoding="utf-8"), LIVE_MARKER,
                         "observed application text must match the typed marker")


if __name__ == "__main__":
    unittest.main()
