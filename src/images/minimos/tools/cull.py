#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
"""
Cull an assembled rootfs down to the paths a keep list names plus what
those paths need at runtime, and emit the result as a tar file.

Inputs:
  --rootfs DIR           the rootfs to cull (mkapkroot's output)
  --keepfile FILE        allowlist of paths/globs (see keepfiles.txt for format);
                         an entry that matches nothing fails the run
  --denyfile FILE        optional denylist applied after allowlist (same format)
  --provided-rootfs DIR  optional tree a lower image layer already ships;
                         a library found there is neither copied nor
                         searched for further dependencies
  --out FILE             output tar path

For every kept ELF binary (ET_EXEC or ET_DYN), the transitive closure of
its DT_NEEDED libraries is resolved against the rootfs's /usr/lib (and
systemd's private /usr/lib/systemd) and added to the kept set. Symlinks
are preserved (not followed) and the pointed-to path is added too.

Pure stdlib, no pyelftools, so the tool needs no third-party packages.
"""

import argparse
from collections import deque
import fnmatch
import os
import stat
import struct
import sys
import tarfile
from pathlib import Path, PurePosixPath

from common import UnsafeInputError, atomic_output, link_parts


# Wolfi is fully usr-merged: every library lives under /usr/lib and the
# /lib, /lib64 and /usr/lib64 links point there, so this finds each one
# at its canonical path. (A "/lib/..." result would make tar/docker
# extract into the symlink target and as a new directory.) /usr/lib/systemd
# is the RPATH systemd's binaries carry for libsystemd-core-*.so and
# libsystemd-shared-*.so.
LIB_SEARCH = [
    "/usr/lib/systemd",
    "/usr/lib",
]

DT_NULL = 0
DT_NEEDED = 1
DT_STRTAB = 5
DT_STRSZ = 10
MAX_ELF_SIZE = 256 * 1024 * 1024
MAX_OUTPUT_ENTRIES = 200_000
MAX_OUTPUT_FILE_SIZE = 512 * 1024 * 1024
MAX_OUTPUT_CONTENT_SIZE = 4 * 1024 * 1024 * 1024

_GLOB_CHARS = frozenset("*?[")


def log(msg: str) -> None:
    print(f"cull: {msg}", file=sys.stderr)


def _segments(path: str) -> tuple[str, ...]:
    return tuple(part for part in path.strip("/").split("/") if part)


def _match(parts: tuple[str, ...], pattern: tuple[str, ...]) -> bool:
    if not pattern:
        return not parts
    head = pattern[0]
    if head == "**":
        return _match(parts, pattern[1:]) or (
            bool(parts) and _match(parts[1:], pattern)
        )
    return bool(parts) and fnmatch.fnmatchcase(parts[0], head) and _match(
        parts[1:], pattern[1:]
    )


class Globs:
    """A keep or deny list, matched per POSIX path segment.

    `*` never crosses `/`, `**` may. Most entries name one exact path, so
    those go in a table and cost one hash per lookup; only the patterns with
    a wildcard are walked. Both tables map an entry back to its line as
    written, for reporting.
    """

    def __init__(self, globs: list[str]):
        self.literals: dict[tuple[str, ...], str] = {}
        self.patterns: dict[tuple[str, ...], str] = {}
        for glob in globs:
            parts = _segments(glob)
            if any(_GLOB_CHARS.intersection(part) for part in parts):
                self.patterns[parts] = glob
            else:
                self.literals[parts] = glob

    def __len__(self) -> int:
        return len(self.literals) + len(self.patterns)

    def matches(self, path: str) -> bool:
        parts = _segments(path)
        if parts in self.literals:
            return True
        return any(_match(parts, pattern) for pattern in self.patterns)

    def unused(self, paths: list[str]) -> list[str]:
        """The entries, as written, that match none of `paths`."""
        literals = dict(self.literals)
        patterns = dict(self.patterns)
        for path in paths:
            parts = _segments(path)
            literals.pop(parts, None)
            for pattern in [p for p in patterns if _match(parts, p)]:
                del patterns[pattern]
        return sorted([*literals.values(), *patterns.values()])


def read_globs(path: Path) -> Globs:
    globs = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        globs.append(line)
    return Globs(globs)


