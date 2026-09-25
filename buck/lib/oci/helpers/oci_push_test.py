# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Tests for oci_push, run against the pinned skopeo with local destinations."""

import contextlib
import hashlib
import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

import oci_push

SKOPEO = sys.argv[1] if len(sys.argv) > 1 else None


def _blob(root: Path, data: bytes) -> dict:
    digest = hashlib.sha256(data).hexdigest()
    (root / "blobs" / "sha256").mkdir(parents=True, exist_ok=True)
    (root / "blobs" / "sha256" / digest).write_bytes(data)
    return {"digest": f"sha256:{digest}", "size": len(data)}


def _image(root: Path, arch: str) -> dict:
    """Write one single-layer image into `root` and return its manifest descriptor."""
    payload = f"hello from {arch}\n".encode()
    layer = io.BytesIO()
    with tarfile.open(fileobj=layer, mode="w") as tar:
        info = tarfile.TarInfo("hello.txt")
        info.size = len(payload)
        tar.addfile(info, io.BytesIO(payload))
    layer_desc = _blob(root, layer.getvalue())
    config = _blob(root, json.dumps({
        "architecture": arch,
        "os": "linux",
        "config": {"Cmd": ["/hello"]},
        "rootfs": {"type": "layers", "diff_ids": [layer_desc["digest"]]},
    }).encode())
    manifest = _blob(root, json.dumps({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": {"mediaType": "application/vnd.oci.image.config.v1+json", **config},
        "layers": [{"mediaType": "application/vnd.oci.image.layer.v1.tar", **layer_desc}],
    }).encode())
    return {
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        **manifest,
        "platform": {"architecture": arch, "os": "linux"},
    }


def _layout(root: Path, arches: list[str]) -> Path:
    """An OCI layout the way oci_image (one arch) or oci_index (several) writes it."""
    root.mkdir(parents=True)
    manifests = [_image(root, arch) for arch in arches]
    if len(manifests) == 1:
        manifests[0]["annotations"] = {"org.opencontainers.image.ref.name": "latest"}
    (root / "oci-layout").write_text(json.dumps({"imageLayoutVersion": "1.0.0"}))
    (root / "index.json").write_text(json.dumps({
        "schemaVersion": 2,
        "mediaType": oci_push.INDEX_MEDIA_TYPE,
        "manifests": manifests,
    }))
    return root


def _push(*args: str) -> list[str]:
    stdout = io.StringIO()
    with contextlib.redirect_stdout(stdout):
        status = oci_push.main(["--skopeo", SKOPEO, *args])
    if status != 0:
        raise AssertionError(f"oci_push exited {status}")
    return stdout.getvalue().splitlines()


class DestinationTests(unittest.TestCase):
    def test_bare_references_go_to_a_registry(self) -> None:
        self.assertEqual(oci_push.destination("ttl.sh/me:1h"), "docker://ttl.sh/me:1h")
        self.assertEqual(
            oci_push.destination("localhost:5000/app:v1"), "docker://localhost:5000/app:v1"
        )
        self.assertEqual(oci_push.destination("docker://ghcr.io/me/app:v1"),
                         "docker://ghcr.io/me/app:v1")

    def test_other_transports_pass_through(self) -> None:
        for ref in ("oci:/tmp/out:v1", "docker-archive:/tmp/app.tar", "dir:/tmp/app"):
            with self.subTest(ref=ref):
                self.assertEqual(oci_push.destination(ref), ref)

    def test_registry_references_need_a_tag(self) -> None:
        for ref in ("ttl.sh/me", "localhost:5000/app", "docker://ghcr.io/me/app",
                    "ghcr.io/me/app@sha256:" + "0" * 64):
            with self.subTest(ref=ref), self.assertRaises(oci_push.PushError):
                oci_push.destination(ref)

    def test_pinned_reference_drops_the_tag(self) -> None:
        digest = "sha256:" + "a" * 64
        self.assertEqual(oci_push.pinned("docker://localhost:5000/app:v1", digest),
                         f"localhost:5000/app@{digest}")
        self.assertEqual(oci_push.pinned("oci:/tmp/out:v1", digest), f"oci:/tmp/out:v1 {digest}")


