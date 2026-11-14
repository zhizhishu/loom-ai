#!/usr/bin/env python3
"""LOOM local Computer helper: real desktop capture and whitelisted input.

Protocol (one shot per process):

    <python> host_desktop.py  <<'JSON'
    {"op": "info"}
    JSON

stdout is one JSON header line, then, for `capture` only, exactly `bytes` raw
PNG bytes. The request travels on **stdin only**, so typed text and pointer
coordinates never reach an OS process list, shell history or argv log.

    {"op":"info"}                      -> {"ok":true,"platform":..,"deviceId":..,
                                           "originX":..,"originY":..,
                                           "screenWidth":..,"screenHeight":..}
    {"op":"capture","consent":true,    -> {"ok":true,"width":..,"height":..,
     "maxWidth":1920,"maxHeight":1080}    "originX":..,"originY":..,"scale":..,
                                           "bytes":..,"screenWidth":..,..}
    {"op":"pointer","x":..,"y":..,"button":"left","action":"click"}
    {"op":"wheel","x":..,"y":..,"delta":..}
    {"op":"key","key":"enter"}
    {"op":"text","text":"..."}          (<= 2048 codepoints, no control chars)
    {"op":"release"}                    (best effort: release every button)

A refusal is `{"ok":false,"error":"<code>"}` on stdout with exit status 1:
`invalid_request`, `unsupported_backend`, `no_display`, `session_locked`,
`encoder_unavailable`, `unsupported_input`, `capture_failed`.

Backends call the OS APIs directly through ctypes (Windows GDI + SendInput,
X11 XGetImage + XTest). Pillow only encodes PNG. This script never writes a
file, never opens a socket, never logs and never shells out.
"""

import hashlib
import io
import json
import os
import sys

MAX_TEXT_CODEPOINTS = 2048
MAX_DIMENSION = 4096
MAX_CAPTURE_BYTES = 4 * 1024 * 1024
MAX_REQUEST_BYTES = 8 * 1024
MAX_WHEEL = 1000
MAX_WHEEL_CLICKS = 20
OFFSET_LIMIT = 1 << 20

KEYS = frozenset(
    {
        "enter", "tab", "escape", "backspace", "delete", "space",
        "left", "right", "up", "down", "home", "end", "pageup", "pagedown",
        "shift", "ctrl", "alt", "meta",
        "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
    }
)
BUTTONS = {"left": 1, "right": 2, "middle": 3}
ACTIONS = frozenset({"click", "move"})

# Closed field whitelist per op: no extra key may ride along with a request.
FIELDS = {
    "info": frozenset(),
    "capture": frozenset({"consent", "maxWidth", "maxHeight"}),
    "pointer": frozenset({"x", "y", "button", "action"}),
    "wheel": frozenset({"x", "y", "delta"}),
    "key": frozenset({"key"}),
    "text": frozenset({"text"}),
    "release": frozenset(),
}

# Mouse flags shared by the Windows backend.
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000
MOUSEEVENTF_WHEEL = 0x0800
BUTTON_FLAGS = {
    ("left", "down"): 0x0002,
    ("left", "up"): 0x0004,
    ("right", "down"): 0x0008,
    ("right", "up"): 0x0010,
    ("middle", "down"): 0x0020,
    ("middle", "up"): 0x0040,
}
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

WINDOWS_VK = {
    "enter": 0x0D, "tab": 0x09, "escape": 0x1B, "backspace": 0x08, "delete": 0x2E,
    "space": 0x20, "left": 0x25, "right": 0x27, "up": 0x26, "down": 0x28,
    "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
    "shift": 0x10, "ctrl": 0x11, "alt": 0x12, "meta": 0x5B,
    "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75,
    "f7": 0x76, "f8": 0x77, "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
}

