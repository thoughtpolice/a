#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0
"""
Build an OCI image from scratch: one or more tar layers + config, no base.

Unlike `buck/lib/oci:oci_image`, this does not inherit a base image's
layers — the resulting image contains ONLY the provided tars. Written
for `src/images/minimos/` where we want a true Bottlerocket-style
appliance image.

Usage:
  scratch_image.py \\
      --output DIR \\
      --layer layer1.tar[.gz] [--layer layer2.tar ...] \\
      [--cmd CMD] [--env KEY=VAL]... [--label KEY=VAL]... \\
      [--user USER] [--workdir DIR] [--port N/tcp]... [--arch amd64]

The output is an OCI image layout directory (with `oci-layout`,
`index.json`, and a `blobs/sha256/` tree). Tag it `latest`.
"""

import argparse
from collections import deque
from contextlib import ExitStack
from dataclasses import dataclass
import gzip
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath


MAX_LAYER_ENTRIES = 200_000
MAX_LAYER_FILE_SIZE = 2 * 1024 * 1024 * 1024
MAX_LAYER_CONTENT_SIZE = 4 * 1024 * 1024 * 1024
MAX_LAYER_STREAM_SIZE = 5 * 1024 * 1024 * 1024
MAX_LAYER_BLOB_SIZE = 8 * 1024 * 1024 * 1024
REPRODUCIBLE_CREATED = "1970-01-01T00:00:00Z"
MAX_JSON_BLOB_SIZE = 4 * 1024 * 1024
MAX_IMAGE_LAYERS = 128

# systemd loads drop-ins from "<unit>.d/", but also from type-wide "<type>.d/"
# and truncated-prefix "<prefix>-.<type>.d/" directories, both of which apply
# to every matching unit at once. A composition may configure the units it
# ships; it may not reconfigure the base's by dropping a file into one of
# these. "nginx.service.d" and "user@.service.d" name one concrete unit and
# stay allowed; "service.d" and "user-.slice.d" do not.
_UNIT_TYPES = (
    "service", "socket", "target", "device", "mount", "automount",
    "swap", "timer", "path", "slice", "scope",
)
_WILDCARD_DROPIN = re.compile(
    r"(?:{types}|.*-\.(?:{types}))\.d".format(types="|".join(_UNIT_TYPES))
)


class UnsafeLayerError(ValueError):
    """A layer violates the minimos extraction and privilege policy."""


@dataclass(frozen=True)
class LayerEntry:
    """Extraction-relevant metadata retained for effective-rootfs checks."""

    kind: str
    mode: int
    uid: int
    gid: int
    linkname: str | None = None

    def directory_metadata(self) -> tuple[int, int, int]:
        return (self.mode, self.uid, self.gid)


@dataclass(frozen=True)
class CompositionPolicy:
    """Where a layer stacked on the minimos base may write.

    Default-deny: a composition layer may create a path only underneath a
    `composable` prefix, and never underneath a `sealed` one. The longest
    matching prefix decides and a tie is sealed, so `sealed` can carve a
    directory out of a composable subtree and `composable` can reopen one
    named file inside it.

    This is deliberately the inverse of an allow-everything-then-name-the-
    dangerous-bits policy: a search directory nobody has thought about —
    a new systemd unit path, a new sysctl.d, an ld.so hook — is refused
    because it was never opened, not permitted because it was never denied.

    Replacement is handled separately and unconditionally: a composition
    layer may not redefine any path a lower layer established, whatever the
    prefix lists say.
    """

    composable: frozenset = frozenset()
    sealed: frozenset = frozenset()
    enforce: bool = False

    def allows_new(self, name: str) -> bool:
        if any(_WILDCARD_DROPIN.fullmatch(part) for part in name.split("/")):
            return False
        best, allowed = -1, False
        for prefix in self.composable:
            if (name == prefix or name.startswith(prefix + "/")) and len(prefix) > best:
                best, allowed = len(prefix), True
        for prefix in self.sealed:
            if (name == prefix or name.startswith(prefix + "/")) and len(prefix) >= best:
                best, allowed = len(prefix), False
        return allowed


