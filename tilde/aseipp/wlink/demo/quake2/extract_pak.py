#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
"""Take the game data out of the Quake II 3.14 demo installer.

The installer is a self-extracting zip holding pak0.pak plus the player
models as loose files next to it. The engine reads pak files only, so the
loose files are appended to a copy of the pak. Those contents may only be
redistributed as the unmodified installer, so this runs at build time and the
outputs stay out of shared caches.
"""

import hashlib
import pathlib
import struct
import sys
import zipfile

PAK_SIZE = 49_951_322
PAK_MD5 = "27d77240466ec4f3253256832b54db8a"
DATA_PREFIX = "install/data/baseq2/"
HEADER = struct.Struct("<4sii")
ENTRY = struct.Struct("<56sii")


def entries(pak: bytes) -> list[tuple[str, bytes]]:
    ident, offset, length = HEADER.unpack_from(pak, 0)
    if ident != b"PACK" or length % ENTRY.size or offset + length > len(pak):
        raise SystemExit("pak0.pak: bad directory")
    result = []
    for position in range(offset, offset + length, ENTRY.size):
        name, start, size = ENTRY.unpack_from(pak, position)
        result.append((name.split(b"\0", 1)[0].decode(), pak[start : start + size]))
    return result


def pack(files: list[tuple[str, bytes]]) -> bytes:
    body = bytearray()
    directory = bytearray()
    for name, data in files:
        encoded = name.encode()
        if len(encoded) > 55:
            raise SystemExit(f"{name}: pak names hold at most 55 bytes")
        directory += ENTRY.pack(encoded, HEADER.size + len(body), len(data))
        body += data
    return HEADER.pack(b"PACK", HEADER.size + len(body), len(directory)) + body + directory


def main() -> None:
    installer, out_dir = sys.argv[1], pathlib.Path(sys.argv[2])
    pak = licence = None
    loose = []
    with zipfile.ZipFile(installer) as archive:
        for name in archive.namelist():
            lowered = name.lower().replace("\\", "/")
            if lowered.endswith("/"):
                continue
            if lowered == DATA_PREFIX + "pak0.pak":
                pak = archive.read(name)
            elif lowered == "install/data/docs/license.txt":
                licence = archive.read(name)
            elif lowered.startswith(DATA_PREFIX + "players/"):
                loose.append((lowered[len(DATA_PREFIX) :], archive.read(name)))
    if pak is None or licence is None:
        raise SystemExit(f"{installer}: not the Quake II 3.14 demo installer")
    if len(pak) != PAK_SIZE or hashlib.md5(pak).hexdigest() != PAK_MD5:
        raise SystemExit(f"{installer}: pak0.pak is not the 3.14 demo data")
    files = entries(pak)
    names = {name for name, _ in files}
    files += [(name, data) for name, data in sorted(loose) if name not in names]
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "pak0.pak").write_bytes(pack(files))
    (out_dir / "license.txt").write_bytes(licence)


if __name__ == "__main__":
    main()
