#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
"""
Install Rust's upstream component tarballs into one OCI layer tar.

Each static.rust-lang.org tarball (rustc-nightly-<host>.tar.xz and so on)
holds a top directory with a `components` file and one directory per
component, laid out the way the files land under the install prefix.
install.sh copies those directories into place; this does the same into
a layer, under --prefix, without running the script. rustc finds its
sysroot relative to its own binary, so any prefix works.

Every entry is owned by root with mtime 0. Two components may ship the
same path only with the same contents.

Usage: rust_layer.py --out LAYER.tar.gz --prefix usr/local TARBALL.tar.xz...
"""

import argparse
import contextlib
import gzip
import hashlib
import sys
import tarfile
from pathlib import Path, PurePosixPath


CHUNK = 1024 * 1024


@contextlib.contextmanager
def _open_layer(out: Path):
    """A gzipped layer tar whose bytes depend only on what goes in it."""
    with open(out, "wb") as raw, gzip.GzipFile(
        filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=6
    ) as compressed, tarfile.open(
        fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT
    ) as layer:
        yield layer


class LayerError(Exception):
    pass


class _Hashing:
    """A reader that hashes what passes through it."""

    def __init__(self, reader):
        self.reader = reader
        self.digest = hashlib.sha256()

    def read(self, size=-1):
        data = self.reader.read(size)
        self.digest.update(data)
        return data


def _directory(name: str) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.type, info.mode, info.mtime = tarfile.DIRTYPE, 0o755, 0
    return info


def install(tarballs: list[Path], prefix: str, out: Path) -> int:
    written: dict[str, str | None] = {}
    with _open_layer(out) as layer:

        def parents(name: str) -> None:
            missing = []
            parent = PurePosixPath(name).parent
            while str(parent) != "." and str(parent) not in written:
                missing.append(str(parent))
                parent = parent.parent
            for directory in reversed(missing):
                layer.addfile(_directory(directory))
                written[directory] = None

        for tarball in tarballs:
            with tarfile.open(tarball, "r|xz") as archive:
                for member in archive:
                    parts = PurePosixPath(member.name).parts
                    if ".." in parts or PurePosixPath(member.name).is_absolute():
                        raise LayerError(f"{tarball.name}: unsafe path {member.name!r}")
                    # <top>/<component>/<path>; everything else at the top
                    # (install.sh, components, the version stamp) and each
                    # component's manifest.in is installer metadata.
                    if len(parts) < 3 or parts[2:] == ("manifest.in",):
                        continue
                    name = str(PurePosixPath(prefix, *parts[2:]))
                    info = tarfile.TarInfo(name)
                    info.mtime, info.uid, info.gid = 0, 0, 0
                    info.mode = member.mode & 0o755 if member.isdir() or member.mode & 0o111 else 0o644
                    if member.isdir():
                        if name not in written:
                            parents(name)
                            layer.addfile(_directory(name))
                            written[name] = None
                        continue
                    if member.issym():
                        info.type, info.linkname, info.mode = tarfile.SYMTYPE, member.linkname, 0o777
                        digest = "link:" + member.linkname
                        if name in written:
                            if written[name] != digest:
                                raise LayerError(f"{name} differs between components")
                            continue
                        parents(name)
                        layer.addfile(info)
                        written[name] = digest
                        continue
                    if not member.isreg():
                        raise LayerError(f"{tarball.name}: unsupported entry {member.name!r}")
                    reader = archive.extractfile(member)
                    assert reader is not None
                    if name in written:
                        digest = hashlib.sha256()
                        while chunk := reader.read(CHUNK):
                            digest.update(chunk)
                        if written[name] != digest.hexdigest():
                            raise LayerError(f"{name} differs between components")
                        continue
                    parents(name)
                    info.size = member.size
                    hashing = _Hashing(reader)
                    layer.addfile(info, hashing)
                    written[name] = hashing.digest.hexdigest()
    return len(written)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("tarballs", nargs="+", type=Path)
    args = parser.parse_args()
    prefix = args.prefix.strip("/")
    try:
        count = install(args.tarballs, prefix, args.out)
    except (LayerError, OSError, tarfile.TarError) as error:
        print(f"rust_layer: {error}", file=sys.stderr)
        return 1
    print(f"rust_layer: wrote {args.out}: {len(args.tarballs)} tarballs, {count} entries", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