X11_KEYSYM = {
    "enter": 0xFF0D, "tab": 0xFF09, "escape": 0xFF1B, "backspace": 0xFF08,
    "delete": 0xFFFF, "space": 0x0020, "left": 0xFF51, "right": 0xFF53,
    "up": 0xFF52, "down": 0xFF54, "home": 0xFF50, "end": 0xFF57,
    "pageup": 0xFF55, "pagedown": 0xFF56, "shift": 0xFFE1, "ctrl": 0xFFE3,
    "alt": 0xFFE9, "meta": 0xFFEB,
    "f1": 0xFFBE, "f2": 0xFFBF, "f3": 0xFFC0, "f4": 0xFFC1, "f5": 0xFFC2,
    "f6": 0xFFC3, "f7": 0xFFC4, "f8": 0xFFC5, "f9": 0xFFC6, "f10": 0xFFC7,
    "f11": 0xFFC8, "f12": 0xFFC9,
}


class Failure(Exception):
    """A reported refusal. `detail` stays short and never contains input."""

    def __init__(self, code, detail=None):
        super().__init__(code)
        self.code = code
        self.detail = detail


# ---------------------------------------------------------------- validation


def _integer(request, name, minimum, maximum):
    value = request.get(name)
    if isinstance(value, bool) or not isinstance(value, int):
        raise Failure("invalid_request", name)
    if value < minimum or value > maximum:
        raise Failure("invalid_request", name)
    return value


def validate_bounds(bounds):
    x, y, width, height = bounds
    for value in (x, y):
        if value < -OFFSET_LIMIT or value > OFFSET_LIMIT:
            raise Failure("capture_failed", "origin")
    if width <= 0 or height <= 0 or width > MAX_DIMENSION * 4 or height > MAX_DIMENSION * 4:
        raise Failure("capture_failed", "bounds")
    return (x, y, width, height)


def validate_point(x, y, bounds):
    bx, by, width, height = bounds
    if not (bx <= x < bx + width and by <= y < by + height):
        raise Failure("invalid_request", "point")
    return x, y


def validate_text(text):
    if not isinstance(text, str) or not text:
        raise Failure("invalid_request", "text")
    if len(text) > MAX_TEXT_CODEPOINTS:
        raise Failure("invalid_request", "text")
    for character in text:
        codepoint = ord(character)
        # No control characters, no surrogate escapes, no astral plane: the
        # unicode key path must never have to synthesise a surrogate pair.
        if codepoint < 0x20 or codepoint == 0x7F or 0xD800 <= codepoint <= 0xDFFF:
            raise Failure("invalid_request", "text")
        if codepoint > 0xFFFF:
            raise Failure("invalid_request", "text")
    return text


def validate_key(name):
    if name not in KEYS:
        raise Failure("invalid_request", "key")
    return name


def validate_request_fields(request):
    """Closed request shape: only the documented fields of the current op."""
    allowed = FIELDS.get(request.get("op"))
    if allowed is None:
        raise Failure("invalid_request", "op")
    if set(request) - allowed - {"op"}:
        raise Failure("invalid_request", "field")
    return request


def device_id(platform, bounds):
    x, y, width, height = bounds
    digest = hashlib.sha256(f"{platform}|{x},{y},{width},{height}".encode("utf-8"))
    return "sha256:" + digest.hexdigest()


# ------------------------------------------------------------ input planning