def _root_relative(rootfs: Path, path: Path | str) -> tuple[str, ...]:
    """Convert a lexical host/rootfs path or image path to safe components."""
    root = rootfs.resolve()
    if isinstance(path, Path):
        try:
            relative = path.relative_to(root)
        except ValueError as error:
            raise UnsafeInputError(f"path is outside rootfs: {path}") from error
        raw = PurePosixPath(relative.as_posix())
    else:
        if "\x00" in path:
            raise UnsafeInputError("rootfs path contains NUL")
        if path.startswith("//"):
            raise UnsafeInputError(f"ambiguous double-slash rootfs path: {path!r}")
        raw = PurePosixPath(path.lstrip("/"))
    parts: list[str] = []
    for part in raw.parts:
        if part in ("", ".", "/"):
            continue
        if part == "..":
            if not parts:
                raise UnsafeInputError(f"path escapes rootfs: {path}")
            parts.pop()
        else:
            parts.append(part)
    return tuple(parts)


def resolve_virtual(rootfs: Path, path: Path | str, *, follow_final: bool = True,
                    max_links: int = 40) -> tuple[Path | None, set[Path]]:
    """Resolve symlinks as though `rootfs` were `/`, never as host paths.

    Returns the resolved path (or None if a component is absent) and every
    symlink encountered, so callers can preserve the complete link chain.
    """
    root = rootfs.resolve()
    pending = deque(_root_relative(root, path))
    resolved: list[str] = []
    links: set[Path] = set()
    followed = 0
    while pending:
        part = pending.popleft()
        if not part or part == ".." or part.startswith("/"):
            raise UnsafeInputError(f"unsafe queued rootfs component: {part!r}")
        candidate = root.joinpath(*resolved, part)
        try:
            candidate.relative_to(root)
        except ValueError as error:
            raise UnsafeInputError(
                f"resolved path escaped rootfs while processing {path}"
            ) from error
        is_final = not pending
        try:
            mode = candidate.lstat().st_mode
        except FileNotFoundError:
            return None, links
        if stat.S_ISLNK(mode) and (follow_final or not is_final):
            followed += 1
            if followed > max_links:
                raise UnsafeInputError(f"too many symlinks while resolving {path}")
            links.add(candidate)
            target_parts = link_parts(resolved, os.readlink(candidate))
            pending = deque(target_parts + list(pending))
            resolved = []
            continue
        resolved.append(part)
    result = root.joinpath(*resolved)
    try:
        result.relative_to(root)
    except ValueError as error:
        raise UnsafeInputError(f"resolved path escaped rootfs: {path}") from error
    return result, links


def is_elf(full: Path) -> bool:
    try:
        if not stat.S_ISREG(full.lstat().st_mode):
            return False
        with open(full, "rb") as f:
            return f.read(4) == b"\x7fELF"
    except OSError:
        return False