class BoundedReader:
    """Bound all decompressed tar bytes, including PAX/longname/padding."""

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
            raise UnsafeLayerError(
                f"decompressed layer exceeds {self.limit} bytes"
            )
        return data

    def readinto(self, buffer) -> int:
        data = self.read(len(buffer))
        buffer[:len(data)] = data
        return len(data)


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 16):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


def is_gzip(path: Path) -> bool:
    with open(path, "rb") as f:
        return f.read(2) == b"\x1f\x8b"


def sha256_uncompressed(path: Path) -> str:
    """diffID: sha256 of the uncompressed tar stream."""
    h = hashlib.sha256()
    with ExitStack() as stack:
        raw = stack.enter_context(open(path, "rb"))
        stream = (
            stack.enter_context(gzip.GzipFile(fileobj=raw))
            if is_gzip(path)
            else raw
        )
        bounded = BoundedReader(stream, MAX_LAYER_STREAM_SIZE)
        while chunk := bounded.read(1 << 16):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


def canonical_member_name(name: str) -> str:
    if not name or "\x00" in name:
        raise UnsafeLayerError("layer member name is empty or contains NUL")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part == ".." for part in path.parts):
        raise UnsafeLayerError(f"layer member escapes image root: {name!r}")
    parts = tuple(part for part in path.parts if part not in ("", "."))
    canonical = "/".join(parts)
    if not canonical or canonical != name.rstrip("/"):
        raise UnsafeLayerError(f"layer member is not canonical: {name!r}")
    if any(part.startswith(".wh.") for part in parts):
        raise UnsafeLayerError(f"OCI whiteouts are forbidden in minimos layers: {name!r}")
    return canonical


def validate_link_target(member: str, target: str) -> None:
    if not target or "\x00" in target:
        raise UnsafeLayerError(f"symlink {member!r} has an invalid target")
    if target.startswith("//"):
        raise UnsafeLayerError(
            f"symlink {member!r} has an ambiguous target: {target!r}"
        )
    link = PurePosixPath(target)
    depth = 0 if link.is_absolute() else len(PurePosixPath(member).parts) - 1
    for part in link.parts:
        if part in ("", ".", "/"):
            continue
        if part.startswith("/"):
            raise UnsafeLayerError(
                f"symlink {member!r} has an absolute path component: {target!r}"
            )
        if part == "..":
            if depth == 0:
                raise UnsafeLayerError(
                    f"symlink {member!r} escapes image root: {target!r}"
                )
            depth -= 1
        else:
            depth += 1