def plan_input(request, bounds, unicode_text):
    """Translate one validated request into backend-neutral steps.

    Pure and deterministic, so the closed whitelist is testable on any platform
    without touching a real desktop.
    """
    validate_request_fields(request)
    op = request.get("op")
    if op in ("pointer", "wheel"):
        x = _integer(request, "x", -OFFSET_LIMIT, OFFSET_LIMIT)
        y = _integer(request, "y", -OFFSET_LIMIT, OFFSET_LIMIT)
        validate_point(x, y, bounds)
    if op == "pointer":
        action = request.get("action")
        if action not in ACTIONS:
            raise Failure("invalid_request", "action")
        button = request.get("button")
        if button is not None and button not in BUTTONS:
            raise Failure("invalid_request", "button")
        if action == "move":
            if button is not None:
                raise Failure("invalid_request", "button")
            return [("move", x, y)]
        if button is None:
            raise Failure("invalid_request", "button")
        # Only a click remains, and it is one atomic down+up pair inside a single
        # request: no request can leave a button held after it returns.
        return [("button", x, y, button, "down"), ("button", x, y, button, "up")]
    if op == "wheel":
        delta = _integer(request, "delta", -MAX_WHEEL, MAX_WHEEL)
        if delta == 0:
            raise Failure("invalid_request", "delta")
        return [("wheel", x, y, delta)]
    if op == "key":
        name = validate_key(request.get("key"))
        # Always a tap: no open-ended key-down a dropped client could leave stuck.
        return [("key", name, "down"), ("key", name, "up")]
    if op == "text":
        text = validate_text(request.get("text"))
        if unicode_text:
            return [("unicode", ord(character)) for character in text]
        for character in text:
            if ord(character) > 0xFF:
                raise Failure("unsupported_input", "text encoding")
        return [("keysym", ord(character)) for character in text]
    raise Failure("invalid_request", "op")


def normalize(x, y, bounds):
    """Map a screen point into the 0..65535 absolute space the OS APIs use."""
    bx, by, width, height = bounds
    nx = 0 if width <= 1 else int(round((x - bx) * 65535 / (width - 1)))
    ny = 0 if height <= 1 else int(round((y - by) * 65535 / (height - 1)))
    return max(0, min(65535, nx)), max(0, min(65535, ny))


def unicode_units(codepoint):
    """UTF-16 code units for one code point.

    `KEYBDINPUT.wScan` is a `WORD`, so a supplementary-plane character must be sent as its
    surrogate pair (two units); a BMP character is one unit. Never truncate.
    """
    if isinstance(codepoint, bool) or not isinstance(codepoint, int):
        raise Failure("invalid_request", "unicode")
    if codepoint < 0 or codepoint > 0x10FFFF or 0xD800 <= codepoint <= 0xDFFF:
        raise Failure("invalid_request", "unicode")
    if codepoint <= 0xFFFF:
        return (codepoint,)
    value = codepoint - 0x10000
    return (0xD800 + (value >> 10), 0xDC00 + (value & 0x3FF))


def build_send_input(plan, bounds):
    """Pure Windows plan: (type, flags, dx, dy, mouse_data, virtual_key, scan)."""
    steps = []
    for step in plan:
        kind = step[0]
        if kind in ("move", "button", "wheel"):
            _, x, y = step[0], step[1], step[2]
            nx, ny = normalize(x, y, bounds)
            steps.append((0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                          nx, ny, 0, 0, 0))
            if kind == "move":
                continue
            if kind == "wheel":
                steps.append((0, MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_WHEEL,
                              nx, ny, step[3] * 120, 0, 0))
                continue
            _, _, _, button, action = step
            steps.append((0, MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
                          | BUTTON_FLAGS[(button, action)], nx, ny, 0, 0, 0))
        elif kind == "key":
            _, name, state = step
            steps.append((1, 0 if state == "down" else KEYEVENTF_KEYUP,
                          0, 0, 0, WINDOWS_VK[name], 0))
        elif kind == "unicode":
            # Microsoft KEYBDINPUT: with KEYEVENTF_UNICODE, wVk must be 0 and wScan carries
            # one UTF-16 code unit. Each unit needs its own down **and** up entry, or the
            # character is only half delivered.
            for unit in unicode_units(step[1]):
                steps.append((1, KEYEVENTF_UNICODE, 0, 0, 0, 0, unit))
                steps.append((1, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, 0, 0, 0, unit))
        else:
            raise Failure("unsupported_input", kind)
    return steps


