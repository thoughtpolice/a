# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Run the linked application and failure paths through a simulated Kitty PTY."""

import base64
import hashlib
import importlib.machinery
import pathlib
import re
import sys
import tempfile
import types


GRAPHICS_PACKET = re.compile(rb"\x1b_G([^;\x1b]+);([A-Za-z0-9+/]*)\x1b\\")


def inspect_frames(output):
    current = None
    latest = None
    images = set()
    hashes = set()
    frames = 0
    for packet in GRAPHICS_PACKET.finditer(output):
        controls = dict(item.split(b"=", 1) for item in packet[1].split(b","))
        if controls.get(b"a") == b"T":
            assert current is None, "a new image interrupted an unfinished image"
            assert controls[b"f"] == b"24" and controls[b"t"] == b"d"
            assert controls[b"s"] == b"320" and controls[b"v"] == b"200"
            assert controls[b"C"] == b"1", "graphics must not scroll the terminal"
            columns, rows = int(controls[b"c"]), int(controls[b"r"])
            assert 1 <= columns <= 80 and 1 <= rows < 24
            # The emulator reports 8x16 pixel cells, so this measures the
            # displayed aspect ratio rather than the engine's 320:200 buffer.
            assert abs((columns * 8) / (rows * 16) - 4 / 3) < 0.03
            images.add(int(controls[b"i"]))
            current = bytearray()
        elif current is None:
            continue  # The capability query is not a displayed frame.
        else:
            assert set(controls) <= {b"m", b"q"}, "invalid continuation metadata"
        payload = packet[2]
        assert 0 < len(payload) <= 4096 and len(payload) % 4 == 0
        current.extend(base64.b64decode(payload, validate=True))
        if controls[b"m"] == b"0":
            assert len(current) == 320 * 200 * 3, "incomplete RGB image"
            latest = bytes(current)
            hashes.add(hashlib.sha256(latest).digest())
            current = None
            frames += 1
    assert current is None, "the final image was truncated"
    assert frames == 50, f"expected 50 displayed frames, got {frames}"
    assert len(hashes) > 1, "the game never updated its framebuffer"
    assert images == {42424241, 42424242}, "image storage grew beyond two IDs"
    assert latest is not None
    assert len(set(latest)) > 32, "the game only produced a blank or placeholder frame"
    return latest


def doom_session(Session, binary, wad):
    with tempfile.TemporaryDirectory(prefix="console-app-pty-") as directory:
        capture = pathlib.Path(directory) / "doom.ppm"
        recording = pathlib.Path(directory) / "recording.txt"
        # Every frame the game draws has to reach the terminal, because this
        # counts them and compares the last one against the capture. Without
        # it a machine busy enough to make a frame take more than its budget
        # is sent fewer than it drew, which is the engine working as intended.
        arguments = ["--iwad", wad, "--renderer", "auto", "--no-save", "--no-audio", "--frames", "50",
                     "--present-every-frame",
                     "--dump-frame", str(capture), "--record", str(recording), "--", "-warp", "1", "-nomonsters"]
        session = Session(binary, "auto", graphics=True, keyboard=True,
                          arguments=arguments, output_limit=16 * 1024 * 1024)
        try:
            session.wait_for(lambda: session.frames_started >= 4, timeout=5)
            session.check_raw()
            # Hold forward across several actual guest frames, then release;
            # then click, drag, turn the wheel, and type a letter.
            session.send(b"\x1b[119;1:1u", fragmented=True)
            session.wait_for(lambda: session.frames_started >= 14, timeout=3)
            session.send(b"\x1b[119;1:3u", fragmented=True)
            session.wait_for(lambda: session.frames_started >= 18, timeout=3)
            # Kitty reports the pointer in pixels: a press held over frames,
            # then a drag, the release, a wheel notch, and a typed letter.
            session.send(b"\x1b[<0;245;185M", fragmented=True)
            session.wait_for(lambda: session.frames_started >= 22, timeout=3)
            session.send(b"\x1b[<32;325;185M\x1b[<0;325;185m\x1b[<64;325;185M\x1b[104;1:1;104u\x1b[104;1:3u",
                         fragmented=True)
            session.finish(timeout=5)
            assert session.keyboard_pushed
            final_rgb = inspect_frames(session.output)
            ppm = capture.read_bytes()
            header = b"P6\n320 200\n255\n"
            assert ppm.startswith(header)
            assert ppm[len(header):] == final_rgb, "captured pixels differ from the transmitted final image"
            assert b"guest trapped:" not in session.output
            assert b"trace frame=" not in session.output
            # The held key was recorded as the press and the release the
            # terminal reported, on the frames they reached the game, and the
            # pointer and the typed letter with them.
            lines = [line.split() for line in recording.read_text().splitlines() if not line.startswith("#")]
            events = [line for line in lines if line[1] not in ("mouse", "text")]
            assert [event[1:] for event in events] == [["w", "down"], ["w", "up"], ["h", "down"], ["h", "up"]], lines
            assert 4 <= int(events[0][0]) < int(events[1][0]) <= 50, events
            mice = [line for line in lines if line[1] == "mouse"]
            assert any(line[4] == "1" for line in mice) and mice[-1][4] == "0" and mice[-1][5] == "1", lines
            assert ["text", "h"] in [line[1:] for line in lines], lines
            assert b"\x1b[?1003h" in session.output and b"\x1b[?1003l" in session.output
        finally:
            session.close()


def failure_session(Session, binary, wad, argument, status):
    arguments = ["--iwad", wad, "--renderer", "auto", "--no-save", "--no-audio", "--frames", "1", "--", argument]
    session = Session(binary, "auto", graphics=True, keyboard=True, arguments=arguments)
    try:
        session.finish(expected_status=status, timeout=5)
        assert session.keyboard_pushed, "guest ran before keyboard negotiation"
        assert b"\x1b_Ga=T," not in session.output, "init failure unexpectedly rendered a frame"
        if argument == "--trap":
            assert b"guest trapped:" in session.output
            assert session.output.index(b"guest trapped:") > session.output.index(b"\x1b[?1049l")
        else:
            assert b"guest trapped:" not in session.output, "SDK exit was reported as an engine trap"
    finally:
        session.close()


def main():
    doom, sdk, wad, helper = sys.argv[1:]
    loader = importlib.machinery.SourceFileLoader("terminal_pty_test", helper)
    module = types.ModuleType(loader.name)
    loader.exec_module(module)
    doom_session(module.Session, doom, wad)
    failure_session(module.Session, sdk, wad, "--trap", 1)
    failure_session(module.Session, sdk, wad, "--exit-7", 7)
    print("application PTY: 50 Doom frames, keyboard input, recording, pixel capture, trap and exit cleanup passed")


if __name__ == "__main__":
    main()
