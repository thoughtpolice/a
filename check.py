#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
check.py - Print the targets affected by the current change

Runs tdutil, the repository's target determinator, and prints the affected
targets one per line. That is also the shape of a Buck2 argument file, so
buck2 can run this script itself and act on its output:

    buck2 build @check.py
    buck2 test @check.py
    buck2 test @check.py#quick

It can also be run directly. Any arguments are handed to tdutil:

    ./check.py --from 'trunk()' --to '@'
    ./check.py --help

With no arguments tdutil compares fork_point(trunk() | @) against @, over
every cell CI tests: the root, tilde, toolchains, third-party and mode cells,
less the vendored crates (see EXCLUDE). Naming any universe pattern replaces
that default; see buck/tools/tdutil/README.md for the rest.

`--everything`, or the `everything` flavor, prints every target CI tests
instead, with no comparison at all; any further arguments go to buck2:

    buck2 test @check.py#everything
    ./check.py --everything @buck/ci.buckargs
"""

import sys

sys.dont_write_bytecode = True

import os
import re
import subprocess
import time
from pathlib import Path

TDUTIL = "root//buck/tools/tdutil:tdutil"

# What CI tests: every cell but the archived cellar. tdutil's own default is
# the root cell alone. It collects the other cells' graphs whatever it is
# asked, so their changes reach the root cell's targets, but it reports only
# the universe, and the tests and source checks in those cells would never be
# selected. CI tests nothing else: with no change to compare, it tests what
# `--everything` lists. tdutil knows cells only by their canonical names, so
# the aliases root//, tilde// and the rest won't do.
UNIVERSE = [
    "depot//...",
    "depot-tilde//...",
    "depot-toolchains//...",
    "depot-third-party//...",
    "depot-mode//...",
]

# What CI leaves out of the universe: the targets reindeer generates for the
# vendored crates, one per crate and archive in Cargo.lock, whatever platform
# it is for. Nothing needs to build a crate on its own. It is built when a
# target that uses it is, for that target's platform, and a change to it still
# selects those targets, since tdutil walks the whole graph.
EXCLUDE = ["depot-third-party//rust:"]

# Flavors are what follows the '#' in '@check.py#quick', which buck2 hands to
# an argument file as '--flavors quick'.
FLAVORS = {
    # Only the working-copy graph is consulted: interactive speed, at the cost
    # of some precision. Fine for a local check, not for CI.
    "quick": ["--quick"],
    # Every target CI tests, not only those a change affects.
    "everything": ["--everything"],
}


def expand_flavors(argv):
    """Replace buck2's `--flavors a,b` with the arguments they stand for."""
    if len(argv) >= 2 and argv[0] == "--flavors":
        args = []
        for flavor in argv[1].split(","):
            if flavor not in FLAVORS:
                known = ", ".join(sorted(FLAVORS))
                sys.exit(f"check.py: unknown flavor {flavor!r} (known: {known})")
            args += FLAVORS[flavor]
        return args + argv[2:]
    return argv


def tdutil_args(argv):
    """Turn this script's arguments into tdutil's, and say whether the
    default universe, and so EXCLUDE, applies."""
    if names_universe(argv):
        return argv, False
    # Ahead of the caller's arguments, where a `--` among them can't turn
    # these into positional ones.
    universe = [arg for pattern in UNIVERSE for arg in ("--universe", pattern)]
    return universe + argv, True


def excluded(label):
    """Whether a target is one EXCLUDE leaves out."""
    for pattern in EXCLUDE:
        if pattern.endswith(":") and label.startswith(pattern):
            return True
        if pattern.endswith("/...") and label.startswith(pattern[: -len("...")]):
            return True
        if pattern.endswith("/...") and label.startswith(pattern[: -len("/...")] + ":"):
            return True
    return False


def names_universe(argv):
    """Whether tdutil's arguments already name a universe pattern."""
    # tdutil takes a universe from -u/--universe, or from any positional
    # argument containing `//`. A revset never does, and an option value that
    # might, like `--cache s3://...`, has no `//` directly after a cell name.
    for arg in argv:
        if arg in ("-u", "--universe") or arg.startswith(("-u=", "--universe=")):
            return True
        if re.match(r"[\w-]+//", arg):
            return True
    return False


def status_stream():
    """Where progress goes: the terminal, wherever it can be found."""
    # buck2 captures an argument file's stderr and shows it only if the script
    # fails, so under buck2 a successful run would print nothing at all. Write
    # to the terminal directly then; with none, as in CI, stderr is all there
    # is.
    if os.environ.get("BUCK2_ARG_FILE"):
        try:
            return open("/dev/tty", "w")
        except OSError:
            pass
    return sys.stderr


def build_tdutil(root, status):
    """Build tdutil, returning the path of its executable."""
    status.write("check.py: building tdutil... ")
    status.flush()
    start = time.monotonic()
    try:
        result = subprocess.run(
            ["buck2", "build", TDUTIL, "--show-full-simple-output"],
            check=False,
            cwd=root,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        status.write("failed\n")
        sys.exit("check.py: buck2 is not on PATH; is the environment set up?")
    if result.returncode != 0:
        status.write("failed\n")
        sys.stderr.write(result.stderr)
        sys.exit(result.returncode)
    status.write(f"done ({time.monotonic() - start:.1f}s)\n")
    return result.stdout.strip().splitlines()[-1]


def everything(root, status, buck_args):
    """Print every target CI tests, as buck2 sees the graph."""
    status.write("check.py: listing every target... ")
    status.flush()
    start = time.monotonic()
    query = " + ".join(UNIVERSE)
    if EXCLUDE:
        query = f"({query}) - ({' + '.join(EXCLUDE)})"
    try:
        result = subprocess.run(
            ["buck2", "uquery", *buck_args, query],
            check=False,
            cwd=root,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        status.write("failed\n")
        sys.exit("check.py: buck2 is not on PATH; is the environment set up?")
    if result.returncode != 0:
        status.write("failed\n")
        sys.stderr.write(result.stderr)
        return result.returncode
    labels = [line for line in result.stdout.splitlines() if line.strip()]
    status.write(f"{len(labels)} targets ({time.monotonic() - start:.1f}s)\n")
    sys.stdout.writelines(label + "\n" for label in labels)
    return 0


def main():
    # buck2 runs an argument file from the caller's directory, which may be
    # anywhere in the repository or another cell entirely; tdutil works on the
    # repository it is run in.
    root = Path(__file__).resolve().parent
    argv = expand_flavors(sys.argv[1:])
    status = status_stream()
    if argv[:1] == ["--everything"]:
        return everything(root, status, argv[1:])
    args, defaulted = tdutil_args(argv)

    tdutil = build_tdutil(root, status)

    status.write("check.py: determining affected targets... ")
    status.flush()
    start = time.monotonic()
    # tdutil's stdout is the target list. Its stderr only ever carries
    # warnings and errors, held back until the status line above is finished.
    result = subprocess.run(
        [tdutil, *args],
        check=False,
        cwd=root,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        status.write("failed\n")
        sys.stderr.write(result.stderr)
        print(
            f"check.py: tdutil failed with exit code {result.returncode}",
            file=sys.stderr,
        )
        return result.returncode

    labels = result.stdout.splitlines()
    if defaulted:
        labels = [label for label in labels if not excluded(label)]
    count = len(labels)
    noun = "target" if count == 1 else "targets"
    status.write(f"{count} {noun} ({time.monotonic() - start:.1f}s)\n")
    sys.stderr.write(result.stderr)
    sys.stdout.writelines(label + "\n" for label in labels)
    return 0


if __name__ == "__main__":
    sys.exit(main())