def build_button_release(plan_steps=("left", "right", "middle")):
    """Pure Windows plan for a bare button release: no pointer movement."""
    return [(0, MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | BUTTON_FLAGS[(button, "up")],
             0, 0, 0, 0, 0) for button in plan_steps]


DOWN_TO_UP = {
    BUTTON_FLAGS[("left", "down")]: BUTTON_FLAGS[("left", "up")],
    BUTTON_FLAGS[("right", "down")]: BUTTON_FLAGS[("right", "up")],
    BUTTON_FLAGS[("middle", "down")]: BUTTON_FLAGS[("middle", "up")],
}


def build_release_steps(steps):
    """Up-only steps for whatever `steps` could have pressed.

    Pure, and the only cleanup shape allowed after a partial native send: it can release
    a button or a key and can never press one.
    """
    releases = []
    for kind, flags, dx, dy, _data, virtual_key, scan in steps:
        if kind == 0:
            for down_flag, up_flag in DOWN_TO_UP.items():
                if flags & down_flag:
                    releases.append((
                        0,
                        MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | up_flag,
                        dx,
                        dy,
                        0,
                        0,
                        0,
                    ))
        elif not flags & KEYEVENTF_KEYUP:
            # Preserve the encoding flag: a unicode key-up without KEYEVENTF_UNICODE would
            # be interpreted as a virtual-key press of a different (or no) key.
            releases.append(
                (1, (flags & KEYEVENTF_UNICODE) | KEYEVENTF_KEYUP, 0, 0, 0, virtual_key, scan)
            )
    return releases


# ------------------------------------------------------------------- Pillow


def _load_pillow():
    try:
        from PIL import Image  # noqa: PLC0415 - optional by design
    except Exception:  # noqa: BLE001 - any import problem means "no encoder"
        raise Failure("encoder_unavailable")
    return Image


def encode_png(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=False)
    data = buffer.getvalue()
    if not data or len(data) > MAX_CAPTURE_BYTES:
        raise Failure("capture_failed", "encoded size")
    return data


def scaled(width, height, max_width, max_height):
    factor = min(1.0, max_width / width, max_height / height)
    return max(1, int(round(width * factor))), max(1, int(round(height * factor))), factor


# ------------------------------------------------------------------ Windows


def _windows_dlls():
    import ctypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    handle = ctypes.c_void_p
    user32.GetDC.restype = handle
    user32.GetDC.argtypes = [handle]
    user32.ReleaseDC.argtypes = [handle, handle]
    user32.SendInput.restype = ctypes.c_uint
    gdi32.CreateCompatibleDC.restype = handle
    gdi32.CreateCompatibleDC.argtypes = [handle]
    gdi32.CreateCompatibleBitmap.restype = handle
    gdi32.CreateCompatibleBitmap.argtypes = [handle, ctypes.c_int, ctypes.c_int]
    gdi32.SelectObject.restype = handle
    gdi32.SelectObject.argtypes = [handle, handle]
    gdi32.DeleteObject.argtypes = [handle]
    gdi32.DeleteDC.argtypes = [handle]
    gdi32.SetStretchBltMode.argtypes = [handle, ctypes.c_int]
    gdi32.StretchBlt.argtypes = [
        handle, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        handle, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
    ]
    gdi32.GetDIBits.argtypes = [
        handle, handle, ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p,
        ctypes.c_void_p, ctypes.c_uint,
    ]
    user32.SendInput.argtypes = [ctypes.c_uint, ctypes.c_void_p, ctypes.c_int]
    return ctypes, user32, gdi32


def windows_bounds(user32):
    metrics = (76, 77, 78, 79)  # X/Y/CX/CY of the virtual screen
    x, y, width, height = (user32.GetSystemMetrics(index) for index in metrics)
    if width <= 0 or height <= 0:
        # A locked or disconnected session reports no drawable virtual screen.
        raise Failure("session_locked", "virtual screen")
    return validate_bounds((x, y, width, height))


