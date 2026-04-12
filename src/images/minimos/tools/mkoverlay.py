#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
"""
Build a deterministic overlay tar for a minimos-based image from CLI args.

This is the generic layer builder behind `minimos.overlay()` (see
../defs.bzl): directories, files, symlinks, and systemd units are all
declared in the BUILD file, so composed images don't need a bespoke
tar-writing script each.

Usage:
  mkoverlay.py --out overlay.tar \\
      [--dir ARC[:MODE[:UID:GID]]]... \\
      [--file SRC:ARC[:MODE[:UID:GID]]]... \\
      [--empty ARC[:MODE]]... \\
      [--symlink ARC:TARGET]... \\
      [--unit SRC]... \\
      [--mask UNIT]...

  --dir      directory entry; MODE is octal (default 755), UID/GID default 0
  --file     copy SRC into the tar at ARC; MODE is octal (default 644),
             UID/GID default 0
  --empty    zero-length file at ARC; MODE is octal (default 644)
  --symlink  symlink at ARC pointing to TARGET
  --unit     systemd unit: installs SRC at /etc/systemd/system/<basename>
             and enables it via a multi-user.target.wants symlink
  --mask     mask a unit: /etc/systemd/system/UNIT -> /dev/null

Parent directories are NOT created implicitly — declare them with --dir
(or rely on a lower layer providing them). All entries get mtime=0 and
uid/gid 0 unless overridden, so the same args always produce the same
bytes.
"""

import argparse
from contextlib import contextmanager
import os
import stat
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

SYSTEMD_DIR = "etc/systemd/system"
WANTS_DIR = SYSTEMD_DIR + "/multi-user.target.wants"
MAX_OVERLAY_ENTRIES = 200_000
MAX_OVERLAY_FILE_SIZE = 2 * 1024 * 1024 * 1024
MAX_OVERLAY_CONTENT_SIZE = 4 * 1024 * 1024 * 1024


def safe_arcname(name: str) -> str:
    """Require one canonical path relative to the image root."""
    if not name or "\x00" in name:
        raise ValueError("archive path is empty or contains NUL")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part == ".." for part in path.parts):
        raise ValueError(f"archive path escapes image root: {name!r}")
    parts = tuple(part for part in path.parts if part not in ("", "."))
    canonical = "/".join(parts)
    if not canonical or canonical != name.rstrip("/"):
        raise ValueError(f"archive path is not canonical: {name!r}")
    return canonical


def safe_link_target(arcname: str, target: str) -> str:
    if not target or "\x00" in target:
        raise ValueError(f"symlink {arcname!r} has an invalid target")
    if target.startswith("//"):
        raise ValueError(f"symlink {arcname!r} has an ambiguous target: {target!r}")
    link = PurePosixPath(target)
    depth = 0 if link.is_absolute() else len(PurePosixPath(arcname).parts) - 1
    for part in link.parts:
        if part in ("", ".", "/"):
            continue
        if part.startswith("/"):
            raise ValueError(
                f"symlink {arcname!r} has an absolute path component: {target!r}"
            )
        if part == "..":
            if depth == 0:
                raise ValueError(
                    f"symlink {arcname!r} escapes image root: {target!r}"
                )
            depth -= 1
        else:
            depth += 1
    return target


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


def add_file(tar: tarfile.TarFile, src: Path, arcname: str, mode: int,
             uid: int = 0, gid: int = 0,
             content_budget: list[int] | None = None) -> None:
    arcname = safe_arcname(arcname)
    mode = safe_mode(mode, directory=False)
    uid = safe_id(uid, kind="uid")
    gid = safe_id(gid, kind="gid")
    try:
        # Buck materializes declared inputs as sandbox symlinks. Open the
        # caller-provided path exactly once, then make every decision from the
        # resulting descriptor so pathname replacement cannot change the bytes
        # being copied.
        source_fd = os.open(src, os.O_RDONLY | os.O_CLOEXEC)
    except OSError as error:
        raise ValueError(f"overlay source is not a safe regular file: {src}") from error
    try:
        metadata = os.fstat(source_fd)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_size < 0
            or metadata.st_size > MAX_OVERLAY_FILE_SIZE
        ):
            raise ValueError(f"overlay source is not a bounded regular file: {src}")
        if content_budget is not None:
            content_budget[0] += metadata.st_size
            if content_budget[0] > MAX_OVERLAY_CONTENT_SIZE:
                raise ValueError("overlay expanded content exceeds size limit")
        info = tarfile.TarInfo(name=arcname)
        info.size = metadata.st_size
        info.mode = mode
        info.mtime = 0
        info.uid = uid
        info.gid = gid
        with os.fdopen(os.dup(source_fd), "rb") as source:
            tar.addfile(info, source)
    finally:
        os.close(source_fd)