def elf_needed(full: Path) -> list[str]:
    """Parse DT_NEEDED from a bounded ELF64-LE file, failing closed."""
    try:
        size = full.stat().st_size
        if size < 0 or size > MAX_ELF_SIZE:
            raise UnsafeInputError(f"ELF file has an unsafe size: {full} ({size})")
        with open(full, "rb") as f:
            data = f.read()
    except OSError:
        return []

    if data[:4] != b"\x7fELF":
        return []
    if len(data) < 64:
        raise UnsafeInputError(f"truncated ELF header: {full}")
    # e_ident: [4]=EI_CLASS (1=32,2=64), [5]=EI_DATA (1=LE,2=BE)
    if data[4] != 2 or data[5] != 1:
        raise UnsafeInputError(f"unsupported ELF class/endianness: {full}")

    # ELF64 header offsets
    e_phoff = struct.unpack_from("<Q", data, 0x20)[0]
    e_phentsize = struct.unpack_from("<H", data, 0x36)[0]
    e_phnum = struct.unpack_from("<H", data, 0x38)[0]
    if e_phnum and e_phentsize < 0x38:
        raise UnsafeInputError(f"invalid ELF program-header size: {full}")
    if e_phoff > len(data) or e_phnum * e_phentsize > len(data) - e_phoff:
        raise UnsafeInputError(f"ELF program headers exceed file bounds: {full}")

    # scan program headers for PT_DYNAMIC (p_type == 2)
    dyn_offset = None
    dyn_size = None
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        if off + 0x38 > len(data):
            break
        p_type = struct.unpack_from("<I", data, off)[0]
        if p_type == 2:  # PT_DYNAMIC
            dyn_offset = struct.unpack_from("<Q", data, off + 0x08)[0]
            dyn_size = struct.unpack_from("<Q", data, off + 0x20)[0]
            break
    if dyn_offset is None:
        return []
    if dyn_size is None or dyn_offset > len(data) or dyn_size > len(data) - dyn_offset:
        raise UnsafeInputError(f"ELF dynamic table exceeds file bounds: {full}")
    if dyn_size % 16:
        raise UnsafeInputError(f"ELF dynamic table is misaligned: {full}")

    # walk .dynamic: array of {d_tag: int64, d_val: uint64}
    strtab_vaddr = None
    strtab_size = None
    needed_offsets: list[int] = []
    for i in range(dyn_size // 16):
        off = dyn_offset + i * 16
        if off + 16 > len(data):
            break
        d_tag, d_val = struct.unpack_from("<qQ", data, off)
        if d_tag == DT_NULL:
            break
        elif d_tag == DT_NEEDED:
            needed_offsets.append(d_val)
        elif d_tag == DT_STRTAB:
            strtab_vaddr = d_val
        elif d_tag == DT_STRSZ:
            strtab_size = d_val

    if not needed_offsets:
        return []
    if strtab_vaddr is None or strtab_size is None or strtab_size > MAX_ELF_SIZE:
        raise UnsafeInputError(f"ELF has invalid dynamic string table: {full}")

    # resolve strtab vaddr -> file offset via LOAD program headers
    file_strtab = None
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        if off + 0x38 > len(data):
            break
        p_type = struct.unpack_from("<I", data, off)[0]
        if p_type != 1:  # PT_LOAD
            continue
        p_offset = struct.unpack_from("<Q", data, off + 0x08)[0]
        p_vaddr = struct.unpack_from("<Q", data, off + 0x10)[0]
        p_filesz = struct.unpack_from("<Q", data, off + 0x20)[0]
        if p_offset > len(data) or p_filesz > len(data) - p_offset:
            raise UnsafeInputError(f"ELF load segment exceeds file bounds: {full}")
        if p_vaddr <= strtab_vaddr < p_vaddr + p_filesz:
            file_strtab = p_offset + (strtab_vaddr - p_vaddr)
            break
    if file_strtab is None:
        raise UnsafeInputError(f"ELF string table is not in a load segment: {full}")
    if file_strtab > len(data) or strtab_size > len(data) - file_strtab:
        raise UnsafeInputError(f"ELF string table exceeds file bounds: {full}")

    out = []
    for n_off in needed_offsets:
        if n_off >= strtab_size:
            raise UnsafeInputError(f"ELF DT_NEEDED offset is out of bounds: {full}")
        pos = file_strtab + n_off
        end = data.find(b"\x00", pos, file_strtab + strtab_size)
        if end < 0 or end - pos > 256:
            raise UnsafeInputError(f"ELF has an invalid DT_NEEDED string: {full}")
        try:
            name = data[pos:end].decode("ascii")
        except UnicodeDecodeError as error:
            raise UnsafeInputError(f"ELF has a non-ASCII DT_NEEDED name: {full}") from error
        if not name or name in (".", "..") or "/" in name or "\x00" in name:
            raise UnsafeInputError(f"ELF has an unsafe DT_NEEDED name: {name!r}")
        out.append(name)
    return out


def lib_search_dirs(rootfs: Path) -> list[Path]:
    """The LIB_SEARCH directories present under `rootfs`, links resolved once."""
    dirs = []
    for d in LIB_SEARCH:
        directory, _ = resolve_virtual(rootfs, d, follow_final=True)
        if directory is not None:
            dirs.append(directory)
    return dirs


def resolve_lib(search_dirs: list[Path], soname: str) -> Path | None:
    if not soname or soname in (".", "..") or "/" in soname or "\x00" in soname:
        raise UnsafeInputError(f"invalid DT_NEEDED name: {soname!r}")
    for directory in search_dirs:
        candidate = directory / soname
        try:
            candidate.lstat()
        except FileNotFoundError:
            continue
        return candidate
    return None


def walk_kept(rootfs: Path, globs: Globs) -> set[Path]:
    kept: set[Path] = set()
    for dirpath, dirnames, filenames in os.walk(rootfs, followlinks=False):
        rel_dir = "/" + os.path.relpath(dirpath, rootfs).replace(os.sep, "/")
        if rel_dir == "/.":
            rel_dir = ""
        for name in filenames + dirnames:
            rel = (rel_dir + "/" + name) if rel_dir else "/" + name
            if globs.matches(rel):
                kept.add(rootfs / rel.lstrip("/"))
    return kept


def close_symlinks(rootfs: Path, kept: set[Path]) -> set[Path]:
    output = set(kept)
    for path in list(kept):
        try:
            is_link = stat.S_ISLNK(path.lstat().st_mode)
        except FileNotFoundError:
            continue
        if not is_link:
            continue
        target, links = resolve_virtual(rootfs, path, follow_final=True)
        output.update(links)
        if target is not None:
            output.add(target)
    return output


def close_elf(rootfs: Path, kept: set[Path], provided: Path | None = None) -> set[Path]:
    """Add the DT_NEEDED closure of every kept ELF file.

    A library that `provided` (the tree a lower image layer ships) already
    has is left out: the loader finds it there at runtime, and a second
    copy is exactly the base-path replacement minimos.image() refuses.
    """
    search = lib_search_dirs(rootfs)
    provided_search = lib_search_dirs(provided) if provided is not None else []
    queue = [p for p in kept if is_elf(p)]
    seen = set(queue)
    unresolved: dict[str, Path] = {}
    while queue:
        current = queue.pop()
        for needed in elf_needed(current):
            if resolve_lib(provided_search, needed) is not None:
                continue
            resolved = resolve_lib(search, needed)
            if resolved is None:
                # A neighbouring layer may provide it at runtime, but
                # say so: a silently missing soname cost a debugging
                # session once (libmount dlopen'd by systemd needed a
                # libblkid nobody shipped).
                unresolved.setdefault(needed, current)
                continue
            if resolved in seen:
                continue
            seen.add(resolved)
            kept.add(resolved)
            target, links = resolve_virtual(rootfs, resolved, follow_final=True)
            for link in links:
                if link not in seen:
                    seen.add(link)
                    kept.add(link)
            if target is not None and target not in seen:
                seen.add(target)
                kept.add(target)
            if target is not None and is_elf(target):
                queue.append(target)
    if unresolved:
        details = ", ".join(
            f"{soname} (needed by {ref.name})"
            for soname, ref in sorted(unresolved.items())
        )
        raise UnsafeInputError(f"unresolved required ELF libraries: {details}")
    return kept


def ensure_parent_dirs(rootfs: Path, kept: set[Path]) -> set[Path]:
    out = set(kept)
    root_resolved = rootfs.resolve()
    for p in kept:
        parent = p.parent
        # Every element of `kept` is visited, so an ancestor already in
        # `out` has had, or will have, its own ancestors added.
        while parent != root_resolved and parent not in out:
            try:
                parent.relative_to(root_resolved)
            except ValueError:
                break
            out.add(parent)
            parent = parent.parent
    return out


def write_tar(rootfs: Path, kept: set[Path], out: Path) -> None:
    root_resolved = rootfs.resolve()
    paths = sorted(kept, key=lambda p: str(p.relative_to(root_resolved)))
    if len(paths) > MAX_OUTPUT_ENTRIES:
        raise UnsafeInputError(
            f"culled layer has more than {MAX_OUTPUT_ENTRIES} entries"
        )

    # Preflight the complete output before opening a destination. Hardlinked
    # rootfs paths are intentionally emitted as independent regular members
    # because minimos layers forbid extraction-time hardlinks; charge every
    # pathname so one source inode cannot amplify into an unbounded tar.
    total_size = 0
    for p in paths:
        rel = p.relative_to(root_resolved)
        lst = p.lstat()
        mode = stat.S_IMODE(lst.st_mode) & ~(stat.S_ISUID | stat.S_ISGID)
        if stat.S_ISLNK(lst.st_mode):
            link_parts(list(rel.parts[:-1]), os.readlink(p), what=f"symlink /{rel}")
        elif stat.S_ISDIR(lst.st_mode):
            if mode & stat.S_IWOTH and not mode & stat.S_ISVTX:
                raise UnsafeInputError(
                    f"world-writable non-sticky directory in layer: /{rel}"
                )
        elif stat.S_ISREG(lst.st_mode):
            if mode & stat.S_IWOTH:
                raise UnsafeInputError(f"world-writable file in layer: /{rel}")
            if lst.st_size < 0 or lst.st_size > MAX_OUTPUT_FILE_SIZE:
                raise UnsafeInputError(f"culled layer file is too large: /{rel}")
            total_size += lst.st_size
            if total_size > MAX_OUTPUT_CONTENT_SIZE:
                raise UnsafeInputError(
                    "culled layer expanded content exceeds size limit"
                )
        else:
            raise UnsafeInputError(f"unsupported filesystem entry in layer: /{rel}")

    out.parent.mkdir(parents=True, exist_ok=True)
    with atomic_output(out, prefix=f".{out.name}.cull-") as temporary, \
            tarfile.open(temporary, "w") as tar:
        for p in paths:
            rel = p.relative_to(root_resolved)
            arcname = str(rel).replace(os.sep, "/")
            lst = p.lstat()
            info = tarfile.TarInfo(name=arcname)
            info.mtime = 0
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            # Setuid/setgid never survive into the image: nothing in a
            # minimos rootfs escalates via file modes (services that
            # need privilege start with it), and Wolfi ships
            # mount/umount setuid-root. Sticky bits (e.g. /tmp) stay.
            info.mode = stat.S_IMODE(lst.st_mode) & ~(
                stat.S_ISUID | stat.S_ISGID
            )
            if stat.S_ISLNK(lst.st_mode):
                info.type = tarfile.SYMTYPE
                info.linkname = os.readlink(p)
                info.size = 0
                tar.addfile(info)
            elif stat.S_ISDIR(lst.st_mode):
                info.type = tarfile.DIRTYPE
                info.size = 0
                tar.addfile(info)
            else:
                info.type = tarfile.REGTYPE
                info.size = lst.st_size
                with open(p, "rb") as fp:
                    tar.addfile(info, fp)


def apply_denylist(rootfs: Path, kept: set[Path], deny: Globs, stage: str) -> set[Path]:
    """Drop kept paths matching any deny glob.

    Called twice: once after the allowlist match (so denied binaries don't
    drag in extra .so deps via close_elf), and once after .so closure (so
    libs pulled in transitively can still be excluded)."""
    root_real = rootfs.resolve()
    survivors = set()
    dropped = 0
    for p in kept:
        rel = "/" + str(p.relative_to(root_real)).replace(os.sep, "/")
        if deny.matches(rel):
            dropped += 1
            continue
        survivors.add(p)
    if dropped:
        log(f"denylist ({stage}) dropped {dropped} paths")
    return survivors


def _plain_directory(path: Path, what: str) -> Path | None:
    """`path` resolved, or None (after logging) unless it is a real directory.

    The tools never auto-follow a symlink here: an archive-controlled link
    could otherwise make the build walk and package host files.
    """
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        metadata = None
    if metadata is None or not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
        log(f"error: {what} is not a directory: {path}")
        return None
    # Resolve up front: the path-set logic compares against
    # rootfs.resolve(), so a relative path would never match.
    return path.resolve()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rootfs", required=True, type=Path)
    parser.add_argument("--keepfile", required=True, type=Path)
    parser.add_argument("--denyfile", required=False, default=None, type=Path)
    parser.add_argument("--provided-rootfs", required=False, default=None, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    rootfs = _plain_directory(args.rootfs, "rootfs")
    if rootfs is None:
        return 1
    provided = None
    if args.provided_rootfs is not None:
        provided = _plain_directory(args.provided_rootfs, "provided rootfs")
        if provided is None:
            return 1

    keep = read_globs(args.keepfile)
    log(f"loaded {len(keep)} allowlist entries")

    kept = walk_kept(rootfs, keep)
    log(f"after allowlist: {len(kept)} paths")
    # An unmatched entry is a typo or a file the package moved, and either
    # way the image silently goes without it. A missing DT_NEEDED library
    # already fails the build, so a missing named file should too. The
    # check runs before the denylist, so an entry the denylist overrides
    # on purpose still counts as matched.
    unused = keep.unused(
        ["/" + path.relative_to(rootfs).as_posix() for path in kept]
    )
    if unused:
        log(f"error: {args.keepfile} entries match nothing in the rootfs:")
        for entry in unused:
            log(f"  {entry}")
        return 1

    deny = None
    if args.denyfile is not None:
        deny = read_globs(args.denyfile)
        log(f"loaded {len(deny)} denylist entries")
        kept = apply_denylist(rootfs, kept, deny, stage="pre-closure")

    kept = close_symlinks(rootfs, kept)
    log(f"after symlink closure: {len(kept)} paths")

    kept = close_elf(rootfs, kept, provided)
    log(f"after ELF closure: {len(kept)} paths")

    if deny is not None:
        kept = apply_denylist(rootfs, kept, deny, stage="post-closure")

    kept = ensure_parent_dirs(rootfs, kept)
    log(f"after parent-dir fill: {len(kept)} paths")

    write_tar(rootfs, kept, args.out)
    log(f"wrote {args.out} ({args.out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