def windows_capture(bounds, max_width, max_height):
    ctypes, user32, gdi32 = _windows_dlls()
    Image = _load_pillow()
    bx, by, width, height = bounds
    target_width, target_height, factor = scaled(width, height, max_width, max_height)
    screen = user32.GetDC(None)
    if not screen:
        raise Failure("session_locked", "GetDC")
    memory = gdi32.CreateCompatibleDC(screen)
    bitmap = gdi32.CreateCompatibleBitmap(screen, target_width, target_height)
    try:
        if not memory or not bitmap:
            raise Failure("capture_failed", "gdi objects")
        gdi32.SelectObject(memory, bitmap)
        gdi32.SetStretchBltMode(memory, 4)  # HALFTONE
        # SRCCOPY from the virtual desktop rectangle. A locked secure desktop
        # fails here rather than yielding a black frame.
        if not gdi32.StretchBlt(memory, 0, 0, target_width, target_height,
                                screen, bx, by, width, height, 0x00CC0020):
            raise Failure("session_locked", "StretchBlt")

        class BITMAPINFOHEADER(ctypes.Structure):
            _fields_ = [
                ("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int32),
                ("biHeight", ctypes.c_int32), ("biPlanes", ctypes.c_uint16),
                ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32),
                ("biSizeImage", ctypes.c_uint32), ("biXPelsPerMeter", ctypes.c_int32),
                ("biYPelsPerMeter", ctypes.c_int32), ("biClrUsed", ctypes.c_uint32),
                ("biClrImportant", ctypes.c_uint32),
            ]

        class RGBQUAD(ctypes.Structure):
            _fields_ = [("blue", ctypes.c_ubyte), ("green", ctypes.c_ubyte),
                        ("red", ctypes.c_ubyte), ("reserved", ctypes.c_ubyte)]

        class BITMAPINFO(ctypes.Structure):
            _fields_ = [("header", BITMAPINFOHEADER), ("colors", RGBQUAD * 1)]

        info = BITMAPINFO()
        info.header.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        info.header.biWidth = target_width
        info.header.biHeight = -target_height  # top-down rows
        info.header.biPlanes = 1
        info.header.biBitCount = 32
        info.header.biCompression = 0  # BI_RGB
        stride = target_width * 4
        buffer = (ctypes.c_ubyte * (stride * target_height))()
        if not gdi32.GetDIBits(memory, bitmap, 0, target_height,
                               ctypes.byref(buffer), ctypes.byref(info), 0):
            raise Failure("capture_failed", "GetDIBits")
        image = Image.frombytes("RGB", (target_width, target_height), bytes(buffer),
                               "raw", "BGRX", 0, 1)
    finally:
        if bitmap:
            gdi32.DeleteObject(bitmap)
        if memory:
            gdi32.DeleteDC(memory)
        user32.ReleaseDC(None, screen)
    return image, (target_width, target_height, factor)


def _windows_input_structs(ctypes):
    pointer_size = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [("dx", ctypes.c_int32), ("dy", ctypes.c_int32),
                    ("mouseData", ctypes.c_uint32), ("dwFlags", ctypes.c_uint32),
                    ("time", ctypes.c_uint32), ("dwExtraInfo", pointer_size)]

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [("wVk", ctypes.c_uint16), ("wScan", ctypes.c_uint16),
                    ("dwFlags", ctypes.c_uint32), ("time", ctypes.c_uint32),
                    ("dwExtraInfo", pointer_size)]

    class HARDWAREINPUT(ctypes.Structure):
        _fields_ = [("uMsg", ctypes.c_uint32), ("wParamL", ctypes.c_uint16),
                    ("wParamH", ctypes.c_uint16)]

    class Union(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]

    class INPUT(ctypes.Structure):
        _anonymous_ = ("u",)
        _fields_ = [("type", ctypes.c_uint32), ("u", Union)]

    return INPUT, MOUSEINPUT, KEYBDINPUT


