#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
"""
Install a release tarball into one OCI layer tar, under a prefix.

Release builds such as Lean's unpack into a single top directory named
after the release. This drops that directory and writes everything
under it to --prefix, so the install path doesn't change with the
version. The tarball may be gzip, xz or zstd compressed.

Every entry is owned by root with mtime 0. Files keep only their
execute bits, as 0755 or 0644. Hardlinks, devices and symlinks that
point outside the prefix are errors.

--exclude leaves out a path below the top directory and everything
under it. Each of its segments is an fnmatch pattern for one segment of
the path, as in apk_layer.py, and an exclude that matches nothing is an
error, since it is most likely stale.

Usage: archive_layer.py --out LAYER.tar.gz --prefix opt/lean
                        [--exclude PATH]... TARBALL
"""

import argparse
import contextlib
import fnmatch
import gzip
import posixpath
import sys
import tarfile
from compression import zstd
from pathlib import Path, PurePosixPath


@contextlib.contextmanager
def _open_layer(out: Path):
    """A gzipped layer tar whose bytes depend only on what goes in it."""
    with open(out, "wb") as raw, gzip.GzipFile(
        filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=6
    ) as compressed, tarfile.open(
        fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT
    ) as layer:
        yield layer


@contextlib.contextmanager
def _open_archive(path: Path):
    """A streaming reader for a compressed tarball."""
    if path.name.endswith((".tar.zst", ".tzst")):
        with zstd.open(path, "rb") as raw, tarfile.open(fileobj=raw, mode="r|") as archive:
            yield archive
    else:
        with tarfile.open(path, "r|*") as archive:
            yield archive


class LayerError(Exception):
    pass


def _directory(name: str) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.type, info.mode, info.mtime = tarfile.DIRTYPE, 0o755, 0
    return info


def _matches(parts: tuple[str, ...], pattern: str) -> bool:
    """Whether the exclude `pattern` names the path `parts` or a directory above it."""
    segments = pattern.split("/")
    return len(segments) <= len(parts) and all(
        fnmatch.fnmatchcase(part, segment) for part, segment in zip(parts, segments)
    )


def install(tarball: Path, prefix: str, excludes: list[str], out: Path) -> int:
    written: set[str] = set()
    matched: set[str] = set()
    top: str | None = None
    with _open_layer(out) as layer, _open_archive(tarball) as archive:

        def parents(name: str) -> None:
            missing = []
            parent = PurePosixPath(name).parent
            while str(parent) != "." and str(parent) not in written:
                missing.append(str(parent))
                parent = parent.parent
            for directory in reversed(missing):
                layer.addfile(_directory(directory))
                written.add(directory)

        for member in archive:
            path = PurePosixPath(member.name)
            if ".." in path.parts or path.is_absolute():
                raise LayerError(f"unsafe path {member.name!r}")
            if top is None:
                top = path.parts[0]
            if path.parts[0] != top:
                raise LayerError(f"{member.name!r} is outside the top directory {top!r}")
            if len(path.parts) == 1:
                continue
            relative = PurePosixPath(*path.parts[1:])
            hits = [pattern for pattern in excludes if _matches(relative.parts, pattern)]
            if hits:
                matched.update(hits)
                continue
            name = str(PurePosixPath(prefix, relative))
            if name in written:
                raise LayerError(f"{member.name!r} appears twice")
            parents(name)
            if member.isdir():
                layer.addfile(_directory(name))
                written.add(name)
                continue
            info = tarfile.TarInfo(name)
            info.mtime, info.uid, info.gid = 0, 0, 0
            if member.issym():
                target = posixpath.normpath(posixpath.join(str(relative.parent), member.linkname))
                if posixpath.isabs(member.linkname) or target == ".." or target.startswith("../"):
                    raise LayerError(f"{member.name!r} links outside the prefix: {member.linkname!r}")
                info.type, info.linkname, info.mode = tarfile.SYMTYPE, member.linkname, 0o777
                layer.addfile(info)
            elif member.isreg():
                info.size = member.size
                info.mode = 0o755 if member.mode & 0o111 else 0o644
                layer.addfile(info, archive.extractfile(member))
            else:
                raise LayerError(f"unsupported entry {member.name!r}")
            written.add(name)
    if top is None:
        raise LayerError(f"{tarball.name} is empty")
    unused = [pattern for pattern in excludes if pattern not in matched]
    if unused:
        raise LayerError("--exclude matches nothing: " + ", ".join(unused))
    return len(written)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--exclude", action="append", default=[],
                        help="a path below the top directory to leave out; "
                        "each segment may be an fnmatch pattern")
    parser.add_argument("tarball", type=Path)
    args = parser.parse_args()
    try:
        excludes = [path.strip("/") for path in args.exclude]
        count = install(args.tarball, args.prefix.strip("/"), excludes, args.out)
    except (LayerError, OSError, tarfile.TarError, zstd.ZstdError) as error:
        print(f"archive_layer: {args.tarball.name}: {error}", file=sys.stderr)
        return 1
    print(f"archive_layer: wrote {args.out}: {count} entries", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
