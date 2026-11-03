#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
"""
Install Wolfi .apk packages straight into one OCI layer tar.

minimos extracts packages into a directory and culls the result. The
devcontainer keeps everything, so this tool streams each package's data
section into the layer without touching the filesystem, which keeps
the owners and modes the packages declare whoever runs the build.

Packages install in argument order, which the resolver writes with each
package after its dependencies. Two packages may ship the same file only
with the same contents, unless one declares that it replaces the
other; anything else is an error, since apk would refuse it too. Every directory is written once, before any file, and
paths resolve through the symlinks packages ship, as apk installs
them. Every entry gets mtime 0 and no user or group names, so the layer
depends only on its inputs. Hardlinks become relative symlinks, which
the image builder accepts. Setuid and setgid bits are dropped, as the
image builder refuses them, and so are paths named by --exclude.

Usage: apk_layer.py --out LAYER.tar.gz [--exclude PATH]... [--chmod DIR:MODE]... PKG.apk...
"""

import argparse
import fnmatch
import contextlib
import gzip
import hashlib
import posixpath
import stat
import sys
import tarfile
from dataclasses import dataclass
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


def log(message: str) -> None:
    print(f"apk_layer: {message}", file=sys.stderr)


class LayerError(Exception):
    pass


@dataclass
class Entry:
    package: str
    info: tarfile.TarInfo
    digest: str | None


def _members(apk: Path, control: dict[str, list[str]] | None = None):
    """The data members of an apk, with a reader for each regular file.

    With `control`, .PKGINFO's fields are collected into it on the way.
    """
    with gzip.open(apk, "rb") as stream:
        with tarfile.open(fileobj=stream, mode="r|", ignore_zeros=True) as archive:
            for member in archive:
                name = member.name.removeprefix("./")
                if name == ".PKGINFO" and control is not None:
                    reader = archive.extractfile(member)
                    assert reader is not None
                    for line in reader.read().decode("utf-8").splitlines():
                        key, separator, value = line.partition(" = ")
                        if separator and not key.startswith("#"):
                            control.setdefault(key, []).append(value)
                    continue
                if not name or name.startswith("."):
                    continue
                parts = PurePosixPath(name).parts
                if PurePosixPath(name).is_absolute() or ".." in parts:
                    raise LayerError(f"{apk.name}: unsafe path {member.name!r}")
                yield name.rstrip("/"), member, archive


def _digest(archive: tarfile.TarFile, member: tarfile.TarInfo) -> str:
    reader = archive.extractfile(member)
    assert reader is not None
    digest = hashlib.sha256()
    while chunk := reader.read(CHUNK):
        digest.update(chunk)
    return digest.hexdigest()


def _excluded(name: str, excludes: list[str]) -> bool:
    """Whether an exclude names `name` or a directory above it.

    Each segment of an exclude is an fnmatch pattern that matches one
    segment of the path, so usr/lib/*.a matches nothing in usr/lib/x/.
    """
    parts = name.split("/")
    for pattern in excludes:
        segments = pattern.split("/")
        if len(segments) <= len(parts) and all(
            fnmatch.fnmatchcase(part, segment) for part, segment in zip(parts, segments)
        ):
            return True
    return False


def _kind(info: tarfile.TarInfo) -> str:
    if info.isdir():
        return "directory"
    if info.issym():
        return "symlink"
    if info.islnk():
        return "hardlink"
    if info.isreg():
        return "file"
    raise LayerError(f"unsupported entry type for {info.name!r}")


def _resolve(name: str, links: dict[str, str]) -> str:
    """`name` with every symlinked parent directory followed, as apk would."""
    for _ in range(40):
        parts = PurePosixPath(name).parts
        for depth in range(1, len(parts) + 1):
            prefix = "/".join(parts[:depth])
            if prefix in links:
                target = links[prefix]
                base = PurePosixPath() if target.startswith("/") else PurePosixPath(prefix).parent
                resolved = PurePosixPath(base, target.lstrip("/"), *parts[depth:])
                normal = []
                for part in resolved.parts:
                    if part == "..":
                        if not normal:
                            raise LayerError(f"{name} resolves outside the root")
                        normal.pop()
                    elif part != ".":
                        normal.append(part)
                name = "/".join(normal)
                break
        else:
            return name
    raise LayerError(f"too many symlinks resolving {name}")