def _send_batch(ctypes, user32, steps):
    """Hand exactly `steps` to SendInput and return how many were accepted."""
    INPUT, MOUSEINPUT, KEYBDINPUT = _windows_input_structs(ctypes)
    entries = (INPUT * len(steps))()
    for index, (kind, flags, dx, dy, data, virtual_key, scan) in enumerate(steps):
        entries[index].type = kind
        if kind == 0:
            entries[index].mi = MOUSEINPUT(dx, dy, data, flags, 0, 0)
        else:
            entries[index].ki = KEYBDINPUT(virtual_key, scan, flags, 0, 0)
    return int(user32.SendInput(len(steps), ctypes.byref(entries), ctypes.sizeof(INPUT)))


def _release_after(ctypes, user32, steps):
    """Best-effort, synchronous up-only cleanup. Never raises, never presses."""
    releases = build_release_steps(steps)
    if not releases:
        return
    try:
        _send_batch(ctypes, user32, releases)
    except Exception:  # noqa: BLE001 - cleanup must not mask the original failure
        return


def _deliver(ctypes, user32, steps):
    """A partial native send must not leave a key or button held."""
    try:
        sent = _send_batch(ctypes, user32, steps)
    except Exception:
        _release_after(ctypes, user32, steps)
        raise
    if sent != len(steps):
        _release_after(ctypes, user32, steps)
        raise Failure("unsupported_input", "SendInput")
    return sent


def windows_apply(plan, bounds):
    ctypes, user32, _ = _windows_dlls()
    _deliver(ctypes, user32, build_send_input(plan, bounds))


def windows_release():
    ctypes, user32, _ = _windows_dlls()
    _send_batch(ctypes, user32, build_button_release())


# --------------------------------------------------------------------- X11


def _x11():
    import ctypes
    import ctypes.util

    name = ctypes.util.find_library("X11")
    if not name:
        raise Failure("unsupported_backend", "libX11")
    x11 = ctypes.CDLL(name)
    display = ctypes.c_void_p
    x11.XOpenDisplay.restype = display
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XDefaultScreen.restype = ctypes.c_int
    x11.XDefaultScreen.argtypes = [display]
    x11.XDisplayWidth.restype = ctypes.c_int
    x11.XDisplayWidth.argtypes = [display, ctypes.c_int]
    x11.XDisplayHeight.restype = ctypes.c_int
    x11.XDisplayHeight.argtypes = [display, ctypes.c_int]
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XDefaultRootWindow.argtypes = [display]
    x11.XKeysymToKeycode.restype = ctypes.c_ubyte
    x11.XKeysymToKeycode.argtypes = [display, ctypes.c_ulong]
    x11.XFlush.argtypes = [display]
    return ctypes, x11


def linux_display():
    if not os.environ.get("DISPLAY"):
        # No ambient desktop scanning: X11 is opt-in through an explicit DISPLAY.
        raise Failure("no_display")
    ctypes, x11 = _x11()
    display = x11.XOpenDisplay(None)
    if not display:
        raise Failure("no_display")
    screen = x11.XDefaultScreen(display)
    width = x11.XDisplayWidth(display, screen)
    height = x11.XDisplayHeight(display, screen)
    return ctypes, x11, display, screen, validate_bounds((0, 0, width, height))


