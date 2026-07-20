# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

import sys
import tarfile
from pathlib import Path


def main(first_path, second_path, source_path):
    first = Path(first_path).read_bytes()
    second = Path(second_path).read_bytes()
    assert first == second, "equivalent inputs produced different archives"

    assert first[3] & 0x08 == 0, "gzip header contains an output filename"
    assert first[4:8] == b"\0\0\0\0", "gzip header contains a timestamp"

    with tarfile.open(first_path, "r:gz") as archive:
        members = archive.getmembers()
        assert len(members) == 1
        member = members[0]
        assert member.name == "usr/local/bin/test_with_prefix.txt"
        assert member.isfile(), "source artifact was archived as a symlink"
        assert member.uid == 0
        assert member.gid == 0
        assert member.uname == ""
        assert member.gname == ""
        assert member.mtime == 0
        assert member.mode == 0o644

        contents = archive.extractfile(member)
        assert contents is not None
        assert contents.read() == Path(source_path).read_bytes()


if __name__ == "__main__":
    main(*sys.argv[1:])