def plan(apks: list[Path], excludes: list[str]) -> tuple[dict[str, Entry], dict[tuple[str, str], str]]:
    """Read every package once and decide what the layer holds.

    Returns the entries by installed path, and the installed path of each
    (package, path in package) pair.
    """
    raw: list[tuple[str, str, tarfile.TarInfo, str | None]] = []
    matched: set[str] = set()
    # Each package's name and the packages it may overwrite files of, as
    # its .PKGINFO declares (openssl-4.0-libcrypto replaces libcrypto3).
    pkgname: dict[str, str] = {}
    replaces: dict[str, set[str]] = {}
    for apk in apks:
        control: dict[str, list[str]] = {}
        for name, member, archive in _members(apk, control):
            hits = [path for path in excludes if _excluded(name, [path])]
            if hits:
                matched.update(hits)
                continue
            kind = _kind(member)
            raw.append((apk.name, name, member, _digest(archive, member) if kind == "file" else None))
        pkgname[apk.name] = control.get("pkgname", [apk.stem])[0]
        replaces[apk.name] = set(control.get("replaces", []))

    # An exclude that matches nothing is stale, most likely because the
    # package moved the file.
    unused = [path for path in excludes if path not in matched]
    if unused:
        raise LayerError("--exclude matches nothing: " + ", ".join(unused))

    # Wolfi merges /bin, /sbin, /lib and /usr/lib64 through symlinks in
    # wolfi-baselayout, but some packages still ship a directory there, or
    # files beneath it. apk keeps the link and installs through it, so
    # paths are resolved through every symlink a package ships.
    links = {name: member.linkname for _, name, member, _ in raw if member.issym()}
    entries: dict[str, Entry] = {}
    installed: dict[tuple[str, str], str] = {}
    for package, name, member, digest in raw:
        parent = _resolve(str(PurePosixPath(name).parent), links) if "/" in name else ""
        path = str(PurePosixPath(parent, PurePosixPath(name).name)) if parent else name
        kind = _kind(member)
        if kind == "directory" and path in links:
            continue
        previous = entries.get(path)
        if previous is not None:
            if kind == "directory" and _kind(previous.info) == "directory":
                continue
            same = (
                _kind(previous.info) == kind
                and previous.digest == digest
                and previous.info.linkname == member.linkname
            )
            if same or pkgname[package] in replaces[previous.package]:
                continue
            if pkgname[previous.package] not in replaces[package]:
                raise LayerError(f"{path} differs between {previous.package} and {package}")
            if kind == "directory" or _kind(previous.info) == "directory":
                raise LayerError(f"{package} replaces {path} with a different kind of entry")
        entries[path] = Entry(package, member, digest)
        installed[(package, name)] = path
    return entries, installed


def _clean(info: tarfile.TarInfo, name: str) -> tarfile.TarInfo:
    out = tarfile.TarInfo(name)
    out.type = info.type
    out.mode = info.mode & ~(stat.S_ISUID | stat.S_ISGID)
    out.uid, out.gid = info.uid, info.gid
    out.uname = out.gname = ""
    out.mtime = 0
    out.linkname = info.linkname.removeprefix("./") if info.islnk() else info.linkname
    out.size = info.size if info.isreg() else 0
    return out


def write(apks: list[Path], entries: dict[str, Entry],
          installed: dict[tuple[str, str], str], out: Path,
          modes: dict[str, int]) -> None:
    dropped_bits = sorted(
        name for name, entry in entries.items()
        if entry.info.mode & (stat.S_ISUID | stat.S_ISGID)
    )
    for name in dropped_bits:
        log(f"dropping setuid/setgid bits on {name}")

    with _open_layer(out) as layer:
        # Directories first, parents before children, including parents no
        # package declares.
        directories = {name for name, entry in entries.items() if entry.info.isdir()}
        implied = set()
        for name in entries:
            parent = PurePosixPath(name).parent
            while str(parent) != "." and str(parent) not in directories:
                implied.add(str(parent))
                parent = parent.parent
        for name in sorted(directories | implied):
            if name in entries:
                info = _clean(entries[name].info, name)
                info.mode = modes.get(name, info.mode)
                layer.addfile(info)
            else:
                info = tarfile.TarInfo(name)
                info.type, info.mode, info.mtime = tarfile.DIRTYPE, 0o755, 0
                layer.addfile(info)

        # Then each package's own files, in package order, so a hardlink
        # always follows its target.
        for apk in apks:
            for name, member, archive in _members(apk):
                path = installed.get((apk.name, name))
                if path is None or entries[path].package != apk.name or entries[path].info.isdir():
                    continue
                info = _clean(member, path)
                if member.isreg():
                    reader = archive.extractfile(member)
                    layer.addfile(info, reader)
                else:
                    if member.islnk():
                        target = installed.get((apk.name, info.linkname))
                        if target is None:
                            raise LayerError(f"{apk.name}: hardlink {name} -> {info.linkname} leaves the package")
                        # The image builder takes no hardlinks, and copies
                        # would add hundreds of megabytes (git's builtins
                        # are all one binary), so link by name instead.
                        info.type = tarfile.SYMTYPE
                        info.mode = 0o777
                        info.linkname = posixpath.relpath(target, posixpath.dirname(path))
                    layer.addfile(info)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--exclude", action="append", default=[],
                        help="a path to leave out, with everything beneath it; "
                        "each segment may be an fnmatch pattern")
    parser.add_argument("--chmod", action="append", default=[], metavar="DIR:MODE",
                        help="give a directory the packages declare this octal mode")
    parser.add_argument("apks", nargs="+", type=Path)
    args = parser.parse_args()
    excludes = [path.strip("/") for path in args.exclude]
    modes = {}
    for spec in args.chmod:
        path, _, mode = spec.rpartition(":")
        modes[path.strip("/")] = int(mode, 8)
    try:
        entries, installed = plan(args.apks, excludes)
        missing = [path for path in modes if path not in entries or not entries[path].info.isdir()]
        if missing:
            raise LayerError("--chmod names no packaged directory: " + ", ".join(missing))
        write(args.apks, entries, installed, args.out, modes)
    except (LayerError, OSError, tarfile.TarError) as error:
        log(str(error))
        return 1
    log(f"wrote {args.out}: {len(args.apks)} packages, {len(entries)} entries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