def linux_capture(bounds, max_width, max_height):
    ctypes, x11, display, screen, bounds = linux_display()
    Image = _load_pillow()

    class XImage(ctypes.Structure):
        _fields_ = [
            ("width", ctypes.c_int), ("height", ctypes.c_int),
            ("xoffset", ctypes.c_int), ("format", ctypes.c_int),
            ("data", ctypes.POINTER(ctypes.c_char)), ("byte_order", ctypes.c_int),
            ("bitmap_unit", ctypes.c_int), ("bitmap_bit_order", ctypes.c_int),
            ("bitmap_pad", ctypes.c_int), ("depth", ctypes.c_int),
            ("bytes_per_line", ctypes.c_int), ("bits_per_pixel", ctypes.c_int),
        ]

    x11.XGetImage.restype = ctypes.POINTER(XImage)
    x11.XGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
                              ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_int]
    root = x11.XDefaultRootWindow(display)
    _, _, width, height = bounds
    pointer = x11.XGetImage(display, root, 0, 0, width, height, 0xFFFFFFFF, 2)
    if not pointer:
        raise Failure("capture_failed", "XGetImage")
    try:
        raw = pointer.contents
        if raw.bits_per_pixel != 32 or raw.bytes_per_line < raw.width * 4:
            raise Failure("unsupported_backend", "pixel format")
        # LSBFirst images are BGRX, MSBFirst are XRGB.
        rawmode = "BGRX" if raw.byte_order == 0 else "XRGB"
        data = ctypes.string_at(raw.data, raw.bytes_per_line * raw.height)
        image = Image.frombytes("RGB", (raw.width, raw.height), data,
                               "raw", rawmode, raw.bytes_per_line, 1)
        target_width, target_height, factor = scaled(raw.width, raw.height,
                                                    max_width, max_height)
        if (target_width, target_height) != (raw.width, raw.height):
            # Bounded downscale: one capture never ships a full 4K desktop.
            image = image.resize((target_width, target_height), Image.LANCZOS)
            factor = target_width / raw.width
    finally:
        destroy = getattr(x11, "XDestroyImage", None)
        if destroy is not None:
            destroy.argtypes = [ctypes.POINTER(XImage)]
            destroy(pointer)
        x11.XFlush(display)
    return image, (target_width, target_height, factor)


def _xtst():
    import ctypes
    import ctypes.util

    name = ctypes.util.find_library("Xtst")
    if not name:
        raise Failure("unsupported_backend", "libXtst")
    xtst = ctypes.CDLL(name)
    display = ctypes.c_void_p
    xtst.XTestFakeMotionEvent.argtypes = [display, ctypes.c_int, ctypes.c_int,
                                          ctypes.c_int, ctypes.c_ulong]
    xtst.XTestFakeButtonEvent.argtypes = [display, ctypes.c_uint, ctypes.c_int,
                                          ctypes.c_ulong]
    xtst.XTestFakeKeyEvent.argtypes = [display, ctypes.c_uint, ctypes.c_int,
                                       ctypes.c_ulong]
    return xtst


def linux_apply(plan, bounds):
    ctypes, x11, display, screen, bounds = linux_display()
    xtst = _xtst()
    for step in plan:
        kind = step[0]
        if kind in ("move", "button", "wheel"):
            _, x, y = step[0], step[1], step[2]
            xtst.XTestFakeMotionEvent(display, screen, x, y, 0)
            if kind == "wheel":
                synthetic = 4 if step[3] > 0 else 5
                for _ in range(min(abs(step[3]), MAX_WHEEL_CLICKS)):
                    xtst.XTestFakeButtonEvent(display, synthetic, 1, 0)
                    xtst.XTestFakeButtonEvent(display, synthetic, 0, 0)
            elif kind == "button":
                xtst.XTestFakeButtonEvent(display, BUTTONS[step[3]],
                                         1 if step[4] == "down" else 0, 0)
        elif kind == "key":
            code = x11.XKeysymToKeycode(display, X11_KEYSYM[step[1]])
            if not code:
                raise Failure("unsupported_input", "keycode")
            xtst.XTestFakeKeyEvent(display, code, 1 if step[2] == "down" else 0, 0)
        elif kind == "keysym":
            code = x11.XKeysymToKeycode(display, step[1])
            if not code:
                raise Failure("unsupported_input", "keysym")
            xtst.XTestFakeKeyEvent(display, code, 1, 0)
            xtst.XTestFakeKeyEvent(display, code, 0, 0)
        else:
            raise Failure("unsupported_input", kind)
        x11.XFlush(display)


