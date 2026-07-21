# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import os
import struct
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from unittest import mock

import native_binary_layer as layer


def relocatable_elf() -> bytes:
    """Return a minimal, valid ELF64 ET_REL file with no program headers."""

    identification = b"\x7fELF\x02\x01\x01" + b"\0" * 9
    header = struct.pack(
        "<HHIQQQIHHHHHH",
        1,  # ET_REL
        62,  # EM_X86_64
        1,
        0,
        0,
        0,
        0,
        64,
        0,
        0,
        0,
        0,
        0,
    )
    return identification + header


def test_relocatable_elf() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        obj = root / "crt1.o"
        obj.write_bytes(relocatable_elf())

        assert layer.elf_runtime_paths(obj) == (None, [], [])
        assert layer.discover_store_closure([root]) == [root]


def test_runtime_path_fixed_point() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        parent = Path(temporary)
        first = parent / "first"
        second = parent / "second"
        third = parent / "third"
        for root in (first, second, third):
            root.mkdir()
            (root / "library.so").write_bytes(relocatable_elf())

        embedded_path = "/nix/store/" + "a" * 32 + "-runtime-second"
        bootstrap_placeholder = "/nix/store/" + "e" * 32 + "-bootstrap"
        (first / "library.so").write_bytes(
            relocatable_elf()
            + b"\0"
            + bootstrap_placeholder.encode()
            + b"\0"
            + embedded_path.encode()
        )
        assert layer.embedded_store_paths(first / "library.so") == [embedded_path]

        runtime_paths = {
            second / "library.so": str(third),
        }

        def fake_runtime_paths(path: Path) -> tuple[str | None, list[str], list[str]]:
            runtime = runtime_paths.get(path)
            return None, [runtime] if runtime else [], []

        def fake_store_root(path: str) -> Path | None:
            if path == embedded_path:
                return second
            candidate = Path(path)
            return candidate if candidate in (first, second, third) else None

        with (
            mock.patch.object(layer, "elf_runtime_paths", fake_runtime_paths),
            mock.patch.object(layer, "nix_store_root", fake_store_root),
        ):
            assert layer.discover_store_closure([first]) == [first, second, third]


def test_hardlinks_archived_as_data() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        parent = Path(temporary)
        binary = parent / "binary"
        binary.write_bytes(relocatable_elf())
        binary.chmod(0o755)

        root = parent / "store-root"
        root.mkdir()
        first = root / "first"
        second = root / "second"
        first.write_bytes(b"same contents")
        os.link(first, second)

        optimized = parent / "optimized.tar.gz"
        unoptimized = parent / "unoptimized.tar.gz"
        destination = PurePosixPath("/usr/local/bin/example")
        layer.write_layer(binary, optimized, destination, [root])

        second.unlink()
        second.write_bytes(first.read_bytes())
        layer.write_layer(binary, unoptimized, destination, [root])

        assert optimized.read_bytes() == unoptimized.read_bytes()
        with tarfile.open(optimized, "r:gz") as archive:
            members = {member.name: member for member in archive.getmembers()}
        prefix = str(root).lstrip("/")
        assert members[prefix + "/first"].isfile()
        assert members[prefix + "/second"].isfile()


def main() -> None:
    test_relocatable_elf()
    test_runtime_path_fixed_point()
    test_hardlinks_archived_as_data()


if __name__ == "__main__":
    main()
