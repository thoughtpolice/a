# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
"""What the minimos image tools share for handling untrusted archive input.

Every tool in this directory reads archives or trees it did not produce
(Wolfi packages, layer tars, a scratch rootfs) and must never let one of
them name a build-host path, escape the image root, or expand without
bound. The checks that enforce that live here once; the tools import
them rather than each carrying a copy that could drift.
"""

from contextlib import contextmanager
import os
import tempfile
from pathlib import Path, PurePosixPath


class UnsafeInputError(ValueError):
    """Input that would resolve with build-host semantics or exceed a bound."""


class BoundedReader:
    """Count every byte handed to the consumer and stop at `limit`.

    Sits between a (possibly decompressing) stream and tarfile so that
    skipped bodies, PAX records, long-name records and padding all pass
    through the same budget. With `digest` set, every byte returned also
    feeds that hash, so one pass yields both the parse and the stream's
    checksum.
    """

    def __init__(self, stream, limit: int, *, digest=None):
        self.stream = stream
        self.limit = limit
        self.consumed = 0
        self.digest = digest

    def read(self, size: int = -1) -> bytes:
        remaining = self.limit - self.consumed
        request = remaining + 1 if size < 0 else min(size, remaining + 1)
        data = self.stream.read(request)
        self.consumed += len(data)
        if self.consumed > self.limit:
            raise UnsafeInputError(f"decompressed stream exceeds {self.limit} bytes")
        if self.digest is not None:
            self.digest.update(data)
        return data


def member_parts(name: str, *, what: str = "member") -> tuple[str, ...]:
    """Split an archive member name into relative, root-bound components.

    Tolerates the `./` and doubled-slash spellings tar writers produce;
    refuses absolute names and any `..`.
    """
    if not name or "\x00" in name:
        raise UnsafeInputError(f"{what} has an empty or NUL-containing name")
    path = PurePosixPath(name)
    if path.is_absolute():
        raise UnsafeInputError(f"{what} uses an absolute path: {name!r}")
    parts = tuple(part for part in path.parts if part not in ("", "."))
    if not parts or any(part == ".." for part in parts):
        raise UnsafeInputError(f"{what} escapes the image root: {name!r}")
    return parts


def canonical_name(name: str, *, what: str = "archive path") -> str:
    """Require one spelling of a path relative to the image root.

    Stricter than member_parts: the name has to already be in the form
    the tools write, so two spellings of one destination cannot slip past
    a duplicate check.
    """
    parts = member_parts(name, what=what)
    canonical = "/".join(parts)
    if canonical != name.rstrip("/"):
        raise UnsafeInputError(f"{what} is not canonical: {name!r}")
    return canonical


def link_parts(parent: list[str], target: str, *, what: str = "symlink") -> list[str]:
    """Interpret a symlink target as though the image root were `/`.

    `parent` is the component list of the link's own directory. Returns
    the components the target names, and refuses any target that would
    climb above the root or that POSIX leaves implementation-defined
    (a leading `//`).
    """
    if not target or "\x00" in target:
        raise UnsafeInputError(f"{what} has an empty or NUL-containing target")
    if target.startswith("//"):
        raise UnsafeInputError(f"{what} has an ambiguous double-slash target: {target!r}")
    output = [] if target.startswith("/") else list(parent)
    for part in PurePosixPath(target).parts:
        if part in ("", ".", "/"):
            continue
        if part.startswith("/"):
            raise UnsafeInputError(f"{what} has an absolute path component: {target!r}")
        if part == "..":
            if not output:
                raise UnsafeInputError(f"{what} escapes the image root: {target!r}")
            output.pop()
        else:
            output.append(part)
    return output


def copy_exact(source, sink, size: int, *, what: str, digest=None) -> None:
    """Copy exactly `size` bytes, failing if the source ends early."""
    remaining = size
    while remaining:
        chunk = source.read(min(1 << 20, remaining))
        if not chunk:
            raise UnsafeInputError(f"{what} ended before its declared {size} bytes")
        if digest is not None:
            digest.update(chunk)
        sink.write(chunk)
        remaining -= len(chunk)


@contextmanager
def atomic_output(target: Path, *, prefix: str):
    """Yield a private path beside `target`; publish it on success, else discard it.

    A prior `target` survives a failed run untouched, so a broken build
    never leaves a half-written artifact behind.
    """
    fd, name = tempfile.mkstemp(prefix=prefix, dir=target.parent)
    os.close(fd)
    temporary = Path(name)
    try:
        yield temporary
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
