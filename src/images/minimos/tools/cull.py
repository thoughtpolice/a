#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
"""
Cull an unpacked OCI rootfs down to just what a minimal systemd needs, and
emit the result as a tar file.

Inputs:
  --rootfs DIR     the 'rootfs' subdirectory of an oci_unpack output bundle
  --keepfile FILE  allowlist of paths/globs (see keepfiles.txt for format)
  --denyfile FILE  optional denylist applied after allowlist (same format)
  --out FILE       output tar path

For every kept ELF binary (ET_EXEC or ET_DYN), the transitive closure of
its DT_NEEDED libraries is resolved against the rootfs's /lib* and /usr/lib*
directories and added to the kept set. Symlinks are preserved (not followed)
and the pointed-to path is added too.

Pure stdlib — no pyelftools — so we can run this from a plain python3
genrule without a uv lock file.
"""

import argparse
from collections import deque
import fnmatch
from functools import lru_cache
import os
import stat
import struct
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath


# Search /usr/* first so merged-usr distros resolve to the canonical
# (non-symlinked) paths. Returning "/lib/..." would cause tar/docker to
# extract into the symlink target AND as a new dir, confusing loaders.
# /usr/lib/systemd is here because systemd binaries have it in their
# RPATH for libsystemd-core-*.so and libsystemd-shared-*.so.
LIB_SEARCH = [
    "/usr/lib/x86_64-linux-gnu/systemd",  # libsystemd-core-*, libsystemd-shared-*
    "/usr/lib/systemd",
    "/usr/lib/x86_64-linux-gnu",
    "/usr/lib64",
    "/usr/lib",
    "/lib/x86_64-linux-gnu",
    "/lib64",
    "/lib",
]

DT_NULL = 0
DT_NEEDED = 1
DT_STRTAB = 5
DT_STRSZ = 10
MAX_ELF_SIZE = 256 * 1024 * 1024
MAX_OUTPUT_ENTRIES = 200_000
MAX_OUTPUT_FILE_SIZE = 512 * 1024 * 1024
MAX_OUTPUT_CONTENT_SIZE = 4 * 1024 * 1024 * 1024


def log(msg: str) -> None:
    print(f"cull: {msg}", file=sys.stderr)


def read_globs(path: Path) -> list[str]:
    globs = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        globs.append(line)
    return globs


def matches_any(path: str, globs: list[str]) -> bool:
    """Match POSIX path segments; `*` never crosses `/`, `**` may."""
    path_parts = tuple(part for part in path.strip("/").split("/") if part)

    @lru_cache(maxsize=None)
    def match(parts: tuple[str, ...], pattern: tuple[str, ...]) -> bool:
        if not pattern:
            return not parts
        head = pattern[0]
        if head == "**":
            return match(parts, pattern[1:]) or (
                bool(parts) and match(parts[1:], pattern)
            )
        return bool(parts) and fnmatch.fnmatchcase(parts[0], head) and match(
            parts[1:], pattern[1:]
        )

    for glob in globs:
        pattern = tuple(part for part in glob.strip("/").split("/") if part)
        if match(path_parts, pattern):
            return True
    return False


class UnsafeRootfsError(ValueError):
    """A rootfs path would be resolved using build-host semantics."""


def _root_relative(rootfs: Path, path: Path | str) -> tuple[str, ...]:
    """Convert a lexical host/rootfs path or image path to safe components."""
    root = rootfs.resolve()
    if isinstance(path, Path):
        try:
            relative = path.relative_to(root)
        except ValueError as error:
            raise UnsafeRootfsError(f"path is outside rootfs: {path}") from error
        raw = PurePosixPath(relative.as_posix())
    else:
        if "\x00" in path:
            raise UnsafeRootfsError("rootfs path contains NUL")
        if path.startswith("//"):
            raise UnsafeRootfsError(f"ambiguous double-slash rootfs path: {path!r}")
        raw = PurePosixPath(path.lstrip("/"))
    parts: list[str] = []
    for part in raw.parts:
        if part in ("", ".", "/"):
            continue
        if part == "..":
            if not parts:
                raise UnsafeRootfsError(f"path escapes rootfs: {path}")
            parts.pop()
        else:
            parts.append(part)
    return tuple(parts)


