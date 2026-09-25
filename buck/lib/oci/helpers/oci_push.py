# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Push an OCI image layout to a registry with skopeo.

An oci_push target runs this through `buck2 run`:

    buck2 run //pkg:app-push -- ttl.sh/me-app:1h
    buck2 run //pkg:app-push -- ghcr.io/me/app:v1 ghcr.io/me/app:latest
    buck2 run //pkg:app-push -- --tag v1     # when the target sets repository

A destination is an image reference with a tag. A bare reference goes to a
registry, and one with a skopeo transport prefix such as `oci:` or
`docker-archive:` goes there instead. For each registry destination the
reference by digest, `repo@sha256:...`, is printed on stdout once the push
succeeds. Progress goes to stderr.

Credentials come from wherever skopeo looks for them: REGISTRY_AUTH_FILE,
`skopeo login` or `docker login` state, or the file given with --authfile.

The layout is staged in a private directory before skopeo reads it, with
blobs hard-linked where possible, so a rebuild that rewrites buck-out can't
change the image halfway through a push. Staging also turns a layout that
lists one manifest per platform, as oci_index writes, into a single image
index that skopeo can push as one multi-platform image.
"""

import argparse
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json"

# Transports skopeo accepts as a copy destination. Anything else is taken to
# be a registry reference.
TRANSPORTS = (
    "containers-storage:",
    "dir:",
    "docker-archive:",
    "docker-daemon:",
    "docker://",
    "oci-archive:",
    "oci:",
)


class PushError(Exception):
    pass


def destination(ref: str) -> str:
    """The skopeo destination for `ref`, which must carry a tag if it names a registry."""
    if ref.startswith(TRANSPORTS):
        if not ref.startswith("docker://"):
            return ref
        name = ref.removeprefix("docker://")
    else:
        name = ref
    last = name.rpartition("/")[2]
    if "@" in name:
        raise PushError(
            f"{ref}: push to a tag, not a digest. The digest is printed after the push."
        )
    if ":" not in last:
        raise PushError(
            f"{ref}: name a tag, such as {name}:v1. Pushing an implicit :latest "
            "is easy to miss, and registries and exe.dev cache it."
        )
    return "docker://" + name


def pinned(dest: str, digest: str) -> str:
    """The digest reference for a registry destination, or `dest digest` otherwise."""
    if not dest.startswith("docker://"):
        return f"{dest} {digest}"
    name = dest.removeprefix("docker://")
    repository = name.rpartition(":")[0]
    return f"{repository}@{digest}"


def _link_or_copy(src: Path, dst: Path) -> None:
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def stage(layout: Path, out: Path) -> None:
    """Write a private copy of `layout` at `out` that names exactly one image."""
    try:
        index = json.loads((layout / "index.json").read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise PushError(f"{layout} is not an OCI image layout: {error}") from error
    manifests = index.get("manifests") or []
    if not manifests:
        raise PushError(f"{layout}/index.json lists no manifests")

    for algorithm in (layout / "blobs").iterdir():
        target = out / "blobs" / algorithm.name
        target.mkdir(parents=True, exist_ok=True)
        for blob in algorithm.iterdir():
            _link_or_copy(blob.resolve(), target / blob.name)

    if len(manifests) == 1:
        top = manifests[0]
    else:
        nested = json.dumps(
            {"schemaVersion": 2, "mediaType": INDEX_MEDIA_TYPE, "manifests": manifests},
            sort_keys=True,
        ).encode()
        digest = hashlib.sha256(nested).hexdigest()
        (out / "blobs" / "sha256").mkdir(parents=True, exist_ok=True)
        (out / "blobs" / "sha256" / digest).write_bytes(nested)
        top = {"mediaType": INDEX_MEDIA_TYPE, "digest": f"sha256:{digest}", "size": len(nested)}

    (out / "oci-layout").write_text(json.dumps({"imageLayoutVersion": "1.0.0"}))
    (out / "index.json").write_text(json.dumps(
        {"schemaVersion": 2, "mediaType": INDEX_MEDIA_TYPE, "manifests": [top]},
        sort_keys=True,
    ))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Push an OCI image layout with skopeo",
        epilog="Example: buck2 run //pkg:app-push -- ttl.sh/me-app:1h",
    )
    parser.add_argument("--skopeo", required=True, help=argparse.SUPPRESS)
    parser.add_argument("--image", required=True, type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--repository", help=argparse.SUPPRESS)
    parser.add_argument("--default-tag", action="append", default=[], help=argparse.SUPPRESS)
    parser.add_argument("destinations", nargs="*", metavar="REF",
                        help="image reference to push to, such as ghcr.io/me/app:v1")
    parser.add_argument("--tag", action="append", default=[],
                        help="push to REPOSITORY:TAG, using the target's repository")
    parser.add_argument("--authfile", help="registry credentials file for skopeo")
    parser.add_argument("--retry-times", type=int, default=3,
                        help="retries for each failed registry request (default 3)")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the skopeo commands instead of running them")
    args = parser.parse_args(argv)

    refs = list(args.destinations)
    tags = args.tag or ([] if refs else args.default_tag)
    if tags and not args.repository:
        parser.error("--tag needs a repository, which this target doesn't set")
    refs += [f"{args.repository}:{tag}" for tag in tags]
    if not refs:
        parser.error("name a destination, such as ttl.sh/$USER-image:1h")

    try:
        dests = [destination(ref) for ref in refs]
    except PushError as error:
        parser.error(str(error))

    with tempfile.TemporaryDirectory(prefix="oci-push-") as tmp:
        staged = Path(tmp) / "layout"
        digestfile = Path(tmp) / "digest"
        try:
            stage(args.image, staged)
        except PushError as error:
            print(f"oci_push: {error}", file=sys.stderr)
            return 1

        results = []
        for dest in dests:
            command = [
                args.skopeo, "--insecure-policy", "copy",
                "--multi-arch", "all",
                "--retry-times", str(args.retry_times),
                "--digestfile", str(digestfile),
            ]
            if args.authfile:
                command += ["--dest-authfile", args.authfile]
            if dest.startswith("docker://"):
                # Compress each layer before asking the registry for it, so a
                # layer the repository already has is not uploaded again.
                command.append("--dest-precompute-digests")
            command += [f"oci:{staged}", dest]

            print(f"oci_push: {shlex.join(command)}", file=sys.stderr)
            if args.dry_run:
                continue
            # skopeo reports progress on stdout. Keep stdout for the results.
            status = subprocess.run(command, stdout=sys.stderr).returncode
            if status != 0:
                print(f"oci_push: pushing to {dest} failed", file=sys.stderr)
                return status
            results.append(pinned(dest, digestfile.read_text().strip()))

    for line in results:
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
