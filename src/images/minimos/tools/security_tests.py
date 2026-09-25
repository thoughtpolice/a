# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Adversarial tests for minimos's archive and OCI build boundary."""

import gzip
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
from unittest import mock

import common
import cull
import mkapkroot
import mkoverlay
import scratch_image as scratch

UnsafeInputError = common.UnsafeInputError

# The shipped composition policy, so the adversarial cases exercise what
# ships rather than a copy that can drift away from it.
POLICY_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else None


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


def directory(mode: int = 0o755, uid: int = 0, gid: int = 0) -> scratch.LayerEntry:
    return scratch.LayerEntry("directory", mode, uid, gid)


def regular(mode: int = 0o644, uid: int = 0, gid: int = 0) -> scratch.LayerEntry:
    return scratch.LayerEntry("regular", mode, uid, gid)


def symlink(target: str) -> scratch.LayerEntry:
    return scratch.LayerEntry("symlink", 0o777, 0, 0, target)


class SecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if POLICY_PATH is None:
            raise RuntimeError("expected the path to policy.txt as the only argument")
        cls.policy = scratch.load_policy(POLICY_PATH)

    def make_apk(self, directory: Path,
                 members: list[tuple[tarfile.TarInfo, bytes]],
                 name: str = "fixture.apk") -> Path:
        apk = directory / name
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

    def build_layout(self, output: Path, *layers: Path) -> None:
        args = ["scratch_image.py", "build", "--output", str(output), "--cmd", "/bin/true"]
        for layer in layers:
            args += ["--layer", str(layer)]
        with argv(*args):
            self.assertEqual(scratch.main(), 0)

    def assert_apk_rejected(self, member: tarfile.TarInfo,
                            data: bytes = b"payload") -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            apk = self.make_apk(root, [(member, data)])
            with self.assertRaises(UnsafeInputError):
                mkapkroot.extract_apk(apk, root / "rootfs")

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
            mkapkroot.extract_apk(apk, rootfs)
            self.assertEqual(outside.read_bytes(), b"sentinel")
            self.assertFalse((rootfs / "victim").is_symlink())
            self.assertEqual((rootfs / "victim").read_bytes(), b"safe")

    def test_apk_rechecks_ancestor_links_between_packages(self) -> None:
        # Package one routes a member through a merged-usr style link and
        # package two repoints that link at the host. The directory the
        # first extraction proved real must not vouch for the second.
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            outside = base / "outside"
            outside.mkdir()
            rootfs = base / "rootfs"
            first = self.make_apk(base, [
                (tar_member("usr", b"", mode=0o755, kind=tarfile.DIRTYPE), b""),
                (tar_member("usr/lib", b"", mode=0o755, kind=tarfile.DIRTYPE), b""),
                (tar_member("usr/lib/foo", b"", mode=0o755, kind=tarfile.DIRTYPE), b""),
                (tar_member("lib", b"", kind=tarfile.SYMTYPE, linkname="usr/lib"), b""),
                (tar_member("lib/foo/x", b"one"), b"one"),
            ], name="first.apk")
            second = self.make_apk(base, [
                (tar_member("lib", b"", kind=tarfile.SYMTYPE, linkname=str(outside)), b""),
                (tar_member("lib/foo/y", b"two"), b"two"),
            ], name="second.apk")
            mkapkroot.extract_apk(first, rootfs)
            self.assertEqual((rootfs / "usr/lib/foo/x").read_bytes(), b"one")
            with self.assertRaises(UnsafeInputError):
                mkapkroot.extract_apk(second, rootfs)
            self.assertEqual(list(outside.iterdir()), [])

    def test_apk_rejects_device_nodes(self) -> None:
        self.assert_apk_rejected(
            tar_member("dev/evil", b"", kind=tarfile.CHRTYPE), b""
        )

    def test_apk_counts_control_entries_and_decompressed_bytes(self) -> None:
        original_entries = mkapkroot.MAX_ENTRIES
        try:
            mkapkroot.MAX_ENTRIES = 0
            self.assert_apk_rejected(
                tar_member(".PKGINFO", b"metadata"), b"metadata"
            )
        finally:
            mkapkroot.MAX_ENTRIES = original_entries
        reader = common.BoundedReader(io.BytesIO(b"abcd"), 3)
        with self.assertRaises(UnsafeInputError):
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
            original_limit = mkapkroot.MAX_TOTAL_SIZE
            try:
                mkapkroot.MAX_TOTAL_SIZE = 12
                with self.assertRaises(UnsafeInputError):
                    mkapkroot.extract_apk(apk, base / "bounded")
            finally:
                mkapkroot.MAX_TOTAL_SIZE = original_limit

            roots = [base / "umask-022", base / "umask-077"]
            old_umask = os.umask(0o022)
            try:
                mkapkroot.extract_apk(apk, roots[0])
                os.umask(0o077)
                mkapkroot.extract_apk(apk, roots[1])
            finally:
                os.umask(old_umask)
            self.assertEqual(roots[0].joinpath("new").stat().st_mode & 0o777, 0o755)
            self.assertEqual(roots[1].joinpath("new").stat().st_mode & 0o777, 0o755)

    def test_globs_are_segment_aware(self) -> None:
        globs = cull.Globs(["/usr/bin/*", "/usr/share/**", "/lib", "/etc/exact.conf"])
        self.assertTrue(globs.matches("/usr/bin/tool"))
        self.assertFalse(globs.matches("/usr/bin/nested/tool"))
        self.assertTrue(globs.matches("/usr/share/nested/deep/file"))
        self.assertTrue(globs.matches("lib"))
        self.assertTrue(globs.matches("/etc/exact.conf"))
        self.assertFalse(globs.matches("/etc/exact.conf.bak"))
        self.assertFalse(globs.matches("/etc"))
        self.assertEqual(len(globs), 4)
        # A literal and a pattern that match nothing are both reported, as
        # written, and a path two entries match counts for both.
        overlapping = cull.Globs(["/usr/bin/*", "/usr/bin/tool", "/etc/gone", "/opt/*"])
        self.assertEqual(overlapping.unused(["/usr/bin/tool"]), ["/etc/gone", "/opt/*"])

    def test_cull_rejects_root_escaping_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "rootfs"
            root.mkdir()
            link = root / "link"
            link.symlink_to("../../outside")
            with self.assertRaises(UnsafeInputError):
                cull.close_symlinks(root, {link})

    def test_cull_rejects_double_slash_and_chained_escape(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "rootfs"
            root.mkdir()
            direct = root / "direct"
            direct.symlink_to("//etc/passwd")
            with self.assertRaises(UnsafeInputError):
                cull.resolve_virtual(root, direct)

            first = root / "first"
            second = root / "second"
            first.symlink_to("second")
            second.symlink_to("//etc/passwd")
            with self.assertRaises(UnsafeInputError):
                cull.resolve_virtual(root, first)

            (root / "etc").mkdir()
            image_passwd = root / "etc" / "passwd"
            image_passwd.write_bytes(b"image")
            safe = root / "safe"
            safe.symlink_to("/etc/passwd")
            resolved, _ = cull.resolve_virtual(root, safe)
            self.assertEqual(resolved, image_passwd)

    def test_cull_rejects_world_writable_regular_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root = base / "rootfs"
            root.mkdir()
            item = root / "item"
            item.write_bytes(b"data")
            item.chmod(0o666)
            with self.assertRaises(UnsafeInputError):
                cull.write_tar(root, {item}, base / "out.tar")

    def test_cull_leaves_provided_libraries_out(self) -> None:
        # A table stands in for the ELF parser. The test is about which side
        # of the provided boundary each soname lands on.
        needed = {"app": ["libshared.so", "libown.so"], "libown.so": ["libshared.so"]}
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root = base / "rootfs"
            provided = base / "provided"
            for tree in (root, provided):
                (tree / "usr" / "lib").mkdir(parents=True)
                (tree / "usr" / "lib" / "libshared.so").write_bytes(b"shared")
            (root / "usr" / "bin").mkdir()
            app = root / "usr" / "bin" / "app"
            app.write_bytes(b"app")
            own = root / "usr" / "lib" / "libown.so"
            own.write_bytes(b"own")
            with mock.patch.object(cull, "is_elf", lambda path: path.name in needed), \
                    mock.patch.object(cull, "elf_needed", lambda path: needed[path.name]):
                kept = cull.close_elf(root, {app}, provided)
                self.assertEqual(kept, {app, own})
                self.assertEqual(
                    cull.close_elf(root, {app}, None),
                    {app, own, root / "usr" / "lib" / "libshared.so"},
                )
                needed["libown.so"] = ["libmissing.so"]
                with self.assertRaises(UnsafeInputError):
                    cull.close_elf(root, {app}, provided)
                # The error names the file that needs the soname, even
                # after an earlier soname of the same file resolved.
                needed["app"] = ["libown.so", "libgone.so"]
                needed["libown.so"] = []
                with self.assertRaisesRegex(
                    UnsafeInputError, re.escape("libgone.so (needed by app)")
                ):
                    cull.close_elf(root, {app}, provided)

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
            # /sentinel exists only behind the child named rootfs, so the
            # entry matches nothing and cull writes no layer at all. Had it
            # treated that child as the root, the entry would have matched.
            with argv(
                "cull.py",
                "--rootfs",
                str(root),
                "--keepfile",
                str(keep),
                "--out",
                str(output),
            ):
                self.assertEqual(cull.main(), 1)
            self.assertFalse(output.exists())

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
                self.assertEqual(cull.main(), 1)

            data = root / "data"
            alias = root / "alias"
            data.write_bytes(b"12345678")
            os.link(data, alias)
            previous = base / "previous.tar"
            previous.write_bytes(b"preserve-me")
            original_limit = cull.MAX_OUTPUT_CONTENT_SIZE
            try:
                cull.MAX_OUTPUT_CONTENT_SIZE = 12
                with self.assertRaises(UnsafeInputError):
                    cull.write_tar(root, {data, alias}, previous)
            finally:
                cull.MAX_OUTPUT_CONTENT_SIZE = original_limit
            self.assertEqual(previous.read_bytes(), b"preserve-me")

    def test_overlay_rejects_unsafe_paths_modes_and_units(self) -> None:
        for name in ("/absolute", "a/../../escape", "a/./alias"):
            with self.subTest(name=name), self.assertRaises(UnsafeInputError):
                common.canonical_name(name)
        with self.assertRaises(UnsafeInputError):
            common.link_parts(["a"], "../../escape")
        for target in ("//etc/passwd", "///etc/passwd", "/../../etc/passwd"):
            with self.subTest(target=target), self.assertRaises(UnsafeInputError):
                common.link_parts(["a"], target)
        self.assertEqual(common.link_parts(["a"], "/etc/passwd"), ["etc", "passwd"])
        self.assertEqual(common.link_parts(["a", "b"], "../c"), ["a", "c"])
        with self.assertRaises(ValueError):
            mkoverlay.safe_mode(0o4755, directory=False)
        with self.assertRaises(ValueError):
            mkoverlay.safe_mode(0o666, directory=False)
        with self.assertRaises(ValueError):
            mkoverlay.safe_unit_name("../../evil.service")

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
                mkoverlay.main()
            self.assertEqual(output.read_bytes(), b"preserve-me")

    def test_overlay_enables_units_per_install_section(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            enabled = base / "enabled.service"
            enabled.write_text(
                "[Unit]\nDescription=x\n\n[Service]\nExecStart=/bin/true\n\n"
                "[Install]\n# early boot, and the usual place\n"
                "WantedBy=sysinit.target multi-user.target\nRequiredBy=x.target\n"
            )
            template = base / "plain@.service"
            template.write_text("[Service]\nExecStart=/bin/true\n")
            output = base / "overlay.tar"
            with argv(
                "mkoverlay.py", "--out", str(output),
                "--unit", str(enabled), "--unit", str(template),
            ):
                self.assertEqual(mkoverlay.main(), 0)
            with tarfile.open(output) as archive:
                members = {member.name: member for member in archive.getmembers()}
            self.assertEqual(
                set(members),
                {
                    "etc/systemd/system/enabled.service",
                    "etc/systemd/system/sysinit.target.wants/enabled.service",
                    "etc/systemd/system/multi-user.target.wants/enabled.service",
                    "etc/systemd/system/x.target.requires/enabled.service",
                    "etc/systemd/system/plain@.service",
                },
            )
            link = members["etc/systemd/system/sysinit.target.wants/enabled.service"]
            self.assertTrue(link.issym())
            self.assertEqual(link.linkname, "/etc/systemd/system/enabled.service")

            aliased = base / "aliased.service"
            aliased.write_text("[Install]\nAlias=other.service\n")
            with argv("mkoverlay.py", "--out", str(base / "x.tar"), "--unit", str(aliased)), \
                    self.assertRaises(ValueError):
                mkoverlay.main()

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
                    UnsafeInputError
                ):
                    scratch.validate_layer(path)

    def test_layer_validator_rejects_duplicates_and_capabilities(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            duplicate = base / "duplicate.tar"
            write_tar(
                duplicate,
                [(tar_member("same", b"a"), b"a"),
                 (tar_member("same", b"b"), b"b")],
            )
            with self.assertRaises(UnsafeInputError):
                scratch.validate_layer(duplicate)

            capability = tar_member("bin/cap")
            capability.pax_headers["SCHILY.xattr.security.capability"] = "AAAA"
            cap_layer = base / "cap.tar"
            write_tar(cap_layer, [(capability, b"payload")])
            with self.assertRaises(UnsafeInputError):
                scratch.validate_layer(cap_layer)

    def test_layer_validator_hashes_the_whole_stream(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            members = [(tar_member("file", b"data"), b"data")]
            plain = base / "layer.tar"
            write_tar(plain, members)
            _, diff_id = scratch.validate_layer(plain)
            self.assertEqual(diff_id, "sha256:" + hashlib.sha256(plain.read_bytes()).hexdigest())

            compressed = base / "layer.tar.gz"
            write_tar(compressed, members, gzip=True)
            _, diff_id = scratch.validate_layer(compressed)
            self.assertEqual(
                diff_id,
                "sha256:" + hashlib.sha256(gzip.decompress(compressed.read_bytes())).hexdigest(),
            )

    def test_policy_file_format(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            policy = Path(tmp) / "policy.txt"
            policy.write_text("# comment\n\ncomposable etc\nsealed  etc/passwd \n")
            loaded = scratch.load_policy(policy)
            self.assertTrue(loaded.enforce)
            self.assertTrue(loaded.allows_new("etc/app.conf"))
            self.assertFalse(loaded.allows_new("etc/passwd"))
            self.assertFalse(loaded.allows_new("usr/bin/app"))
            for bad in ("open etc\n", "composable /etc\n", "sealed etc\n", "composable\n"):
                policy.write_text(bad)
                with self.subTest(policy=bad), self.assertRaises(UnsafeInputError):
                    scratch.load_policy(policy)
        self.assertFalse(scratch.CompositionPolicy().enforce)

    def base_state(self):
        """A miniature of the real base: merged-usr links and owned paths."""
        state: dict[str, object] = {}
        parents: set[str] = set()
        scratch.apply_layer_state(
            {
                "etc": directory(),
                "etc/passwd": regular(),
                "etc/systemd": directory(),
                "etc/systemd/system": directory(),
                "etc/systemd/system/minimos-harden.service": regular(),
                "etc/systemd/system/dbus.service.d": directory(),
                "etc/systemd/system/dbus.service.d/50-minimos-hardening.conf": regular(),
                # system.slice has no unit file; the base configures it
                # through a drop-in alone.
                "etc/systemd/system/system.slice.d": directory(),
                "etc/systemd/system/user-workload.slice": regular(),
                "etc/systemd/system/user-workload.slice.d": directory(),
                "etc/sysctl.d": directory(),
                "usr": directory(),
                "usr/bin": directory(),
                "usr/bin/bash": regular(0o755),
                "usr/bin/mount": regular(0o755),
                "usr/lib": directory(),
                "usr/lib/systemd": directory(),
                "usr/lib/systemd/system": directory(),
                "usr/lib/systemd/system/dbus.service": regular(),
                "usr/lib/systemd/system/default.target": symlink("graphical.target"),
                "usr/lib/systemd/system/getty@.service": regular(),
                "usr/lib/systemd/system/systemd-journald.service": regular(),
                "usr/lib/systemd/system/user@.service": regular(),
                "usr/lib/systemd/system-generators": directory(),
                "usr/lib/systemd/user": directory(),
                "usr/lib/systemd/user/systemd-journalctl.socket": regular(),
                "usr/lib/minimos": directory(),
                "usr/lib/minimos/login-shell": regular(0o755),
                "var": directory(),
                "lib": symlink("usr/lib"),
            },
            state,
            parents,
            scratch.CompositionPolicy(),
            Path("base"),
        )
        return state, parents

    def test_composition_policy_refuses_privileged_paths(self) -> None:
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
            "manager config outside the unit trees": {
                "etc/systemd/resolved.conf": regular(),
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
            "drop-in kind under /usr/local/lib": {
                "usr/local": directory(),
                "usr/local/lib": directory(),
                "usr/local/lib/environment.d": directory(),
                "usr/local/lib/environment.d/99-evil.conf": regular(),
            },
        }
        for name, fixture in refused.items():
            with self.subTest(attack=name), self.assertRaises(UnsafeInputError):
                scratch.apply_layer_state(
                    fixture, dict(state), set(parents), self.policy, Path("upper")
                )

    def test_composition_policy_allows_real_compositions(self) -> None:
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
            "per-unit drop-in for a unit the composition ships": {
                "etc/systemd/system/app.service": regular(),
                "etc/systemd/system/app.service.d": directory(),
                "etc/systemd/system/app.service.d/50-limits.conf": regular(),
            },
            "enabling a vendor unit the base left unmasked": {
                "etc/systemd/system/multi-user.target.wants": directory(),
                "etc/systemd/system/multi-user.target.wants/user@1000.service":
                    symlink("/usr/lib/systemd/system/user@.service"),
            },
            "program under a name no lower layer uses": {
                "usr/bin/app": regular(0o755),
                "usr/bin/app-helper": symlink("app"),
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
            # The user can override any of these from ~/.config/systemd/user,
            # so the unit-name rule leaves the user tree alone.
            "masked vendor user units and interactive profile": {
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
                "etc/systemd": directory(),
                "usr": directory(),
                "usr/lib": directory(),
                "usr/lib/systemd": directory(),
            },
        }
        for name, fixture in allowed.items():
            with self.subTest(composition=name):
                scratch.apply_layer_state(
                    fixture, dict(state), set(parents), self.policy, Path("upper")
                )

    def test_composition_policy_refuses_lower_names(self) -> None:
        # Every fixture here writes only new paths under composable prefixes,
        # and each one was accepted before the policy compared names.
        state, parents = self.base_state()
        unit = "a unit that already exists below this layer"
        program = "a lookup by name can run instead of"
        refused = {
            "drop-in for a base unit": (unit, {
                "etc/systemd/system/minimos-harden.service.d": directory(),
                "etc/systemd/system/minimos-harden.service.d/99.conf": regular(),
            }),
            "file in the base's own drop-in directory": (unit, {
                "etc/systemd/system/dbus.service.d/99.conf": regular(),
            }),
            "drop-in for a unit the base only configures": (unit, {
                "etc/systemd/system/system.slice.d/99.conf": regular(),
            }),
            "drop-in lifting the workload ceiling": (unit, {
                "etc/systemd/system/user-workload.slice.d/99.conf": regular(),
            }),
            "mask of a vendor unit": (unit, {
                "etc/systemd/system/systemd-journald.service": symlink("/dev/null"),
            }),
            "redirected default target": (unit, {
                "etc/systemd/system/default.target": symlink("rescue.target"),
            }),
            "drop-in for a vendor template": (unit, {
                "etc/systemd/system/user@.service.d": directory(),
                "etc/systemd/system/user@.service.d/99.conf": regular(),
            }),
            "drop-in for one instance of a vendor template": (unit, {
                "etc/systemd/system/user@1000.service.d": directory(),
                "etc/systemd/system/user@1000.service.d/99.conf": regular(),
            }),
            "unit file for one instance of a vendor template": (unit, {
                "etc/systemd/system/getty@tty1.service": regular(),
            }),
            "unit file for a unit PID 1 creates itself": (unit, {
                "etc/systemd/system/-.mount": regular(),
            }),
            "new name aliasing a vendor unit": ("which aliases dbus.service", {
                "etc/systemd/system/innocent.service":
                    symlink("/usr/lib/systemd/system/dbus.service"),
            }),
            "base program shadowed from /usr/local/bin": (program, {
                "usr/local": directory(),
                "usr/local/bin": directory(),
                "usr/local/bin/mount": regular(0o755),
            }),
            "base program shadowed from /usr/local/sbin": (program, {
                "usr/local": directory(),
                "usr/local/sbin": directory(),
                "usr/local/sbin/bash": symlink("/opt/bash"),
            }),
            "undeclared parent directory": ("no layer declares its parent", {
                "etc/app/app.conf": regular(),
            }),
        }
        for name, (message, fixture) in refused.items():
            with self.subTest(attack=name), self.assertRaisesRegex(
                UnsafeInputError, re.escape(message)
            ):
                scratch.apply_layer_state(
                    fixture, dict(state), set(parents), self.policy, Path("upper")
                )

    def test_composition_enables_but_cannot_reconfigure_lower_templates(self) -> None:
        # This is the container-host pattern. One composition ships a
        # template, and a composition stacked on it enables an instance.
        state, parents = self.base_state()
        scratch.apply_layer_state(
            {"etc/systemd/system/container@.service": regular()},
            state, parents, self.policy, Path("container-host"),
        )
        scratch.apply_layer_state(
            {
                "etc/systemd/system/multi-user.target.wants": directory(),
                "etc/systemd/system/multi-user.target.wants/container@web.service":
                    symlink("/etc/systemd/system/container@.service"),
            },
            dict(state), set(parents), self.policy, Path("workload"),
        )
        with self.assertRaisesRegex(UnsafeInputError, "reconfigures container@web.service"):
            scratch.apply_layer_state(
                {
                    "etc/systemd/system/container@web.service.d": directory(),
                    "etc/systemd/system/container@web.service.d/99.conf": regular(),
                },
                dict(state), set(parents), self.policy, Path("workload"),
            )

    def test_every_layer_declares_its_parents(self) -> None:
        # The trusted base is held to this too. A directory it never declares
        # has no state entry, so a composition could otherwise add it as a
        # new path with its own owner.
        with self.assertRaisesRegex(
            UnsafeInputError, re.escape("parent directory /etc/systemd/user.conf.d")
        ):
            scratch.apply_layer_state(
                {
                    "etc": directory(),
                    "etc/systemd": directory(),
                    "etc/systemd/user.conf.d/minimos-overrides.conf": regular(),
                },
                {}, set(), scratch.CompositionPolicy(), Path("base"),
            )
        # A parent may come later in the same tar; extraction ends the same.
        scratch.apply_layer_state(
            {"etc/app.conf": regular(), "etc": directory()},
            {}, set(), scratch.CompositionPolicy(), Path("base"),
        )

    def test_effective_state_accepts_safe_deep_relative_symlink(self) -> None:
        state = {
            "usr": directory(),
            "etc": directory(),
            "usr/alias": symlink("../etc"),
        }
        self.assertEqual(
            scratch.resolve_state_path("usr/alias/conf", state, follow_final=False),
            "etc/conf",
        )
        escaping = {"alias": symlink("../outside")}
        with self.assertRaises(UnsafeInputError):
            scratch.resolve_state_path("alias/file", escaping, follow_final=False)

    def test_layer_rejects_acl_ids_compression_and_type_collisions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            acl = tar_member("file")
            acl.pax_headers["SCHILY.acl.access"] = "user::rw-"
            acl_layer = base / "acl.tar"
            write_tar(acl_layer, [(acl, b"payload")])
            with self.assertRaises(UnsafeInputError):
                scratch.validate_layer(acl_layer)

            bad_id = tar_member("bad-id")
            bad_id.uid = -1
            id_layer = base / "id.tar"
            write_tar(id_layer, [(bad_id, b"payload")])
            with self.assertRaises(UnsafeInputError):
                scratch.validate_layer(id_layer)

            compressed = base / "layer.tar.xz"
            with tarfile.open(compressed, "w:xz") as archive:
                member = tar_member("file")
                archive.addfile(member, io.BytesIO(b"payload"))
            with self.assertRaises(UnsafeInputError):
                scratch.validate_layer(compressed)

            for entries in (
                {"parent": regular(), "parent/child": regular()},
                {"parent/child": regular(), "parent": symlink("/tmp")},
            ):
                with self.assertRaises(UnsafeInputError):
                    scratch.apply_layer_state(
                        entries, {}, set(), scratch.CompositionPolicy(),
                        Path("collision"),
                    )

    def test_scratch_image_is_reproducible(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            layer = base / "layer.tar"
            write_tar(layer, [(tar_member("file", b"data"), b"data")])
            outputs = [base / "first", base / "second"]
            for output in outputs:
                self.build_layout(output, layer)
                scratch.validate_oci_layout(output)
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
            self.build_layout(output, layer)

            index, manifest, config = self.read_layout_chain(output)
            config["rootfs"]["diff_ids"][0] = "sha256:" + ("0" * 64)
            self.publish_layout_chain(output, index, manifest, config)
            with self.assertRaises(UnsafeInputError):
                scratch.validate_oci_layout(output)

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            layer = base / "layer.tar"
            write_tar(layer, [(tar_member("file", b"data"), b"data")])
            output = base / "layout"
            self.build_layout(output, layer)
            index = json.loads((output / "index.json").read_bytes())
            index["schemaVersion"] = 1
            (output / "index.json").write_text(json.dumps(index))
            with self.assertRaises(UnsafeInputError):
                scratch.validate_oci_layout(output)

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            first = base / "first.tar"
            second = base / "second.tar"
            parent = tar_member("parent", b"", kind=tarfile.DIRTYPE)
            write_tar(first, [(parent, b"")])
            write_tar(second, [(tar_member("parent/child"), b"payload")])
            output = base / "layout"
            self.build_layout(output, first, second)

            conflicting = base / "conflicting.tar"
            write_tar(conflicting, [(tar_member("parent"), b"payload")])
            index, manifest, config = self.read_layout_chain(output)
            layer_digest = scratch.sha256_file(conflicting)
            layer_blob = (
                output
                / "blobs"
                / "sha256"
                / layer_digest.removeprefix("sha256:")
            )
            layer_blob.write_bytes(conflicting.read_bytes())
            manifest["layers"][0]["digest"] = layer_digest
            manifest["layers"][0]["size"] = conflicting.stat().st_size
            config["rootfs"]["diff_ids"][0] = scratch.validate_layer(conflicting)[1]
            self.publish_layout_chain(output, index, manifest, config)
            with self.assertRaises(UnsafeInputError):
                scratch.validate_oci_layout(output)

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
            original_limit = scratch.MAX_IMAGE_LAYERS
            try:
                scratch.MAX_IMAGE_LAYERS = 1
                with argv(
                    "scratch_image.py", "build",
                    "--output", str(output),
                    "--layer", str(layers[0]),
                    "--layer", str(layers[1]),
                ):
                    self.assertEqual(scratch.main(), 1)
            finally:
                scratch.MAX_IMAGE_LAYERS = original_limit
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
                "scratch_image.py", "build", "--output", str(output),
                "--layer", str(layer), "--cmd", "/bin/true",
            ):
                self.assertEqual(scratch.main(), 1)
            self.assertEqual(sentinel.read_bytes(), b"keep")


if __name__ == "__main__":
    # unittest must not interpret the Buck-provided policy path as a test filter.
    sys.argv[:] = [sys.argv[0]]
    unittest.main()
