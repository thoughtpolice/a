# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Exercise native wasm2c executables using only their public host interface."""

import pathlib
import re
import shlex
import subprocess
import sys
import tempfile


def run(binary, wad, directory, *, frames=280, script="", args=(), trace=False, expected=0, save_dir=None,
        record=None, audio=None, options=()):
    script_path = directory / "input.txt"
    script_path.write_text(script)
    capture = directory / "frame.ppm"
    # A runner may be several words, as a Deno one is; no buck-out path has a space in it.
    command = [*shlex.split(binary), "--iwad", wad, "--headless", "--frames", str(frames),
               "--script", str(script_path), *options]
    if trace:
        command += ["--trace"]
    if save_dir is not None:
        command += ["--save-dir", str(save_dir)]
    if record is not None:
        command += ["--record", str(record)]
    if audio is not None:
        command += ["--dump-audio", str(audio)]
    if expected == 0:
        command += ["--dump-frame", str(capture)]
    result = subprocess.run(command + ["--", *args], capture_output=True, text=True, timeout=90)
    assert result.returncode == expected, (command, result.returncode, result.stdout[-8000:], result.stderr)
    summaries = re.findall(r"^summary (.*)$", result.stdout, re.M)
    assert len(summaries) == 1, result.stdout[-8000:]
    summary = dict(field.split("=", 1) for field in summaries[0].split())
    states = {}
    traces = {}
    for line in result.stdout.splitlines():
        if "doom-state " in line:
            state = dict((k, int(v)) for k, v in re.findall(r"(\w+)=(-?\d+)", line))
            states[state["frame"]] = state
        if line.startswith("frame="):
            fields = dict(field.split("=", 1) for field in line.split())
            traces[int(fields["frame"])] = fields
    return result, summary, states, traces, capture.read_bytes() if expected == 0 else b""


def doom_test(test_binary, production_binary, wad, directory):
    script = """100 w down
130 w up
140 right down
170 right up
180 space down
220 space up
"""
    args = ("-warp", "1", "-skill", "3", "-nomonsters")
    first = run(test_binary, wad, directory, script=script, args=args, trace=True)
    result, summary, states, traces, image = first
    assert len(states) == 280 and int(summary["presents"]) == 280, summary
    assert summary["width"] == "320" and summary["height"] == "200", summary
    assert image.startswith(b"P6\n320 200\n255\n") and len(image.split(b"\n", 3)[3]) == 320 * 200 * 3
    rgb = image.split(b"\n", 3)[3]
    assert len({rgb[i:i + 3] for i in range(0, len(rgb), 3)}) > 32, "frame is blank or uninitialized"
    assert all(states[n]["level"] == 1 and states[n]["user"] == 1 and states[n]["map"] == 1 for n in range(90, 281))
    assert states[90]["wipe"] == 0 and states[90]["demo"] == 0, states[90]
    assert states[100]["forward"] == 1 and states[130]["forward"] == 0, (states[100], states[130])
    assert (states[99]["x"], states[99]["y"]) != (states[130]["x"], states[130]["y"]), "forward input did not move the player"
    assert states[140]["turn"] == 1 and states[170]["turn"] == 0, (states[140], states[170])
    assert states[139]["angle"] != states[170]["angle"], "turn input did not rotate the player"
    assert states[180]["fire"] == 1 and states[220]["fire"] == 0, (states[180], states[220])
    assert states[220]["ammo"] < states[179]["ammo"], "fire input did not consume ammunition"
    assert states[280]["tic"] > states[70]["tic"] + 150, "clock stalled after its initial second"
    assert states[280]["forward"] == states[280]["turn"] == states[280]["fire"] == 0

    repeated = run(test_binary, wad, directory, script=script, args=args, trace=True)
    assert repeated[2] == states and repeated[3] == traces and repeated[4] == image, "scripted execution is not deterministic"
    # A recording holds the events the game received, frame by frame, in the
    # script format, so replaying it is the same run.
    recording = directory / "recording.txt"
    run(test_binary, wad, directory, script=script, args=args, record=recording)
    recorded = recording.read_text()
    assert recorded.startswith("# doom input recording\n"), recorded
    assert [line.split() for line in recorded.splitlines()[1:]] == [line.split() for line in script.splitlines()], recorded
    replayed = run(test_binary, wad, directory, script=recorded, args=args, trace=True)
    assert replayed[2] == states and replayed[3] == traces and replayed[4] == image, "the recording does not replay the run"
    idle = run(test_binary, wad, directory, args=args)
    assert idle[1]["hash"] != summary["hash"], "input did not change rendered output"
    # Sound plays continuously; the pistol changes it.
    assert int(summary["played"]) >= 280 * 1260 - 4096 and int(idle[1]["played"]) == int(summary["played"]), (summary, idle[1])
    assert idle[1]["audio"] != summary["audio"], "firing did not change the sound"
    production = run(production_binary, wad, directory, script=script, args=args)
    assert production[4] == image, "test instrumentation changed the production game"

    menu = run(test_binary, wad, directory, args=("-nomonsters",), script=(
        "20 escape down\n21 escape up\n25 enter down\n26 enter up\n30 enter down\n31 enter up\n"
    ))
    assert menu[2][280]["level"] == menu[2][280]["user"] == 1, "default title/menu cannot start a playable game"
    assert menu[2][280]["demo"] == menu[2][280]["wipe"] == 0, menu[2][280]

    quit_run = run(production_binary, wad, directory, args=args, script=(
        "100 f10 down\n101 f10 up\n105 y down\n106 y up\n"
    ))
    assert int(quit_run[1]["frames"]) < 280 and "guest trapped" not in quit_run[0].stderr, "Doom's Quit command did not exit cleanly"

    long_run = run(production_binary, wad, directory, frames=2100, script=script, args=args, trace=True)
    for memory in ("game-memory", "platform-memory"):
        baseline = int(long_run[3][350][memory])
        assert all(int(t[memory]) == baseline for n, t in long_run[3].items() if n >= 350), (memory, long_run[1])
    print("PASS Doom MAP01: movement, turn, fire, sound, releases, menu startup, quit, deterministic frames, recording replay, production parity, 2100-frame memory stability")


