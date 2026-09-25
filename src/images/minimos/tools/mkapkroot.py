#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
"""
Extract apk v2 package data sections into a rootfs directory.

An .apk is three concatenated gzip streams holding the signature, the
control data and the package contents. gzip's multistream mode and
tarfile's ignore_zeros read all three as one tar. The signature and
control entries all start with "." (.SIGN..., .PKGINFO, install hooks),
so skipping those leaves only rootfs content. Installing a package is
plain extraction in argument order, with later packages winning. No
apk-tools, scriptlets or network are involved, and setuid and setgid
bits are dropped on the way.

Usage: mkapkroot.py --dest DIR PKG.apk...
"""

import argparse
import gzip
import os
import stat
import sys
import tarfile
from pathlib import Path

from common import (
    BoundedReader,
    UnsafeInputError,
    atomic_output,
    copy_exact,
    link_parts,
    member_parts,
)


# These are build-time denial-of-service bounds, not package-size targets.
# Current Wolfi inputs are orders of magnitude smaller, while the ceilings
# leave room for deliberately large development packages.
MAX_ENTRIES = 200_000
MAX_MEMBER_SIZE = 512 * 1024 * 1024
MAX_TOTAL_SIZE = 1024 * 1024 * 1024
MAX_DECOMPRESSED_STREAM_SIZE = 1024 * 1024 * 1024


def log(msg: str) -> None:
    print(f"mkapkroot: {msg}", file=sys.stderr)


def _beneath(root: Path, path: Path, *, what: str) -> Path:
    """Resolve `path` with host semantics and require it to stay below `root`."""
    resolved = path.resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise UnsafeInputError(f"{what} resolves outside the rootfs: {path}") from error
    return resolved


def _prepare_parent(root: Path, target: Path, verified: set[Path], *, what: str) -> None:
    """Create `target`'s parents, proving each one stays below `root`.

    An earlier package may have put a symlink anywhere in the chain
    (baselayout's lib -> usr/lib is the everyday case), and a later package
    may replace that link, so a link is resolved every time it is crossed.
    A real directory reached without crossing a link can never be replaced
    (only non-directories are ever removed), so once verified it stays
    verified for the rest of the extraction. The extraction directory is
    private to this process, so there is no rename race between checks.
    """
    current = root
    through_link = False
    for part in target.parent.relative_to(root).parts:
        current = current / part
        if current in verified:
            continue
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:
            current.mkdir(mode=0o755)
            # mkdir applies the process umask; normalize every implicit parent
            # so identical package contents produce identical layer metadata.
            os.chmod(current, 0o755)
            if not through_link:
                verified.add(current)
            continue
        if stat.S_ISLNK(mode):
            _beneath(root, current, what=what)
            through_link = True
        elif stat.S_ISDIR(mode):
            if not through_link:
                verified.add(current)
        else:
            raise UnsafeInputError(
                f"{what} descends through a non-directory: {current}"
            )
    if through_link:
        _beneath(root, target.parent, what=what)


def _remove_non_directory(target: Path) -> None:
    try:
        mode = target.lstat().st_mode
    except FileNotFoundError:
        return
    if stat.S_ISDIR(mode):
        raise UnsafeInputError(f"cannot replace non-empty directory: {target}")
    target.unlink()


def _stream_regular(tar: tarfile.TarFile, member: tarfile.TarInfo,
                    target: Path) -> None:
    source = tar.extractfile(member)
    if source is None:
        raise UnsafeInputError(f"regular member has no data: {member.name!r}")
    with source, atomic_output(target, prefix=".mkapkroot-") as temporary:
        with open(temporary, "wb") as output:
            copy_exact(source, output, member.size, what=f"member {member.name!r}")
        os.chmod(temporary, member.mode & 0o777)


def extract_apk(apk: Path, dest: Path) -> int:
    n = 0
    total_size = 0
    root = dest.resolve()
    root.mkdir(parents=True, exist_ok=True)
    verified: set[Path] = set()
    with gzip.open(apk, "rb") as gz:
        bounded = BoundedReader(gz, MAX_DECOMPRESSED_STREAM_SIZE)
        with tarfile.open(fileobj=bounded, mode="r|", ignore_zeros=True) as tar:
            for m in tar:
                name = m.name
                n += 1
                if n > MAX_ENTRIES:
                    raise UnsafeInputError(f"{apk}: too many archive entries")
                if m.size < 0 or m.size > MAX_MEMBER_SIZE:
                    raise UnsafeInputError(
                        f"{apk}: member {name!r} is too large ({m.size} bytes)"
                    )
                total_size += m.size
                if total_size > MAX_TOTAL_SIZE:
                    raise UnsafeInputError(f"{apk}: expanded data exceeds size limit")
                if name.startswith("."):
                    continue

                parts = member_parts(name)
                target = root.joinpath(*parts)
                what = f"member {name!r}"
                _prepare_parent(root, target, verified, what=what)
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
                    link_parts(list(parts[:-1]), m.linkname, what=f"symlink {name!r}")
                    _remove_non_directory(target)
                    os.symlink(m.linkname, target)
                elif m.isreg():
                    try:
                        if stat.S_ISDIR(target.lstat().st_mode):
                            raise UnsafeInputError(
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
                        raise UnsafeInputError(
                            f"hardlink target does not exist yet: {m.linkname!r}"
                        ) from error
                    if not stat.S_ISREG(source_mode):
                        raise UnsafeInputError(
                            f"hardlink target is not a regular file: {m.linkname!r}"
                        )
                    # Tar hardlinks normally advertise size zero, but cull
                    # emits every pathname as an independent regular member.
                    # Charge the referenced bytes now so a tiny apk cannot
                    # amplify one inode into an unbounded downstream layer.
                    linked_size = source.stat().st_size
                    if linked_size < 0 or linked_size > MAX_MEMBER_SIZE:
                        raise UnsafeInputError(
                            f"hardlink target is too large: {m.linkname!r}"
                        )
                    total_size += linked_size
                    if total_size > MAX_TOTAL_SIZE:
                        raise UnsafeInputError(
                            f"{apk}: expanded hardlink data exceeds size limit"
                        )
                    _remove_non_directory(target)
                    os.link(source, target, follow_symlinks=False)
                else:
                    raise UnsafeInputError(
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
