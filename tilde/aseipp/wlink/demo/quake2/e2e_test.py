#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
"""Quake II on the console SDK, driven through the runner's public interface.

The test build logs the server's view of the player once per frame; the
production build must render the very same frames without it.
"""

import pathlib
import re
import shlex
import subprocess
import sys
import tempfile


def run(binary, pak, directory, *, frames=300, script="", args=("+map", "demo1"), trace=False, expected=0,
        save_dir=None):
    script_path = directory / "input.txt"
    script_path.write_text(script)
    capture = directory / "frame.ppm"
    # A runner may be several words, as a Deno one is; no buck-out path has a space in it.
    command = [*shlex.split(binary), "--pak", pak, "--headless", "--frames", str(frames),
               "--script", str(script_path)]
    if trace:
        command += ["--trace"]
    if save_dir is not None:
        command += ["--save-dir", str(save_dir)]
    if expected == 0:
        command += ["--dump-frame", str(capture)]
    result = subprocess.run(command + ["--", *args], capture_output=True, text=True, timeout=300)
    assert result.returncode == expected, (command, result.returncode, result.stdout[-8000:], result.stderr)
    assert "guest trapped" not in result.stderr, result.stderr
    summaries = re.findall(r"^summary (.*)$", result.stdout, re.M)
    assert len(summaries) == 1, result.stdout[-8000:]
    summary = dict(field.split("=", 1) for field in summaries[0].split())
    states = {}
    traces = {}
    for line in result.stdout.splitlines():
        if "quake2-state " in line:
            fields = dict(re.findall(r"(\w+)=(\S+)", line.split("quake2-state ", 1)[1]))
            state = {k: int(v) if re.fullmatch(r"-?\d+", v) else v for k, v in fields.items()}
            states[state["frame"]] = state
        if line.startswith("frame="):
            fields = dict(field.split("=", 1) for field in line.split())
            traces[int(fields["frame"])] = fields
    image = capture.read_bytes() if expected == 0 else b""
    return result, summary, states, traces, image