def sdk_test(binary, wad, directory, *, raw_argv=True):
    script = "0 a down\n0 a up\n0 pause down\n0 pause up\n0 page-up down\n0 page-up up\n0 mouse 5 6 1 0\n0 text hi\u2603\n"
    identity = ("--seed", "42", "--unix-time", "1234567")
    # POSIX arguments are bytes and the guest sees an empty string for each one
    # that is not UTF-8. A runner whose own arguments must be text -- Deno
    # refuses to start otherwise, and a browser only ever has strings -- is
    # given the empty strings directly, which is what the guest observes.
    utf8 = (b"\xff", b"\xed\xa0\x80", b"\xf4\x90\x80\x80") if raw_argv else ("", "", "")
    for args in ((), ("--invalid-framebuffer",),
                 ("--utf8-test", *utf8, "\u2603")):
        result, summary, _, _, image = run(binary, wad, directory, frames=100, script=script, args=args, options=identity)
        for stage in ("args", "allocator", "directories", "streams", "files", "large lists", "system", "display info",
                      "audio", "input", "audio playback", "clock", "contract"):
            assert f"PASS sdk {stage}" in result.stdout, result.stdout
        assert summary["played"] == "44100", summary
        assert summary["presents"] == "1" and summary["width"] == summary["height"] == "2", summary
        assert image == b"P6\n2 2\n255\n" + bytes((255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255)), image
        assert "guest trapped" not in result.stderr

    # A game may pick its frame rate and blank frame size during init: ten
    # frames at 70 Hz on a 64 by 48 frame, presented once, when drawn on.
    result, summary, _, _, image = run(binary, wad, directory, frames=100, script=script, args=("--fast",), options=identity)
    assert "PASS sdk mode" in result.stdout and "PASS sdk fast" in result.stdout, result.stdout
    assert summary["frames"] == "10" and summary["presents"] == "1", summary
    assert image.startswith(b"P6\n64 48\n255\n") and set(image.split(b"\n", 3)[3]) == {255}, image[:20]

    # The overlay: one of every primitive on a white 16 by 16 frame.
    result, summary, _, _, image = run(binary, wad, directory, frames=100, script=script, args=("--overlay",), options=identity)
    assert "PASS sdk overlay" in result.stdout and summary["presents"] == "1", result.stdout
    assert image.startswith(b"P6\n16 16\n255\n"), image[:20]
    rgb = image.split(b"\n", 3)[3]
    pixel = lambda x, y: rgb[(y * 16 + x) * 3:(y * 16 + x) * 3 + 3]
    black, white = b"\0\0\0", b"\xff\xff\xff"
    assert all(pixel(x, y) == black for x in range(8) for y in range(8)), "fill-rect"
    assert pixel(8, 0) == white and pixel(10, 0) == black and pixel(10, 3) == black and pixel(9, 3) == white, "text"
    assert pixel(8, 8) == black and pixel(9, 8) == white and pixel(8, 9) == white and pixel(9, 9) == black, "sprite"
    assert all(pixel(x, 15) == black for x in range(16)) and pixel(15, 14) == white, "line"
    assert all(pixel(x, y) == black for x, y in ((12, 4), (11, 4), (13, 4), (12, 3), (12, 5))) and pixel(11, 3) == white, "circle"
    assert all(pixel(x, y) == black for x in range(4) for y in range(8, 12)) and pixel(4, 8) == white, "clip"
    assert all(pixel(x, y) == black for x in range(4) for y in range(12, 14)) and pixel(4, 12) == white, "camera"

    # The audio dump is a WAV file of every frame period played, silence
    # included: the second of samples the contract wrote, then nothing. The
    # last frame exits before its period plays.
    wav = directory / "audio.wav"
    result, summary, *_ = run(binary, wad, directory, frames=100, script=script, audio=wav, options=identity)
    data = wav.read_bytes()
    frames = (int(summary["frames"]) - 1) * 1260
    assert data[:4] == b"RIFF" and data[8:16] == b"WAVEfmt " and data[36:40] == b"data", data[:44]
    assert int.from_bytes(data[40:44], "little") == frames * 4 and len(data) == 44 + frames * 4, (len(data), frames)
    assert int.from_bytes(data[22:24], "little") == 2 and int.from_bytes(data[24:28], "little") == 44100, data[:44]
    assert any(data[44 + 4 * 1260 * 34:44 + 4 * 1260 * 35]) and not any(data[44 + 4 * 1260 * 36:]), "played samples and silence are misplaced"

    # A save directory holds what the game wrote once it exits, and a second
    # run starts from it: files the host put there are listed, read, and
    # removed on disk when the game removes them.
    save = directory / "save"
    result, *_ = run(binary, wad, directory, frames=100, script=script, save_dir=save, args=("--persistent",), options=identity)
    assert "PASS sdk contract" in result.stdout and "saves not written" not in result.stderr, result
    assert (save / "contract.tmp").read_bytes() == b"aXYZa"
    assert (save / "contract-stream.tmp").read_bytes() == b"alXYZ"
    assert (save / "contract-large.tmp").stat().st_size == 2 * 1024 * 1024 + 17
    assert not (save / "contract-dir").exists() and not (save / "contract-moved").exists()
    assert not (save / "contract-open.tmp").exists() and not (save / ".flush.tmp").exists()
    (save / "preexisting").mkdir()
    (save / "preexisting" / "hello.txt").write_bytes(b"hi")
    result, *_ = run(binary, wad, directory, frames=100, script=script, save_dir=save,
                     args=("--expect-saved", "--persistent"), options=identity)
    assert "PASS sdk saved state" in result.stdout and "PASS sdk contract" in result.stdout, result.stdout
    assert "saves not written" not in result.stderr, result.stderr
    assert not (save / "preexisting").exists()
    assert (save / "contract.tmp").read_bytes() == b"aXYZa"
    result, *_ = run(binary, wad, directory, frames=1, args=("--trap",), expected=1, options=identity)
    assert "guest trapped" in result.stderr, result.stderr
    result, *_ = run(binary, wad, directory, frames=1, args=("--exit-7",), expected=7, options=identity)
    assert "guest trapped" not in result.stderr, result.stderr
    print("PASS SDK canonical buffers, growth, files, directories, save directory, events, mouse, text, audio, framebuffer, overlay, mode, system, clock, exit and trap handling")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="wlink-doom-") as temporary:
        directory = pathlib.Path(temporary)
        if sys.argv[1] == "doom":
            doom_test(sys.argv[2], sys.argv[3], sys.argv[4], directory)
        elif sys.argv[1] == "sdk":
            sdk_test(sys.argv[2], sys.argv[3], directory)
        elif sys.argv[1] == "sdk-web":
            sdk_test(sys.argv[2], sys.argv[3], directory, raw_argv=False)
        else:
            raise SystemExit("expected doom, sdk or sdk-web")
