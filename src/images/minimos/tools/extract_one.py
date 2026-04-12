#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
"""Extract a single member of a tar archive to a path.

Usage: extract_one.py ARCHIVE MEMBER OUT

Streams the member's bytes to OUT; ownership and mode are left to
whatever consumes the file (mkoverlay.py stamps its own), so this
stays safe against hostile archive metadata.
"""

import gzip
import os
import sys
import tarfile
import tempfile
from pathlib import Path


MAX_EXTRACTED_SIZE = 512 * 1024 * 1024
MAX_ARCHIVE_STREAM_SIZE = 1024 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 200_000


class ArchiveLimitError(ValueError):
    pass


class BoundedReader:
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
            raise ArchiveLimitError(
                f"decompressed archive exceeds {self.limit} bytes"
            )
        return data

    def readinto(self, buffer) -> int:
        data = self.read(len(buffer))
        buffer[:len(data)] = data
        return len(data)


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    archive, member, out = sys.argv[1:4]
    output = Path(out)
    temporary: str | None = None
    found = 0
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        with open(archive, "rb") as raw:
            magic = raw.read(2)
            raw.seek(0)
            stream = gzip.GzipFile(fileobj=raw) if magic == b"\x1f\x8b" else raw
            bounded = BoundedReader(stream, MAX_ARCHIVE_STREAM_SIZE)
            with tarfile.open(fileobj=bounded, mode="r|") as tar:
                for count, selected in enumerate(tar, start=1):
                    if count > MAX_ARCHIVE_ENTRIES:
                        raise ArchiveLimitError("archive has too many entries")
                    if selected.name != member:
                        continue
                    found += 1
                    if found > 1:
                        raise ArchiveLimitError(
                            f"expected exactly one {member!r}; found multiple"
                        )
                    if (
                        not selected.isreg()
                        or selected.size < 0
                        or selected.size > MAX_EXTRACTED_SIZE
                    ):
                        raise ArchiveLimitError(
                            f"{member!r} is not a bounded regular file"
                        )
                    src = tar.extractfile(selected)
                    if src is None:
                        raise ArchiveLimitError(f"{member!r} has no file data")
                    fd, temporary = tempfile.mkstemp(
                        prefix=".extract-one-", dir=output.parent
                    )
                    with src, os.fdopen(fd, "wb") as dst:
                        remaining = selected.size
                        while remaining:
                            chunk = src.read(min(1 << 20, remaining))
                            if not chunk:
                                raise ArchiveLimitError(
                                    f"truncated data for {member!r}"
                                )
                            dst.write(chunk)
                            remaining -= len(chunk)
        if found != 1 or temporary is None:
            raise ArchiveLimitError(
                f"expected exactly one {member!r} in {archive}; found {found}"
            )
        os.replace(temporary, output)
        temporary = None
        return 0
    except (ArchiveLimitError, OSError, tarfile.TarError, EOFError) as error:
        print(f"extract_one: {error}", file=sys.stderr)
        return 1
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    sys.exit(main())
