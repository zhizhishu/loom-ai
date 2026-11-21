#!/usr/bin/env python3
"""Tests for the LOOM Computer helper: pure contract plus real desktop acceptance.

The pure tests never capture a screen, never inject input and never need Pillow.
They own the closed input whitelist, the coordinate/origin arithmetic, the
Windows INPUT plan, device identity and the stdin-only request framing.

The real desktop acceptance (`LiveDesktopAcceptance`) is opt-in through
`LOOM_COMPUTER_LIVE_ACCEPTANCE=1` and needs a private Xvfb display plus
`xdotool`, `xmessage`, `xterm` and `setxkbmap` (installed by
`scripts/bero/loom-dev-setup.sh`). It drives the shipped one-shot helper over
stdin, one process per operation, and one of its cases switches that display's
keyboard layout, so typed text is proven against a layout the helper does not
hard-code, and two cases change the display's own keyboard state (a second
layout group and Caps Lock) before typing.

Run pure only:
    python3 -m unittest discover -s resources/computer -p test_host_desktop.py -v
Run pure + real desktop:
    LOOM_COMPUTER_LIVE_ACCEPTANCE=1 xvfb-run -a python3 -m unittest discover \
        -s resources/computer -p test_host_desktop.py -v
"""

import ctypes
import ctypes.util
import importlib.util
import io
import json
import os
import pathlib
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
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
        # The X11 plan stays layout-independent: keycode and shift level are decided
        # at apply time from the display's own mapping (`X11TextLevels` below), so
        # one hard-coded layout can never be assumed here.
        self.assertEqual(ansi, [("keysym", ord("O")), ("keysym", ord("k"))])
        # X11 keysyms only map Latin-1 without an input-method round trip.
        with self.assertRaises(helper.Failure) as raised:
            helper.plan_input({"op": "text", "text": "中文"}, BOUNDS, unicode_text=False)
        self.assertEqual(raised.exception.code, "unsupported_input")


# Keyboard mappings in the shape the X server reports them: per keycode, the
# keysyms of the levels shift can reach. Letters and the space bar are the same on
# both fixtures; `+` is not, which is exactly the difference that must never be
# baked into the helper.
LIVE_LOWER = "abcdefghijklmnopqrstuvwxyz"
LETTER_KEYCODE = 38


def letter_keycode(letter):
    return LETTER_KEYCODE + LIVE_LOWER.index(letter)


COMMON_KEYMAP = (
    [(letter_keycode(letter), [ord(letter), ord(letter.upper())])
     for letter in LIVE_LOWER]
    + [(57, [ord(" "), ord(" ")]), (10, [ord("1"), ord("!")])]
)


def keymap(rows):
    """Rows in the order a real X server reports them."""
    return sorted(rows, key=lambda row: row[0])


# The two layouts differ in the key that carries `+` (shift level of `=` on us, a
# bare key on de), and in the letter row that carries `ä` on de only.
US_KEYMAP = keymap(COMMON_KEYMAP + [(21, [ord("="), ord("+")])])
DE_KEYMAP = keymap(COMMON_KEYMAP + [(21, [ord("+"), ord("*")]),
                                   (48, [ord("\u00e4"), ord("\u00c4")])])