def validate_layer(path: Path) -> dict[str, LayerEntry]:
    """Validate every extraction-relevant field and retain ordered metadata."""
    entries: dict[str, LayerEntry] = {}
    total_size = 0
    try:
        stack = ExitStack()
        raw = stack.enter_context(open(path, "rb"))
        stream = (
            stack.enter_context(gzip.GzipFile(fileobj=raw))
            if is_gzip(path)
            else raw
        )
        bounded = BoundedReader(stream, MAX_LAYER_STREAM_SIZE)
        # Stream mode ensures skipped file bodies, PAX records, GNU long-name
        # records, and tar padding all pass through the byte budget.
        archive = stack.enter_context(tarfile.open(fileobj=bounded, mode="r|"))
    except (tarfile.TarError, OSError, EOFError) as error:
        try:
            stack.close()
        except UnboundLocalError:
            pass
        raise UnsafeLayerError(f"layer is not a readable tar archive: {path}") from error
    with stack:
        for count, member in enumerate(archive, start=1):
            if count > MAX_LAYER_ENTRIES:
                raise UnsafeLayerError(f"layer has more than {MAX_LAYER_ENTRIES} entries")
            name = canonical_member_name(member.name)
            if name in entries:
                raise UnsafeLayerError(f"duplicate layer destination: {name}")
            if member.size < 0 or member.size > MAX_LAYER_FILE_SIZE:
                raise UnsafeLayerError(f"layer member has invalid size: {name}")
            total_size += member.size
            if total_size > MAX_LAYER_CONTENT_SIZE:
                raise UnsafeLayerError("layer expanded content exceeds size limit")

            mode = member.mode
            if mode < 0 or mode > 0o7777:
                raise UnsafeLayerError(f"layer entry has an invalid mode: {name}")
            if member.uid < 0 or member.uid > 2**31 - 1:
                raise UnsafeLayerError(f"layer entry has an invalid uid: {name}")
            if member.gid < 0 or member.gid > 2**31 - 1:
                raise UnsafeLayerError(f"layer entry has an invalid gid: {name}")
            if mode & (stat.S_ISUID | stat.S_ISGID):
                raise UnsafeLayerError(f"setuid/setgid layer entry: {name}")
            if member.isdir():
                if mode & stat.S_IWOTH and not mode & stat.S_ISVTX:
                    raise UnsafeLayerError(
                        f"world-writable non-sticky layer directory: {name}"
                    )
                kind = "directory"
            elif member.isreg():
                if mode & stat.S_IWOTH:
                    raise UnsafeLayerError(f"world-writable layer file: {name}")
                kind = "regular"
            elif member.issym():
                validate_link_target(name, member.linkname)
                kind = "symlink"
            else:
                raise UnsafeLayerError(
                    f"unsupported layer entry type {member.type!r}: {name}"
                )
            if getattr(member, "sparse", None):
                raise UnsafeLayerError(f"sparse layer entries are forbidden: {name}")
            for key in member.pax_headers:
                lowered = key.lower()
                if any(token in lowered for token in (
                    "xattr", "acl", "capability", "selinux", "trusted.",
                )):
                    raise UnsafeLayerError(
                        f"extraction-affecting PAX metadata is forbidden: {name} ({key})"
                    )
            entries[name] = LayerEntry(
                kind=kind,
                mode=mode,
                uid=member.uid,
                gid=member.gid,
                linkname=member.linkname if member.issym() else None,
            )
    return entries


def _link_parts(parent: list[str], target: str) -> list[str]:
    """Interpret a validated symlink target relative to the image root."""
    if not target or "\x00" in target:
        raise UnsafeLayerError("symlink has an empty or NUL-containing target")
    if target.startswith("//"):
        raise UnsafeLayerError(
            f"symlink has an ambiguous double-slash target: {target!r}"
        )
    output = [] if target.startswith("/") else list(parent)
    for part in PurePosixPath(target).parts:
        if part in ("", ".", "/"):
            continue
        if part.startswith("/"):
            raise UnsafeLayerError(f"absolute symlink component: {target!r}")
        if part == "..":
            if not output:
                raise UnsafeLayerError(f"symlink escapes image root: {target!r}")
            output.pop()
        else:
            output.append(part)
    return output


def resolve_state_path(name: str, state: dict[str, LayerEntry], *,
                       follow_final: bool) -> str:
    """Resolve a member against the effective lower/current image state."""
    pending = deque(canonical_member_name(name).split("/"))
    resolved: list[str] = []
    followed = 0
    while pending:
        part = pending.popleft()
        if not part or part == ".." or part.startswith("/"):
            raise UnsafeLayerError(f"unsafe effective-rootfs component: {part!r}")
        candidate = "/".join(resolved + [part])
        entry = state.get(candidate)
        final = not pending
        if entry is not None and entry.kind == "symlink" and (
            follow_final or not final
        ):
            followed += 1
            if followed > 40:
                raise UnsafeLayerError(f"too many symlinks while resolving /{name}")
            if entry.linkname is None:
                raise UnsafeLayerError(f"symlink is missing a target: /{candidate}")
            pending = deque(_link_parts(resolved, entry.linkname) + list(pending))
            resolved = []
            continue
        if entry is not None and entry.kind != "directory" and not final:
            raise UnsafeLayerError(
                f"layer path /{name} descends through non-directory /{candidate}"
            )
        resolved.append(part)
    return "/".join(resolved)


def _ancestors(name: str) -> list[str]:
    parts = name.split("/")
    return ["/".join(parts[:index]) for index in range(1, len(parts))]


