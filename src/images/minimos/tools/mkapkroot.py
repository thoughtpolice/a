#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
"""
Extract apk v2 package data sections into a rootfs directory.

An .apk is three concatenated gzip streams — signature, control, data.
gzip's multistream mode plus tarfile's ignore_zeros reads all three as
one tar; the signature/control entries all start with "." (.SIGN...,
.PKGINFO, install hooks) and are skipped, leaving only rootfs content.
No apk-tools, no scriptlets, no network: package installation is just
deterministic extraction, in argument order, later packages winning.

Pure stdlib — runs from a plain python3 genrule.

Usage: mkapkroot.py --dest DIR PKG.apk...
"""

import argparse
import gzip
import os
import stat
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath


# These are build-time denial-of-service bounds, not package-size targets.
# Current Wolfi inputs are orders of magnitude smaller, while the ceilings
# leave room for deliberately large development packages.
MAX_ENTRIES = 200_000
MAX_MEMBER_SIZE = 512 * 1024 * 1024
MAX_TOTAL_SIZE = 1024 * 1024 * 1024
MAX_DECOMPRESSED_STREAM_SIZE = 1024 * 1024 * 1024


class UnsafeArchiveError(ValueError):
    """An apk member cannot be represented safely below the scratch root."""


class BoundedReader:
    """Count every decompressed byte consumed by tarfile, including metadata."""

    def __init__(self, stream, limit: int):
        self.stream = stream
        self.limit = limit
        self.consumed = 0

    def read(self, size: int = -1) -> bytes:
        remaining = self.limit - self.consumed
        request = remaining + 1 if size < 0 else min(size, remaining + 1)
        data = self.stream.read(request)
        self.consumed += len(data)
        if self.consumed > self.limit:
            raise UnsafeArchiveError(
                f"apk decompressed stream exceeds {self.limit} bytes"
            )
        return data

    def readinto(self, buffer) -> int:
        data = self.read(len(buffer))
        buffer[:len(data)] = data
        return len(data)


def log(msg: str) -> None:
    print(f"mkapkroot: {msg}", file=sys.stderr)


def member_parts(name: str, *, what: str = "member") -> tuple[str, ...]:
    """Return a canonical, relative POSIX archive path or fail closed."""
    if not name or "\x00" in name:
        raise UnsafeArchiveError(f"{what} has an empty or NUL-containing name")
    path = PurePosixPath(name)
    if path.is_absolute():
        raise UnsafeArchiveError(f"{what} uses an absolute path: {name!r}")
    parts = tuple(part for part in path.parts if part not in ("", "."))
    if not parts or any(part == ".." for part in parts):
        raise UnsafeArchiveError(f"{what} escapes the rootfs: {name!r}")
    return parts


def _beneath(root: Path, path: Path, *, what: str) -> Path:
    """Resolve an existing-parent path and require it to remain below root."""
    root = root.resolve()
    resolved = path.resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise UnsafeArchiveError(f"{what} resolves outside the rootfs: {path}") from error
    return resolved


def _prepare_parent(root: Path, target: Path, *, what: str) -> None:
    # Check before and after mkdir: an earlier package may have installed a
    # symlink in any ancestor. The extraction directory is private to this
    # process, so there is no attacker-controlled rename race between checks.
    _beneath(root, target.parent, what=what)
    current = root
    for part in target.parent.relative_to(root).parts:
        current /= part
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:
            current.mkdir(mode=0o755)
            # mkdir applies the process umask; normalize every implicit parent
            # so identical package contents produce identical layer metadata.
            os.chmod(current, 0o755)
            continue
        if stat.S_ISLNK(mode):
            _beneath(root, current, what=what)
        elif not stat.S_ISDIR(mode):
            raise UnsafeArchiveError(
                f"{what} descends through a non-directory: {current}"
            )
    _beneath(root, target.parent, what=what)


def _validate_symlink(member: str, linkname: str) -> None:
    """Reject links which climb above or ambiguously name the image root."""
    if not linkname or "\x00" in linkname:
        raise UnsafeArchiveError(f"symlink {member!r} has an invalid target")
    if linkname.startswith("//"):
        raise UnsafeArchiveError(
            f"symlink {member!r} has an ambiguous target: {linkname!r}"
        )
    link = PurePosixPath(linkname)
    depth = 0 if link.is_absolute() else len(member_parts(member)[:-1])
    for part in link.parts:
        if part in ("", ".", "/"):
            continue
        if part.startswith("/"):
            raise UnsafeArchiveError(
                f"symlink {member!r} has an absolute path component: {linkname!r}"
            )
        if part == "..":
            if depth == 0:
                raise UnsafeArchiveError(
                    f"symlink {member!r} escapes the image root: {linkname!r}"
                )
            depth -= 1
        else:
            depth += 1