class X11TextLevels(unittest.TestCase):
    """Typed text follows the display's keyboard mapping, not one layout.

    Pure: the mappings below are fixture rows, no X server is contacted.
    """

    def test_shift_is_pressed_only_where_the_layout_needs_it(self):
        us = helper.keyboard_levels(US_KEYMAP)
        de = helper.keyboard_levels(DE_KEYMAP)
        # The same request, two layouts: us needs shift for `+`, de must not.
        self.assertEqual(
            helper.plan_text_steps([ord("+")], us),
            [("key", "shift", "down"), ("keycode", 21), ("key", "shift", "up")],
        )
        self.assertEqual(helper.plan_text_steps([ord("+")], de), [("keycode", 21)])
        self.assertEqual(helper.plan_text_steps([ord("=")], us), [("keycode", 21)])
        for name, levels in (("us", us), ("de", de)):
            # A capital is the shift level of its letter on either layout.
            self.assertEqual(
                helper.plan_text_steps([ord("O")], levels),
                [("key", "shift", "down"), ("keycode", letter_keycode("o")),
                 ("key", "shift", "up")],
                name,
            )
            self.assertEqual(helper.plan_text_steps([ord("o")], levels),
                             [("keycode", letter_keycode("o"))], name)

    def test_a_character_on_no_shift_level_is_refused_not_mistyped(self):
        levels = helper.keyboard_levels(DE_KEYMAP)
        # On de `@` only exists on the AltGr level, which this helper cannot hold.
        with self.assertRaises(helper.Failure) as raised:
            helper.plan_text_steps([ord("@")], levels)
        self.assertEqual(raised.exception.code, "unsupported_input")
        with self.assertRaises(helper.Failure):
            helper.plan_text_steps([0], levels)

    def test_an_unshifted_duplicate_wins_over_a_shifted_one(self):
        # Ascending keycodes: `+` first appears shifted, then on a bare key.
        levels = helper.keyboard_levels([(21, [ord("="), ord("+")]),
                                        (35, [ord("+"), ord("*")])])
        self.assertEqual(levels[ord("+")], (35, False))
        self.assertEqual(helper.plan_text_steps([ord("+")], levels), [("keycode", 35)])
        # A shifted duplicate keeps the first keycode it was found on.
        self.assertEqual(levels[ord("*")], (35, True))

    def test_a_group_specific_letter_keeps_its_own_keycode_and_shift(self):
        # On de `ä` is the base level of its own key; on us that key types `'`.
        de = helper.keyboard_levels(DE_KEYMAP)
        us = helper.keyboard_levels(US_KEYMAP)
        self.assertEqual(helper.plan_text_steps([ord("\u00e4")], de), [("keycode", 48)])
        self.assertEqual(
            helper.plan_text_steps([ord("\u00c4")], de),
            [("key", "shift", "down"), ("keycode", 48), ("key", "shift", "up")],
        )
        # The same character has no level in the other group, so it is refused
        # rather than typed as the neighbour that group puts on that key.
        with self.assertRaises(helper.Failure) as raised:
            helper.plan_text_steps([ord("\u00e4")], us)
        self.assertEqual(raised.exception.code, "unsupported_input")

    def test_expansion_resolves_only_the_text_taps(self):
        levels = helper.keyboard_levels(US_KEYMAP)
        plan = helper.plan_input({"op": "text", "text": "o+"}, BOUNDS,
                                unicode_text=False)
        self.assertEqual(
            helper.expand_keysym_taps(plan, levels),
            [("keycode", letter_keycode("o")), ("key", "shift", "down"),
             ("keycode", 21), ("key", "shift", "up")],
        )
        pointer = helper.plan_input({"op": "pointer", "x": 1, "y": 2, "action": "move"},
                                    BOUNDS, unicode_text=True)
        self.assertEqual(helper.expand_keysym_taps(pointer, levels), pointer)


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
# The marker is the upstream sample verbatim, capitals included: the X11 text path
# must hold shift for the shift-level characters instead of delivering their
# lowercase form.
LIVE_MARKER = "Mikka isolated CUA input"
# `setxkbmap` switches the fixture display's own layout: typed text must follow
# the mapping the display serves, never one layout baked into the helper.
LIVE_TOOLS = ("Xvfb", "xdpyinfo", "xdotool", "xmessage", "xterm", "setxkbmap")
# The bottom-left default button, as measured in the upstream fixture.
BUTTON_INSET = (16, 14)
# The isolated display handshake is POSIX-only: `os.pipe` + `select` and
# `Popen(pass_fds=...)` do not exist on Windows, while the Windows CI runs this
# whole file (`-p 'test_*.py'`). Those checks are skipped there; the real desktop
# acceptance keeps running in full on Linux.
POSIX_ONLY = unittest.skipIf(
    sys.platform == "win32",
    "the isolated X display handshake needs POSIX pipes, select and pass_fds",
)


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


