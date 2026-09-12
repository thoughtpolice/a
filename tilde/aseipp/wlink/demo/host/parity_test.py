# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Run one application through two hosts and compare them frame by frame.

The native runner and the browser host implement the same hardware layer over
the same linked module, so for the same inputs every `frame=` line and the
`summary` line must be identical: the video hash, both component memory sizes,
the audio hash and the frames played. That is exactly what the interpreter host
is held to, and it is the whole conformance claim in one assertion.
"""

import pathlib
import re
import shlex
import subprocess
import sys
import tempfile

# Arrows, Z and X are what every cart the console ships reads.
LUAU_SCRIPT = """20 left down
60 left up
70 z down
80 z up
90 right down
150 right up
160 x down
170 x up
180 down down
220 down up
230 z down
260 z up
"""

MODES = {
    # mode: (option, frames, script, guest arguments, timeout)
    # The console carries its cart rather than opening one the host names: the
    # native runner is given it as an argument and the browser package has it
    # mounted, so neither side takes an asset here.
    "luau": (None, 300, LUAU_SCRIPT, (), 180),
}


def run(binary, option, asset, frames, script_path, args, timeout):
    command = [
        *shlex.split(binary), *((option, asset) if option else ()),
        "--headless", "--frames", str(frames),
        "--script", str(script_path), "--trace",
        "--seed", "42", "--unix-time", "1234567", "--",
        *args,
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    assert result.returncode in (0, 7), (command, result.returncode, result.stdout[-4000:], result.stderr)
    assert "guest trapped" not in result.stderr, (command, result.stderr)
    traces = [line for line in result.stdout.splitlines() if line.startswith("frame=")]
    summaries = re.findall(r"^summary .*$", result.stdout, re.M)
    assert len(summaries) == 1, result.stdout[-4000:]
    return traces, summaries[0]


def main(mode, native, web, asset, directory):
    option, frames, script, args, timeout = MODES[mode]
    script_path = directory / "input.txt"
    script_path.write_text(script)
    native_traces, native_summary = run(native, option, asset, frames, script_path, args, timeout)
    web_traces, web_summary = run(web, option, asset, frames, script_path, args, timeout)

    assert native_traces, "the native runner traced no frames"
    assert len(native_traces) == len(web_traces), (
        f"the native runner traced {len(native_traces)} frames and the browser host "
        f"{len(web_traces)}"
    )
    for index, (left, right) in enumerate(zip(native_traces, web_traces)):
        assert left == right, f"frame {index + 1} differs:\n  native: {left}\n  web:    {right}"
    assert native_summary == web_summary, (
        f"the runs end differently:\n  native: {native_summary}\n  web:    {web_summary}"
    )
    print(f"PASS {mode} parity: {len(native_traces)} identical frames and the same summary")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="wlink-parity-") as temporary:
        asset = sys.argv[4] if len(sys.argv) > 4 else None
        main(sys.argv[1], sys.argv[2], sys.argv[3], asset, pathlib.Path(temporary))
