# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Exercise the real terminal lifecycle against a small PTY terminal emulator."""

import base64
import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time


QUERIES = re.compile(
    rb"\x1b_Gi=42424243,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\"
    rb"|\x1b\[\?u|\x1b\[c|\x1b\[>31u"
)
EXPECTED_RGB = bytes((255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255))
# macOS reports the kernel's own "has been written" bit (FWASWRITTEN) through
# F_GETFL once anything has written to the description. It is no status flag
# the terminal could have changed, so it is left out of the comparisons.
STATUS_FLAGS = ~0x10000 if sys.platform == "darwin" else ~0


def status_flags(fd):
    return fcntl.fcntl(fd, fcntl.F_GETFL) & STATUS_FLAGS


class Session:
    def __init__(self, binary, renderer, *, graphics, keyboard, keyboard_flags=31,
                 device=True, arguments=None, output_limit=1024 * 1024):
        self.master, self.slave = pty.openpty()
        self.set_size(80, 24, 640, 384)
        self.saved_attrs = termios.tcgetattr(self.slave)
        self.saved_flags = status_flags(self.slave)
        self.graphics = graphics
        self.keyboard = keyboard
        self.keyboard_flags = keyboard_flags
        self.device = device
        self.keyboard_pushed = False
        self.harness = arguments is None
        self.output_limit = output_limit
        self.output = bytearray()
        self.pending = bytearray()
        # Frames are counted as they arrive: recounting the whole capture on
        # every poll cannot keep up with the runner, which then drops frames.
        self.frames_started = 0
        # All three streams deliberately share the same open-file description.
        self.process = subprocess.Popen(
            [binary, *(["--session", renderer] if arguments is None else arguments)],
            stdin=self.slave,
            stdout=self.slave,
            stderr=self.slave,
            close_fds=True,
            start_new_session=True,
        )

    def set_size(self, columns, rows, width, height):
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, width, height))

    def send(self, data, fragmented=False):
        pieces = (data[:1], data[1:3], data[3:]) if fragmented else (data,)
        for piece in pieces:
            while piece:
                count = os.write(self.master, piece)
                piece = piece[count:]
            if fragmented:
                time.sleep(0.003)

    def record(self, data):
        self.frames_started += (self.output[-8:] + data).count(b"\x1b_Ga=T,") - self.output[-8:].count(b"\x1b_Ga=T,")
        self.output.extend(data)
        assert len(self.output) < self.output_limit, "unbounded terminal output"
        self.pending.extend(data)

    def answer(self):
        while match := QUERIES.search(self.pending):
            query = bytes(match.group())
            del self.pending[:match.end()]
            if query.startswith(b"\x1b_G") and self.graphics:
                self.send(b"\x1b_Gi=42424243;OK\x1b\\", fragmented=True)
            elif query == b"\x1b[?u" and self.keyboard:
                flags = self.keyboard_flags if self.keyboard_pushed else 0
                self.send(f"\x1b[?{flags}u".encode(), fragmented=True)
            elif query == b"\x1b[c" and self.device:
                self.send(b"\x1b[?62;4c", fragmented=True)
            elif query == b"\x1b[>31u":
                self.keyboard_pushed = True
        # Preserve possible fragmented query prefixes, not entire RGB frames.
        if len(self.pending) > 128:
            del self.pending[:-128]

    # A real terminal answers while the host is writing, so every read answers:
    # a session that only drains leaves the host's queries unanswered and it
    # gives up on the capabilities it was negotiating.
    def pump(self, timeout=0.03):
        ready, _, _ = select.select([self.master], [], [], timeout)
        if not ready:
            return
        data = os.read(self.master, 65536)
        if not data:
            return
        self.record(data)
        self.answer()

    def wait_for(self, predicate, timeout=3):
        deadline = time.monotonic() + timeout
        while not predicate():
            assert time.monotonic() < deadline, f"terminal timed out: {bytes(self.output[-500:])!r}"
            self.pump()
            if self.process.poll() is not None and not predicate():
                self.pump(0)
                assert predicate(), f"terminal exited early: {bytes(self.output[-500:])!r}"

    def frame_ready(self, kitty):
        if kitty:
            return re.search(rb"\x1b_Ga=T,[^;]+;[A-Za-z0-9+/]+\x1b\\", self.output) is not None
        first_pixel = self.output.find(b"\xe2\x96\x80")
        return first_pixel >= 0 and self.output.find(b"\x1b[0m", first_pixel) >= 0

    def check_raw(self):
        attrs = termios.tcgetattr(self.slave)
        assert not attrs[3] & (termios.ICANON | termios.ECHO), "terminal did not enter raw mode"
        assert status_flags(self.slave) == self.saved_flags, "shared fd flags changed"

    def finish(self, expected_status=0, timeout=3):
        # Drain the master continuously until the pty reports end of file. A
        # reader has to stay blocked on the master across the child's exit: on
        # macOS a pty discards whatever the slave has written but the master
        # has not yet read the moment the slave side closes, so the summary and
        # the restore sequences the terminal emits just before exiting are lost
        # if we wait for the process to exit and only then drain, the way Linux
        # tolerates because it keeps that output buffered.
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            assert remaining > 0, f"terminal timed out: {bytes(self.output[-500:])!r}"
            ready, _, _ = select.select([self.master], [], [], min(remaining, 0.1))
            if not ready:
                if self.process.poll() is not None:
                    break
                continue
            try:
                data = os.read(self.master, 65536)
            except OSError:
                break
            if not data:
                break
            self.record(data)
            self.answer()
        self.process.wait()
        assert self.process.returncode == expected_status, bytes(self.output[-500:])
        actual_attrs = termios.tcgetattr(self.slave)
        expected_attrs = self.saved_attrs.copy()
        # libc may replace CIBAUD=0 (input speed follows output) with its
        # explicit equivalent. Compare the actual speeds in fields 4 and 5.
        # Only Linux has the mask; the BSDs keep the two speeds apart.
        cibaud = getattr(termios, "CIBAUD", 0)
        actual_attrs[2] &= ~cibaud
        expected_attrs[2] &= ~cibaud
        # macOS toggles two c_lflag housekeeping bits the terminal never sets
        # and cannot control: PENDIN (retype-pending-input state) turns on
        # whenever canonical mode is re-enabled, and ECHOCTL is not read back
        # the way it was written. Neither reflects a setting left unrestored.
        lflag_state = (0x20000000 | 0x40) if sys.platform == "darwin" else 0
        actual_attrs[3] &= ~lflag_state
        expected_attrs[3] &= ~lflag_state
        assert actual_attrs == expected_attrs, f"termios was not restored: {actual_attrs!r} != {expected_attrs!r}"
        assert status_flags(self.slave) == self.saved_flags, "fd flags were not restored"
        assert b"\x1b[?1049h" in self.output and b"\x1b[?25l" in self.output
        assert b"\x1b[?25h\x1b[?1049l" in self.output, "screen or cursor was not restored"
        if self.keyboard_pushed:
            assert self.output.count(b"\x1b[<u") == 1, "keyboard state was not restored exactly once"
        if expected_status == 0 and self.harness:
            assert b"quit=1" in self.output, bytes(self.output[-500:])

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait()
        os.close(self.master)
        os.close(self.slave)