def apply_layer_state(entries: dict[str, LayerEntry], state: dict[str, LayerEntry],
                      parents_with_children: set[str], policy: CompositionPolicy,
                      layer: Path) -> None:
    """Merge a layer while enforcing policy against effective destinations."""
    destinations: set[str] = set()
    for lexical_name, entry in entries.items():
        name = resolve_state_path(lexical_name, state, follow_final=False)
        if name in destinations:
            raise UnsafeLayerError(
                f"duplicate effective destination in {layer}: /{name}"
            )
        destinations.add(name)

        existing = state.get(name)
        if existing is not None and existing.kind != entry.kind:
            raise UnsafeLayerError(
                f"layer {layer} changes entry type at /{name}: "
                f"{existing.kind} -> {entry.kind}"
            )
        if entry.kind != "directory" and name in parents_with_children:
            raise UnsafeLayerError(
                f"layer {layer} replaces non-empty directory /{name}"
            )

        if policy.enforce:
            if existing is not None:
                # Restating an ancestor directory with identical ownership and
                # mode is how every composition overlay declares its parents.
                # Anything else redefines what a lower layer established —
                # a binary, a unit, a library, an account file.
                if not (
                    entry.kind == "directory"
                    and existing.kind == "directory"
                    and entry.directory_metadata() == existing.directory_metadata()
                ):
                    raise UnsafeLayerError(
                        f"composition layer {layer} replaces /{name}, which a "
                        f"lower layer established"
                    )
            elif not policy.allows_new(name):
                raise UnsafeLayerError(
                    f"composition layer {layer} writes /{name}, which is not "
                    f"under a composable path"
                )

        state[name] = entry
        parents_with_children.update(_ancestors(name))


def _descriptor_blob(layout: Path, descriptor: dict, *, what: str,
                     max_size: int | None = None) -> Path:
    digest = descriptor.get("digest")
    size = descriptor.get("size")
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise UnsafeLayerError(f"{what} has an invalid digest")
    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
        raise UnsafeLayerError(f"{what} has an invalid size")
    if max_size is not None and size > max_size:
        raise UnsafeLayerError(f"{what} exceeds {max_size} bytes")
    blob = layout / "blobs" / "sha256" / digest.removeprefix("sha256:")
    try:
        metadata = blob.lstat()
    except FileNotFoundError as error:
        raise UnsafeLayerError(f"{what} blob is missing: {digest}") from error
    if not stat.S_ISREG(metadata.st_mode) or blob.is_symlink():
        raise UnsafeLayerError(f"{what} blob is not a regular file: {digest}")
    if metadata.st_size != size:
        raise UnsafeLayerError(f"{what} size does not match descriptor: {digest}")
    if sha256_file(blob) != digest:
        raise UnsafeLayerError(f"{what} digest does not match content: {digest}")
    return blob


def _read_json(path: Path, *, what: str) -> dict:
    if path.stat().st_size > MAX_JSON_BLOB_SIZE:
        raise UnsafeLayerError(f"{what} JSON exceeds {MAX_JSON_BLOB_SIZE} bytes")
    try:
        value = json.loads(path.read_bytes())
    except (json.JSONDecodeError, OSError) as error:
        raise UnsafeLayerError(f"{what} is not valid JSON") from error
    if not isinstance(value, dict):
        raise UnsafeLayerError(f"{what} JSON is not an object")
    return value


