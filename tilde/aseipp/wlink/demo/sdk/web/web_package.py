# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Lay out a console application as a directory a browser can open.

A package is the browser host's bundle, its audio worklet, the page that loads
them, the linked core module, and the application's mounted assets at the
virtual paths the guest opens them by, described by a manifest both the browser
and the headless runner read. Building it here rather than in Starlark keeps
the validation -- what a virtual path may be, what a module must start with --
testable on its own.
"""

import argparse
import filecmp
import json
import os
import shutil
import sys

RESERVED = ("index.html", "console.js", "worklet.js", "linked.wasm", "manifest.json")
MODULE_NAME = "linked.wasm"
MAX_NAME = 256


class PackageError(Exception):
    """A package that cannot be built or does not match its inputs."""


def check_mount_path(path):
    """The virtual path an asset is mounted at, as the HAL's file_name reads one."""
    if not path or len(path.encode()) >= MAX_NAME:
        raise PackageError(f"{path!r} is not a usable mount path")
    if "\\" in path or "\0" in path:
        raise PackageError(f"{path!r} is not a usable mount path")
    for segment in path.split("/"):
        if segment in ("", ".", ".."):
            raise PackageError(f"{path!r} is not a usable mount path")
    if path in RESERVED or path.split("/")[0] in RESERVED:
        raise PackageError(f"{path!r} collides with a file the package needs")
    return path


def parse_mount(value):
    virtual, sep, source = value.partition("=")
    if not sep or not virtual or not source:
        raise PackageError(f"expected PATH=FILE, found {value!r}")
    return check_mount_path(virtual), source


def check_module(path):
    with open(path, "rb") as module:
        if module.read(4) != b"\0asm":
            raise PackageError(f"{path} is not a WebAssembly module")
    return path


def build(options):
    mounts = [parse_mount(mount) for mount in options.mount]
    seen = set()
    for virtual, _ in mounts:
        if virtual in seen:
            raise PackageError(f"{virtual!r} is mounted twice")
        seen.add(virtual)
    if options.option is not None and len(mounts) != 1:
        raise PackageError(f"--option {options.option} needs exactly one mount to replace")
    check_module(options.module)

    out = options.out
    os.makedirs(out, exist_ok=True)
    shutil.copyfile(options.index, os.path.join(out, "index.html"))
    shutil.copyfile(options.script, os.path.join(out, "console.js"))
    shutil.copyfile(options.worklet, os.path.join(out, "worklet.js"))
    shutil.copyfile(options.module, os.path.join(out, MODULE_NAME))

    entries = []
    for virtual, source in mounts:
        target = os.path.join(out, virtual)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(source, target)
        entries.append({"path": virtual, "file": virtual, "size": os.stat(target).st_size})

    manifest = {
        "name": options.name,
        "title": options.title or options.name,
        "module": MODULE_NAME,
        "frames_per_second": options.frames_per_second,
        "aspect": options.aspect,
        "option": options.option,
        "args": options.arg,
        "mounts": entries,
    }
    with open(os.path.join(out, "manifest.json"), "w") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")


def check(options):
    with open(os.path.join(options.check, "manifest.json")) as handle:
        manifest = json.load(handle)
    for name in RESERVED:
        if not os.path.isfile(os.path.join(options.check, name)):
            raise PackageError(f"the package has no {name}")
    if manifest["module"] != MODULE_NAME:
        raise PackageError(f"the manifest names {manifest['module']!r} as its module")
    if options.module is not None:
        packaged = os.path.join(options.check, MODULE_NAME)
        if not filecmp.cmp(packaged, options.module, shallow=False):
            raise PackageError(f"{MODULE_NAME} is not the module it was built from")

    expected = dict(parse_mount(mount) for mount in options.mount)
    listed = {entry["path"]: entry for entry in manifest["mounts"]}
    if set(expected) != set(listed):
        raise PackageError(f"the manifest mounts {sorted(listed)}, not {sorted(expected)}")
    for virtual, source in expected.items():
        packaged = os.path.join(options.check, listed[virtual]["file"])
        if not filecmp.cmp(packaged, source, shallow=False):
            raise PackageError(f"{virtual} is not the file it was built from")
        if os.stat(packaged).st_size != listed[virtual]["size"]:
            raise PackageError(f"the manifest reports the wrong size for {virtual}")
    if manifest["option"] is not None and len(listed) != 1:
        raise PackageError("the manifest declares an option without a single mount to replace")


def parser():
    parsed = argparse.ArgumentParser(allow_abbrev=False)
    parsed.add_argument("out", nargs="?")
    parsed.add_argument("--check")
    parsed.add_argument("--name")
    parsed.add_argument("--title")
    parsed.add_argument("--frames-per-second", type=int, default=60)
    parsed.add_argument("--aspect", choices=("4:3", "frame"), default="4:3")
    parsed.add_argument("--module")
    parsed.add_argument("--script")
    parsed.add_argument("--worklet")
    parsed.add_argument("--index")
    parsed.add_argument("--option")
    parsed.add_argument("--mount", action="append", default=[])
    parsed.add_argument("--arg", action="append", default=[])
    return parsed


def main(argv):
    options = parser().parse_args(argv)
    if options.check is not None:
        check(options)
        return
    missing = [
        name for name in ("out", "name", "module", "script", "worklet", "index")
        if getattr(options, name) is None
    ]
    if missing:
        raise PackageError(f"building a package needs {', '.join(sorted(missing))}")
    if options.frames_per_second < 1 or options.frames_per_second > 1000:
        raise PackageError("a frame rate is 1 to 1000 Hz")
    build(options)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except PackageError as error:
        raise SystemExit(f"web_package: {error}")