@contextmanager
def atomic_tar_output(out: Path):
    """Publish a complete tar atomically, preserving any prior output."""
    out.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{out.name}.mkoverlay-", dir=out.parent
    )
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        with tarfile.open(temporary, "w") as tar:
            yield tar
        os.replace(temporary, out)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def add_empty(tar: tarfile.TarFile, arcname: str, mode: int) -> None:
    arcname = safe_arcname(arcname)
    mode = safe_mode(mode, directory=False)
    info = tarfile.TarInfo(name=arcname)
    info.size = 0
    info.mode = mode
    info.mtime = 0
    tar.addfile(info)


def add_dir(tar: tarfile.TarFile, arcname: str, mode: int, uid: int, gid: int) -> None:
    arcname = safe_arcname(arcname)
    mode = safe_mode(mode, directory=True)
    uid = safe_id(uid, kind="uid")
    gid = safe_id(gid, kind="gid")
    info = tarfile.TarInfo(name=arcname)
    info.type = tarfile.DIRTYPE
    info.mode = mode
    info.mtime = 0
    info.uid = uid
    info.gid = gid
    tar.addfile(info)


def add_symlink(tar: tarfile.TarFile, arcname: str, target: str) -> None:
    arcname = safe_arcname(arcname)
    target = safe_link_target(arcname, target)
    info = tarfile.TarInfo(name=arcname)
    info.type = tarfile.SYMTYPE
    info.linkname = target
    info.mode = 0o777
    info.mtime = 0
    tar.addfile(info)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--dir", action="append", default=[], metavar="ARC[:MODE[:UID:GID]]")
    ap.add_argument("--file", action="append", default=[],
                    metavar="SRC:ARC[:MODE[:UID:GID]]")
    ap.add_argument("--empty", action="append", default=[], metavar="ARC[:MODE]")
    ap.add_argument("--symlink", action="append", default=[], metavar="ARC:TARGET")
    ap.add_argument("--unit", action="append", default=[], metavar="SRC")
    ap.add_argument("--mask", action="append", default=[], metavar="UNIT")
    args = ap.parse_args()

    seen: set[str] = set()

    def claim(path: str) -> str:
        canonical = safe_arcname(path)
        if canonical in seen:
            ap.error(f"duplicate archive destination: {canonical}")
        seen.add(canonical)
        if len(seen) > MAX_OVERLAY_ENTRIES:
            ap.error(f"overlay has more than {MAX_OVERLAY_ENTRIES} entries")
        return canonical

    content_budget = [0]
    with atomic_tar_output(args.out) as tar:
        for spec in args.dir:
            parts = spec.split(":")
            arc = claim(parts[0])
            if len(parts) == 1:
                add_dir(tar, arc, mode=0o755, uid=0, gid=0)
            elif len(parts) == 2:
                add_dir(tar, arc, mode=int(parts[1], 8), uid=0, gid=0)
            elif len(parts) == 4:
                add_dir(tar, arc, mode=int(parts[1], 8),
                        uid=int(parts[2]), gid=int(parts[3]))
            else:
                ap.error(f"--dir {spec!r}: expected ARC[:MODE[:UID:GID]]")

        for spec in args.symlink:
            arc, target = spec.split(":", 1)
            add_symlink(tar, claim(arc), target)

        for src in args.unit:
            name = safe_unit_name(Path(src).name)
            unit_path = claim(f"{SYSTEMD_DIR}/{name}")
            wants_path = claim(f"{WANTS_DIR}/{name}")
            add_file(
                tar,
                Path(src),
                unit_path,
                mode=0o644,
                content_budget=content_budget,
            )
            add_symlink(tar, wants_path, f"/{SYSTEMD_DIR}/{name}")

        for spec in args.file:
            parts = spec.split(":")
            uid = gid = 0
            if len(parts) == 2:
                src, arc, mode = parts[0], parts[1], 0o644
            elif len(parts) == 3:
                src, arc, mode = parts[0], parts[1], int(parts[2], 8)
            elif len(parts) == 5:
                src, arc, mode = parts[0], parts[1], int(parts[2], 8)
                uid, gid = int(parts[3]), int(parts[4])
            else:
                ap.error(f"--file {spec!r}: expected SRC:ARC[:MODE[:UID:GID]]")
            add_file(
                tar,
                Path(src),
                claim(arc),
                mode=mode,
                uid=uid,
                gid=gid,
                content_budget=content_budget,
            )

        for spec in args.empty:
            parts = spec.split(":")
            arc = claim(parts[0])
            if len(parts) == 1:
                add_empty(tar, arc, mode=0o644)
            elif len(parts) == 2:
                add_empty(tar, arc, mode=int(parts[1], 8))
            else:
                ap.error(f"--empty {spec!r}: expected ARC[:MODE]")

        # Symlinks to /dev/null are systemd's canonical "masked" encoding:
        # the unit shows as masked instead of failing to start.
        for unit in args.mask:
            unit = safe_unit_name(unit)
            path = claim(f"{SYSTEMD_DIR}/{unit}")
            add_symlink(tar, path, "/dev/null")

    print(f"mkoverlay: wrote {args.out} ({args.out.stat().st_size} bytes)",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
