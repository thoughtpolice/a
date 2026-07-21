# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Build a deterministic OCI layer for a Nix-linked native executable.

The executable produced by this repository's Nix-backed C/C++ toolchain has
an ELF interpreter and RUNPATH entries below /nix/store.  A normal container
does not mount the host's Nix store, so those immutable store roots must be
present in the image at their original absolute paths.

This helper reads PT_INTERP and DT_{R, RUN}PATH directly from ELF files. It can
add every referenced Nix store root (following embedded Nix references, ELF
runtime paths, and cross-store symlinks to a fixed point), or repoint the
executable at an ABI-compatible base runtime. Store roots are copied whole:
besides being simple and robust, this retains glibc's runtime-loaded NSS modules,
which DT_NEEDED alone cannot discover.
"""

from __future__ import annotations

import argparse
import gzip
import os
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
from collections import deque
from pathlib import Path, PurePosixPath
from typing import Iterable


PT_LOAD = 1
PT_DYNAMIC = 2
PT_INTERP = 3

DT_NULL = 0
DT_NEEDED = 1
DT_STRTAB = 5
DT_STRSZ = 10
DT_RPATH = 15
DT_RUNPATH = 29

NIX_HASH = r"0-9abcdfghijklmnpqrsvwxyz"
NIX_NAME = r"0-9A-Za-z+._?=-"
NIX_STORE_ROOT = re.compile(
    rf"^(/nix/store/[{NIX_HASH}]{{32}}-[{NIX_NAME}]+)"
)
NIX_STORE_REFERENCE = re.compile(
    rb"(/nix/store/[0-9abcdfghijklmnpqrsvwxyz]{32}-"
    rb"[0-9A-Za-z+._?=-]+)(?=[^0-9A-Za-z+._?=-])"
)
REFERENCE_SCAN_CHUNK = 1024 * 1024
REFERENCE_SCAN_TAIL = 4096


class ElfError(ValueError):
    """The input is not a supported ELF executable."""


def _cstring(data: bytes, offset: int, limit: int | None = None) -> str:
    if offset < 0 or offset >= len(data):
        raise ElfError(f"string offset {offset} is outside the ELF file")
    end_limit = min(len(data), limit if limit is not None else len(data))
    end = data.find(b"\0", offset, end_limit)
    if end == -1:
        raise ElfError(f"unterminated ELF string at offset {offset}")
    return data[offset:end].decode("utf-8", errors="surrogateescape")


def elf_runtime_paths(path: Path) -> tuple[str | None, list[str], list[str]]:
    """Return (interpreter, search paths, needed entries) from an ELF file."""

    data = path.read_bytes()
    if len(data) < 16 or data[:4] != b"\x7fELF":
        raise ElfError(f"{path} is not an ELF file")

    elf_class = data[4]
    byte_order = data[5]
    if byte_order == 1:
        endian = "<"
    elif byte_order == 2:
        endian = ">"
    else:
        raise ElfError(f"{path} has unsupported ELF byte order {byte_order}")

    if elf_class == 2:
        header_format = endian + "HHIQQQIHHHHHH"
        program_format = endian + "IIQQQQQQ"
        dynamic_format = endian + "qQ"
    elif elf_class == 1:
        header_format = endian + "HHIIIIIHHHHHH"
        program_format = endian + "IIIIIIII"
        dynamic_format = endian + "iI"
    else:
        raise ElfError(f"{path} has unsupported ELF class {elf_class}")

    header_size = struct.calcsize(header_format)
    if len(data) < 16 + header_size:
        raise ElfError(f"{path} has a truncated ELF header")
    header = struct.unpack_from(header_format, data, 16)
    program_offset = header[4]
    program_entry_size = header[8]
    program_count = header[9]
    expected_program_size = struct.calcsize(program_format)
    if program_count and program_entry_size < expected_program_size:
        raise ElfError(
            f"{path} has program headers of {program_entry_size} bytes; "
            f"need at least {expected_program_size}"
        )

    programs: list[tuple[int, int, int, int, int]] = []
    interpreter: str | None = None
    dynamic_segment: tuple[int, int] | None = None
    for index in range(program_count):
        offset = program_offset + index * program_entry_size
        if offset + expected_program_size > len(data):
            raise ElfError(f"{path} has a truncated program header table")
        fields = struct.unpack_from(program_format, data, offset)
        if elf_class == 2:
            p_type, p_offset, p_vaddr, p_filesz, p_memsz = (
                fields[0],
                fields[2],
                fields[3],
                fields[5],
                fields[6],
            )
        else:
            p_type, p_offset, p_vaddr, p_filesz, p_memsz = (
                fields[0],
                fields[1],
                fields[2],
                fields[4],
                fields[5],
            )
        programs.append((p_type, p_offset, p_vaddr, p_filesz, p_memsz))

        if p_type == PT_INTERP:
            interpreter = _cstring(data, p_offset, p_offset + p_filesz)
        elif p_type == PT_DYNAMIC:
            dynamic_segment = (p_offset, p_filesz)

    if dynamic_segment is None:
        return interpreter, [], []

    dynamic_size = struct.calcsize(dynamic_format)
    string_table_vaddr: int | None = None
    string_table_size: int | None = None
    path_offsets: list[int] = []
    needed_offsets: list[int] = []
    dynamic_offset, dynamic_filesz = dynamic_segment
    for offset in range(
        dynamic_offset,
        dynamic_offset + dynamic_filesz,
        dynamic_size,
    ):
        if offset + dynamic_size > len(data):
            raise ElfError(f"{path} has a truncated dynamic segment")
        tag, value = struct.unpack_from(dynamic_format, data, offset)
        if tag == DT_NULL:
            break
        if tag == DT_STRTAB:
            string_table_vaddr = value
        elif tag == DT_STRSZ:
            string_table_size = value
        elif tag in (DT_RPATH, DT_RUNPATH):
            path_offsets.append(value)
        elif tag == DT_NEEDED:
            needed_offsets.append(value)

    if not path_offsets and not needed_offsets:
        return interpreter, [], []
    if string_table_vaddr is None:
        raise ElfError(f"{path} has dynamic strings but no DT_STRTAB")

    string_table_offset: int | None = None
    for p_type, p_offset, p_vaddr, p_filesz, _ in programs:
        if (
            p_type == PT_LOAD
            and p_vaddr <= string_table_vaddr < p_vaddr + p_filesz
        ):
            string_table_offset = p_offset + (string_table_vaddr - p_vaddr)
            break
    if string_table_offset is None:
        raise ElfError(f"{path} has a DT_STRTAB outside its loadable segments")

    table_limit = (
        string_table_offset + string_table_size
        if string_table_size is not None
        else None
    )
    search_paths: list[str] = []
    for string_offset in path_offsets:
        value = _cstring(data, string_table_offset + string_offset, table_limit)
        search_paths.extend(item for item in value.split(":") if item)
    needed = [
        _cstring(data, string_table_offset + string_offset, table_limit)
        for string_offset in needed_offsets
    ]
    return interpreter, search_paths, needed


def nix_store_root(path: str) -> Path | None:
    match = NIX_STORE_ROOT.match(path)
    return Path(match.group(1)) if match else None


def embedded_store_paths(path: Path) -> list[str]:
    """Return absolute Nix store paths embedded in an arbitrary file."""

    references: set[str] = set()
    tail = b""
    with path.open("rb") as source:
        while chunk := source.read(REFERENCE_SCAN_CHUNK):
            data = tail + chunk
            for match in NIX_STORE_REFERENCE.finditer(data):
                references.add(os.fsdecode(match.group(1)))
            tail = data[-REFERENCE_SCAN_TAIL:]

    # The lookahead deliberately does not accept end-of-buffer, because a
    # store name may span chunks. A sentinel makes a reference at EOF complete.
    for match in NIX_STORE_REFERENCE.finditer(tail + b"\0"):
        references.add(os.fsdecode(match.group(1)))
    return sorted(references)


def _store_entries(root: Path) -> Iterable[Path]:
    if not root.is_dir():
        yield root
        return

    for directory, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames.sort()
        filenames.sort()
        for name in dirnames + filenames:
            yield Path(directory) / name


def discover_store_closure(initial: Iterable[Path]) -> list[Path]:
    """Follow Nix references, ELF runtime paths, and symlinks to a fixed point."""

    pending = deque(sorted(set(initial), key=str))
    seen: set[Path] = set()
    while pending:
        root = pending.popleft()
        if root in seen:
            continue
        if not root.exists():
            raise FileNotFoundError(
                f"ELF references Nix store root {root}, but it is unavailable"
            )
        seen.add(root)

        for entry in _store_entries(root):
            if entry.is_symlink():
                resolved = os.path.realpath(entry)
                target_root = nix_store_root(resolved)
                if target_root is not None and target_root not in seen:
                    pending.append(target_root)
                continue

            if not entry.is_file():
                continue
            for reference in embedded_store_paths(entry):
                target_root = nix_store_root(reference)
                if target_root is not None and target_root not in seen:
                    pending.append(target_root)

            with entry.open("rb") as candidate:
                if candidate.read(4) != b"\x7fELF":
                    continue
            interpreter, search_paths, needed = elf_runtime_paths(entry)
            for runtime_path in (
                ([interpreter] if interpreter else [])
                + search_paths
                + needed
            ):
                target_root = nix_store_root(runtime_path)
                if target_root is not None and target_root not in seen:
                    pending.append(target_root)

    return sorted(seen, key=str)


def _normalize_tarinfo(info: tarfile.TarInfo) -> tarfile.TarInfo:
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    info.pax_headers = {}
    return info


def _add_directory(archive: tarfile.TarFile, name: str, mode: int = 0o755) -> None:
    info = tarfile.TarInfo(name.rstrip("/"))
    info.type = tarfile.DIRTYPE
    info.mode = mode
    archive.addfile(_normalize_tarinfo(info))


def _add_tree_as_data(
    archive: tarfile.TarFile,
    source: Path,
    arcname: str,
) -> None:
    """Add a sorted tree without encoding host-side hardlink optimization."""

    # TarFile otherwise remembers (device, inode) pairs and emits later files
    # as hardlinks. Nix can optimise identical files into hardlinks without
    # changing their store/NAR contents, so inode layout is not a stable input.
    archive.inodes.clear()
    archive.add(
        source,
        arcname=arcname,
        recursive=False,
        filter=_normalize_tarinfo,
    )
    if source.is_symlink() or not source.is_dir():
        return
    for child in sorted(source.iterdir(), key=lambda path: path.name):
        _add_tree_as_data(archive, child, arcname + "/" + child.name)


def _destination(path: str) -> PurePosixPath:
    destination = PurePosixPath(path)
    if not destination.is_absolute() or destination == PurePosixPath("/"):
        raise ValueError(f"destination must be an absolute file path: {path!r}")
    if ".." in destination.parts:
        raise ValueError(f"destination cannot contain '..': {path!r}")
    return destination


def write_layer(
    binary: Path,
    output: Path,
    destination: PurePosixPath,
    store_roots: list[Path],
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as raw:
        with gzip.GzipFile(
            filename="",
            mode="wb",
            compresslevel=6,
            mtime=0,
            fileobj=raw,
        ) as compressed:
            with tarfile.open(
                fileobj=compressed,
                mode="w",
                format=tarfile.GNU_FORMAT,
                dereference=False,
            ) as archive:
                parents: list[str] = []
                current = destination.parent
                while current != PurePosixPath("/"):
                    parents.append(str(current).lstrip("/"))
                    current = current.parent
                for parent in reversed(parents):
                    _add_directory(archive, parent)

                if store_roots:
                    _add_directory(archive, "nix")
                    _add_directory(archive, "nix/store")

                info = archive.gettarinfo(
                    str(binary),
                    arcname=str(destination).lstrip("/"),
                )
                info.mode = (info.mode | 0o111) & ~0o6000
                with binary.open("rb") as source:
                    archive.addfile(_normalize_tarinfo(info), source)

                for root in store_roots:
                    _add_tree_as_data(
                        archive,
                        root,
                        str(root).lstrip("/"),
                    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--destination", required=True)
    parser.add_argument(
        "--interpreter",
        help="replace PT_INTERP (requires patchelf; use only with an ABI-compatible base)",
    )
    parser.add_argument(
        "--rpath",
        help="replace DT_RUNPATH (requires patchelf; use only with an ABI-compatible base)",
    )
    parser.add_argument("--patchelf", default="patchelf")
    parser.add_argument(
        "--include-nix-store",
        choices=("true", "false"),
        default="true",
        help="copy Nix runtime roots instead of requiring the base to provide them",
    )
    args = parser.parse_args()

    destination = _destination(args.destination)
    with tempfile.TemporaryDirectory(prefix="native-binary-layer-") as temporary:
        binary = args.binary
        if args.interpreter is not None or args.rpath is not None:
            binary = Path(temporary) / "binary"
            shutil.copyfile(args.binary, binary)
            binary.chmod(args.binary.stat().st_mode)
            command = [args.patchelf]
            if args.interpreter is not None:
                command += ["--set-interpreter", args.interpreter]
            if args.rpath is not None:
                command += ["--set-rpath", args.rpath]
            command.append(str(binary))
            try:
                subprocess.run(command, check=True)
            except FileNotFoundError as error:
                raise FileNotFoundError(
                    f"cannot patch ELF runtime: {args.patchelf!r} was not found"
                ) from error

        interpreter, search_paths, needed = elf_runtime_paths(binary)
        initial_roots: set[Path] = set()
        for runtime_path in (
            ([interpreter] if interpreter else []) + search_paths + needed
        ):
            root = nix_store_root(runtime_path)
            if root is not None:
                initial_roots.add(root)

        include_nix_store = args.include_nix_store == "true"
        if not include_nix_store and initial_roots:
            roots = ", ".join(str(path) for path in sorted(initial_roots))
            raise ValueError(
                "include-nix-store=false, but the packaged ELF still references: "
                + roots
            )
        store_roots = (
            discover_store_closure(initial_roots) if include_nix_store else []
        )

        print(
            f"native_binary_layer: {args.binary} -> {destination}",
            file=sys.stderr,
        )
        print(
            f"native_binary_layer: interpreter: {interpreter or '<static>'}",
            file=sys.stderr,
        )
        for root in store_roots:
            print(f"native_binary_layer: including {root}", file=sys.stderr)

        write_layer(binary, args.output, destination, store_roots)
    print(
        f"native_binary_layer: wrote {args.output} with "
        f"{len(store_roots)} Nix store root(s)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (
        ElfError,
        FileNotFoundError,
        subprocess.CalledProcessError,
        ValueError,
    ) as error:
        print(f"native_binary_layer: error: {error}", file=sys.stderr)
        sys.exit(1)