class PushTests(unittest.TestCase):
    def setUp(self) -> None:
        if SKOPEO is None:
            self.skipTest("expected the path to skopeo as the first argument")
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))

    def test_single_image(self) -> None:
        layout = _layout(self.tmp / "image", ["amd64"])
        out = self.tmp / "out"
        [line] = _push("--image", str(layout), f"oci:{out}:pushed")
        dest, digest = line.split(" ")
        self.assertEqual(dest, f"oci:{out}:pushed")
        [entry] = json.loads((out / "index.json").read_text())["manifests"]
        self.assertEqual(entry["digest"], digest)
        self.assertEqual(entry["annotations"]["org.opencontainers.image.ref.name"], "pushed")

    def test_per_platform_manifests_push_as_one_index(self) -> None:
        layout = _layout(self.tmp / "index", ["amd64", "arm64"])
        out = self.tmp / "out"
        [line] = _push("--image", str(layout), f"oci:{out}:multi")
        digest = line.split(" ")[1]
        [entry] = json.loads((out / "index.json").read_text())["manifests"]
        self.assertEqual(entry["mediaType"], oci_push.INDEX_MEDIA_TYPE)
        self.assertEqual(entry["digest"], digest)
        nested = json.loads((out / "blobs" / "sha256" / digest.removeprefix("sha256:")).read_text())
        self.assertEqual(
            sorted(m["platform"]["architecture"] for m in nested["manifests"]),
            ["amd64", "arm64"],
        )

    def test_staged_copy_survives_a_rebuild(self) -> None:
        layout = _layout(self.tmp / "image", ["amd64"])
        staged = self.tmp / "staged"
        oci_push.stage(layout, staged)
        # Buck replaces outputs by deleting and rewriting them.
        for blob in (layout / "blobs" / "sha256").iterdir():
            blob.unlink()
            blob.write_bytes(b"rebuilt")
        for blob in (staged / "blobs" / "sha256").iterdir():
            self.assertNotEqual(blob.read_bytes(), b"rebuilt")

    def test_empty_layout_fails(self) -> None:
        layout = self.tmp / "empty"
        layout.mkdir()
        (layout / "blobs").mkdir()
        (layout / "index.json").write_text(json.dumps({"schemaVersion": 2, "manifests": []}))
        with contextlib.redirect_stdout(io.StringIO()):
            status = oci_push.main(["--skopeo", SKOPEO, "--image", str(layout), "oci:/unused:x"])
        self.assertEqual(status, 1)

    def test_tags_come_from_the_repository(self) -> None:
        layout = _layout(self.tmp / "image", ["amd64"])
        base = ["--skopeo", SKOPEO, "--image", str(layout), "--dry-run"]
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.assertEqual(oci_push.main(
                base + ["--repository", "ghcr.io/me/app", "--default-tag", "latest"]), 0)
            self.assertEqual(oci_push.main(
                base + ["--repository", "ghcr.io/me/app", "--default-tag", "latest",
                        "--tag", "v1"]), 0)
        commands = [line for line in stderr.getvalue().splitlines() if "copy" in line]
        self.assertTrue(commands[0].endswith("docker://ghcr.io/me/app:latest"))
        self.assertTrue(commands[1].endswith("docker://ghcr.io/me/app:v1"))
        self.assertIn("--dest-precompute-digests", commands[0])

    def test_tag_without_repository_is_refused(self) -> None:
        layout = _layout(self.tmp / "image", ["amd64"])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            oci_push.main(["--skopeo", SKOPEO, "--image", str(layout), "--tag", "v1"])


if __name__ == "__main__":
    # unittest must not read the skopeo path as a test name.
    sys.argv[:] = sys.argv[:1]
    unittest.main()
