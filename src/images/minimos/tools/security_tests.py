# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Adversarial tests for minimos's archive and OCI build boundary."""

import importlib.util
import hashlib
import io
import json
import os
import re
import sys
import tarfile
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path


TOOL_PATHS = tuple(sys.argv[1:])


def load_module(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@contextmanager
def argv(*items: str):
    original = sys.argv
    sys.argv = list(items)
    try:
        yield
    finally:
        sys.argv = original


def tar_member(name: str, data: bytes = b"payload", mode: int = 0o644,
               kind: bytes = tarfile.REGTYPE, linkname: str = "") -> tarfile.TarInfo:
    member = tarfile.TarInfo(name)
    member.type = kind
    member.mode = mode
    member.linkname = linkname
    member.size = len(data) if kind == tarfile.REGTYPE else 0
    return member


def write_tar(path: Path, members: list[tuple[tarfile.TarInfo, bytes]],
              *, gzip: bool = False) -> None:
    mode = "w:gz" if gzip else "w"
    with tarfile.open(path, mode) as archive:
        for member, data in members:
            archive.addfile(member, io.BytesIO(data) if member.isreg() else None)


class SecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if len(TOOL_PATHS) != 6:
            raise RuntimeError(
                "expected paths to mkapkroot, cull, mkoverlay, scratch_image, "
                "extract_one, defs.bzl"
            )
        cls.mkapkroot = load_module("minimos_mkapkroot", TOOL_PATHS[0])
        cls.cull = load_module("minimos_cull", TOOL_PATHS[1])
        cls.mkoverlay = load_module("minimos_mkoverlay", TOOL_PATHS[2])
        cls.scratch = load_module("minimos_scratch_image", TOOL_PATHS[3])
        cls.extract_one = load_module("minimos_extract_one", TOOL_PATHS[4])
        cls.defs_bzl = Path(TOOL_PATHS[5])

    def make_apk(self, directory: Path,
                 members: list[tuple[tarfile.TarInfo, bytes]]) -> Path:
        apk = directory / "fixture.apk"
        write_tar(apk, members, gzip=True)
        return apk

    @staticmethod
    def write_json_blob(layout: Path, value: dict) -> tuple[str, int]:
        data = json.dumps(value, indent=2, sort_keys=True).encode()
        digest = "sha256:" + hashlib.sha256(data).hexdigest()
        (layout / "blobs" / "sha256" / digest.removeprefix("sha256:")).write_bytes(
            data
        )
        return digest, len(data)

    def read_layout_chain(self, layout: Path) -> tuple[dict, dict, dict]:
        index = json.loads((layout / "index.json").read_bytes())
        manifest_digest = index["manifests"][0]["digest"].removeprefix("sha256:")
        manifest = json.loads(
            (layout / "blobs" / "sha256" / manifest_digest).read_bytes()
        )
        config_digest = manifest["config"]["digest"].removeprefix("sha256:")
        config = json.loads(
            (layout / "blobs" / "sha256" / config_digest).read_bytes()
        )
        return index, manifest, config

    def publish_layout_chain(
        self, layout: Path, index: dict, manifest: dict, config: dict
    ) -> None:
        config_digest, config_size = self.write_json_blob(layout, config)
        manifest["config"]["digest"] = config_digest
        manifest["config"]["size"] = config_size
        manifest_digest, manifest_size = self.write_json_blob(layout, manifest)
        index["manifests"][0]["digest"] = manifest_digest
        index["manifests"][0]["size"] = manifest_size
        (layout / "index.json").write_text(
            json.dumps(index, indent=2, sort_keys=True)
        )

    def assert_apk_rejected(self, member: tarfile.TarInfo,
                            data: bytes = b"payload") -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            apk = self.make_apk(root, [(member, data)])
            with self.assertRaises(self.mkapkroot.UnsafeArchiveError):
                self.mkapkroot.extract_apk(apk, root / "rootfs")

    def test_apk_rejects_absolute_and_embedded_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            absolute = str(Path(tmp) / "outside")
            self.assert_apk_rejected(tar_member(absolute))
        self.assert_apk_rejected(tar_member("safe/../../outside"))

    def test_apk_rejects_escaping_symlink_and_hardlink(self) -> None:
        self.assert_apk_rejected(
            tar_member("link", b"", kind=tarfile.SYMTYPE, linkname="../../outside"),
            b"",
        )
        self.assert_apk_rejected(
            tar_member(
                "safe/link", b"", kind=tarfile.LNKTYPE,
                linkname="safe/../../outside",
            ),
            b"",
        )
        for target in ("//etc/passwd", "///etc/passwd", "/../../etc/passwd"):
            with self.subTest(target=target):
                self.assert_apk_rejected(
                    tar_member("link", b"", kind=tarfile.SYMTYPE, linkname=target),
                    b"",
                )

    def test_apk_does_not_follow_existing_final_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            rootfs = base / "rootfs"
            rootfs.mkdir()
            outside = base / "outside"
            outside.write_bytes(b"sentinel")
            (rootfs / "victim").symlink_to(outside)
            apk = self.make_apk(base, [(tar_member("victim", b"safe"), b"safe")])
            self.mkapkroot.extract_apk(apk, rootfs)
            self.assertEqual(outside.read_bytes(), b"sentinel")
            self.assertFalse((rootfs / "victim").is_symlink())
            self.assertEqual((rootfs / "victim").read_bytes(), b"safe")

    def test_apk_rejects_device_nodes(self) -> None:
        self.assert_apk_rejected(
            tar_member("dev/evil", b"", kind=tarfile.CHRTYPE), b""
        )

    def test_apk_counts_control_entries_and_decompressed_bytes(self) -> None:
        original_entries = self.mkapkroot.MAX_ENTRIES
        try:
            self.mkapkroot.MAX_ENTRIES = 0
            self.assert_apk_rejected(
                tar_member(".PKGINFO", b"metadata"), b"metadata"
            )
        finally:
            self.mkapkroot.MAX_ENTRIES = original_entries
        reader = self.mkapkroot.BoundedReader(io.BytesIO(b"abcd"), 3)
        with self.assertRaises(self.mkapkroot.UnsafeArchiveError):
            reader.read(4)

    def test_apk_charges_hardlink_expansion_and_normalizes_parents(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            apk = self.make_apk(
                base,
                [
                    (tar_member("new/file", b"12345678"), b"12345678"),
                    (
                        tar_member(
                            "new/alias",
                            b"",
                            kind=tarfile.LNKTYPE,
                            linkname="new/file",
                        ),
                        b"",
                    ),
                ],
            )
            original_limit = self.mkapkroot.MAX_TOTAL_SIZE
            try:
                self.mkapkroot.MAX_TOTAL_SIZE = 12
                with self.assertRaises(self.mkapkroot.UnsafeArchiveError):
                    self.mkapkroot.extract_apk(apk, base / "bounded")
            finally:
                self.mkapkroot.MAX_TOTAL_SIZE = original_limit

            roots = [base / "umask-022", base / "umask-077"]
            old_umask = os.umask(0o022)
            try:
                self.mkapkroot.extract_apk(apk, roots[0])
                os.umask(0o077)
                self.mkapkroot.extract_apk(apk, roots[1])
            finally:
                os.umask(old_umask)
            self.assertEqual(roots[0].joinpath("new").stat().st_mode & 0o777, 0o755)
            self.assertEqual(roots[1].joinpath("new").stat().st_mode & 0o777, 0o755)

    def test_globs_are_segment_aware(self) -> None:
        self.assertTrue(self.cull.matches_any("/usr/bin/tool", ["/usr/bin/*"]))
        self.assertFalse(
            self.cull.matches_any("/usr/bin/nested/tool", ["/usr/bin/*"])
        )
        self.assertTrue(
            self.cull.matches_any("/usr/bin/nested/tool", ["/usr/bin/**"])
        )

    def test_cull_rejects_root_escaping_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "rootfs"
            root.mkdir()
            link = root / "link"
            link.symlink_to("../../outside")
            with self.assertRaises(self.cull.UnsafeRootfsError):
                self.cull.close_symlinks(root, {link})

    def test_cull_rejects_double_slash_and_chained_escape(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "rootfs"
            root.mkdir()
            direct = root / "direct"
            direct.symlink_to("//etc/passwd")
            with self.assertRaises(self.cull.UnsafeRootfsError):
                self.cull.resolve_virtual(root, direct)

            first = root / "first"
            second = root / "second"
            first.symlink_to("second")
            second.symlink_to("//etc/passwd")
            with self.assertRaises(self.cull.UnsafeRootfsError):
                self.cull.resolve_virtual(root, first)

            (root / "etc").mkdir()
            image_passwd = root / "etc" / "passwd"
            image_passwd.write_bytes(b"image")
            safe = root / "safe"
            safe.symlink_to("/etc/passwd")
            resolved, _ = self.cull.resolve_virtual(root, safe)
            self.assertEqual(resolved, image_passwd)

    def test_cull_rejects_world_writable_regular_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root = base / "rootfs"
            root.mkdir()
            item = root / "item"
            item.write_bytes(b"data")
            item.chmod(0o666)
            with self.assertRaises(self.cull.UnsafeRootfsError):
                self.cull.write_tar(root, {item}, base / "out.tar")

    def test_cull_uses_exact_root_and_bounds_hardlink_output_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root = base / "image-root"
            outside = base / "outside"
            root.mkdir()
            outside.mkdir()
            (outside / "sentinel").write_bytes(b"host-like")
            (root / "rootfs").symlink_to(outside)
            keep = base / "keep"
            keep.write_text("/sentinel\n")
            output = base / "exact.tar"
            with argv(
                "cull.py",
                "--rootfs",
                str(root),
                "--keepfile",
                str(keep),
                "--out",
                str(output),
            ):
                self.assertEqual(self.cull.main(), 0)
            with tarfile.open(output) as archive:
                self.assertEqual(archive.getnames(), [])

            root_link = base / "root-link"
            root_link.symlink_to(root)
            with argv(
                "cull.py",
                "--rootfs",
                str(root_link),
                "--keepfile",
                str(keep),
                "--out",
                str(base / "rejected.tar"),
            ):
                self.assertEqual(self.cull.main(), 1)

            data = root / "data"
            alias = root / "alias"
            data.write_bytes(b"12345678")
            os.link(data, alias)
            previous = base / "previous.tar"
            previous.write_bytes(b"preserve-me")
            original_limit = self.cull.MAX_OUTPUT_CONTENT_SIZE
            try:
                self.cull.MAX_OUTPUT_CONTENT_SIZE = 12
                with self.assertRaises(self.cull.UnsafeRootfsError):
                    self.cull.write_tar(root, {data, alias}, previous)
            finally:
                self.cull.MAX_OUTPUT_CONTENT_SIZE = original_limit
            self.assertEqual(previous.read_bytes(), b"preserve-me")

    def test_overlay_rejects_unsafe_paths_modes_and_units(self) -> None:
        for name in ("/absolute", "a/../../escape", "a/./alias"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.mkoverlay.safe_arcname(name)
        with self.assertRaises(ValueError):
            self.mkoverlay.safe_link_target("a/link", "../../escape")
        for target in ("//etc/passwd", "///etc/passwd", "/../../etc/passwd"):
            with self.subTest(target=target), self.assertRaises(ValueError):
                self.mkoverlay.safe_link_target("a/link", target)
        self.assertEqual(
            self.mkoverlay.safe_link_target("a/link", "/etc/passwd"),
            "/etc/passwd",
        )
        with self.assertRaises(ValueError):
            self.mkoverlay.safe_mode(0o4755, directory=False)
        with self.assertRaises(ValueError):
            self.mkoverlay.safe_mode(0o666, directory=False)
        with self.assertRaises(ValueError):
            self.mkoverlay.safe_unit_name("../../evil.service")

    def test_overlay_publishes_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            source = base / "source"
            source.write_bytes(b"data")
            output = base / "overlay.tar"
            output.write_bytes(b"preserve-me")
            with argv(
                "mkoverlay.py",
                "--out",
                str(output),
                "--file",
                f"{source}:first",
                "--file",
                f"{base / 'missing'}:second",
            ), self.assertRaises(ValueError):
                self.mkoverlay.main()
            self.assertEqual(output.read_bytes(), b"preserve-me")

    def test_layer_validator_rejects_dangerous_metadata(self) -> None:
        fixtures = [
            tar_member("../escape"),
            tar_member(".wh.passwd"),
            tar_member("dev/evil", b"", kind=tarfile.CHRTYPE),
            tar_member("bin/suid", mode=0o4755),
            tar_member("tmp/open", mode=0o666),
            tar_member("link", b"", kind=tarfile.SYMTYPE, linkname="../../escape"),
            tar_member("double", b"", kind=tarfile.SYMTYPE,
                       linkname="//etc/passwd"),
            tar_member("absolute-up", b"", kind=tarfile.SYMTYPE,
                       linkname="/../../etc/passwd"),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            for index, member in enumerate(fixtures):
                path = base / f"bad-{index}.tar"
                data = b"payload" if member.isreg() else b""
                write_tar(path, [(member, data)])
                with self.subTest(member=member.name), self.assertRaises(
                    self.scratch.UnsafeLayerError
                ):
                    self.scratch.validate_layer(path)

    def test_layer_validator_rejects_duplicates_and_capabilities(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            duplicate = base / "duplicate.tar"
            write_tar(
                duplicate,
                [(tar_member("same", b"a"), b"a"),
                 (tar_member("same", b"b"), b"b")],
            )
            with self.assertRaises(self.scratch.UnsafeLayerError):
                self.scratch.validate_layer(duplicate)

            capability = tar_member("bin/cap")
            capability.pax_headers["SCHILY.xattr.security.capability"] = "AAAA"
            cap_layer = base / "cap.tar"
            write_tar(cap_layer, [(capability, b"payload")])
            with self.assertRaises(self.scratch.UnsafeLayerError):
                self.scratch.validate_layer(cap_layer)

    # The real policy, read out of defs.bzl so these tests exercise what ships
    # rather than a copy that can drift away from it.
    def shipped_policy(self):
        source = self.defs_bzl.read_text()

        def literal_list(name: str) -> set[str]:
            block = source.split(f"{name} = [", 1)[1].split("]", 1)[0]
            return set(re.findall(r'"([^"]+)"', block))

        composable = literal_list("_COMPOSABLE_PATHS")
        sealed = literal_list("_SEALED_PATHS")
        self.assertGreater(len(composable), 5)
        self.assertGreater(len(sealed), 20)
        return self.scratch.build_policy(composable, sealed)

    def base_state(self):
        """A miniature of the real base: merged-usr links and owned paths."""
        entry = self.scratch.LayerEntry
        directory = lambda mode=0o755: entry("directory", mode, 0, 0)
        regular = lambda mode=0o644: entry("regular", mode, 0, 0)
        symlink = lambda target: entry("symlink", 0o777, 0, 0, target)
        state: dict[str, object] = {}
        parents: set[str] = set()
        self.scratch.apply_layer_state(
            {
                "etc": directory(),
                "etc/passwd": regular(),
                "etc/systemd": directory(),
                "etc/systemd/system": directory(),
                "etc/systemd/system/minimos-harden.service": regular(),
                "etc/sysctl.d": directory(),
                "usr": directory(),
                "usr/bin": directory(),
                "usr/bin/bash": regular(0o755),
                "usr/lib": directory(),
                "usr/lib/systemd": directory(),
                "usr/lib/systemd/system-generators": directory(),
                "usr/lib/minimos": directory(),
                "usr/lib/minimos/login-shell": regular(0o755),
                "var": directory(),
                "lib": symlink("usr/lib"),
            },
            state,
            parents,
            self.scratch.CompositionPolicy(),
            Path("base"),
        )
        return state, parents

    def test_composition_policy_refuses_privileged_paths(self) -> None:
        entry = self.scratch.LayerEntry
        directory = lambda mode=0o755: entry("directory", mode, 0, 0)
        regular = lambda mode=0o644: entry("regular", mode, 0, 0)
        symlink = lambda target: entry("symlink", 0o777, 0, 0, target)
        policy = self.shipped_policy()
        state, parents = self.base_state()

        refused = {
            # Every one of these was accepted by the path-by-path policy this
            # replaced; each is a way to own the boot from a composition layer.
            "unit dir outranking /etc/systemd/system": {
                "etc/systemd/system.control": directory(),
                "etc/systemd/system.control/minimos-harden.service": symlink("/dev/null"),
            },
            "vendor generator directory": {
                "usr/lib/systemd/system-generators/00-evil": regular(0o755),
            },
            "/etc generator directory": {
                "etc/systemd/system-generators": directory(),
                "etc/systemd/system-generators/00-evil": regular(0o755),
            },
            "loader preload": {"etc/ld.so.preload": regular()},
            "type-wide service drop-in": {
                "etc/systemd/system/service.d": directory(),
                "etc/systemd/system/service.d/99-evil.conf": regular(),
            },
            "template slice drop-in": {
                "etc/systemd/system/user-.slice.d": directory(),
                "etc/systemd/system/user-.slice.d/99-evil.conf": regular(),
            },
            "name resolution": {"etc/nsswitch.conf": regular()},
            # Paths outside every composable prefix need no explicit rule:
            # they are refused because nothing opened them.
            "runtime unit tree": {
                "run": directory(),
                "run/systemd": directory(),
                "run/systemd/transient": directory(),
                "run/systemd/transient/evil.service": regular(),
            },
            "merged-usr link target": {"sbin": directory()},
            # Redefining anything a lower layer established.
            "base account file": {"etc/passwd": regular()},
            "base binary": {"usr/bin/bash": regular(0o755)},
            "base unit": {"etc/systemd/system/minimos-harden.service": regular()},
            "base login shell via the merged-usr symlink": {
                "lib/minimos/login-shell": regular(0o755),
            },
            "ancestor metadata change": {"etc": directory(0o700)},
            "ancestor type change": {"etc": regular()},
            "redirect through a new alias": {
                "opt": directory(),
                "opt/alias": symlink("/etc"),
                "opt/alias/passwd": regular(),
            },
            "sealed config directory": {"etc/sysctl.d/99-evil.conf": regular()},
        }
        for name, fixture in refused.items():
            with self.subTest(attack=name), self.assertRaises(
                self.scratch.UnsafeLayerError
            ):
                self.scratch.apply_layer_state(
                    fixture, dict(state), set(parents), policy, Path("upper")
                )

    def test_composition_policy_allows_real_compositions(self) -> None:
        entry = self.scratch.LayerEntry
        directory = lambda mode=0o755, uid=0, gid=0: entry("directory", mode, uid, gid)
        regular = lambda mode=0o644, uid=0, gid=0: entry("regular", mode, uid, gid)
        symlink = lambda target: entry("symlink", 0o777, 0, 0, target)
        policy = self.shipped_policy()
        state, parents = self.base_state()

        # The shapes the shipped examples actually use.
        allowed = {
            "service binary, config, content, unit": {
                "usr/bin/nginx": regular(0o755),
                "etc/nginx": directory(),
                "etc/nginx/nginx.conf": regular(),
                "etc/systemd/system/nginx.service": regular(),
                "etc/systemd/system/multi-user.target.wants": directory(),
                "var/www": directory(),
                "var/www/index.html": regular(),
            },
            "per-unit drop-in for a unit the composition targets": {
                "etc/systemd/system/user@.service.d": directory(),
                "etc/systemd/system/user@.service.d/50-no-pam.conf": regular(),
            },
            "lingering user manager and its helper binary": {
                "usr/lib/systemd/systemd-user-runtime-dir": regular(0o755),
                "usr/bin/loginctl": regular(0o755),
                "var/lib": directory(),
                "var/lib/systemd": directory(),
                "var/lib/systemd/linger": directory(),
                "var/lib/systemd/linger/exedev": regular(),
                "etc/minimos": directory(),
                "etc/minimos/require-user-scope": regular(0o444),
            },
            "masked user units and interactive profile": {
                "etc/systemd/user": directory(),
                "etc/systemd/user/systemd-journalctl.socket": symlink("/dev/null"),
                "etc/profile": regular(),
            },
            "agent binary and per-user config": {
                "usr/local": directory(),
                "usr/local/bin": directory(),
                "usr/local/bin/codex": regular(0o755),
                "home": directory(),
                "home/exedev": directory(0o700, 1000, 1000),
                "home/exedev/.codex": directory(0o700, 1000, 1000),
                "home/exedev/.codex/config.toml": regular(0o600, 1000, 1000),
            },
            "restated ancestors with identical metadata": {
                "etc": directory(),
                "usr": directory(),
                "usr/lib": directory(),
                "usr/lib/systemd": directory(),
            },
        }
        for name, fixture in allowed.items():
            with self.subTest(composition=name):
                self.scratch.apply_layer_state(
                    fixture, dict(state), set(parents), policy, Path("upper")
                )

    def test_effective_state_accepts_safe_deep_relative_symlink(self) -> None:
        entry = self.scratch.LayerEntry
        state = {
            "usr": entry("directory", 0o755, 0, 0),
            "etc": entry("directory", 0o755, 0, 0),
            "usr/alias": entry("symlink", 0o777, 0, 0, "../etc"),
        }
        self.assertEqual(
            self.scratch.resolve_state_path(
                "usr/alias/conf", state, follow_final=False
            ),
            "etc/conf",
        )
        escaping = {
            "alias": entry("symlink", 0o777, 0, 0, "../outside"),
        }
        with self.assertRaises(self.scratch.UnsafeLayerError):
            self.scratch.resolve_state_path(
                "alias/file", escaping, follow_final=False
            )

    def test_layer_rejects_acl_ids_compression_and_type_collisions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            acl = tar_member("file")
            acl.pax_headers["SCHILY.acl.access"] = "user::rw-"
            acl_layer = base / "acl.tar"
            write_tar(acl_layer, [(acl, b"payload")])
            with self.assertRaises(self.scratch.UnsafeLayerError):
                self.scratch.validate_layer(acl_layer)

            bad_id = tar_member("bad-id")
            bad_id.uid = -1
            id_layer = base / "id.tar"
            write_tar(id_layer, [(bad_id, b"payload")])
            with self.assertRaises(self.scratch.UnsafeLayerError):
                self.scratch.validate_layer(id_layer)

            compressed = base / "layer.tar.xz"
            with tarfile.open(compressed, "w:xz") as archive:
                member = tar_member("file")
                archive.addfile(member, io.BytesIO(b"payload"))
            with self.assertRaises(self.scratch.UnsafeLayerError):
                self.scratch.validate_layer(compressed)

            entry = self.scratch.LayerEntry
            for entries in (
                {
                    "parent": entry("regular", 0o644, 0, 0),
                    "parent/child": entry("regular", 0o644, 0, 0),
                },
                {
                    "parent/child": entry("regular", 0o644, 0, 0),
                    "parent": entry("symlink", 0o777, 0, 0, "/tmp"),
                },
            ):
                with self.assertRaises(self.scratch.UnsafeLayerError):
                    self.scratch.apply_layer_state(
                        entries, {}, set(), self.scratch.CompositionPolicy(),
                        Path("collision"),
                    )

    def test_scratch_image_is_reproducible(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            layer = base / "layer.tar"
            write_tar(layer, [(tar_member("file", b"data"), b"data")])
            outputs = [base / "first", base / "second"]
            for output in outputs:
                with argv(
                    "scratch_image.py", "--output", str(output),
                    "--layer", str(layer), "--cmd", "/bin/true",
                ):
                    self.assertEqual(self.scratch.main(), 0)
                self.scratch.validate_oci_layout(output)
            first = {
                item.relative_to(outputs[0]): item.read_bytes()
                for item in outputs[0].rglob("*") if item.is_file()
            }
            second = {
                item.relative_to(outputs[1]): item.read_bytes()
                for item in outputs[1].rglob("*") if item.is_file()
            }
            self.assertEqual(first, second)

    def test_oci_validator_rejects_diffid_schema_and_composed_collision(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            layer = base / "layer.tar"
            write_tar(layer, [(tar_member("file", b"data"), b"data")])
            output = base / "layout"
            with argv(
                "scratch_image.py",
                "--output",
                str(output),
                "--layer",
                str(layer),
                "--cmd",
                "/bin/true",
            ):
                self.assertEqual(self.scratch.main(), 0)

            index, manifest, config = self.read_layout_chain(output)
            config["rootfs"]["diff_ids"][0] = "sha256:" + ("0" * 64)
            self.publish_layout_chain(output, index, manifest, config)
            with self.assertRaises(self.scratch.UnsafeLayerError):
                self.scratch.validate_oci_layout(output)

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            layer = base / "layer.tar"
            write_tar(layer, [(tar_member("file", b"data"), b"data")])
            output = base / "layout"
            with argv(
                "scratch_image.py",
                "--output",
                str(output),
                "--layer",
                str(layer),
                "--cmd",
                "/bin/true",
            ):
                self.assertEqual(self.scratch.main(), 0)
            index = json.loads((output / "index.json").read_bytes())
            index["schemaVersion"] = 1
            (output / "index.json").write_text(json.dumps(index))
            with self.assertRaises(self.scratch.UnsafeLayerError):
                self.scratch.validate_oci_layout(output)

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            first = base / "first.tar"
            second = base / "second.tar"
            parent = tar_member("parent", b"", kind=tarfile.DIRTYPE)
            write_tar(first, [(parent, b"")])
            write_tar(second, [(tar_member("parent/child"), b"payload")])
            output = base / "layout"
            with argv(
                "scratch_image.py",
                "--output",
                str(output),
                "--layer",
                str(first),
                "--layer",
                str(second),
                "--cmd",
                "/bin/true",
            ):
                self.assertEqual(self.scratch.main(), 0)

            conflicting = base / "conflicting.tar"
            write_tar(conflicting, [(tar_member("parent"), b"payload")])
            index, manifest, config = self.read_layout_chain(output)
            layer_digest = self.scratch.sha256_file(conflicting)
            layer_blob = (
                output
                / "blobs"
                / "sha256"
                / layer_digest.removeprefix("sha256:")
            )
            layer_blob.write_bytes(conflicting.read_bytes())
            manifest["layers"][0]["digest"] = layer_digest
            manifest["layers"][0]["size"] = conflicting.stat().st_size
            config["rootfs"]["diff_ids"][0] = self.scratch.sha256_uncompressed(
                conflicting
            )
            self.publish_layout_chain(output, index, manifest, config)
            with self.assertRaises(self.scratch.UnsafeLayerError):
                self.scratch.validate_oci_layout(output)

    def test_scratch_rejects_excess_layers_before_publication(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            layers = [base / "one.tar", base / "two.tar"]
            for index, layer in enumerate(layers):
                write_tar(
                    layer,
                    [(tar_member(f"file-{index}", b"data"), b"data")],
                )
            output = base / "layout"
            original_limit = self.scratch.MAX_IMAGE_LAYERS
            try:
                self.scratch.MAX_IMAGE_LAYERS = 1
                with argv(
                    "scratch_image.py",
                    "--output",
                    str(output),
                    "--layer",
                    str(layers[0]),
                    "--layer",
                    str(layers[1]),
                ):
                    self.assertEqual(self.scratch.main(), 1)
            finally:
                self.scratch.MAX_IMAGE_LAYERS = original_limit
            self.assertFalse(output.exists())

    def test_scratch_refuses_to_delete_existing_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            layer = base / "layer.tar"
            write_tar(layer, [(tar_member("file", b"data"), b"data")])
            output = base / "existing"
            output.mkdir()
            sentinel = output / "sentinel"
            sentinel.write_bytes(b"keep")
            with argv(
                "scratch_image.py", "--output", str(output),
                "--layer", str(layer), "--cmd", "/bin/true",
            ):
                self.assertEqual(self.scratch.main(), 1)
            self.assertEqual(sentinel.read_bytes(), b"keep")

    def test_decompressed_stream_budgets_are_enforced(self) -> None:
        with self.assertRaises(self.scratch.UnsafeLayerError):
            self.scratch.BoundedReader(io.BytesIO(b"abcd"), 3).read(4)
        with self.assertRaises(self.extract_one.ArchiveLimitError):
            self.extract_one.BoundedReader(io.BytesIO(b"abcd"), 3).read(4)

    def test_extract_one_rejects_duplicate_or_link_member(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            duplicate = base / "duplicate.tar"
            write_tar(
                duplicate,
                [(tar_member("item", b"a"), b"a"),
                 (tar_member("item", b"b"), b"b")],
            )
            with argv("extract_one.py", str(duplicate), "item", str(base / "out")):
                self.assertEqual(self.extract_one.main(), 1)

            link = base / "link.tar"
            write_tar(
                link,
                [(tar_member("item", b"", kind=tarfile.SYMTYPE,
                             linkname="target"), b"")],
            )
            with argv("extract_one.py", str(link), "item", str(base / "out")):
                self.assertEqual(self.extract_one.main(), 1)


if __name__ == "__main__":
    # unittest must not interpret the Buck-provided tool paths as test filters.
    sys.argv[:] = [sys.argv[0]]
    unittest.main()