def validate_oci_layout(layout: Path, *, base_layer_count: int = 0,
                        policy: CompositionPolicy | None = None) -> dict:
    """Validate a complete minimos OCI layout and its effective layer state."""
    try:
        layout_metadata = layout.lstat()
    except FileNotFoundError:
        layout_metadata = None
    if (
        layout_metadata is None
        or not stat.S_ISDIR(layout_metadata.st_mode)
        or layout.is_symlink()
    ):
        raise UnsafeLayerError(f"OCI layout is not a directory: {layout}")
    layout = layout.resolve()
    oci_layout_path = layout / "oci-layout"
    if not oci_layout_path.is_file() or oci_layout_path.is_symlink():
        raise UnsafeLayerError("OCI oci-layout is missing or unsafe")
    oci_layout = _read_json(oci_layout_path, what="OCI layout metadata")
    if oci_layout != {"imageLayoutVersion": "1.0.0"}:
        raise UnsafeLayerError("OCI layout metadata has an unsupported version")

    index_path = layout / "index.json"
    if not index_path.is_file() or index_path.is_symlink():
        raise UnsafeLayerError("OCI index.json is missing or unsafe")
    index = _read_json(index_path, what="OCI index")
    if index.get("schemaVersion") != 2:
        raise UnsafeLayerError("OCI index has an unsupported schema version")
    if index.get("mediaType") != "application/vnd.oci.image.index.v1+json":
        raise UnsafeLayerError("OCI index has an unsupported media type")
    manifests = index.get("manifests")
    if not isinstance(manifests, list) or len(manifests) != 1:
        raise UnsafeLayerError("OCI index must reference exactly one manifest")
    manifest_descriptor = manifests[0]
    if not isinstance(manifest_descriptor, dict):
        raise UnsafeLayerError("OCI manifest descriptor is not an object")
    if manifest_descriptor.get("mediaType") != "application/vnd.oci.image.manifest.v1+json":
        raise UnsafeLayerError("OCI index references an unsupported manifest type")
    manifest_blob = _descriptor_blob(
        layout,
        manifest_descriptor,
        what="OCI manifest",
        max_size=MAX_JSON_BLOB_SIZE,
    )
    manifest = _read_json(manifest_blob, what="OCI manifest")
    if manifest.get("schemaVersion") != 2:
        raise UnsafeLayerError("OCI manifest has an unsupported schema version")
    if manifest.get("mediaType") != "application/vnd.oci.image.manifest.v1+json":
        raise UnsafeLayerError("OCI manifest has an unsupported media type")

    config_descriptor = manifest.get("config")
    if not isinstance(config_descriptor, dict):
        raise UnsafeLayerError("OCI manifest config descriptor is invalid")
    if config_descriptor.get("mediaType") != "application/vnd.oci.image.config.v1+json":
        raise UnsafeLayerError("OCI manifest references an unsupported config type")
    config_blob = _descriptor_blob(
        layout, config_descriptor, what="OCI config", max_size=MAX_JSON_BLOB_SIZE
    )
    config = _read_json(config_blob, what="OCI config")

    layers = manifest.get("layers")
    if not isinstance(layers, list) or not layers or len(layers) > MAX_IMAGE_LAYERS:
        raise UnsafeLayerError("OCI manifest has an invalid layer count")
    if base_layer_count < 0 or base_layer_count > len(layers):
        raise UnsafeLayerError("OCI base layer count is invalid")

    rootfs = config.get("rootfs")
    if not isinstance(rootfs, dict) or rootfs.get("type") != "layers":
        raise UnsafeLayerError("OCI config has an invalid rootfs")
    diff_ids = rootfs.get("diff_ids")
    if (
        not isinstance(diff_ids, list)
        or len(diff_ids) != len(layers)
        or not all(
            isinstance(item, str)
            and re.fullmatch(r"sha256:[0-9a-f]{64}", item)
            for item in diff_ids
        )
    ):
        raise UnsafeLayerError("OCI config has invalid rootfs diff_ids")

    policy = policy or CompositionPolicy()
    effective_state: dict[str, LayerEntry] = {}
    parents_with_children: set[str] = set()
    computed_diff_ids: list[str] = []
    for index, descriptor in enumerate(layers):
        if not isinstance(descriptor, dict):
            raise UnsafeLayerError(f"OCI layer {index} descriptor is invalid")
        media_type = descriptor.get("mediaType")
        if media_type not in {
            "application/vnd.oci.image.layer.v1.tar",
            "application/vnd.oci.image.layer.v1.tar+gzip",
        }:
            raise UnsafeLayerError(f"OCI layer {index} has an unsupported media type")
        blob = _descriptor_blob(
            layout,
            descriptor,
            what=f"OCI layer {index}",
            max_size=MAX_LAYER_BLOB_SIZE,
        )
        compressed = is_gzip(blob)
        if compressed != media_type.endswith("+gzip"):
            raise UnsafeLayerError(
                f"OCI layer {index} compression disagrees with its media type"
            )
        entries = validate_layer(blob)
        apply_layer_state(
            entries,
            effective_state,
            parents_with_children,
            policy if index >= base_layer_count else CompositionPolicy(),
            blob,
        )
        computed_diff_ids.append(sha256_uncompressed(blob))
    if computed_diff_ids != diff_ids:
        raise UnsafeLayerError("OCI config diff_ids do not match layer contents")

    architecture = config.get("architecture")
    operating_system = config.get("os")
    if not isinstance(architecture, str) or not architecture:
        raise UnsafeLayerError("OCI config has an invalid architecture")
    if not isinstance(operating_system, str) or not operating_system:
        raise UnsafeLayerError("OCI config has an invalid operating system")
    platform = manifest_descriptor.get("platform")
    if not isinstance(platform, dict) or (
        platform.get("architecture") != architecture
        or platform.get("os") != operating_system
    ):
        raise UnsafeLayerError("OCI index platform disagrees with the config")
    return config