def main(test_binary, production_binary, pak, directory):
    script = """120 w down
160 w up
170 right down
200 right up
210 space down
230 space up
"""
    result, summary, states, traces, image = run(test_binary, pak, directory, script=script, trace=True)
    # The platform shows at most one frame per host frame, and the engine
    # renders nothing while the level loads.
    assert len(states) == 300 and 200 <= int(summary["presents"]) <= 300, summary
    assert summary["width"] == "320" and summary["height"] == "240", summary
    assert image.startswith(b"P6\n320 240\n255\n") and len(image.split(b"\n", 3)[3]) == 320 * 240 * 3
    rgb = image.split(b"\n", 3)[3]
    assert len({rgb[i:i + 3] for i in range(0, len(rgb), 3)}) > 32, "frame is blank or uninitialized"
    spawned = min(n for n in states if states[n]["spawned"] == 1)
    assert spawned < 110, f"the player spawned only at frame {spawned}"
    assert all(states[n]["state"] == 2 and states[n]["spawned"] == 1 and states[n]["map"] == "demo1"
               for n in range(spawned, 301)), states[spawned]
    assert states[110]["health"] == 100, states[110]
    assert states[110]["z"] < states[spawned]["z"], "the player did not fall to the floor"
    assert states[120]["forward"] == 1 and states[160]["forward"] == 0, (states[120], states[160])
    assert (states[119]["x"], states[119]["y"]) != (states[160]["x"], states[160]["y"]), "forward input did not move the player"
    assert states[170]["turn"] == 1 and states[200]["turn"] == 0, (states[170], states[200])
    assert states[169]["yaw"] != states[200]["yaw"], "turn input did not rotate the player"
    assert states[210]["fire"] == 1 and states[230]["fire"] == 0, (states[210], states[230])
    assert states[300]["forward"] == states[300]["turn"] == states[300]["fire"] == 0

    repeated = run(test_binary, pak, directory, script=script, trace=True)
    assert repeated[2] == states and repeated[3] == traces and repeated[4] == image, "scripted execution is not deterministic"
    idle = run(test_binary, pak, directory)
    assert idle[1]["hash"] != summary["hash"], "input did not change rendered output"
    # The mixer keeps the host's queue fed continuously; the blaster changes it.
    assert int(summary["played"]) >= 300 * 735 - 8820 and int(idle[1]["played"]) == int(summary["played"]), (summary, idle[1])
    assert idle[1]["audio"] != summary["audio"], "firing did not change the sound"
    production = run(production_binary, pak, directory, script=script)
    assert production[4] == image, "test instrumentation changed the production game"

    verbose = run(production_binary, pak, directory, frames=120, args=("+set", "developer", "1", "+map", "demo1"))
    assert "can't find players/male/tris.md2" not in verbose[0].stdout, "player models are missing from the pak"

    menu = run(test_binary, pak, directory, frames=120, args=())
    assert menu[2][120]["state"] == 0 and int(menu[1]["presents"]) >= 1, menu[2][120]

    # Aiming with the pointer. The console turns the engine's freelook on,
    # and without it vertical motion walks the player rather than raising the
    # view, so the run has to change the pitch and leave the player standing
    # exactly where it was.
    look = run(test_binary, pak, directory, frames=200, script=(
        "120 mouse 160 120 0 0\n"  # the pointer arrives; a position, not a motion
        "140 mouse 160 90 0 0\n"   # up the screen, so the view goes up
        "170 mouse 160 150 0 0\n"  # and back down, past where it started
        "180 mouse 200 150 0 0\n"  # across the screen, so the view turns
    ))[2]
    assert look[139]["pitch"] == 0 and look[160]["pitch"] < 0, (look[139], look[160])
    assert look[200]["pitch"] > 0, look[200]
    assert look[200]["yaw"] != look[139]["yaw"], (look[139], look[200])
    standing = tuple(look[139][axis] for axis in "xyz")
    assert all(tuple(look[n][axis] for axis in "xyz") == standing for n in range(139, 201)), \
        "aiming moved the player"

    # A walk, a quick save at rest away from the spawn point, another walk,
    # and a quick load: the engine copies the slot through the directory
    # listing and puts the player back where the save was made, not where
    # the level starts. A fresh run loads the slot the first one left in the
    # save directory.
    save = directory / "save"
    saved = run(test_binary, pak, directory, frames=440, save_dir=save, script=(
        "120 w down\n150 w up\n200 f6 down\n201 f6 up\n230 w down\n260 w up\n290 f9 down\n291 f9 up\n"
    ))
    at = lambda frame: tuple(saved[2][frame][axis] for axis in "xyz")
    position = at(200)
    assert position == at(199) and position[:2] != at(110)[:2], "the player was not at rest away from the start"
    assert at(260)[:2] != position[:2], "the second walk did not move the player"
    assert saved[2][440]["map"] == "demo1" and saved[2][440]["spawned"] == 1, saved[2][440]
    assert at(440) == position, (saved[2][440], position)
    assert "saves not written" not in saved[0].stderr, saved[0].stderr
    slot = save / "baseq2" / "save" / "quick"
    assert {"server.ssv", "game.ssv", "demo1.sav", "demo1.sv2"} <= {p.name for p in slot.iterdir()}, sorted(slot.iterdir())
    loaded = run(test_binary, pak, directory, frames=200, save_dir=save, args=("+load", "quick"))
    assert loaded[2][200]["map"] == "demo1" and loaded[2][200]["spawned"] == 1, loaded[2][200]
    assert tuple(loaded[2][200][axis] for axis in "xyz") == position, (loaded[2][200], position)

    long_run = run(production_binary, pak, directory, frames=1500, script=script, trace=True)
    for memory in ("game-memory", "platform-memory"):
        baseline = int(long_run[3][300][memory])
        assert all(int(t[memory]) == baseline for n, t in long_run[3].items() if n >= 300), (memory, long_run[1])
    print("PASS Quake II demo1: movement, turn, fire, sound, releases, default menu startup, deterministic frames, "
          "production parity, player models, mouse look, quick save and load, saves on disk, "
          "1500-frame memory stability")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="wlink-quake2-") as temporary:
        main(sys.argv[1], sys.argv[2], sys.argv[3], pathlib.Path(temporary))