def set_keyboard_layout(environment, layout):
    """Switch one fixture display's keyboard layout, then prove the server took it.

    `setxkbmap` changes the mapping the X server serves, which is what typed text
    must follow. The query is read back because a silent failure here would make a
    layout regression test assert nothing at all.
    """
    completed = subprocess.run(["setxkbmap", layout], env=environment,
                               capture_output=True, text=True)
    if completed.returncode != 0:
        raise AssertionError("could not switch the fixture keyboard to %s: %s"
                             % (layout, completed.stderr.strip()))
    query = subprocess.run(["setxkbmap", "-query"], env=environment,
                           capture_output=True, text=True, check=True).stdout
    reported = [line.partition(":")[2].strip() for line in query.splitlines()
                if line.partition(":")[0].strip() == "layout"]
    if reported != [layout]:
        raise AssertionError("the fixture keyboard reports %s, not %r"
                             % (reported, layout))


def socket_owner_inodes(number, socket_dir="/tmp/.X11-unix"):
    """Socket inodes registered for one display number, from /proc.

    A display number is only a name, and it has two: the filesystem socket and
    the abstract one. Xlib prefers the abstract name, so a server that only holds
    one of them can leave clients connecting to somebody else's desktop (or to a
    socket that resets). The kernel knows who holds which inode, so the fixture
    asks it instead of trusting a number.
    """
    path = os.path.join(socket_dir, "X%d" % number)
    inodes = set()
    try:
        with open("/proc/net/unix", "r", encoding="utf-8", errors="replace") as table:
            for line in table:
                fields = line.split()
                if len(fields) >= 7 and fields[-1] in (path, "@" + path):
                    inodes.add(fields[6])
    except OSError:
        return None
    return inodes


def process_socket_inodes(pid):
    """Socket inodes a process holds open, from /proc/<pid>/fd."""
    inodes = set()
    try:
        names = os.listdir("/proc/%d/fd" % pid)
    except OSError:
        return inodes
    for name in names:
        try:
            target = os.readlink("/proc/%d/fd/%s" % (pid, name))
        except OSError:
            continue
        if target.startswith("socket:[") and target.endswith("]"):
            inodes.add(target[len("socket:["):-1])
    return inodes


def process_diagnostic(process):
    """The stderr a fixture window reported, for a failure message only."""
    if process is None or process.stderr is None or process.poll() is None:
        return ""
    try:
        output = process.stderr.read()
    except Exception:  # noqa: BLE001 - diagnostics must never mask the failure
        return ""
    if isinstance(output, bytes):
        output = output.decode("utf-8", "replace")
    output = output.strip()
    return ": %s" % output if output else ""