def exercise(binary, renderer, *, graphics, keyboard, termination, partial_keyboard=False):
    session = Session(binary, renderer, graphics=graphics, keyboard=keyboard,
                      keyboard_flags=1 if partial_keyboard else 11)
    kitty = graphics and renderer != "ansi"
    try:
        session.wait_for(lambda: session.frame_ready(kitty))
        session.check_raw()
        if keyboard:
            assert b"\x1b[>31u" in session.output
        else:
            assert b"\x1b[>31u" not in session.output
        assert b"\x1b[?1003h\x1b[?1006h" in session.output, "mouse reporting was not requested"
        if partial_keyboard:
            assert b"\x1b[<u" in session.output, "unsupported keyboard enhancements were left enabled"
        clear_count = session.output.count(b"\x1b[2J")
        session.set_size(100, 36, 1000, 720)
        session.process.send_signal(signal.SIGWINCH)
        session.wait_for(lambda: session.output.count(b"\x1b[2J") > clear_count)
        if kitty:
            session.wait_for(lambda: b"c=93,r=35" in session.output)
        else:
            assert b"\x1b_Ga=T" not in session.output
        if termination == "signal":
            session.process.send_signal(signal.SIGTERM)
        elif termination == "kitty":
            # A press held across polls, then a drag, a release, and a typed letter.
            session.send(b"\x1b[<0;160;160M", fragmented=True)
            deadline = time.monotonic() + 0.1
            while time.monotonic() < deadline:
                session.pump()
            session.send(b"\x1b[<32;200;160M\x1b[<0;200;160m\x1b[104;1:1;104u\x1b[104;1:3u", fragmented=True)
            deadline = time.monotonic() + 0.25
            while time.monotonic() < deadline:
                session.pump()
            session.send(b"\x1b[119;1:1u\x1b[119;1:3u\x1b[99;5:1u", fragmented=True)
        else:
            session.send(b"w")
            # Give the synthetic release time to reach the application loop.
            deadline = time.monotonic() + 0.25
            while time.monotonic() < deadline:
                session.pump()
            session.send(b"\x03")
        session.finish()
        if termination != "signal":
            match = re.search(rb"terminal session: events=(\d+) mouse=(\d+) text=(\d+) quit=1", session.output)
            assert match is not None and int(match[1]) >= 2, "key transitions did not reach the loop"
            assert int(match[3]) >= 1, "typed text did not reach the loop"
            if termination == "kitty":
                assert int(match[2]) >= 1, "mouse reports did not reach the loop"
            assert b"\x1b[?1003l" in session.output, "mouse reporting was left on"
        if kitty:
            frames = re.findall(rb"\x1b_Ga=T,([^;]+);([A-Za-z0-9+/]+)\x1b\\", session.output)
            assert len(frames) >= 2
            ids = set()
            for metadata, payload in frames:
                assert base64.b64decode(payload, validate=True) == EXPECTED_RGB
                ids.add(int(re.search(rb"(?:^|,)i=(\d+),", metadata)[1]))
            assert ids == {42424241, 42424242}, "images did not reuse two bounded IDs"
            for image_id in ids:
                assert f"\x1b_Ga=d,d=I,i={image_id},q=2\x1b\\".encode() in session.output
    finally:
        session.close()


def unsupported_kitty(binary):
    session = Session(binary, "kitty", graphics=False, keyboard=False, device=False)
    try:
        session.finish(expected_status=2)
        assert b"not acknowledged" in session.output
    finally:
        session.close()


def main():
    binary = sys.argv[1]
    exercise(binary, "auto", graphics=True, keyboard=True, termination="kitty")
    exercise(binary, "auto", graphics=False, keyboard=True, termination="signal")
    exercise(binary, "ansi", graphics=True, keyboard=False, termination="legacy")
    exercise(binary, "kitty", graphics=True, keyboard=True, termination="legacy", partial_keyboard=True)
    unsupported_kitty(binary)
    print("terminal PTY: negotiation, resize, shared descriptors, key input, and cleanup passed")


if __name__ == "__main__":
    main()