def _link_parts(parent: list[str], target: str) -> list[str]:
    if not target or "\x00" in target:
        raise UnsafeRootfsError("symlink has an empty or NUL-containing target")
    # POSIX leaves exactly two leading slashes implementation-defined, and
    # PurePosixPath preserves them as an absolute component named "//".
    # Never let Path.joinpath reinterpret that component as a host path.
    if target.startswith("//"):
        raise UnsafeRootfsError(
            f"symlink has an ambiguous double-slash target: {target!r}"
        )
    output = [] if target.startswith("/") else list(parent)
    for part in PurePosixPath(target).parts:
        if part in ("", ".", "/"):
            continue
        if part.startswith("/"):
            raise UnsafeRootfsError(f"absolute symlink component: {target!r}")
        if part == "..":
            if not output:
                raise UnsafeRootfsError(f"symlink escapes image root: {target!r}")
            output.pop()
        else:
            output.append(part)
    return output


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
            raise UnsafeRootfsError(f"unsafe queued rootfs component: {part!r}")
        candidate = root.joinpath(*resolved, part)
        try:
            candidate.relative_to(root)
        except ValueError as error:
            raise UnsafeRootfsError(
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
                raise UnsafeRootfsError(f"too many symlinks while resolving {path}")
            links.add(candidate)
            target_parts = _link_parts(resolved, os.readlink(candidate))
            pending = deque(target_parts + list(pending))
            resolved = []
            continue
        resolved.append(part)
    result = root.joinpath(*resolved)
    try:
        result.relative_to(root)
    except ValueError as error:
        raise UnsafeRootfsError(f"resolved path escaped rootfs: {path}") from error
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
            raise UnsafeRootfsError(f"ELF file has an unsafe size: {full} ({size})")
        with open(full, "rb") as f:
            data = f.read()
    except OSError:
        return []

    if data[:4] != b"\x7fELF":
        return []
    if len(data) < 64:
        raise UnsafeRootfsError(f"truncated ELF header: {full}")
    # e_ident: [4]=EI_CLASS (1=32,2=64), [5]=EI_DATA (1=LE,2=BE)
    if data[4] != 2 or data[5] != 1:
        raise UnsafeRootfsError(f"unsupported ELF class/endianness: {full}")

    # ELF64 header offsets
    e_phoff = struct.unpack_from("<Q", data, 0x20)[0]
    e_phentsize = struct.unpack_from("<H", data, 0x36)[0]
    e_phnum = struct.unpack_from("<H", data, 0x38)[0]
    if e_phnum and e_phentsize < 0x38:
        raise UnsafeRootfsError(f"invalid ELF program-header size: {full}")
    if e_phoff > len(data) or e_phnum * e_phentsize > len(data) - e_phoff:
        raise UnsafeRootfsError(f"ELF program headers exceed file bounds: {full}")

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
        raise UnsafeRootfsError(f"ELF dynamic table exceeds file bounds: {full}")
    if dyn_size % 16:
        raise UnsafeRootfsError(f"ELF dynamic table is misaligned: {full}")

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
        raise UnsafeRootfsError(f"ELF has invalid dynamic string table: {full}")

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
            raise UnsafeRootfsError(f"ELF load segment exceeds file bounds: {full}")
        if p_vaddr <= strtab_vaddr < p_vaddr + p_filesz:
            file_strtab = p_offset + (strtab_vaddr - p_vaddr)
            break
    if file_strtab is None:
        raise UnsafeRootfsError(f"ELF string table is not in a load segment: {full}")
    if file_strtab > len(data) or strtab_size > len(data) - file_strtab:
        raise UnsafeRootfsError(f"ELF string table exceeds file bounds: {full}")

    out = []
    for n_off in needed_offsets:
        if n_off >= strtab_size:
            raise UnsafeRootfsError(f"ELF DT_NEEDED offset is out of bounds: {full}")
        pos = file_strtab + n_off
        end = data.find(b"\x00", pos, file_strtab + strtab_size)
        if end < 0 or end - pos > 256:
            raise UnsafeRootfsError(f"ELF has an invalid DT_NEEDED string: {full}")
        try:
            name = data[pos:end].decode("ascii")
        except UnicodeDecodeError as error:
            raise UnsafeRootfsError(f"ELF has a non-ASCII DT_NEEDED name: {full}") from error
        if not name or name in (".", "..") or "/" in name or "\x00" in name:
            raise UnsafeRootfsError(f"ELF has an unsafe DT_NEEDED name: {name!r}")
        out.append(name)
    return out


def resolve_lib(rootfs: Path, soname: str) -> Path | None:
    if not soname or soname in (".", "..") or "/" in soname or "\x00" in soname:
        raise UnsafeRootfsError(f"invalid DT_NEEDED name: {soname!r}")
    for d in LIB_SEARCH:
        directory, _ = resolve_virtual(rootfs, d, follow_final=True)
        if directory is None:
            continue
        candidate = directory / soname
        try:
            candidate.lstat()
        except FileNotFoundError:
            continue
        return candidate
    return None


def walk_kept(rootfs: Path, globs: list[str]) -> set[Path]:
    kept: set[Path] = set()
    for dirpath, dirnames, filenames in os.walk(rootfs, followlinks=False):
        rel_dir = "/" + os.path.relpath(dirpath, rootfs).replace(os.sep, "/")
        if rel_dir == "/.":
            rel_dir = ""
        for name in filenames + dirnames:
            rel = (rel_dir + "/" + name) if rel_dir else "/" + name
            if matches_any(rel, globs):
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


def close_elf(rootfs: Path, kept: set[Path]) -> set[Path]:
    queue = [p for p in kept if is_elf(p)]
    seen = set(queue)
    unresolved: dict[str, Path] = {}
    while queue:
        current = queue.pop()
        for needed in elf_needed(current):
            resolved = resolve_lib(rootfs, needed)
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
            current, links = resolve_virtual(rootfs, resolved, follow_final=True)
            for link in links:
                if link not in seen:
                    seen.add(link)
                    kept.add(link)
            if current is not None and current not in seen:
                seen.add(current)
                kept.add(current)
            if current is not None and is_elf(current):
                queue.append(current)
    if unresolved:
        details = ", ".join(
            f"{soname} (needed by {ref.name})"
            for soname, ref in sorted(unresolved.items())
        )
        raise UnsafeRootfsError(f"unresolved required ELF libraries: {details}")
    return kept


def ensure_parent_dirs(rootfs: Path, kept: set[Path]) -> set[Path]:
    out = set(kept)
    root_resolved = rootfs.resolve()
    for p in kept:
        parent = p.parent
        while True:
            try:
                parent.relative_to(root_resolved)
            except ValueError:
                break
            if parent == root_resolved:
                break
            out.add(parent)
            parent = parent.parent
    return out


def write_tar(rootfs: Path, kept: set[Path], out: Path) -> None:
    root_resolved = rootfs.resolve()
    paths = sorted(kept, key=lambda p: str(p.relative_to(root_resolved)))
    if len(paths) > MAX_OUTPUT_ENTRIES:
        raise UnsafeRootfsError(
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
            _link_parts(list(rel.parts[:-1]), os.readlink(p))
        elif stat.S_ISDIR(lst.st_mode):
            if mode & stat.S_IWOTH and not mode & stat.S_ISVTX:
                raise UnsafeRootfsError(
                    f"world-writable non-sticky directory in layer: /{rel}"
                )
        elif stat.S_ISREG(lst.st_mode):
            if mode & stat.S_IWOTH:
                raise UnsafeRootfsError(f"world-writable file in layer: /{rel}")
            if lst.st_size < 0 or lst.st_size > MAX_OUTPUT_FILE_SIZE:
                raise UnsafeRootfsError(f"culled layer file is too large: /{rel}")
            total_size += lst.st_size
            if total_size > MAX_OUTPUT_CONTENT_SIZE:
                raise UnsafeRootfsError(
                    "culled layer expanded content exceeds size limit"
                )
        else:
            raise UnsafeRootfsError(f"unsupported filesystem entry in layer: /{rel}")

    out.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{out.name}.cull-", dir=out.parent
    )
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        with tarfile.open(temporary, "w") as tar:
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
        os.replace(temporary, out)
    except BaseException:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def apply_denylist(rootfs: Path, kept: set[Path], deny_globs: list[str], stage: str) -> set[Path]:
    """Drop kept paths matching any deny glob.

    Called twice: once after the allowlist match (so denied binaries don't
    drag in extra .so deps via close_elf), and once after .so closure (so
    libs pulled in transitively can still be excluded — useful when the
    same lib is provided by a neighbouring image layer and we only need
    it once in the final rootfs)."""
    root_real = rootfs.resolve()
    survivors = set()
    dropped = 0
    for p in kept:
        rel = "/" + str(p.relative_to(root_real)).replace(os.sep, "/")
        if matches_any(rel, deny_globs):
            dropped += 1
            continue
        survivors.add(p)
    if dropped:
        log(f"denylist ({stage}) dropped {dropped} paths")
    return survivors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rootfs", required=True, type=Path)
    parser.add_argument("--keepfile", required=True, type=Path)
    parser.add_argument("--denyfile", required=False, default=None, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    # --rootfs always names the exact root. Never auto-follow a child named
    # "rootfs": an archive-controlled symlink there could otherwise make the
    # build walk and package host files.
    try:
        rootfs_metadata = args.rootfs.lstat()
    except FileNotFoundError:
        rootfs_metadata = None
    if (
        rootfs_metadata is None
        or not stat.S_ISDIR(rootfs_metadata.st_mode)
        or args.rootfs.is_symlink()
    ):
        log(f"error: rootfs is not a directory: {args.rootfs}")
        return 1
    # Resolve up front: the path-set logic compares against
    # rootfs.resolve(), so a relative --rootfs would never match.
    rootfs: Path = args.rootfs.resolve()

    globs = read_globs(args.keepfile)
    log(f"loaded {len(globs)} allowlist entries")

    kept = walk_kept(rootfs, globs)
    log(f"after allowlist: {len(kept)} paths")

    deny_globs: list[str] = []
    if args.denyfile is not None:
        deny_globs = read_globs(args.denyfile)
        log(f"loaded {len(deny_globs)} denylist entries")
        kept = apply_denylist(rootfs, kept, deny_globs, stage="pre-closure")

    kept = close_symlinks(rootfs, kept)
    log(f"after symlink closure: {len(kept)} paths")

    kept = close_elf(rootfs, kept)
    log(f"after ELF closure: {len(kept)} paths")

    if deny_globs:
        kept = apply_denylist(rootfs, kept, deny_globs, stage="post-closure")

    kept = ensure_parent_dirs(rootfs, kept)
    log(f"after parent-dir fill: {len(kept)} paths")

    write_tar(rootfs, kept, args.out)
    log(f"wrote {args.out} ({args.out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
