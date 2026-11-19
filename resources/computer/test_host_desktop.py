#!/usr/bin/env python3
"""Pure tests for the LOOM Computer helper.

These tests never capture a screen, never inject input and never need Pillow.
They own the closed input whitelist, the coordinate/origin arithmetic, the
Windows INPUT plan, device identity and the stdin-only request framing.

Run: python -m unittest discover -s resources/computer -p 'test_*.py' -v
"""

import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import unittest
from unittest import mock

import ctypes

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


if __name__ == "__main__":
    unittest.main()
