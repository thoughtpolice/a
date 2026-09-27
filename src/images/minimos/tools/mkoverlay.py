#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
"""
Build a deterministic overlay tar for a minimos-based image from CLI args.

This is the layer builder behind `minimos.overlay()` in ../defs.bzl.
Directories, files, symlinks and systemd units are all declared in the
BUILD file, so no image needs its own tar-writing script.

Usage:
  mkoverlay.py --out overlay.tar \\
      [--dir ARC[:MODE[:UID:GID]]]... \\
      [--file SRC:ARC[:MODE[:UID:GID]]]... \\
      [--empty ARC[:MODE[:UID:GID]]]... \\
      [--symlink ARC:TARGET]... \\
      [--unit SRC]... \\
      [--mask UNIT]...

  --dir      directory entry; MODE is octal (default 755), UID/GID default 0
  --file     copy SRC into the tar at ARC; MODE is octal (default 644),
             UID/GID default 0
  --empty    zero-length file at ARC; MODE is octal (default 644)
  --symlink  symlink at ARC pointing to TARGET
  --unit     systemd unit: installs SRC at /etc/systemd/system/<basename>
             and links it into the <target>.wants/ and <target>.requires/
             directories its own [Install] section names, the way
             `systemctl enable` would. A unit without an [Install] section
             is installed and left disabled.
  --mask     mask a unit: /etc/systemd/system/UNIT -> /dev/null

Parent directories are not created implicitly. Declare them with --dir
unless a lower layer already does. Every entry gets mtime 0 and uid/gid
0 unless the spec says otherwise, so the same arguments always produce
the same bytes.
"""

import argparse
import io
import os
import stat
import sys
import tarfile
from pathlib import Path

from common import UnsafeInputError, atomic_output, canonical_name, link_parts

SYSTEMD_DIR = "etc/systemd/system"
MAX_OVERLAY_ENTRIES = 200_000
MAX_OVERLAY_FILE_SIZE = 2 * 1024 * 1024 * 1024
MAX_OVERLAY_CONTENT_SIZE = 4 * 1024 * 1024 * 1024
# A unit file is parsed in memory for its [Install] section.
MAX_UNIT_FILE_SIZE = 1024 * 1024


def safe_mode(mode: int, *, directory: bool) -> int:
    if mode < 0 or mode > 0o7777:
        raise ValueError(f"invalid mode: {mode:o}")
    if mode & (stat.S_ISUID | stat.S_ISGID):
        raise ValueError(f"setuid/setgid modes are forbidden: {mode:o}")
    if mode & stat.S_IWOTH and not (directory and mode & stat.S_ISVTX):
        raise ValueError(f"world-writable mode requires a sticky directory: {mode:o}")
    return mode


def safe_id(value: int, *, kind: str) -> int:
    if value < 0 or value > 2**31 - 1:
        raise ValueError(f"invalid {kind}: {value}")
    return value


def safe_unit_name(name: str) -> str:
    if not name or name in (".", "..") or "/" in name or "\x00" in name:
        raise ValueError(f"invalid systemd unit name: {name!r}")
    return name


def _info(name: str, *, kind: bytes = tarfile.REGTYPE, mode: int = 0o644,
          uid: int = 0, gid: int = 0, size: int = 0,
          linkname: str = "") -> tarfile.TarInfo:
    """A tar header with every field the output's determinism depends on set."""
    info = tarfile.TarInfo(name=canonical_name(name))
    info.type = kind
    info.mode = mode
    info.uid = safe_id(uid, kind="uid")
    info.gid = safe_id(gid, kind="gid")
    info.size = size
    info.linkname = linkname
    info.mtime = 0
    return info


def _open_source(src: Path) -> tuple[io.BufferedReader, int]:
    """Open `src` once and vet it by descriptor.

    Buck materializes declared inputs as sandbox symlinks. Every later
    decision is made from the resulting descriptor, so pathname
    replacement cannot change the bytes being copied.
    """
    try:
        fd = os.open(src, os.O_RDONLY | os.O_CLOEXEC)
    except OSError as error:
        raise ValueError(f"overlay source is not a safe regular file: {src}") from error
    try:
        metadata = os.fstat(fd)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_size < 0
            or metadata.st_size > MAX_OVERLAY_FILE_SIZE
        ):
            raise ValueError(f"overlay source is not a bounded regular file: {src}")
        return os.fdopen(fd, "rb"), metadata.st_size
    except BaseException:
        os.close(fd)
        raise


def add_file(tar: tarfile.TarFile, src: Path, arcname: str, mode: int,
             uid: int = 0, gid: int = 0) -> int:
    """Copy `src` into the tar at `arcname`; returns its size for the budget."""
    source, size = _open_source(src)
    with source:
        tar.addfile(
            _info(arcname, mode=safe_mode(mode, directory=False),
                  uid=uid, gid=gid, size=size),
            source,
        )
    return size


def add_bytes(tar: tarfile.TarFile, arcname: str, data: bytes, mode: int,
              uid: int = 0, gid: int = 0) -> None:
    tar.addfile(
        _info(arcname, mode=safe_mode(mode, directory=False),
              uid=uid, gid=gid, size=len(data)),
        io.BytesIO(data),
    )


def add_dir(tar: tarfile.TarFile, arcname: str, mode: int, uid: int, gid: int) -> None:
    tar.addfile(_info(arcname, kind=tarfile.DIRTYPE,
                      mode=safe_mode(mode, directory=True), uid=uid, gid=gid))