def build_policy(composable, sealed) -> CompositionPolicy:
    """A CompositionPolicy from CLI prefixes; empty lists mean no enforcement."""
    composable = {canonical_member_name(item) for item in composable or []}
    sealed = {canonical_member_name(item) for item in sealed or []}
    return CompositionPolicy(
        composable=frozenset(composable),
        sealed=frozenset(sealed),
        enforce=bool(composable),
    )


def copy_to_blob(src: Path, output: Path, digest: str) -> None:
    algo, hex_ = digest.split(":", 1)
    dst_dir = output / "blobs" / algo
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / hex_
    if not dst.exists():
        shutil.copyfile(src, dst)


def write_blob(data: bytes, output: Path, digest: str) -> None:
    algo, hex_ = digest.split(":", 1)
    dst_dir = output / "blobs" / algo
    dst_dir.mkdir(parents=True, exist_ok=True)
    (dst_dir / hex_).write_bytes(data)


def kv_pairs(raw: list[str] | None) -> dict[str, str]:
    out: dict[str, str] = {}
    for item in raw or []:
        if "=" not in item:
            raise ValueError(f"expected KEY=VALUE, got {item!r}")
        k, v = item.split("=", 1)
        if not k or "\x00" in k or "\x00" in v:
            raise ValueError(f"invalid KEY=VALUE item: {item!r}")
        if k in out:
            raise ValueError(f"duplicate key: {k}")
        out[k] = v
    return out