def await_window(environment, name, process=None, only_visible=False, attempts=100):
    for _ in range(attempts):
        if process is not None and process.poll() is not None:
            raise AssertionError(
                "fixture window %r exited with %s before it was observed%s"
                % (name, process.returncode, process_diagnostic(process))
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
    """A private Xvfb display whose number Xvfb itself hands back to us.

    The number is never guessed here: `Xvfb -displayfd <pipe>` picks a free
    display and writes the number into a pipe only this process holds. The
    handshake is then confirmed, because a number is not ownership: the server
    must still be alive, and every socket registered for that number (the
    filesystem name and the abstract name Xlib prefers) must belong to this
    process. Xvfb announces a number before it has claimed it, and a stopping
    server can still hold one of the two names, so a number alone proves nothing.

    Our own fixtures start one at a time and wait for a stopped display to
    release its sockets, so two of them cannot share a desktop.
    """

    HANDSHAKE_TIMEOUT = 10
    START_LOCK = threading.Lock()

    def __init__(self, width, height, socket_dir="/tmp/.X11-unix"):
        self.width = width
        self.height = height
        self.socket_dir = socket_dir
        self.name = ""
        self.number = None
        self.binary = None
        self.process = None

    def start(self, attempts=3):
        self.binary = shutil.which("Xvfb")
        if self.binary is None:
            raise RuntimeError(
                "Xvfb is missing; scripts/bero/loom-dev-setup.sh installs the fixture tools"
            )
        failures = 0
        for _ in range(attempts):
            with IsolatedDisplay.START_LOCK:
                if self.spawn():
                    return self.name
            failures += 1
        raise RuntimeError(
            "isolated X display did not start after %d attempt(s)" % failures
        )

    def spawn(self):
        """Start Xvfb once; accept only a display this process really serves."""
        read_fd, write_fd = os.pipe()
        try:
            self.process = subprocess.Popen(
                [self.binary or "Xvfb", "-displayfd", str(write_fd),
                 "-screen", "0", "%dx%dx24" % (self.width, self.height),
                 # A reset (default: when the last client disconnects) would drop
                 # the connection of a client starting right after our probe.
                 "-noreset", "-nolisten", "tcp"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                pass_fds=(write_fd,),
            )
        finally:
            os.close(write_fd)
        try:
            number = self.read_display_number(read_fd)
        finally:
            os.close(read_fd)
        if number is None or self.process.poll() is not None:
            # No handshake means this server is not serving the display we would
            # talk to, so its desktop is never adopted as ours.
            self.stop()
            return False
        if not self.owns_display(number):
            # The number is real but not entirely ours: adopting it would drive a
            # desktop (or a dead socket) this fixture did not start. Nothing of
            # ours to release, so the next attempt starts clean.
            self.stop()
            return False
        self.number = number
        self.name = ":%d" % number
        for _ in range(100):
            if self.process.poll() is not None:
                break
            if self.ready():
                return True
            time.sleep(0.1)
        self.stop()
        return False

    def owns_display(self, number):
        """Are *all* sockets named by `number` held by the process we started?

        `True` when the platform cannot answer (no /proc/net/unix): the handshake
        over the private pipe is then the only evidence available.
        """
        inodes = socket_owner_inodes(number, self.socket_dir)
        if inodes is None:
            return True
        if not inodes:
            return False
        return inodes <= process_socket_inodes(self.process.pid)

    @classmethod
    def read_display_number(cls, read_fd, timeout=None):
        """The number Xvfb reported, or None if the handshake never completed."""
        deadline = time.monotonic() + (
            cls.HANDSHAKE_TIMEOUT if timeout is None else timeout
        )
        data = b""
        while b"\n" not in data:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            readable, _, _ = select.select([read_fd], [], [], remaining)
            if not readable:
                break
            chunk = os.read(read_fd, 64)
            if not chunk:
                break
            data += chunk
        number = data.split(b"\n", 1)[0].strip()
        return int(number) if number.isdigit() else None

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
        number, self.number, self.name = self.number, None, ""
        if process is None:
            return
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
        if number is not None:
            self.release(number)

    def release(self, number, timeout=10.0):
        """Wait until this display number's sockets are really gone.

        The next fixture must not pick the same number while the kernel (or the
        exiting server) still has it registered under either name.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            inodes = socket_owner_inodes(number, self.socket_dir)
            if inodes == set():
                return True
            time.sleep(0.02)
        return False


class LiveFixtureContract(unittest.TestCase):
    """Pure contract of the live fixture; runs under plain discovery too."""

    def test_the_live_gate_requires_an_explicit_one(self):
        self.assertTrue(live_acceptance_enabled("1"))
        for value in ["", "0", "true", "yes", "on", "01", " "]:
            self.assertFalse(live_acceptance_enabled(value), value)

    def test_the_marker_keeps_its_case_on_the_x11_text_path(self):
        # The upstream sample, capitals included: a capital is the shift level of
        # its letter, so the plan must hold shift around it on every layout.
        self.assertEqual(LIVE_MARKER, "Mikka isolated CUA input")
        self.assertTrue(any(character.isupper() for character in LIVE_MARKER))
        self.assertTrue(all(ord(character) < 0x100 for character in LIVE_MARKER))
        capitals = sum(1 for character in LIVE_MARKER if character.isupper())
        plan = helper.plan_input({"op": "text", "text": LIVE_MARKER}, BOUNDS,
                                 unicode_text=False)
        self.assertEqual([step[1] for step in plan],
                         [ord(character) for character in LIVE_MARKER])
        for name, rows in (("us", US_KEYMAP), ("de", DE_KEYMAP)):
            steps = helper.expand_keysym_taps(plan, helper.keyboard_levels(rows))
            # Every marker character is reachable, and shift wraps exactly the
            # capitals: one down and one up per capital, no other modifier.
            self.assertTrue(all(step[0] in ("key", "keycode") for step in steps), name)
            downs = [step for step in steps if step == ("key", "shift", "down")]
            ups = [step for step in steps if step == ("key", "shift", "up")]
            self.assertEqual((len(downs), len(ups)), (capitals, capitals), name)
            self.assertEqual(sum(1 for step in steps if step[0] == "keycode"),
                             len(LIVE_MARKER), name)

    def test_button_point_reproduces_the_ported_upstream_click(self):
        self.assertEqual(button_point((200, 200, 400, 140)), (216, 326))
        self.assertEqual(button_point((0, 0, 400, 140)), (16, 126))
        self.assertEqual(button_point((10, 20, 800, 300)), (26, 306))

    @POSIX_ONLY
    def test_the_handshake_reads_only_a_display_number_xvfb_reported(self):
        for reported, expected in [(b"104\n", 104), (b":7\n", None),
                                   (b"", None), (b"banana\n", None)]:
            read_fd, write_fd = os.pipe()
            try:
                os.write(write_fd, reported)
            finally:
                os.close(write_fd)
            try:
                self.assertEqual(
                    IsolatedDisplay.read_display_number(read_fd, timeout=1), expected,
                    reported,
                )
            finally:
                os.close(read_fd)
        # A silent server never yields a number, so its desktop is never adopted.
        read_fd, write_fd = os.pipe()
        os.close(write_fd)
        try:
            self.assertIsNone(IsolatedDisplay.read_display_number(read_fd, timeout=0.2))
        finally:
            os.close(read_fd)

    @unittest.skipIf(sys.platform == "win32", "POSIX display check only")
    def test_the_shared_call_path_reports_a_refusal_without_a_body(self):
        environment = dict(os.environ)
        environment.pop("DISPLAY", None)
        status, header, body = call_helper({"op": "info"}, environment=environment)
        self.assertNotEqual(status, 0)
        self.assertFalse(header["ok"])
        self.assertEqual(header["error"], "no_display")
        self.assertEqual(body, b"")

    @unittest.skipUnless(os.path.exists("/proc/net/unix"),
                         "socket ownership needs the Linux socket table")
    def test_ownership_follows_the_listening_socket_not_the_name(self):
        with tempfile.TemporaryDirectory() as root:
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.addCleanup(server.close)
            server.bind(os.path.join(root, "X77"))
            server.listen(1)
            display = IsolatedDisplay(*LIVE_SCREEN, socket_dir=root)
            display.process = mock.Mock(pid=os.getpid())
            self.assertTrue(display.owns_display(77), "our own listener is ours")
            display.process = mock.Mock(pid=1)
            self.assertFalse(display.owns_display(77),
                             "a number our process does not listen on is not ours")

    def test_the_display_refuses_to_start_without_xvfb(self):
        display = IsolatedDisplay(*LIVE_SCREEN)
        with mock.patch.object(shutil, "which", return_value=None):
            with self.assertRaises(RuntimeError):
                display.start()
        self.assertIsNone(display.process)
        display.stop()  # idempotent teardown

    @POSIX_ONLY
    def test_a_failing_xvfb_is_retried_and_reported(self):
        class CountingDisplay(IsolatedDisplay):
            attempts = 0

            def spawn(self):
                CountingDisplay.attempts += 1
                return super().spawn()

        display = CountingDisplay(*LIVE_SCREEN)
        # A real process that exits without a handshake, not a mocked spawn.
        failing = shutil.which("false") or "/bin/false"
        with mock.patch.object(shutil, "which", return_value=failing):
            with self.assertRaises(RuntimeError):
                display.start(attempts=3)
        self.assertEqual(CountingDisplay.attempts, 3)
        self.assertIsNone(display.process, "a failed start leaks no server")


class XServerKeyboard:
    """The fixture display's own keyboard state, read and changed from outside the helper.

    The helper must type what the user would get, so the fixture changes the
    display the way a user does: select a second layout group, or lock Caps Lock.
    Those changes are server state, not fixture bookkeeping, so every assertion
    below reads them back from the X server instead of trusting a variable.
    """

    XKB_USE_CORE_KEYBOARD = 0x0100
    LOCK_MASK = 0x02  # Caps Lock

    class State(ctypes.Structure):
        # XkbStateRec from X11/extensions/XKBlib.h, in declaration order.
        _fields_ = [
            ("group", ctypes.c_ubyte), ("locked_group", ctypes.c_ubyte),
            ("base_group", ctypes.c_ushort), ("latched_group", ctypes.c_ushort),
            ("mods", ctypes.c_ubyte), ("base_mods", ctypes.c_ubyte),
            ("latched_mods", ctypes.c_ubyte), ("locked_mods", ctypes.c_ubyte),
            ("compat_state", ctypes.c_ubyte), ("grab_mods", ctypes.c_ubyte),
            ("compat_grab_mods", ctypes.c_ubyte), ("lookup_mods", ctypes.c_ubyte),
            ("compat_lookup_mods", ctypes.c_ubyte),
            ("ptr_buttons", ctypes.c_ushort),
        ]

    def __init__(self, environment):
        name = ctypes.util.find_library("X11")
        if not name:
            raise AssertionError("the live fixture needs libX11")
        self.x11 = ctypes.CDLL(name)
        self.x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
        self.x11.XOpenDisplay.restype = ctypes.c_void_p
        self.display = ctypes.c_void_p(
            self.x11.XOpenDisplay(environment["DISPLAY"].encode("utf-8"))
        )
        if not self.display:
            raise AssertionError("cannot open the fixture display %r" % environment["DISPLAY"])
        self.x11.XkbGetState.argtypes = [ctypes.c_void_p, ctypes.c_uint,
                                        ctypes.POINTER(self.State)]
        self.x11.XkbGetState.restype = ctypes.c_int
        self.x11.XkbLockGroup.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint]
        self.x11.XkbLockModifiers.argtypes = [ctypes.c_void_p, ctypes.c_uint,
                                             ctypes.c_uint, ctypes.c_uint]
        self.x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.x11.XCloseDisplay.argtypes = [ctypes.c_void_p]

    def close(self):
        if self.display:
            self.x11.XCloseDisplay(self.display)
            self.display = None

    def state(self):
        state = self.State()
        # XkbGetState reports Success as zero; the lock requests below are Bool.
        if self.x11.XkbGetState(self.display, self.XKB_USE_CORE_KEYBOARD,
                                ctypes.byref(state)) != 0:
            raise AssertionError("could not read the keyboard state on the fixture display")
        self.x11.XSync(self.display, 0)
        return {"group": state.group, "locked_mods": state.locked_mods}

    def lock_group(self, group):
        self.assert_ok(self.x11.XkbLockGroup(self.display, self.XKB_USE_CORE_KEYBOARD, group),
                       "select keyboard group %d" % group)
        self.x11.XSync(self.display, 0)

    def lock_modifiers(self, mask, value):
        self.assert_ok(self.x11.XkbLockModifiers(self.display, self.XKB_USE_CORE_KEYBOARD,
                                                 mask, value),
                       "set locked modifiers %d" % value)
        self.x11.XSync(self.display, 0)

    @staticmethod
    def assert_ok(status, action):
        if not status:
            raise AssertionError("could not %s on the fixture display" % action)


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
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
        if process.stderr is not None:
            # The captured diagnostics are read on failure only; the pipe still
            # has to be closed.
            process.stderr.close()

    def dialog(self, title):
        process = subprocess.Popen(
            ["xmessage", "-title", title, "-geometry", "400x140+200+200",
             "-buttons", "OK:0", "LOOM isolated computer-use test"],
            env=self.environment,
            stdout=subprocess.DEVNULL,
            # Captured, never discarded: an unexpected exit must say why.
            stderr=subprocess.PIPE,
        )
        self.addCleanup(self.reap, process)
        return process

    def focus(self, environment, window):
        """Focus a window on the display that owns it, not on the class display."""
        completed = None
        for _ in range(20):
            completed = subprocess.run(
                ["xdotool", "windowfocus", "--sync", window],
                env=environment, capture_output=True, text=True,
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

    def test_a_second_fixture_gets_its_own_display(self):
        """Two servers started at the same instant must never share a desktop.

        Real Xvfb processes, no mocked spawn: before the `-displayfd` handshake a
        contender whose guessed number was already taken still reported success
        because `xdpyinfo` could talk to the winner's server.
        """
        displays = [IsolatedDisplay(*LIVE_SCREEN), IsolatedDisplay(*LIVE_SCREEN)]
        failures = []

        def start(display):
            try:
                display.start()
            except BaseException as error:  # noqa: BLE001 - reported after join
                failures.append(error)

        threads = [threading.Thread(target=start, args=(display,))
                   for display in displays]
        for display in displays:
            self.addCleanup(display.stop)
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=60)
        self.assertEqual(failures, [])
        self.assertEqual(sorted(display.name for display in displays),
                         sorted({display.name for display in displays}),
                         "each fixture must own a distinct display")
        for display in displays:
            self.assertIsNotNone(display.process, "%s never started" % display.name)
            self.assertIsNone(display.process.poll(),
                              "%s must still be served by its own Xvfb" % display.name)
            self.assertNotEqual(display.name, os.environ.get("DISPLAY"))
        # Same display would mean the same desktop: a window on one must be
        # invisible to the other, which is the whole point of the handshake.
        title = dedicated_title("competition")
        window = subprocess.Popen(
            ["xmessage", "-title", title, "-geometry", "300x120+40+40",
             "-buttons", "OK:0", title],
            env=displays[0].environment(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        self.addCleanup(self.reap, window)
        self.assertNotEqual(await_window(displays[0].environment(), title, window), "")
        self.assertEqual(find_window(displays[1].environment(), title, only_visible=True), "",
                         "the second fixture must not see the first fixture's window")

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
        box = (geometry[0], geometry[1], geometry[0] + geometry[2],
               geometry[1] + geometry[3])
        with self.decode(before) as shown, self.decode(after) as cleared:
            changed = self.changed_pixels(shown, cleared, box)
        # The dialog rectangle itself must be repainted: a moved cursor or a stale
        # frame is not a closed window.
        self.assertGreater(changed, (box[2] - box[0]) * (box[3] - box[1]) // 4,
                           "the dialog rectangle must be repainted after the click")

    def test_typed_text_reaches_the_dedicated_window(self):
        received = self.typed_line(self.environment, "input", LIVE_MARKER)
        # Case is part of the text: the shift taps, not just the taps, must arrive.
        self.assertTrue(any(character.isupper() for character in received),
                        "typed text must keep the capital letters of the marker")

    def test_typed_text_follows_the_display_keyboard_layout(self):
        """On a non-US layout `+` must still arrive as `+`.

        `de` has a `+` key of its own while `=` needs shift, so a hard-coded US
        table types `=` and still reports success. The layout is switched on this
        case's own display, so no other case can inherit it.
        """
        display = IsolatedDisplay(*LIVE_SCREEN)
        self.addCleanup(display.stop)
        display.start()
        environment = display.environment()
        set_keyboard_layout(environment, "us")
        set_keyboard_layout(environment, "de")
        received = self.typed_line(environment, "layout", "Mikka + CUA")
        self.assertIn("+", received, "the de `+` key must not arrive as another character")
        self.assertNotIn("=", received)

    def test_typed_text_follows_the_active_keyboard_group(self):
        """A second layout group must type its own characters, including non-ASCII.

        The core keysym table has no portable group stride (a layout may put four
        levels on one group and two on the next), so a reader that always takes
        the first group types the wrong characters or refuses characters the
        active group can reach. `ä` is a base-level character of the German group
        and `+` is unshifted there, while the US group has neither.
        """
        display = IsolatedDisplay(*LIVE_SCREEN)
        self.addCleanup(display.stop)
        display.start()
        environment = display.environment()
        set_keyboard_layout(environment, "us,de")
        keyboard = XServerKeyboard(environment)
        self.addCleanup(keyboard.close)
        keyboard.lock_group(1)
        state = keyboard.state()
        self.assertEqual(state["group"], 1, "the fixture must be in the second group")
        self.assertEqual(state["locked_mods"] & keyboard.LOCK_MASK, 0)
        received = self.typed_line(environment, "group", "Mikka \u00e4 + CUA")
        self.assertIn("\u00e4", received, "the active group's own letter must arrive")
        self.assertIn("+", received, "the active group's unshifted `+` must arrive")
        self.assertNotIn("=", received)

    def test_typed_text_keeps_its_case_under_caps_lock(self):
        """Caps Lock must not swap the case of typed text, and must stay locked."""
        display = IsolatedDisplay(*LIVE_SCREEN)
        self.addCleanup(display.stop)
        display.start()
        environment = display.environment()
        set_keyboard_layout(environment, "us")
        keyboard = XServerKeyboard(environment)
        self.addCleanup(keyboard.close)
        keyboard.lock_modifiers(XServerKeyboard.LOCK_MASK, XServerKeyboard.LOCK_MASK)
        self.assertEqual(keyboard.state()["locked_mods"] & keyboard.LOCK_MASK,
                         keyboard.LOCK_MASK,
                         "Caps Lock must be locked before the text is typed")
        received = self.typed_line(environment, "caps", LIVE_MARKER)
        self.assertEqual(received, LIVE_MARKER, "Caps Lock must not change the typed case")
        self.assertEqual(keyboard.state()["locked_mods"] & keyboard.LOCK_MASK,
                         keyboard.LOCK_MASK,
                         "typing must restore the user's Caps Lock")

    def typed_line(self, environment, label, text):
        """Type `text` then Enter into a dedicated xterm; return what it received.

        The received text is read from the application's own file, which must not
        exist before the injection, so a helper receipt can never stand in for the
        characters that actually arrived.
        """
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
        title = dedicated_title(label)
        terminal = subprocess.Popen(
            ["xterm", "-title", title, "-geometry", "60x5+200+200", "-e",
             sys.executable, str(reader), str(typed)],
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.addCleanup(self.reap, terminal)
        window = await_window(environment, title, terminal, only_visible=True)
        self.focus(environment, window)
        self.assertFalse(typed.exists(), "the application must not have the text yet")
        for request in ({"op": "text", "text": text}, {"op": "key", "key": "enter"}):
            status, header, _ = call_helper(request, environment=environment)
            self.assertEqual(status, 0, header)
            self.assertTrue(header.get("ok"), header)
        for _ in range(50):
            if terminal.poll() is not None:
                break
            time.sleep(0.1)
        self.assertEqual(terminal.returncode, 0,
                         "the fixture application exits only after a complete line")
        received = typed.read_text(encoding="utf-8")
        self.assertEqual(received, text,
                         "observed application text must match the typed text")
        return received


if __name__ == "__main__":
    unittest.main()
