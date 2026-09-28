import array
import ctypes
import ctypes.util
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "desktop"))
from computer_wayland import WaylandInput

spec = importlib.util.spec_from_file_location("computer_linux", Path(__file__).resolve().parents[1] / "desktop/computer-linux.py")
computer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(computer)


def words(*values):
    return struct.pack("=" + "I" * len(values), *values)


def signed(*values):
    return struct.pack("=" + "i" * len(values), *values)


def text(value):
    data = value.encode() + b"\0"
    return words(len(data)) + data.ljust((len(data) + 3) & ~3, b"\0")


class Compositor:
    """A private wire-protocol peer: no connection to the user's desktop."""

    def __init__(self):
        """Listen on an isolated Wayland socket in a temp directory."""
        self.directory = tempfile.TemporaryDirectory(prefix="citropy-wayland-test-")
        self.path = os.path.join(self.directory.name, "wayland")
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(self.path)
        self.listener.listen(1)
        self.listener.settimeout(5)
        self.objects = {1: "wl_display"}
        self.bound_outputs = {}
        self.logical_outputs = {}
        self.pointers = {}
        self.events = []
        self.keymaps = []
        self.errors = []
        self.on_key = None
        self.layout_change = False
        self.reject_keyboard = False
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def emit(self, target, opcode, payload):
        """Send one raw Wayland message to the connected client."""
        self.connection.sendall(words(target, ((len(payload) + 8) << 16) | opcode) + payload)

    def run(self):
        """Serve registry, outputs, and virtual devices until disconnect."""
        fds = []
        try:
            self.connection, _ = self.listener.accept()
            with self.connection:
                self.connection.settimeout(5)
                buffer = b""
                while True:
                    data, ancillary, _, _ = self.connection.recvmsg(65536, socket.CMSG_SPACE(16))
                    if not data:
                        return
                    for level, kind, payload in ancillary:
                        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                            values = array.array("i")
                            values.frombytes(payload[:len(payload) - len(payload) % values.itemsize])
                            fds.extend(values)
                    buffer += data
                    while len(buffer) >= 8:
                        target, header = struct.unpack_from("=II", buffer)
                        size, opcode = header >> 16, header & 0xffff
                        if len(buffer) < size:
                            break
                        payload, buffer = buffer[8:size], buffer[size:]
                        self.request(target, opcode, payload, fds)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except BaseException as error:
            self.errors.append(error)
        finally:
            for fd in fds:
                os.close(fd)

    def request(self, target, opcode, data, fds):
        """Handle one client request, recording events and keymaps."""
        interface = self.objects[target]
        values = struct.unpack("=" + "I" * (len(data) // 4), data)
        if interface == "wl_display":
            if opcode == 1:
                registry = values[0]
                self.objects[registry] = "wl_registry"
                for name, kind, version in [(10, "wl_seat", 1), (11, "wl_output", 4), (12, "wl_output", 4), (13, "zxdg_output_manager_v1", 2), (14, "zwlr_virtual_pointer_manager_v1", 2), (15, "zwp_virtual_keyboard_manager_v1", 1)]:
                    self.emit(registry, 0, words(name) + text(kind) + words(version))
            else:
                self.events.append((interface, target, opcode, values))
                if self.layout_change:
                    logical = next(iter(self.logical_outputs))
                    self.emit(logical, 0, signed(300, 400))
                    self.layout_change = False
                self.emit(values[0], 0, words(1))
                self.emit(1, 1, words(values[0]))
        elif interface == "wl_registry":
            name, length = values[:2]
            kind = data[8:8 + length - 1].decode()
            version, object_id = struct.unpack_from("=II", data, 8 + ((length + 3) & ~3))
            self.objects[object_id] = kind
            if kind == "wl_output":
                self.bound_outputs[object_id] = name
                self.emit(object_id, 0, signed(0, 0, 300, 200, 0) + text("Test") + text("Monitor") + signed(0))
                self.emit(object_id, 1, words(1) + signed(2560, 1440, 60000))
                self.emit(object_id, 3, signed(2))
                self.emit(object_id, 2, b"")
        elif interface == "zxdg_output_manager_v1":
            logical, output = values
            self.objects[logical] = "zxdg_output_v1"
            self.logical_outputs[logical] = output
            x = -1280 if self.bound_outputs[output] == 11 else 0
            self.emit(logical, 0, signed(x, 0))
            self.emit(logical, 1, signed(1280, 720))
            self.emit(logical, 3, text(f"OUTPUT-{self.bound_outputs[output]}"))
            self.emit(logical, 2, b"")
        elif interface == "zwlr_virtual_pointer_manager_v1":
            assert opcode == 2, "the pointer must be bound to the selected output"
            seat, output, pointer = values
            self.objects[pointer] = "zwlr_virtual_pointer_v1"
            self.pointers[pointer] = self.bound_outputs[output]
        elif interface == "zwp_virtual_keyboard_manager_v1":
            seat, keyboard = values
            self.objects[keyboard] = "zwp_virtual_keyboard_v1"
            if self.reject_keyboard:
                self.emit(1, 0, words(keyboard, 0) + text("virtual keyboard denied"))
        elif interface == "zwp_virtual_keyboard_v1" and opcode == 0:
            assert values[0] == 1
            fd = fds.pop(0)
            try:
                os.lseek(fd, 0, os.SEEK_SET)
                self.keymaps.append(os.read(fd, values[1]))
                assert len(self.keymaps[-1]) == values[1]
            finally:
                os.close(fd)
        else:
            self.events.append((interface, target, opcode, values))
            if interface == "zwp_virtual_keyboard_v1" and opcode == 1 and self.on_key:
                self.on_key(values)

    def close(self):
        """Join the server thread, failing if the client never disconnected."""
        self.thread.join(5)
        self.listener.close()
        self.directory.cleanup()
        if self.thread.is_alive():
            raise AssertionError("Wayland connection was not closed")
        if self.errors:
            raise self.errors[0]


class VirtualInputTests(unittest.TestCase):
    def setUp(self):
        """Start an isolated compositor and connect a client to it."""
        self.server = Compositor()
        self.addCleanup(self.server.close)
        self.environment = patch.dict(os.environ, {"WAYLAND_DISPLAY": self.server.path})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.client = WaylandInput()
        self.addCleanup(self.client.close)
        self.stream = {"id": "screen", "width": 1280, "height": 720, "x": -1280, "y": 0}

    def start(self):
        """Begin a control session on the single positioned test screen."""
        self.client.start([self.stream])

    def test_probe_does_not_create_input_devices(self):
        """Probing binds globals but creates no pointers or keyboards."""
        self.assertEqual(self.server.pointers, {})
        self.assertNotIn("zwp_virtual_keyboard_v1", self.server.objects.values())

    def test_scaled_monitor_mapping_and_pointer_events(self):
        """Check output matching and the pointer/button/scroll wire format."""
        self.start()
        self.client.move("screen", 640, 360)
        self.client.button("left", True)
        self.client.button("left", False)
        self.client.scroll(-60, 120)
        pointer = next(iter(self.server.pointers))
        self.assertEqual(self.server.pointers[pointer], 11)
        events = [entry for entry in self.server.events if entry[1] == pointer]
        motion = next(entry[3] for entry in events if entry[2] == 1)
        self.assertEqual(motion[1:], (640 * 256, 360 * 256, 1280 * 256, 720 * 256))
        self.assertEqual([entry[3][1:] for entry in events if entry[2] == 2], [(272, 1), (272, 0)])
        axes = [struct.unpack("=i", words(entry[3][2]))[0] for entry in events if entry[2] == 3]
        self.assertEqual(axes, [120 * 256, -60 * 256])

    def test_ambiguous_monitor_is_rejected_before_creating_devices(self):
        """Refuse to guess among same-sized outputs without position metadata."""
        with self.assertRaisesRegex(RuntimeError, "cannot be matched"):
            self.client.start([{"id": "screen", "width": 1280, "height": 720}])
        self.assertEqual(self.server.pointers, {})

    def test_layout_change_disconnects_before_further_input(self):
        """Disconnect when the monitor layout changes instead of mistargeting."""
        self.start()
        self.server.layout_change = True
        with self.assertRaisesRegex(RuntimeError, "layout changed"):
            self.client.move("screen", 50, 50)
        self.assertTrue(self.client.closed)
        self.assertFalse(any(event[0] == "zwlr_virtual_pointer_v1" and event[2] == 1 for event in self.server.events))

    def test_compositor_denial_closes_connection(self):
        """Close cleanly when the compositor rejects virtual input."""
        self.server.reject_keyboard = True
        with self.assertRaisesRegex(RuntimeError, "virtual keyboard denied"):
            self.start()
        self.assertTrue(self.client.closed)

    def test_pause_releases_keys_and_allows_viewing_then_resume(self):
        """Pause releases held keys, keeps screenshots working, then resumes."""
        self.start()
        self.server.on_key = lambda event: setattr(self.client, "cancelled", True) if event[2] else None
        with self.assertRaisesRegex(InterruptedError, "paused"):
            self.client.press([0xffe3, ord("a")])
        self.assertEqual(self.client.pressed, [])
        keys = [event[3][2] for event in self.server.events if event[0] == "zwp_virtual_keyboard_v1" and event[2] == 1]
        self.assertEqual(keys, [1, 0])
        self.client.sync(check_cancelled=False)
        self.server.on_key = None
        self.client.cancelled = False
        self.client.press([0xffe3, ord("a")])
        self.assertFalse(self.client.closed)

    def test_pause_blocks_pointer_motion_before_sending(self):
        """Pause sends no pointer traffic and motion works again after resume."""
        self.start()
        sent = len(self.server.events)
        self.client.cancelled = True
        with self.assertRaises(InterruptedError):
            self.client.move("screen", 10, 10)
        self.assertEqual(len(self.server.events), sent)
        self.client.cancelled = False
        self.client.move("screen", 10, 10)
        self.assertTrue(any(event[0] == "zwlr_virtual_pointer_v1" and event[2] == 1 for event in self.server.events))

    def test_close_releases_drag_button(self):
        """Closing mid-drag releases the held pointer button."""
        self.start()
        self.client.move("screen", 20, 30)
        self.client.button("left", True)
        self.client.close()
        buttons = [event[3][2] for event in self.server.events if event[0] == "zwlr_virtual_pointer_v1" and event[2] == 2]
        self.assertEqual(buttons, [1, 0])

    def test_unicode_keymap_fd_and_shortcut_modifiers(self):
        """Check FD keymap transfer, Unicode symbols, and modifier tracking."""
        self.start()
        self.client.type("Aé界🙂\t\n")
        keymap = self.server.keymaps[-1]
        self.assertTrue(keymap.endswith(b"\0"))
        self.assertIn(b"0x100754c", keymap)
        self.assertIn(b"0x101f642", keymap)
        self.client.press([0xffe3, 0xffe1, ord("a")])
        modifiers = [event[3][0] for event in self.server.events if event[0] == "zwp_virtual_keyboard_v1" and event[2] == 2]
        self.assertIn(5, modifiers)
        self.assertEqual(modifiers[-1], 0)
        # Validate the actual transferred keymap with the same parser compositors use.
        library = ctypes.util.find_library("xkbcommon")
        if library:
            xkb = ctypes.CDLL(library)
            xkb.xkb_context_new.argtypes = [ctypes.c_int]
            xkb.xkb_context_new.restype = ctypes.c_void_p
            xkb.xkb_keymap_new_from_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_int]
            xkb.xkb_keymap_new_from_string.restype = ctypes.c_void_p
            xkb.xkb_keymap_unref.argtypes = xkb.xkb_context_unref.argtypes = [ctypes.c_void_p]
            context = xkb.xkb_context_new(0)
            try:
                for content in self.server.keymaps:
                    keymap = xkb.xkb_keymap_new_from_string(context, content, 1, 0)
                    self.assertTrue(keymap, content)
                    xkb.xkb_keymap_unref(keymap)
            finally:
                xkb.xkb_context_unref(context)


class PortalTests(unittest.TestCase):
    def setUp(self):
        """Stub portal and desktop modules for backend-selection tests."""
        class DBusError(Exception):
            def get_dbus_name(self):
                return str(self)
        self.error = DBusError
        self.props = Mock()
        self.props.Get.side_effect = lambda interface, name: 1 if interface.endswith("ScreenCast") else 3
        gst = types.SimpleNamespace(init=lambda _: None, ElementFactory=types.SimpleNamespace(find=lambda _: True))
        modules = {"gi": types.SimpleNamespace(require_version=lambda *_: None), "gi.repository": types.SimpleNamespace(Gst=gst), "dbus": types.SimpleNamespace(SessionBus=Mock(), Interface=lambda *_: self.props, DBusException=DBusError)}
        self.modules = patch.dict(sys.modules, modules)
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.environment = patch.dict(os.environ, {"XDG_SESSION_TYPE": "wayland", "WAYLAND_DISPLAY": "test"})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def missing_remote(self, interface, name):
        """Simulate a portal without the RemoteDesktop interface."""
        if interface.endswith("RemoteDesktop"):
            raise self.error("org.freedesktop.DBus.Error.InvalidArgs")
        return 1

    def test_remote_desktop_remains_preferred(self):
        """A full RemoteDesktop portal skips the virtual-input probe."""
        with patch.object(WaylandInput, "probe") as probe:
            self.assertEqual(computer.dependencies(), "wayland-portal")
            probe.assert_not_called()

    def test_missing_remote_desktop_uses_virtual_protocols(self):
        """Fall back to virtual input when RemoteDesktop is absent."""
        self.props.Get.side_effect = self.missing_remote
        with patch.object(WaylandInput, "probe") as probe:
            self.assertEqual(computer.dependencies(), "wayland-wlr")
            probe.assert_called_once()

    def test_screen_cast_only_support_is_reported(self):
        """Report view-only mode when neither input path exists."""
        self.props.Get.side_effect = self.missing_remote
        with patch.object(WaylandInput, "probe", side_effect=RuntimeError("no virtual keyboard")):
            self.assertEqual(computer.dependencies(), "wayland-screencast")

    def test_portal_access_denial_is_not_bypassed(self):
        """Never bypass a portal access denial via the fallback path."""
        self.props.Get.side_effect = self.error("org.freedesktop.DBus.Error.AccessDenied")
        with patch.object(WaylandInput, "probe") as probe:
            with self.assertRaises(self.error):
                computer.dependencies()
            probe.assert_not_called()

    def test_view_only_uses_screen_cast_without_creating_virtual_input(self):
        """View-only sessions never create virtual input devices."""
        portal = computer.Portal.__new__(computer.Portal)
        portal.backend = "wayland-wlr"
        portal.virtual = None
        portal.streams = {}
        portal.cast, portal.remote = object(), object()
        portal.dbus = types.SimpleNamespace(String=str, ObjectPath=str, UInt32=int, Boolean=bool)
        portal.bus = Mock()
        portal.request = Mock(side_effect=[{"session_handle": "/session/test"}, {}, {"streams": []}])
        with patch.object(computer, "WaylandInput") as virtual:
            with self.assertRaisesRegex(RuntimeError, "No screen was selected"):
                portal.start(False)
            virtual.assert_not_called()
        self.assertTrue(all(call.args[0] is portal.cast for call in portal.request.call_args_list))

    def test_failed_start_rolls_back_virtual_input_and_capture(self):
        """A start failure closes the compositor connection and half-opened streams."""
        portal = computer.Portal.__new__(computer.Portal)
        portal.backend = "wayland-wlr"
        portal.virtual = None
        portal.streams = {}
        portal.cast, portal.remote = object(), object()
        portal.dbus = types.SimpleNamespace(String=str, ObjectPath=str, UInt32=int, Boolean=bool)
        portal.bus = Mock()
        portal.Gst = types.SimpleNamespace(State=types.SimpleNamespace(NULL=0))
        portal.request = Mock(side_effect=[{"session_handle": "/session/test"}, RuntimeError("denied")])
        with patch.object(computer, "WaylandInput") as virtual:
            with self.assertRaisesRegex(RuntimeError, "denied"):
                portal.start(True)
            virtual.return_value.close.assert_called_once_with()
        self.assertIsNone(portal.virtual)
        self.assertEqual(portal.streams, {})

    def test_x11_ignores_wayland_protocols(self):
        """X11 sessions never probe the Wayland virtual-input path."""
        with patch.dict(os.environ, {"XDG_SESSION_TYPE": "x11", "WAYLAND_DISPLAY": "", "DISPLAY": ":test"}), patch.object(computer.shutil, "which", return_value="/usr/bin/xdotool"), patch.object(computer.ctypes.util, "find_library", return_value="test"), patch.object(WaylandInput, "probe") as probe:
            self.assertEqual(computer.dependencies(), "x11")
            probe.assert_not_called()


class SwayTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("sway") and shutil.which("swaymsg"), "requires Sway for isolated headless integration")
    def test_input_reaches_a_private_headless_compositor(self):
        """Drive pointer, buttons, scroll, shortcuts, and typing on headless Sway."""
        with tempfile.TemporaryDirectory(prefix="citropy-headless-") as directory:
            root = Path(directory)
            marker = root / "shortcut"
            config = root / "config"
            config.write_text(f"output * mode 1280x720\noutput * scale 2\nseat seat0 fallback true\nbindsym Ctrl+Shift+a exec touch {shlex.quote(str(marker))}\n")
            env = {**os.environ, "XDG_RUNTIME_DIR": directory, "WLR_BACKENDS": "headless", "WLR_RENDERER": "pixman", "WLR_HEADLESS_OUTPUTS": "1", "WLR_LIBINPUT_NO_DEVICES": "1"}
            for key in ["WAYLAND_DISPLAY", "WAYLAND_SOCKET", "SWAYSOCK", "DISPLAY"]:
                env.pop(key, None)
            with (root / "sway.log").open("w+") as log:
                sway = subprocess.Popen(["sway", "-c", str(config)], env=env, stdout=log, stderr=log)
                client = None
                try:
                    for _ in range(100):
                        sockets = [path for path in root.glob("wayland-*") if path.is_socket()]
                        ipc = list(root.glob("sway-ipc.*.sock"))
                        if sockets and ipc:
                            break
                        self.assertIsNone(sway.poll(), (root / "sway.log").read_text())
                        time.sleep(0.05)
                    else:
                        self.fail("Headless Sway did not start: " + (root / "sway.log").read_text())
                    with patch.dict(os.environ, {"WAYLAND_DISPLAY": str(sockets[0])}):
                        client = None
                        for _ in range(5):
                            try:
                                client = WaylandInput()
                                break
                            except RuntimeError:
                                # A headless compositor can be slow to answer under load; retry.
                                time.sleep(0.2)
                        if client is None:
                            self.fail("Headless compositor did not answer: " + (root / "sway.log").read_text())
                    output = next(iter(client.outputs.values()))
                    self.assertEqual((output["width"], output["height"]), (640, 360))
                    client.start([{"id": "test", **{key: output[key] for key in ["x", "y", "width", "height"]}}])
                    client.move("test", 100, 100)
                    client.button("left", True)
                    client.button("left", False)
                    client.scroll(0, 60)
                    client.press([0xffe3, 0xffe1, ord("a")])
                    for _ in range(100):
                        if marker.exists():
                            break
                        time.sleep(0.02)
                    self.assertTrue(marker.exists(), "Shortcut was not delivered: " + (root / "sway.log").read_text())
                    client.type("Citropy é界🙂")
                    client.close()
                    for _ in range(100):
                        devices = json.loads(subprocess.check_output(["swaymsg", "-s", str(ipc[0]), "-t", "get_inputs", "-r"], env=env, text=True, timeout=3))
                        if not any("virtual" in device["name"].lower() for device in devices):
                            break
                        time.sleep(0.02)
                    self.assertFalse(any("virtual" in device["name"].lower() for device in devices), devices)
                finally:
                    if client:
                        client.close()
                    sway.terminate()
                    try:
                        sway.wait(5)
                    except subprocess.TimeoutExpired:
                        sway.kill()
                        sway.wait()


class CaptureTests(unittest.TestCase):
    def test_stalled_stream_never_returns_the_previous_sample(self):
        """A stalled stream errors instead of replaying the previous sample."""
        portal = computer.Portal.__new__(computer.Portal)
        portal.closed = False
        portal.Gst = types.SimpleNamespace(SECOND=1, MessageType=types.SimpleNamespace(ERROR=1, EOS=2))
        pipeline, sink = Mock(), Mock()
        pipeline.get_bus.return_value.pop_filtered.return_value = None
        first = Mock()
        second = Mock()
        entry = {"pipeline": pipeline, "sink": sink, "width": 1366, "height": 768, "sample": first}
        sink.emit.side_effect = [first, second, None]
        video = types.SimpleNamespace(VideoInfo=types.SimpleNamespace(new_from_caps=lambda _: types.SimpleNamespace(width=1366, height=768)))
        with patch.dict(sys.modules, {"gi.repository": types.SimpleNamespace(GstVideo=video)}):
            self.assertIs(portal.sample(entry)[0], first)
            self.assertIs(portal.sample(entry)[0], second)
            with self.assertRaisesRegex(RuntimeError, "fresh screen image"):
                portal.sample(entry)


if __name__ == "__main__":
    unittest.main(verbosity=2)