def linux_release():
    ctypes, x11, display, _, _ = linux_display()
    xtst = _xtst()
    for button in (1, 2, 3):
        xtst.XTestFakeButtonEvent(display, button, 0, 0)
    x11.XFlush(display)


# ---------------------------------------------------------------- dispatch


def info(platform):
    if platform == "win32":
        _, user32, _ = _windows_dlls()
        bounds = windows_bounds(user32)
        backend = "windows-gdi"
    else:
        _, _, _, _, bounds = linux_display()
        backend = "linux-x11"
    return {
        "ok": True,
        "platform": backend,
        "deviceId": device_id(backend, bounds),
        "originX": bounds[0],
        "originY": bounds[1],
        "screenWidth": bounds[2],
        "screenHeight": bounds[3],
    }


def capture(platform, request, max_width, max_height):
    if request.get("consent") is not True:
        # Defence in depth: the Rust layer already required explicit consent.
        raise Failure("invalid_request", "consent")
    if platform == "win32":
        _, user32, _ = _windows_dlls()
        bounds = windows_bounds(user32)
        image, (width, height, factor) = windows_capture(bounds, max_width, max_height)
        backend = "windows-gdi"
    else:
        _, _, _, _, bounds = linux_display()
        image, (width, height, factor) = linux_capture(bounds, max_width, max_height)
        backend = "linux-x11"
    png = encode_png(image)
    return {
        "ok": True,
        "platform": backend,
        "deviceId": device_id(backend, bounds),
        "width": width,
        "height": height,
        "originX": bounds[0],
        "originY": bounds[1],
        "screenWidth": bounds[2],
        "screenHeight": bounds[3],
        "scale": round(factor, 6),
        "bytes": len(png),
    }, png


def apply_input(platform, request):
    if platform == "win32":
        _, user32, _ = _windows_dlls()
        bounds = windows_bounds(user32)
        windows_apply(plan_input(request, bounds, unicode_text=True), bounds)
        return {"ok": True}
    _, _, _, _, bounds = linux_display()
    linux_apply(plan_input(request, bounds, unicode_text=False), bounds)
    return {"ok": True}


def handle(request, platform, display):
    op = validate_request_fields(request).get("op")
    if op == "info":
        # Metadata only: no pixels and no input.
        return info(platform), b""
    if op == "release":
        if platform == "win32":
            windows_release()
        else:
            linux_release()
        return {"ok": True}, b""
    if op == "capture":
        # Consent is checked before any backend is even resolved, so a refusal
        # never depends on whether a display happens to exist.
        if request.get("consent") is not True:
            raise Failure("invalid_request", "consent")
        max_width = _integer(request, "maxWidth", 1, MAX_DIMENSION)
        max_height = _integer(request, "maxHeight", 1, MAX_DIMENSION)
        if platform != "win32" and not display:
            raise Failure("no_display")
        return capture(platform, request, max_width, max_height)
    if platform != "win32" and not display:
        raise Failure("no_display")
    return apply_input(platform, request), b""


def main():
    platform = sys.platform
    display = os.environ.get("DISPLAY")
    try:
        line = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
        if not line or len(line) > MAX_REQUEST_BYTES:
            raise Failure("invalid_request", "request")
        try:
            request = json.loads(line.decode("utf-8"))
        except Exception:  # noqa: BLE001 - a malformed request is a refusal
            raise Failure("invalid_request", "json")
        if not isinstance(request, dict):
            raise Failure("invalid_request", "request")
        header, body = handle(request, platform, display)
    except Failure as failure:
        header = {"ok": False, "error": failure.code}
        if failure.detail:
            header["detail"] = failure.detail
        body = b""
    except Exception:  # noqa: BLE001 - never leak a native traceback
        header, body = {"ok": False, "error": "capture_failed"}, b""
    sys.stdout.buffer.write(json.dumps(header).encode("utf-8") + b"\n")
    if header.get("ok") and header.get("bytes"):
        sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()
    return 0 if header.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