def main() -> int:
    if len(sys.argv) >= 2 and sys.argv[1] == "--validate-layout":
        validator = argparse.ArgumentParser(description="validate a minimos OCI layout")
        validator.add_argument("--validate-layout", required=True, type=Path)
        validator.add_argument("--expected-cmd")
        validator.add_argument("--base-layer-count", default=0, type=int)
        validator.add_argument("--composable-path", action="append", default=[])
        validator.add_argument("--sealed-path", action="append", default=[])
        validation_args = validator.parse_args()
        try:
            config = validate_oci_layout(
                validation_args.validate_layout,
                base_layer_count=validation_args.base_layer_count,
                policy=build_policy(
                    validation_args.composable_path, validation_args.sealed_path
                ),
            )
        except (UnsafeLayerError, OSError) as error:
            print(f"scratch_image: invalid OCI layout: {error}", file=sys.stderr)
            return 1
        command = config.get("config", {}).get("Cmd")
        if not isinstance(command, list) or not command or not all(
            isinstance(item, str) and item for item in command
        ):
            print("scratch_image: OCI config has no valid Cmd", file=sys.stderr)
            return 1
        if validation_args.expected_cmd is not None:
            expected = [item for item in validation_args.expected_cmd.split(",") if item]
            if command != expected:
                print(
                    f"scratch_image: OCI Cmd mismatch: expected {expected!r}, got {command!r}",
                    file=sys.stderr,
                )
                return 1
        print("scratch_image: OCI layout and referenced layers are valid", file=sys.stderr)
        return 0

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument("--layer", action="append", default=[], type=Path,
                    help="tar file to add as a layer (in order; first = bottom)")
    ap.add_argument("--cmd", help="comma-separated argv for Cmd")
    ap.add_argument("--entrypoint", help="comma-separated argv for Entrypoint")
    ap.add_argument("--env", action="append", default=[], help="KEY=VAL")
    ap.add_argument("--label", action="append", default=[], help="KEY=VAL")
    ap.add_argument("--user", help="User field (e.g. root, 1000, 1000:1000)")
    ap.add_argument("--workdir", help="WorkingDir")
    ap.add_argument("--port", action="append", default=[], help="e.g. 22/tcp")
    ap.add_argument("--volume", action="append", default=[], help="mount point")
    ap.add_argument("--arch", default="amd64")
    ap.add_argument("--os", default="linux")
    ap.add_argument("--tag", default="latest")
    ap.add_argument("--base-layer-count", default=0, type=int,
                    help="number of trusted base layers before the policy applies")
    ap.add_argument("--composable-path", action="append", default=[],
                    help="prefix a composition layer may create new paths under")
    ap.add_argument("--sealed-path", action="append", default=[],
                    help="prefix that stays base-only, even inside a composable one")
    ap.add_argument("--created", default=REPRODUCIBLE_CREATED,
                    help="fixed RFC3339 image creation timestamp")
    args = ap.parse_args()

    if not args.layer:
        print("scratch_image: need at least one --layer", file=sys.stderr)
        return 1
    if len(args.layer) > MAX_IMAGE_LAYERS:
        print(
            f"scratch_image: more than {MAX_IMAGE_LAYERS} layers",
            file=sys.stderr,
        )
        return 1

    final_output: Path = args.output
    resolved_output = final_output.resolve(strict=False)
    if (
        final_output.is_symlink()
        or resolved_output == Path("/")
        or resolved_output == Path.cwd().resolve()
    ):
        print(f"scratch_image: refusing unsafe output path: {final_output}", file=sys.stderr)
        return 1
    if final_output.exists() and (
        not final_output.is_dir() or any(final_output.iterdir())
    ):
        print(
            f"scratch_image: refusing to replace non-empty output: {final_output}",
            file=sys.stderr,
        )
        return 1
    final_output.parent.mkdir(parents=True, exist_ok=True)
    workspace = tempfile.TemporaryDirectory(
        prefix=f".{final_output.name}.minimos-", dir=final_output.parent
    )
    workspace_path = Path(workspace.name)
    output = workspace_path / "layout"
    output.mkdir(parents=True)
    snapshots = workspace_path / "inputs"
    snapshots.mkdir()
    (output / "blobs" / "sha256").mkdir(parents=True, exist_ok=True)
    (output / "oci-layout").write_text(
        json.dumps({"imageLayoutVersion": "1.0.0"}, indent=2)
    )

    layer_descriptors = []
    diff_ids = []
    policy = build_policy(args.composable_path, args.sealed_path)
    if args.base_layer_count < 0 or args.base_layer_count > len(args.layer):
        print("scratch_image: invalid --base-layer-count", file=sys.stderr)
        return 1
    effective_state: dict[str, LayerEntry] = {}
    parents_with_children: set[str] = set()
    for index, source_layer in enumerate(args.layer):
        source_layer = Path(source_layer)
        try:
            source_fd = os.open(
                source_layer,
                os.O_RDONLY | os.O_CLOEXEC,
            )
        except (FileNotFoundError, OSError) as error:
            raise UnsafeLayerError(f"layer input is missing: {source_layer}") from error
        # All subsequent validation, hashing, and copying use one private
        # descriptor-backed snapshot, closing direct-CLI pathname replacement
        # races while still accepting Buck's declared-input symlinks.
        layer = snapshots / f"{index}.layer"
        try:
            source_metadata = os.fstat(source_fd)
            if (
                not stat.S_ISREG(source_metadata.st_mode)
                or source_metadata.st_size < 0
                or source_metadata.st_size > MAX_LAYER_BLOB_SIZE
            ):
                raise UnsafeLayerError(
                    f"layer input is not a bounded regular file: {source_layer}"
                )
            remaining = source_metadata.st_size
            with os.fdopen(os.dup(source_fd), "rb") as source, open(
                layer, "xb"
            ) as snapshot:
                while remaining:
                    chunk = source.read(min(1 << 20, remaining))
                    if not chunk:
                        raise UnsafeLayerError(
                            f"layer input changed while copying: {source_layer}"
                        )
                    snapshot.write(chunk)
                    remaining -= len(chunk)
        finally:
            os.close(source_fd)
        layer.chmod(0o400)
        entries = validate_layer(layer)
        apply_layer_state(
            entries,
            effective_state,
            parents_with_children,
            policy if index >= args.base_layer_count else CompositionPolicy(),
            # Validation reads the private snapshot, but a policy violation is
            # something a person has to go fix: name the layer they declared.
            source_layer,
        )
        layer_digest = sha256_file(layer)
        copy_to_blob(layer, output, layer_digest)
        diff_ids.append(sha256_uncompressed(layer))
        media_type = (
            "application/vnd.oci.image.layer.v1.tar+gzip"
            if is_gzip(layer)
            else "application/vnd.oci.image.layer.v1.tar"
        )
        layer_descriptors.append({
            "mediaType": media_type,
            "digest": layer_digest,
            "size": layer.stat().st_size,
        })

    created = args.created

    env_list = [f"{k}={v}" for k, v in kv_pairs(args.env).items()]
    cfg: dict = {
        "Env": env_list,
    }
    if args.cmd:
        cfg["Cmd"] = [s for s in args.cmd.split(",") if s]
    if args.entrypoint:
        cfg["Entrypoint"] = [s for s in args.entrypoint.split(",") if s]
    if args.user:
        cfg["User"] = args.user
    if args.workdir:
        cfg["WorkingDir"] = args.workdir
    if args.port:
        cfg["ExposedPorts"] = {p: {} for p in args.port}
    if args.volume:
        cfg["Volumes"] = {v: {} for v in args.volume}
    labels = kv_pairs(args.label)
    if labels:
        cfg["Labels"] = labels

    image_config = {
        "created": created,
        "architecture": args.arch,
        "os": args.os,
        "config": cfg,
        "rootfs": {
            "type": "layers",
            "diff_ids": diff_ids,
        },
        "history": [
            {"created": created, "created_by": f"scratch_image.py (layer {i + 1}/{len(diff_ids)})"}
            for i in range(len(diff_ids))
        ],
    }

    config_json = json.dumps(image_config, indent=2, sort_keys=True).encode()
    config_digest = sha256_bytes(config_json)
    write_blob(config_json, output, config_digest)

    manifest = {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": {
            "mediaType": "application/vnd.oci.image.config.v1+json",
            "digest": config_digest,
            "size": len(config_json),
        },
        "layers": layer_descriptors,
    }
    manifest_json = json.dumps(manifest, indent=2, sort_keys=True).encode()
    manifest_digest = sha256_bytes(manifest_json)
    write_blob(manifest_json, output, manifest_digest)

    index = {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": [{
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "digest": manifest_digest,
            "size": len(manifest_json),
            "annotations": {"org.opencontainers.image.ref.name": args.tag},
            "platform": {"architecture": args.arch, "os": args.os},
        }],
    }
    (output / "index.json").write_text(
        json.dumps(index, indent=2, sort_keys=True)
    )

    # Re-read the completed layout through the same release-gate validator used
    # by the boot smoke. This cross-checks descriptors, diff IDs, and effective
    # composition-policy semantics before the directory is published.
    validate_oci_layout(
        output,
        base_layer_count=args.base_layer_count,
        policy=policy,
    )

    # Publish only a complete layout. Buck normally supplies an absent output;
    # a pre-created empty directory is also safe to replace. Non-empty paths
    # are never recursively deleted by this tool.
    if final_output.exists():
        if final_output.is_symlink() or not final_output.is_dir() or any(final_output.iterdir()):
            raise UnsafeLayerError(f"output changed while building: {final_output}")
        final_output.rmdir()
    os.replace(output, final_output)
    workspace.cleanup()
    print(
        f"scratch_image: wrote {final_output} ({len(args.layer)} layers)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
