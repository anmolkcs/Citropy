import base64
import ctypes
import ctypes.util
import json
import math
import os
import select
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from itertools import groupby
from computer_wayland import WaylandInput


def number(value, low, high, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError("Invalid " + name)
    return value


def encode(data, width, height, stride, maximum, crop=None):
    from gi.repository import GdkPixbuf, GLib
    image = GdkPixbuf.Pixbuf.new_from_bytes(GLib.Bytes.new(data), GdkPixbuf.Colorspace.RGB, False, 8, width, height, stride)
    bounds = None
    if crop is not None:
        if not isinstance(crop, dict):
            raise ValueError("Choose a screen region.")
        x = number(crop.get("x"), 0, 1, "region x")
        y = number(crop.get("y"), 0, 1, "region y")
        w = number(crop.get("width"), 0, 1, "region width")
        h = number(crop.get("height"), 0, 1, "region height")
        if w <= 0 or h <= 0 or x + w > 1 + 1e-9 or y + h > 1 + 1e-9:
            raise ValueError("The region must fit inside the screen.")
        left, top = math.floor(x * width), math.floor(y * height)
        right, bottom = min(width, math.ceil((x + w) * width)), min(height, math.ceil((y + h) * height))
        if right <= left or bottom <= top:
            raise ValueError("The screen region is empty.")
        image = image.new_subpixbuf(left, top, right - left, bottom - top)
        bounds = {"x": left / width, "y": top / height, "width": (right - left) / width, "height": (bottom - top) / height}
    scale = min(1, maximum / image.get_width(), 1600 / image.get_height())
    if scale < 1:
        image = image.scale_simple(max(1, round(image.get_width() * scale)), max(1, round(image.get_height() * scale)), GdkPixbuf.InterpType.BILINEAR)
    ok, output = image.save_to_bufferv("jpeg", ["quality"], ["82"])
    if not ok:
        raise RuntimeError("The screen image could not be encoded.")
    return {"image": base64.b64encode(output).decode("ascii"), "width": image.get_width(), "height": image.get_height(), **({"crop": bounds} if bounds else {})}


def dependencies():
    """Probe the desktop and report the computer-use backend to use."""
    if sys.platform != "linux":
        raise RuntimeError("Computer use currently supports Linux desktops.")
    import gi
    gi.require_version("GdkPixbuf", "2.0")
    if os.environ.get("XDG_SESSION_TYPE") == "wayland" or os.environ.get("WAYLAND_DISPLAY"):
        import dbus
        gi.require_version("Gst", "1.0")
        gi.require_version("GstVideo", "1.0")
        from gi.repository import Gst
        Gst.init(None)
        missing = [name for name in ["pipewiresrc", "videorate", "videoconvert", "appsink"] if not Gst.ElementFactory.find(name)]
        if missing:
            raise RuntimeError("Install the GStreamer PipeWire and base plugins: " + ", ".join(missing))
        bus = dbus.SessionBus()
        obj = bus.get_object("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop")
        props = dbus.Interface(obj, "org.freedesktop.DBus.Properties")
        if int(props.Get("org.freedesktop.portal.ScreenCast", "AvailableSourceTypes")) & 1 != 1:
            raise RuntimeError("This desktop portal does not offer monitor sharing.")
        try:
            if int(props.Get("org.freedesktop.portal.RemoteDesktop", "AvailableDeviceTypes")) & 3 == 3:
                return "wayland-portal"
        except dbus.DBusException as error:
            if error.get_dbus_name() not in ["org.freedesktop.DBus.Error.InvalidArgs", "org.freedesktop.DBus.Error.UnknownInterface", "org.freedesktop.DBus.Error.UnknownProperty"]:
                raise
        try:
            WaylandInput.probe()
            return "wayland-wlr"
        except (OSError, RuntimeError):
            return "wayland-screencast"
    if not os.environ.get("DISPLAY"):
        raise RuntimeError("Sign into a graphical desktop to use computer control.")
    if not shutil.which("xdotool"):
        raise RuntimeError("Install xdotool to control an X11 desktop.")
    if not ctypes.util.find_library("X11") or not ctypes.util.find_library("Xtst"):
        raise RuntimeError("Install the X11 and XTest libraries.")
    return "x11"


class Portal:
    """Screen sharing with portal or direct Wayland virtual input."""

    def __init__(self, backend="wayland-portal"):
        import dbus
        from dbus.mainloop.glib import DBusGMainLoop
        from gi.repository import GLib, Gst
        DBusGMainLoop(set_as_default=True)
        self.dbus = dbus
        self.bus = dbus.SessionBus(private=True)
        self.bus.set_exit_on_disconnect(False)
        self.object = self.bus.get_object("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", introspect=False)
        self.remote = dbus.Interface(self.object, "org.freedesktop.portal.RemoteDesktop")
        self.cast = dbus.Interface(self.object, "org.freedesktop.portal.ScreenCast")
        self.loop = GLib.MainLoop()
        self.loop_thread = threading.Thread(target=self.loop.run, daemon=True)
        self.loop_thread.start()
        self.session = None
        self.requests = set()
        self.streams = {}
        self.pressed = set()
        self.buttons = set()
        self.control = False
        self.closed = False
        self.Gst = Gst
        self.backend = backend
        self.virtual = None

    def request(self, interface, method, *args, **options):
        """Call one portal method and wait for its request response."""
        token = "citropy_" + uuid.uuid4().hex
        path = "/org/freedesktop/portal/desktop/request/" + self.bus.get_unique_name()[1:].replace(".", "_") + "/" + token
        options["handle_token"] = self.dbus.String(token)
        done = threading.Event()
        result = []

        def response(code, values):
            result.extend([int(code), values])
            done.set()

        match = self.bus.add_signal_receiver(response, signal_name="Response", dbus_interface="org.freedesktop.portal.Request", path=path)
        self.requests.add(path)
        try:
            getattr(interface, method)(*args, self.dbus.Dictionary(options, signature="sv"), timeout=15)
            if not done.wait(115):
                raise RuntimeError("Screen sharing was not confirmed. Try again and select a screen in the desktop dialog.")
            if result[0] != 0:
                raise RuntimeError("Screen sharing was cancelled or denied by the desktop.")
            return result[1]
        finally:
            match.remove()
            try:
                self.bus.get_object("org.freedesktop.portal.Desktop", path, introspect=False).Close(dbus_interface="org.freedesktop.portal.Request", timeout=2)
            except Exception:
                pass
            self.requests.discard(path)

    def start(self, control):
        """Open capture (and virtual input on supported compositors), rolling back on failure."""
        if control and self.backend == "wayland-screencast":
            raise RuntimeError("This compositor supports screen sharing only. Use Plan only mode to view it; control requires RemoteDesktop or Wayland virtual input support.")
        self.control = control
        if control and self.backend == "wayland-wlr":
            self.virtual = WaylandInput()
        try:
            remote_control = control and self.virtual is None
            interface = self.remote if remote_control else self.cast
            created = self.request(interface, "CreateSession", session_handle_token=self.dbus.String("citropy_" + uuid.uuid4().hex))
            self.session = self.dbus.ObjectPath(str(created["session_handle"]))
            self.bus.add_signal_receiver(self.on_closed, signal_name="Closed", dbus_interface="org.freedesktop.portal.Session", path=str(self.session))
            if remote_control:
                self.request(self.remote, "SelectDevices", self.session, types=self.dbus.UInt32(3))
            self.request(self.cast, "SelectSources", self.session, types=self.dbus.UInt32(1), multiple=self.dbus.Boolean(True), cursor_mode=self.dbus.UInt32(2))
            result = self.request(interface, "Start", self.session, "")
            if remote_control and int(result.get("devices", 0)) & 3 != 3:
                raise RuntimeError("Allow both keyboard and pointer control in the desktop sharing dialog.")
            streams = result.get("streams", [])
            if not streams:
                raise RuntimeError("No screen was selected.")
            for index, (node, properties) in enumerate(streams):
                fd = self.cast.OpenPipeWireRemote(self.session, self.dbus.Dictionary({}, signature="sv")).take()
                # Returning PipeWire's buffers immediately prevents downstream samples
                # and videorate from exhausting a compositor's small capture pool.
                pipeline = self.Gst.parse_launch("pipewiresrc name=source do-timestamp=true always-copy=true keepalive-time=1000 ! videorate drop-only=true max-rate=5 ! video/x-raw,framerate=5/1 ! videoconvert ! video/x-raw,format=RGB ! appsink name=sink max-buffers=1 drop=true sync=false enable-last-sample=false")
                source = pipeline.get_by_name("source")
                source.set_property("fd", fd)
                source.set_property("path", str(node))
                size = properties.get("logical_size", properties.get("size", [0, 0]))
                entry = {"id": str(node), "name": "Screen " + str(index + 1), "width": int(size[0]), "height": int(size[1]), "pipeline": pipeline, "sink": pipeline.get_by_name("sink"), "fd": fd}
                position = properties.get("position")
                if position is not None:
                    entry.update(x=int(position[0]), y=int(position[1]))
                self.streams[str(node)] = entry
                pipeline.set_state(self.Gst.State.PLAYING)
                self.sample(entry)
            if self.virtual:
                self.virtual.start(list(self.streams.values()))
            return self.displays()
        except BaseException:
            # A failed start must not retain the compositor connection or
            # half-opened capture pipelines; the helper stays startable.
            if self.virtual:
                self.virtual.close()
                self.virtual = None
            for entry in self.streams.values():
                try:
                    entry["pipeline"].set_state(self.Gst.State.NULL)
                except Exception:
                    pass
                try:
                    os.close(entry["fd"])
                except Exception:
                    pass
            self.streams.clear()
            raise

    def on_closed(self, *_):
        """Report desktop-side session closure to the host."""
        self.closed = True
        print(json.dumps({"event": "closed", "reason": "Screen sharing ended on the desktop."}), flush=True)

    def displays(self):
        """List shared screens without capture internals."""
        return [{key: value[key] for key in ["id", "name", "width", "height", "x", "y"] if key in value} for value in self.streams.values()]

    def sample(self, entry):
        """Pull a fresh screen sample or fail instead of reusing an old one."""
        from gi.repository import GstVideo
        if self.closed:
            raise RuntimeError("Screen sharing has ended.")
        error = entry["pipeline"].get_bus().pop_filtered(self.Gst.MessageType.ERROR | self.Gst.MessageType.EOS)
        if error:
            raise RuntimeError("The screen stream stopped. Start computer use again.")
        sample = entry["sink"].emit("try-pull-sample", 3 * self.Gst.SECOND)
        if sample is None:
            raise RuntimeError("The desktop did not deliver a fresh screen image. Stop computer use and share the screen again.")
        info = GstVideo.VideoInfo.new_from_caps(sample.get_caps())
        size = (info.width, info.height)
        if entry.get("capture_size", size) != size:
            self.on_closed()
            raise RuntimeError("The screen resolution changed. Share the screen again before continuing.")
        entry["capture_size"] = size
        if not entry["width"] or not entry["height"]:
            entry["width"], entry["height"] = info.width, info.height
        return sample, info

    def screenshot(self, display_id, maximum, crop=None):
        """Capture, optionally crop, and JPEG-encode one shared screen."""
        if self.virtual:
            self.virtual.sync(check_cancelled=False)
        entry = self.streams.get(display_id)
        if not entry:
            raise ValueError("Choose one of the shared screens.")
        sample, info = self.sample(entry)
        buffer = sample.get_buffer()
        ok, mapped = buffer.map(self.Gst.MapFlags.READ)
        if not ok:
            raise RuntimeError("The screen image could not be read.")
        try:
            return encode(bytes(mapped.data), info.width, info.height, info.stride[0], maximum, crop)
        finally:
            buffer.unmap(mapped)

    def move(self, display_id, x, y):
        """Move the pointer to absolute desktop coordinates."""
        if self.virtual:
            return self.virtual.move(display_id, x, y)
        self.remote.NotifyPointerMotionAbsolute(self.session, self.dbus.Dictionary({}, signature="sv"), self.dbus.UInt32(int(display_id)), float(x), float(y))

    def button(self, button, pressed):
        """Press or release a pointer button, tracking held buttons."""
        if self.virtual:
            return self.virtual.button(button, pressed)
        code = {"left": 272, "right": 273, "middle": 274}[button]
        if pressed:
            self.buttons.add(button)
        self.remote.NotifyPointerButton(self.session, self.dbus.Dictionary({}, signature="sv"), self.dbus.Int32(code), self.dbus.UInt32(int(pressed)))
        if not pressed:
            self.buttons.discard(button)

    def key(self, key, pressed):
        """Send one keysym event, tracking held keys for cleanup."""
        if pressed:
            self.pressed.add(key)
        self.remote.NotifyKeyboardKeysym(self.session, self.dbus.Dictionary({}, signature="sv"), self.dbus.Int32(key), self.dbus.UInt32(int(pressed)))
        if not pressed:
            self.pressed.discard(key)

    def press(self, keys):
        """Press a shortcut chord, releasing every key afterwards."""
        if self.virtual:
            return self.virtual.press([keysym(key) for key in keys])
        held = []
        try:
            for key in keys:
                self.key(keysym(key), True)
                held.append(keysym(key))
        finally:
            for key in reversed(held):
                self.key(key, False)

    def type(self, text):
        """Type text through the active virtual keyboard."""
        if self.virtual:
            return self.virtual.type(text)
        for character in text:
            key = {"\n": 0xff0d, "\t": 0xff09}.get(character, ord(character) if ord(character) <= 0xff else 0x01000000 | ord(character))
            try:
                self.key(key, True)
            finally:
                self.key(key, False)

    def scroll(self, dx, dy):
        """Send pointer scroll deltas through the active backend."""
        if self.virtual:
            return self.virtual.scroll(dx, dy)
        self.remote.NotifyPointerAxis(self.session, self.dbus.Dictionary({"finish": self.dbus.Boolean(True)}, signature="sv"), float(dx), float(dy))

    def stop(self):
        """Release held input, close capture, and disconnect virtual devices."""
        if self.virtual:
            self.virtual.close()
            self.virtual = None
        if self.session:
            for key in list(self.pressed):
                try:
                    self.key(key, False)
                except Exception:
                    pass
            for button in list(self.buttons):
                try:
                    self.button(button, False)
                except Exception:
                    pass
            try:
                self.bus.get_object("org.freedesktop.portal.Desktop", self.session, introspect=False).Close(dbus_interface="org.freedesktop.portal.Session", timeout=2)
            except Exception:
                pass
            self.session = None
        for entry in self.streams.values():
            entry["pipeline"].set_state(self.Gst.State.NULL)
            os.close(entry["fd"])
        self.streams.clear()
        self.bus.close()
        from gi.repository import GLib
        GLib.idle_add(self.loop.quit)
        self.loop_thread.join(timeout=0.5)


class XImage(ctypes.Structure):
    _fields_ = [("width", ctypes.c_int), ("height", ctypes.c_int), ("xoffset", ctypes.c_int), ("format", ctypes.c_int), ("data", ctypes.c_void_p), ("byte_order", ctypes.c_int), ("bitmap_unit", ctypes.c_int), ("bitmap_bit_order", ctypes.c_int), ("bitmap_pad", ctypes.c_int), ("depth", ctypes.c_int), ("bytes_per_line", ctypes.c_int), ("bits_per_pixel", ctypes.c_int), ("red_mask", ctypes.c_ulong), ("green_mask", ctypes.c_ulong), ("blue_mask", ctypes.c_ulong)]


class X11:
    def __init__(self):
        self.x = ctypes.CDLL(ctypes.util.find_library("X11"))
        self.xt = ctypes.CDLL(ctypes.util.find_library("Xtst"))
        self.x.XOpenDisplay.argtypes = [ctypes.c_char_p]
        self.x.XOpenDisplay.restype = ctypes.c_void_p
        self.x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        self.x.XDefaultRootWindow.restype = ctypes.c_ulong
        self.x.XDefaultScreen.argtypes = [ctypes.c_void_p]
        self.x.XGetGeometry.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
        self.x.XDisplayWidth.argtypes = self.x.XDisplayHeight.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.x.XGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_int]
        self.x.XGetImage.restype = ctypes.POINTER(XImage)
        self.x.XDestroyImage.argtypes = [ctypes.POINTER(XImage)]
        self.x.XFlush.argtypes = self.x.XCloseDisplay.argtypes = [ctypes.c_void_p]
        self.xt.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
        self.xt.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
        self.xt.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
        self.x.XDisplayKeycodes.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
        self.x.XGetKeyboardMapping.argtypes = [ctypes.c_void_p, ctypes.c_ubyte, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
        self.x.XGetKeyboardMapping.restype = ctypes.POINTER(ctypes.c_ulong)
        self.x.XChangeKeyboardMapping.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_ulong), ctypes.c_int]
        self.x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.x.XFree.argtypes = [ctypes.c_void_p]
        self.display = self.x.XOpenDisplay(None)
        if not self.display:
            raise RuntimeError("Could not connect to the X11 desktop.")
        self.screen = self.x.XDefaultScreen(self.display)
        self.root = self.x.XDefaultRootWindow(self.display)
        self.buttons = set()
        self.key_process = None
        self.size = None

    def geometry(self):
        root, x, y = ctypes.c_ulong(), ctypes.c_int(), ctypes.c_int()
        width, height, border, depth = [ctypes.c_uint() for _ in range(4)]
        if not self.x.XGetGeometry(self.display, self.root, ctypes.byref(root), ctypes.byref(x), ctypes.byref(y), ctypes.byref(width), ctypes.byref(height), ctypes.byref(border), ctypes.byref(depth)):
            raise RuntimeError("The desktop dimensions could not be read.")
        return width.value, height.value

    def start(self, control):
        self.control = control
        self.size = self.geometry()
        return [{"id": "desktop", "name": "Desktop", "width": self.size[0], "height": self.size[1]}]

    def screenshot(self, display_id, maximum, crop=None):
        """Capture the X11 root window and JPEG-encode it."""
        if display_id != "desktop":
            raise ValueError("Unknown screen")
        width, height = self.geometry()
        if (width, height) != self.size:
            reason = "The screen resolution changed. Share the screen again before continuing."
            print(json.dumps({"event": "closed", "reason": reason, "error": True}), flush=True)
            raise RuntimeError(reason)
        image = self.x.XGetImage(self.display, self.root, 0, 0, width, height, ctypes.c_ulong(-1).value, 2)
        if not image:
            raise RuntimeError("The desktop could not be captured.")
        try:
            item = image.contents
            if item.bits_per_pixel != 32 or item.byte_order != 0 or item.red_mask != 0xff0000:
                raise RuntimeError("Computer use requires a standard 24-bit or 32-bit X11 display.")
            raw = ctypes.string_at(item.data, item.bytes_per_line * height)
            if item.bytes_per_line != width * 4:
                raw = b"".join(raw[y * item.bytes_per_line:y * item.bytes_per_line + width * 4] for y in range(height))
            rgb = bytearray(width * height * 3)
            rgb[0::3], rgb[1::3], rgb[2::3] = raw[2::4], raw[1::4], raw[0::4]
            return encode(bytes(rgb), width, height, width * 3, maximum, crop)
        finally:
            self.x.XDestroyImage(image)

    def move(self, display_id, x, y):
        """Move the X11 pointer to absolute desktop coordinates."""
        self.xt.XTestFakeMotionEvent(self.display, self.screen, round(x), round(y), 0)
        self.x.XFlush(self.display)

    def button(self, button, pressed):
        """Press or release an X11 pointer button, tracking held buttons."""
        if pressed:
            self.buttons.add(button)
        self.xt.XTestFakeButtonEvent(self.display, {"left": 1, "middle": 2, "right": 3}[button], int(pressed), 0)
        self.x.XFlush(self.display)
        if not pressed:
            self.buttons.discard(button)

    def command(self, args, text=None, timeout=75):
        self.key_process = subprocess.Popen(["xdotool", *args], stdin=subprocess.PIPE if text is not None else subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            _, error = self.key_process.communicate(text.encode() if text is not None else None, timeout=timeout if text is not None else 20)
            if self.key_process.returncode:
                raise RuntimeError(error.decode(errors="replace")[:300] or "Keyboard input failed.")
        finally:
            if self.key_process.poll() is None:
                self.key_process.kill()
                self.key_process.wait()
            self.key_process = None

    def press(self, keys):
        """Press an X11 shortcut chord via xdotool, then release it."""
        names = [xkey(key) for key in keys]
        try:
            self.command(["key", "--clearmodifiers", "+".join(names)])
        finally:
            subprocess.run(["xdotool", "keyup", *names], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)

    def type(self, text):
        """Type text on X11, remapping keys for non-ASCII segments."""
        for ascii_only, characters in groupby(text, str.isascii):
            segment = "".join(characters)
            if ascii_only:
                self.command(["type", "--clearmodifiers", "--delay", "12", "--file", "-"], segment, max(75, len(segment) * 0.012 + 20))
            else:
                self.type_unicode(segment)

    def spare_keycode(self):
        low, high, per = ctypes.c_int(), ctypes.c_int(), ctypes.c_int()
        self.x.XDisplayKeycodes(self.display, ctypes.byref(low), ctypes.byref(high))
        count = high.value - low.value + 1
        mapping = self.x.XGetKeyboardMapping(self.display, low.value, count, ctypes.byref(per))
        try:
            for index in range(count - 1, -1, -1):
                if not any(mapping[index * per.value + level] for level in range(per.value)):
                    return low.value + index
        finally:
            self.x.XFree(mapping)
        raise RuntimeError("No free key is available to type this character.")

    def type_unicode(self, text):
        # Apps translate a key press with the keymap they hold when they read the event, so each remap waits until the previous press has been read.
        code = self.spare_keycode()
        try:
            for character in text:
                point = ord(character)
                symbol = point if 0xa0 <= point <= 0xff else 0x01000000 + point
                self.x.XChangeKeyboardMapping(self.display, code, 2, (ctypes.c_ulong * 2)(symbol, symbol), 1)
                self.x.XSync(self.display, 0)
                time.sleep(0.05)
                self.xt.XTestFakeKeyEvent(self.display, code, 1, 0)
                self.xt.XTestFakeKeyEvent(self.display, code, 0, 0)
                self.x.XSync(self.display, 0)
                time.sleep(0.08)
        finally:
            self.x.XChangeKeyboardMapping(self.display, code, 2, (ctypes.c_ulong * 2)(0, 0), 1)
            self.x.XSync(self.display, 0)

    def scroll(self, dx, dy):
        """Send X11 scroll input as faked button presses."""
        for delta, positive, negative in [(dy, 5, 4), (dx, 7, 6)]:
            for _ in range(min(80, round(abs(delta) / 60))):
                button = positive if delta > 0 else negative
                self.xt.XTestFakeButtonEvent(self.display, button, 1, 0)
                self.xt.XTestFakeButtonEvent(self.display, button, 0, 0)
        self.x.XFlush(self.display)

    def stop(self):
        if self.key_process and self.key_process.poll() is None:
            self.key_process.kill()
        for button in list(self.buttons):
            self.button(button, False)
        if self.display:
            self.x.XCloseDisplay(self.display)
            self.display = None


KEYS = {"Control": "Control_L", "Ctrl": "Control_L", "Alt": "Alt_L", "Shift": "Shift_L", "Super": "Super_L", "Meta": "Super_L", "Enter": "Return", "Escape": "Escape", "Tab": "Tab", "Space": "space", "Backspace": "BackSpace", "Delete": "Delete", "ArrowUp": "Up", "ArrowDown": "Down", "ArrowLeft": "Left", "ArrowRight": "Right", "Home": "Home", "End": "End", "PageUp": "Prior", "PageDown": "Next", "Insert": "Insert", "PrintScreen": "Print", "Plus": "plus"}


def xkey(key):
    if key in KEYS:
        return KEYS[key]
    if len(key) == 1 and key.isascii() and key.isalnum():
        return key.lower()
    if key.startswith("F") and key[1:].isdigit() and 1 <= int(key[1:]) <= 24:
        return key
    raise ValueError("Unknown key: " + key)


def keysym(key):
    name = xkey(key)
    library = ctypes.CDLL(ctypes.util.find_library("xkbcommon"))
    library.xkb_keysym_from_name.argtypes = [ctypes.c_char_p, ctypes.c_int]
    library.xkb_keysym_from_name.restype = ctypes.c_uint32
    value = library.xkb_keysym_from_name(name.encode(), 0)
    if not value:
        raise ValueError("Unknown key: " + key)
    return value


def act(driver, data, displays):
    """Validate one computer action and run it against the driver."""
    if not driver.control:
        raise RuntimeError("This session only allows viewing the screen.")
    action = data.get("action")
    if action in ["move", "click", "drag", "scroll"]:
        display = next((entry for entry in displays if entry["id"] == data.get("displayId")), None)
        if not display:
            raise ValueError("Unknown screen")
        x = number(data.get("x"), 0, display["width"] - 1, "x")
        y = number(data.get("y"), 0, display["height"] - 1, "y")
        driver.move(display["id"], x, y)
    if action == "click":
        button = data.get("button", "left")
        if button not in ["left", "middle", "right"]:
            raise ValueError("Unknown mouse button")
        count = number(data.get("count", 1), 1, 3, "click count")
        if int(count) != count:
            raise ValueError("Use a whole click count")
        for _ in range(int(count)):
            try:
                driver.button(button, True)
                time.sleep(0.025)
            finally:
                driver.button(button, False)
            time.sleep(0.06)
    elif action == "drag":
        target_x = number(data.get("toX"), 0, display["width"] - 1, "target x")
        target_y = number(data.get("toY"), 0, display["height"] - 1, "target y")
        duration = number(data.get("durationMs", 500), 100, 3000, "drag duration") / 1000
        steps = max(2, round(duration * 40))
        try:
            driver.button("left", True)
            for index in range(1, steps + 1):
                driver.move(display["id"], x + (target_x - x) * index / steps, y + (target_y - y) * index / steps)
                time.sleep(duration / steps)
        finally:
            driver.button("left", False)
    elif action == "scroll":
        driver.scroll(number(data.get("deltaX", 0), -4800, 4800, "horizontal scroll"), number(data.get("deltaY", 0), -4800, 4800, "vertical scroll"))
    elif action == "press":
        key = data.get("key")
        if not isinstance(key, str) or len(key) > 100:
            raise ValueError("Provide a key or shortcut")
        keys = key.split("+")
        if len(keys) > 5 or len(set(keys)) != len(keys):
            raise ValueError("Invalid shortcut")
        for item in keys:
            xkey(item)
        driver.press(keys)
    elif action == "type":
        text = data.get("text")
        if not isinstance(text, str) or not text or len(text) > 4000 or any(ord(c) < 32 and c not in "\t\n" for c in text):
            raise ValueError("Type between 1 and 4,000 characters without control codes.")
        driver.type(text)
    elif action == "wait":
        duration = number(data.get("durationMs", 500), 0, 5000, "wait duration") / 1000
        virtual = getattr(driver, "virtual", None)
        if virtual:
            end = time.monotonic() + duration
            while time.monotonic() < end:
                virtual.check_cancelled()
                time.sleep(min(0.05, max(0, end - time.monotonic())))
            virtual.check_cancelled()
        else:
            time.sleep(duration)
    elif action != "move":
        raise ValueError("Unknown computer action")


def main():
    """Serve one computer session over stdin/stdout until stopped."""
    driver = None
    displays = []
    paused = False
    acting = False
    backend = dependencies()
    if "--probe" in sys.argv:
        result = {"available": True, "platform": "linux", "backend": backend}
        if backend == "wayland-screencast":
            result["reason"] = "Screen sharing is available in Plan only mode. Desktop control requires a RemoteDesktop portal or compositor support for Wayland virtual input."
        print(json.dumps(result), flush=True)
        return

    def interrupted(*_):
        raise KeyboardInterrupt()

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    def pause(*_):
        nonlocal paused
        paused = True
        virtual = getattr(driver, "virtual", None)
        if virtual:
            # Let a Wayland round trip finish so cancellation cannot split a frame.
            virtual.cancelled = True
        elif acting:
            raise InterruptedError("Computer control was paused.")
    signal.signal(signal.SIGUSR1, pause)
    buffer = b""
    try:
        while True:
            if b"\n" not in buffer:
                if not select.select([sys.stdin], [], [], 300)[0]:
                    break
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    break
                buffer += data
                if len(buffer) > 100000:
                    raise RuntimeError("Computer input exceeded the request limit.")
                continue
            line, buffer = buffer.split(b"\n", 1)
            request = {}
            try:
                request = json.loads(line)
                method = request.get("method")
                data = request.get("params", {})
                if method == "start":
                    if driver:
                        raise ValueError("A computer session is already open.")
                    driver = Portal(backend) if backend.startswith("wayland-") else X11()
                    displays = driver.start(bool(data.get("control")))
                    result = {"displays": displays, "backend": backend}
                elif not driver:
                    raise ValueError("Start a computer session first.")
                elif method == "screenshot":
                    result = driver.screenshot(data.get("displayId"), number(data.get("maxWidth", 1600), 320, 2560, "image width"), data.get("crop"))
                elif method == "action":
                    if paused:
                        raise RuntimeError("Computer control is paused.")
                    acting = True
                    try:
                        act(driver, data, displays)
                    finally:
                        acting = False
                        if paused and getattr(driver, "virtual", None):
                            driver.virtual.release()
                    result = {"ok": True}
                elif method == "pause":
                    paused = bool(data.get("paused"))
                    if getattr(driver, "virtual", None):
                        driver.virtual.cancelled = paused
                        if paused:
                            driver.virtual.release()
                    result = {"paused": paused}
                elif method == "stop":
                    break
                else:
                    raise ValueError("Unknown computer operation")
                print(json.dumps({"id": request.get("id"), "result": result}), flush=True)
            except Exception as error:
                print(json.dumps({"id": request.get("id"), "error": str(error)}), flush=True)
    finally:
        if driver:
            driver.stop()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as error:
        if "--probe" in sys.argv:
            print(json.dumps({"available": False, "platform": sys.platform, "backend": "unavailable", "reason": str(error)}), flush=True)
        else:
            print(json.dumps({"event": "closed", "reason": str(error), "error": True}), flush=True)
        sys.exit(1)