def _remove_non_directory(target: Path) -> None:
    try:
        mode = target.lstat().st_mode
    except FileNotFoundError:
        return
    if stat.S_ISDIR(mode):
        raise UnsafeArchiveError(f"cannot replace non-empty directory: {target}")
    target.unlink()


def _stream_regular(tar: tarfile.TarFile, member: tarfile.TarInfo,
                    target: Path) -> None:
    source = tar.extractfile(member)
    if source is None:
        raise UnsafeArchiveError(f"regular member has no data: {member.name!r}")
    fd, temporary = tempfile.mkstemp(prefix=".mkapkroot-", dir=target.parent)
    try:
        with source, os.fdopen(fd, "wb") as output:
            remaining = member.size
            while remaining:
                chunk = source.read(min(1 << 20, remaining))
                if not chunk:
                    raise UnsafeArchiveError(f"truncated member: {member.name!r}")
                output.write(chunk)
                remaining -= len(chunk)
        os.chmod(temporary, member.mode & 0o777, follow_symlinks=False)
        os.replace(temporary, target)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def extract_apk(apk: Path, dest: Path) -> int:
    n = 0
    total_size = 0
    root = dest.resolve()
    root.mkdir(parents=True, exist_ok=True)
    with gzip.open(apk, "rb") as gz:
        bounded = BoundedReader(gz, MAX_DECOMPRESSED_STREAM_SIZE)
        with tarfile.open(fileobj=bounded, mode="r|", ignore_zeros=True) as tar:
            for m in tar:
                name = m.name
                n += 1
                if n > MAX_ENTRIES:
                    raise UnsafeArchiveError(f"{apk}: too many archive entries")
                if m.size < 0 or m.size > MAX_MEMBER_SIZE:
                    raise UnsafeArchiveError(
                        f"{apk}: member {name!r} is too large ({m.size} bytes)"
                    )
                total_size += m.size
                if total_size > MAX_TOTAL_SIZE:
                    raise UnsafeArchiveError(f"{apk}: expanded data exceeds size limit")
                if name.startswith("."):
                    continue

                parts = member_parts(name)
                target = root.joinpath(*parts)
                _prepare_parent(root, target, what=f"member {name!r}")
                if m.isdir():
                    # e.g. baselayout's /lib -> usr/lib may already exist
                    # when a later package carries a plain "lib/" entry.
                    if target.is_symlink():
                        _beneath(root, target, what=f"directory {name!r}")
                        continue
                    if target.exists() and not target.is_dir():
                        _remove_non_directory(target)
                    target.mkdir(parents=True, exist_ok=True)
                    os.chmod(target, m.mode & 0o1777)
                elif m.issym():
                    _validate_symlink(name, m.linkname)
                    _remove_non_directory(target)
                    os.symlink(m.linkname, target)
                elif m.isreg():
                    try:
                        if stat.S_ISDIR(target.lstat().st_mode):
                            raise UnsafeArchiveError(
                                f"cannot replace directory with file: {target}"
                            )
                    except FileNotFoundError:
                        pass
                    _stream_regular(tar, m, target)
                elif m.islnk():
                    # hardlink within the same package (e.g. lastb -> last)
                    source_parts = member_parts(m.linkname, what="hardlink target")
                    source = root.joinpath(*source_parts)
                    source = _beneath(root, source, what=f"hardlink target {m.linkname!r}")
                    try:
                        source_mode = source.lstat().st_mode
                    except FileNotFoundError as error:
                        raise UnsafeArchiveError(
                            f"hardlink target does not exist yet: {m.linkname!r}"
                        ) from error
                    if not stat.S_ISREG(source_mode):
                        raise UnsafeArchiveError(
                            f"hardlink target is not a regular file: {m.linkname!r}"
                        )
                    # Tar hardlinks normally advertise size zero, but cull
                    # emits every pathname as an independent regular member.
                    # Charge the referenced bytes now so a tiny apk cannot
                    # amplify one inode into an unbounded downstream layer.
                    linked_size = source.stat().st_size
                    if linked_size < 0 or linked_size > MAX_MEMBER_SIZE:
                        raise UnsafeArchiveError(
                            f"hardlink target is too large: {m.linkname!r}"
                        )
                    total_size += linked_size
                    if total_size > MAX_TOTAL_SIZE:
                        raise UnsafeArchiveError(
                            f"{apk}: expanded hardlink data exceeds size limit"
                        )
                    _remove_non_directory(target)
                    os.link(source, target, follow_symlinks=False)
                else:
                    raise UnsafeArchiveError(
                        f"unsupported tar entry {name!r} with type {m.type!r}"
                    )
    return n


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest", required=True, type=Path)
    parser.add_argument("apks", nargs="+", type=Path)
    args = parser.parse_args()

    args.dest.mkdir(parents=True, exist_ok=True)
    for apk in args.apks:
        n = extract_apk(apk, args.dest)
        log(f"{apk.name}: {n} entries")
    return 0


if __name__ == "__main__":
    sys.exit(main())