def add_symlink(tar: tarfile.TarFile, arcname: str, target: str) -> None:
    link_parts(arcname.split("/")[:-1], target, what=f"symlink {arcname!r}")
    tar.addfile(_info(arcname, kind=tarfile.SYMTYPE, mode=0o777, linkname=target))


def install_links(unit: bytes, name: str) -> list[str]:
    """The `.wants/` and `.requires/` links the unit's [Install] section asks for.

    The offline half of `systemctl enable`: WantedBy= and RequiredBy= are
    honoured, a unit without an [Install] section gets no links, and any
    other install key is refused rather than silently ignored.
    """
    try:
        text = unit.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError(f"unit {name!r} is not UTF-8") from error
    links = []
    section = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line[0] in "#;":
            continue
        if line.startswith("["):
            section = line
            continue
        if section != "[Install]":
            continue
        if line.endswith("\\"):
            raise ValueError(f"unit {name!r}: [Install] line continuations are not supported")
        key, _, value = line.partition("=")
        suffix = {"WantedBy": ".wants", "RequiredBy": ".requires"}.get(key.strip())
        if suffix is None:
            raise ValueError(f"unit {name!r}: unsupported [Install] key {key.strip()!r}")
        for target in value.split():
            links.append(f"{SYSTEMD_DIR}/{safe_unit_name(target)}{suffix}/{name}")
    return links


def _mode_ids(tail: list[str], default_mode: int, *, spec: str,
              shape: str) -> tuple[int, int, int]:
    """The optional [:MODE[:UID:GID]] tail of a spec; MODE is octal."""
    if len(tail) == 0:
        return default_mode, 0, 0
    if len(tail) == 1:
        return int(tail[0], 8), 0, 0
    if len(tail) == 3:
        return int(tail[0], 8), int(tail[1]), int(tail[2])
    raise ValueError(f"{spec!r}: expected {shape}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--dir", action="append", default=[], metavar="ARC[:MODE[:UID:GID]]")
    ap.add_argument("--file", action="append", default=[],
                    metavar="SRC:ARC[:MODE[:UID:GID]]")
    ap.add_argument("--empty", action="append", default=[], metavar="ARC[:MODE[:UID:GID]]")
    ap.add_argument("--symlink", action="append", default=[], metavar="ARC:TARGET")
    ap.add_argument("--unit", action="append", default=[], metavar="SRC")
    ap.add_argument("--mask", action="append", default=[], metavar="UNIT")
    args = ap.parse_args()

    seen: set[str] = set()
    content = 0

    def claim(path: str) -> str:
        canonical = canonical_name(path)
        if canonical in seen:
            ap.error(f"duplicate archive destination: {canonical}")
        seen.add(canonical)
        if len(seen) > MAX_OVERLAY_ENTRIES:
            ap.error(f"overlay has more than {MAX_OVERLAY_ENTRIES} entries")
        return canonical

    def charge(size: int) -> None:
        nonlocal content
        content += size
        if content > MAX_OVERLAY_CONTENT_SIZE:
            raise ValueError("overlay expanded content exceeds size limit")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with atomic_output(args.out, prefix=f".{args.out.name}.mkoverlay-") as temporary, \
            tarfile.open(temporary, "w") as tar:
        for spec in args.dir:
            arc, *tail = spec.split(":")
            mode, uid, gid = _mode_ids(tail, 0o755, spec=f"--dir {spec}",
                                       shape="ARC[:MODE[:UID:GID]]")
            add_dir(tar, claim(arc), mode, uid, gid)

        for spec in args.symlink:
            arc, _, target = spec.partition(":")
            add_symlink(tar, claim(arc), target)

        for src in args.unit:
            name = safe_unit_name(Path(src).name)
            source, size = _open_source(Path(src))
            with source:
                if size > MAX_UNIT_FILE_SIZE:
                    raise ValueError(f"unit {name!r} is larger than {MAX_UNIT_FILE_SIZE} bytes")
                unit = source.read(size)
            charge(size)
            add_bytes(tar, claim(f"{SYSTEMD_DIR}/{name}"), unit, mode=0o644)
            for link in install_links(unit, name):
                add_symlink(tar, claim(link), f"/{SYSTEMD_DIR}/{name}")

        for spec in args.file:
            parts = spec.split(":")
            if len(parts) < 2:
                ap.error(f"--file {spec!r}: expected SRC:ARC[:MODE[:UID:GID]]")
            src, arc, *tail = parts
            mode, uid, gid = _mode_ids(tail, 0o644, spec=f"--file {spec}",
                                       shape="SRC:ARC[:MODE[:UID:GID]]")
            charge(add_file(tar, Path(src), claim(arc), mode, uid, gid))

        for spec in args.empty:
            arc, *tail = spec.split(":")
            mode, uid, gid = _mode_ids(tail, 0o644, spec=f"--empty {spec}",
                                       shape="ARC[:MODE[:UID:GID]]")
            add_bytes(tar, claim(arc), b"", mode, uid, gid)

        # Symlinks to /dev/null are systemd's canonical "masked" encoding:
        # the unit shows as masked instead of failing to start.
        for unit in args.mask:
            unit = safe_unit_name(unit)
            add_symlink(tar, claim(f"{SYSTEMD_DIR}/{unit}"), "/dev/null")

    print(f"mkoverlay: wrote {args.out} ({args.out.stat().st_size} bytes)",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
