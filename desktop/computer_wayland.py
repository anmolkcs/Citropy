"""Small synchronous Wayland client for the computer helper's virtual input.

Uses the core registry/output protocols, xdg-output v2, wlr-virtual-pointer
v2 and virtual-keyboard v1. Only the keyboard keymap transfers an FD. Keeping
the connection in the helper gives pause/stop ownership of every input device.

Wire definitions: wayland.app/protocols/wlr-virtual-pointer-unstable-v1,
wayland.app/protocols/virtual-keyboard-unstable-v1 and xdg-output-unstable-v1.
"""

import array
import os
import socket
import struct
import tempfile
import time


def uint(*values):
    """Pack unsigned 32-bit integers for a Wayland message."""
    return struct.pack("=" + "I" * len(values), *values)


def string(value):
    """Encode a Wayland string with length prefix and padding."""
    data = value.encode() + b"\0"
    return uint(len(data)) + data + b"\0" * (-len(data) % 4)


def read_string(data, offset=0):
    """Decode a Wayland string, returning the text and next offset."""
    length, = struct.unpack_from("=I", data, offset)
    end = offset + 4 + length
    if not length or end > len(data) or data[end - 1] != 0:
        raise RuntimeError("Invalid Wayland string.")
    return data[offset + 4:end - 1].decode(), offset + 4 + ((length + 3) & ~3)


MODIFIERS = {0xffe1: 1, 0xffe3: 4, 0xffe9: 8, 0xffeb: 64}


class WaylandInput:
    def __init__(self):
        """Connect and bind the seat, outputs, and virtual-input managers."""
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.settimeout(2)
        self.next_id = 2
        self.globals = {}
        self.outputs = {}
        self.objects = {}
        self.pointers = {}
        self.keyboard = None
        self.pressed = []
        self.buttons = set()
        self.codes = {}
        self.pointer = None
        self.layout = None
        self.failed = False
        self.closed = False
        self.cancelled = False
        try:
            display = os.environ.get("WAYLAND_DISPLAY", "wayland-0")
            if not os.path.isabs(display):
                runtime = os.environ.get("XDG_RUNTIME_DIR")
                if not runtime:
                    raise RuntimeError("The Wayland session has no runtime directory.")
                display = os.path.join(runtime, display)
            self.socket.connect(display)
            self.registry = self.new_id()
            self.send(1, 1, uint(self.registry))  # wl_display.get_registry
            self.sync()
            self.pointer_manager = self.bind("zwlr_virtual_pointer_manager_v1", 2)
            self.keyboard_manager = self.bind("zwp_virtual_keyboard_manager_v1", 1)
            seats = [name for name, (interface, _) in self.globals.items() if interface == "wl_seat"]
            if len(seats) != 1:
                raise RuntimeError("Virtual input requires a single Wayland seat.")
            self.seat = self.bind("wl_seat", 1)
            xdg = self.bind("zxdg_output_manager_v1", 2)
            for name, (interface, version) in list(self.globals.items()):
                if interface != "wl_output":
                    continue
                output = self.bind(interface, min(version, 4), name)
                self.outputs[output] = {"global": name}
                logical = self.new_id()
                self.objects[logical] = output
                self.send(xdg, 1, uint(logical, output))  # get_xdg_output
            self.sync()
            if not self.outputs:
                raise RuntimeError("The Wayland compositor has no outputs to control.")
        except BaseException:
            self.close()
            raise

    @classmethod
    def probe(cls):
        """Verify the compositor exposes virtual input without creating devices."""
        client = cls()
        client.close()

    def new_id(self):
        """Allocate the next Wayland object ID."""
        result = self.next_id
        self.next_id += 1
        return result

    def send(self, target, opcode, payload=b"", fd=None):
        """Send one Wayland message, transferring the keymap FD when present."""
        if self.closed or self.failed:
            raise RuntimeError("The Wayland input connection ended. Start computer use again.")
        packet = uint(target, ((len(payload) + 8) << 16) | opcode) + payload
        try:
            if fd is None:
                self.socket.sendall(packet)
            else:
                sent = self.socket.sendmsg([packet], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [fd]))])
                self.socket.sendall(packet[sent:])
        except OSError:
            self.failed = True
            self.close()
            raise RuntimeError("The Wayland input connection ended. Start computer use again.") from None
        except BaseException:
            self.failed = True
            self.close()
            raise

    def receive(self, size, deadline):
        """Read exactly size bytes or fail when the compositor goes quiet."""
        data = bytearray()
        while len(data) < size:
            self.socket.settimeout(max(0.001, deadline - time.monotonic()))
            chunk = self.socket.recv(size - len(data))
            if not chunk or time.monotonic() > deadline:
                raise RuntimeError("The Wayland compositor stopped responding.")
            data.extend(chunk)
        return bytes(data)

    def sync(self, check_cancelled=True):
        """Round-trip with the compositor and revalidate the monitor layout."""
        callback = self.new_id()
        self.send(1, 0, uint(callback))  # wl_display.sync
        deadline = time.monotonic() + 2
        try:
            while True:
                target, header = struct.unpack("=II", self.receive(8, deadline))
                size, opcode = header >> 16, header & 0xffff
                if size < 8 or size % 4:
                    raise RuntimeError("Invalid Wayland message.")
                data = self.receive(size - 8, deadline)
                if target == callback and opcode == 0:
                    break
                self.event(target, opcode, data)
            if self.layout is not None and self.layout != self.output_layout():
                raise RuntimeError("The monitor layout changed. Share the screen again before continuing.")
        except (OSError, RuntimeError, ValueError, struct.error) as error:
            self.failed = True
            self.close()
            raise RuntimeError(str(error) or "The Wayland input connection failed.") from None
        except BaseException:
            # A terminated read may have consumed only part of a protocol frame.
            # Disconnecting also destroys any pressed virtual input devices.
            self.failed = True
            self.close()
            raise
        if check_cancelled:
            self.check_cancelled()

    def check_cancelled(self):
        """Raise when pause or stop requested mid-action."""
        if self.cancelled:
            raise InterruptedError("Computer control was paused.")

    def event(self, target, opcode, data):
        """Apply one incoming Wayland event to the tracked globals and outputs."""
        if target == 1 and opcode == 0:  # wl_display.error
            message, _ = read_string(data, 8)
            raise RuntimeError("Wayland input was rejected: " + message)
        if target == self.registry:
            name, = struct.unpack_from("=I", data)
            if opcode == 0:
                interface, offset = read_string(data, 4)
                version, = struct.unpack_from("=I", data, offset)
                self.globals[name] = (interface, version)
                if self.layout is not None and interface in ["wl_output", "wl_seat"]:
                    raise RuntimeError("The Wayland devices changed. Start computer use again.")
            elif opcode == 1:
                removed = self.globals.pop(name, None)
                if self.layout is not None and removed and removed[0] in ["wl_output", "wl_seat", "zwlr_virtual_pointer_manager_v1", "zwp_virtual_keyboard_manager_v1"]:
                    raise RuntimeError("The Wayland devices changed. Start computer use again.")
                for output, info in list(self.outputs.items()):
                    if info["global"] == name:
                        del self.outputs[output]
        elif target in self.outputs:
            info = self.outputs[target]
            if opcode == 0:  # wl_output.geometry
                _, offset = read_string(data, 20)
                _, offset = read_string(data, offset)
                info["transform"], = struct.unpack_from("=i", data, offset)
            elif opcode == 1:
                flags, width, height, _ = struct.unpack("=Iiii", data)
                if flags & 1:
                    info["mode"] = (width, height)
            elif opcode == 3:
                info["scale"], = struct.unpack("=i", data)
        elif target in self.objects:
            info = self.outputs.get(self.objects[target])
            if info is None:
                return
            if opcode == 0:
                info["x"], info["y"] = struct.unpack("=ii", data)
            elif opcode == 1:
                info["width"], info["height"] = struct.unpack("=ii", data)
            elif opcode == 3:
                info["name"], _ = read_string(data)

    def bind(self, interface, version, name=None):
        """Bind a compositor global, failing clearly when it is missing."""
        if name is None:
            name = next((key for key, value in self.globals.items() if value[0] == interface and value[1] >= version), None)
        if name is None:
            raise RuntimeError(f"The compositor does not expose {interface} version {version}.")
        result = self.new_id()
        self.send(self.registry, 0, uint(name) + string(interface) + uint(version, result))
        return result

    def output_layout(self):
        """Snapshot output geometry for layout-change detection."""
        return {output: dict(info) for output, info in self.outputs.items()}

    def match_output(self, stream):
        """Match a shared screen to exactly one Wayland output, never guessing."""
        candidates = list(self.outputs)
        if "x" in stream and "y" in stream:
            candidates = [output for output in candidates if all(self.outputs[output].get(key) == stream[key] for key in ["x", "y", "width", "height"])]
        # A single output is unambiguous even when the portal omits its position.
        # Never guess among same-sized monitors from capture dimensions alone.
        if len(candidates) != 1:
            raise RuntimeError("The shared screen cannot be matched to a Wayland output. Share a monitor with position and size metadata.")
        return candidates[0]

    def start(self, streams):
        """Create one virtual pointer per shared screen plus the keyboard."""
        self.sync()
        matches = [(stream, self.match_output(stream)) for stream in streams]
        self.layout = self.output_layout()
        for stream, output in matches:
            pointer = self.new_id()
            self.send(self.pointer_manager, 2, uint(self.seat, output, pointer))
            self.pointers[stream["id"]] = (pointer, stream["width"], stream["height"])
        self.keyboard = self.new_id()
        self.send(self.keyboard_manager, 0, uint(self.seat, self.keyboard))
        self.sync()

    def timestamp(self):
        """Return a millisecond timestamp for input events."""
        return int(time.monotonic() * 1000) & 0xffffffff

    def move(self, display_id, x, y):
        """Move the pointer to absolute output coordinates."""
        self.check_cancelled()
        self.sync()
        pointer, width, height = self.pointers[display_id]
        self.pointer = pointer
        self.send(pointer, 1, uint(self.timestamp(), round(x * 256), round(y * 256), width * 256, height * 256))
        self.send(pointer, 4)  # frame
        self.sync()

    def button(self, button, pressed):
        """Press or release a pointer button on the active virtual pointer."""
        if pressed:
            self.check_cancelled()
            self.buttons.add((self.pointer, button))
        self.send(self.pointer, 2, uint(self.timestamp(), {"left": 272, "right": 273, "middle": 274}[button], int(pressed)))
        self.send(self.pointer, 4)
        self.sync()
        if not pressed:
            self.buttons.discard((self.pointer, button))

    def scroll(self, dx, dy):
        """Send wheel-axis scroll events for both axes."""
        self.check_cancelled()
        self.send(self.pointer, 5, uint(0))  # axis_source: wheel
        for axis, delta in [(0, dy), (1, dx)]:
            if delta:
                self.send(self.pointer, 3, uint(self.timestamp(), axis) + struct.pack("=i", round(delta * 256)))
        self.send(self.pointer, 4)
        self.sync()

    def keymap(self, symbols, shifted=False):
        """Upload a batch keymap covering the given symbols via FD transfer."""
        self.check_cancelled()
        if self.pressed:
            raise RuntimeError("Release held keys before changing the virtual keymap.")
        self.codes = {symbol: index + 1 for index, symbol in enumerate(dict.fromkeys([*MODIFIERS, *symbols]))}
        if len(self.codes) > 247:
            raise RuntimeError("Too many characters in a virtual keyboard batch.")
        names = {symbol: f"K{code:03}" for symbol, code in self.codes.items()}
        codes = " ".join(f"<{names[symbol]}> = {code + 8};" for symbol, code in self.codes.items())
        entries = []
        for symbol in self.codes:
            upper = ord(chr(symbol).upper()) if shifted and 97 <= symbol <= 122 else symbol
            if shifted and 48 <= symbol <= 57:
                upper = ord(")!@#$%^&*("[symbol - 48])
            entries.append(f'key <{names[symbol]}> {{ type="TWO_LEVEL", [0x{symbol:x}, 0x{upper:x}] }};')
        maps = " ".join(f"modifier_map {name} {{ <{names[symbol]}> }};" for symbol, name in [(0xffe1, "Shift"), (0xffe3, "Control"), (0xffe9, "Mod1"), (0xffeb, "Mod4")])
        text = f'''xkb_keymap {{
            xkb_keycodes "citropy" {{ minimum=8; maximum=255; {codes} }};
            xkb_types "citropy" {{ type "TWO_LEVEL" {{ modifiers=Shift; map[None]=Level1; map[Shift]=Level2; }}; }};
            xkb_compatibility "citropy" {{}};
            xkb_symbols "citropy" {{ {" ".join(entries)} {maps} }};
        }};'''.encode() + b"\0"
        with tempfile.TemporaryFile() as file:
            file.write(text)
            file.flush()
            self.send(self.keyboard, 0, uint(1, len(text)), file.fileno())
        self.send(self.keyboard, 2, uint(0, 0, 0, 0))
        self.sync()

    def key(self, symbol, pressed):
        """Send one key event and refresh the held-modifier state."""
        if pressed:
            self.check_cancelled()
            if symbol not in self.pressed:
                self.pressed.append(symbol)
        elif symbol in self.pressed:
            self.pressed.remove(symbol)
        self.send(self.keyboard, 1, uint(self.timestamp(), self.codes[symbol], int(pressed)))
        modifiers = 0
        for held in self.pressed:
            modifiers |= MODIFIERS.get(held, 0)
        self.send(self.keyboard, 2, uint(modifiers, 0, 0, 0))
        self.sync()

    def press(self, symbols):
        """Press a shortcut chord, always releasing held keys afterwards."""
        self.keymap(symbols, shifted=True)
        try:
            for symbol in symbols:
                self.key(symbol, True)
        finally:
            self.release()

    def type(self, text):
        """Type text in batches, mapping Unicode through keysyms."""
        for offset in range(0, len(text), 200):
            symbols = [{"\n": 0xff0d, "\t": 0xff09}.get(character, ord(character) if ord(character) <= 0xff else 0x01000000 | ord(character)) for character in text[offset:offset + 200]]
            self.keymap(symbols)
            try:
                for symbol in symbols:
                    self.key(symbol, True)
                    self.key(symbol, False)
            finally:
                self.release()

    def release(self):
        """Release every held key and button, even while pausing."""
        if self.closed or self.failed:
            # Disconnecting already destroyed the virtual devices and their held input.
            self.pressed.clear()
            self.buttons.clear()
            return
        cancelled = self.cancelled
        self.cancelled = False
        try:
            for symbol in reversed(self.pressed[:]):
                self.key(symbol, False)
            for pointer, button in list(self.buttons):
                self.pointer = pointer
                self.button(button, False)
        finally:
            self.cancelled = cancelled or self.cancelled

    def close(self):
        """Release held input, destroy virtual devices, and disconnect."""
        if self.closed:
            return
        try:
            if not self.failed:
                self.release()
                if self.keyboard is not None:
                    self.send(self.keyboard, 3)
                for pointer, _, _ in self.pointers.values():
                    self.send(pointer, 8)
        except (OSError, RuntimeError):
            pass
        finally:
            self.closed = True
            self.socket.close()
