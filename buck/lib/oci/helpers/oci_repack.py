# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
Repack OCI runtime bundles back into OCI images using umoci.
"""

import argparse
import subprocess
import sys
from pathlib import Path


def repack_bundle(
    umoci_path: str,
    bundle_path: str,
    output_path: str,
    tag: str,
    base_image: str = None,
):
    """
    Repack an OCI runtime bundle into an OCI image.

    Args:
        umoci_path: Path to umoci binary
        bundle_path: Path to bundle directory (from unpack)
        output_path: Output OCI image layout directory
        tag: Tag for the new image
        base_image: Optional base image to repack from
    """
    output = Path(output_path)

    # Initialize the OCI image layout if it doesn't exist
    layout_file = output / "oci-layout"
    if not layout_file.exists():
        print(f"Initializing OCI layout at {output_path}", file=sys.stderr)
        # umoci init doesn't like existing directories, so we need to use a temp location
        # and let umoci create it, OR manually create the OCI layout structure
        import json
        output.mkdir(parents=True, exist_ok=True)

        # Create oci-layout file
        with open(layout_file, 'w') as f:
            json.dump({"imageLayoutVersion": "1.0.0"}, f)

        # Create blobs directory
        (output / "blobs" / "sha256").mkdir(parents=True, exist_ok=True)

        # Create empty index.json
        with open(output / "index.json", 'w') as f:
            json.dump({
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.index.v1+json",
                "manifests": []
            }, f)

    # Repack the bundle into the OCI image
    cmd = [
        umoci_path,
        "repack",
        "--image",
        f"{output_path}:{tag}",
        bundle_path,
    ]

    print(f"Repacking bundle from {bundle_path}", file=sys.stderr)
    print(f"Command: {' '.join(cmd)}", file=sys.stderr)

    try:
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
        if result.stdout:
            print(result.stdout, file=sys.stderr)
        if result.stderr:
            print(result.stderr, file=sys.stderr)
        print(f"Successfully repacked to {output_path}:{tag}", file=sys.stderr)
    except subprocess.CalledProcessError as e:
        print(f"Failed to repack bundle: {e}", file=sys.stderr)
        if e.stdout:
            print(f"stdout: {e.stdout}", file=sys.stderr)
        if e.stderr:
            print(f"stderr: {e.stderr}", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description="Repack OCI bundles into OCI images"
    )
    parser.add_argument("--umoci", required=True, help="Path to umoci binary")
    parser.add_argument("--bundle", required=True, help="Bundle directory to repack")
    parser.add_argument("--output", required=True, help="Output OCI image directory")
    parser.add_argument("--tag", default="latest", help="Tag for output image")
    parser.add_argument("--base", help="Optional base image path")

    args = parser.parse_args()
    repack_bundle(args.umoci, args.bundle, args.output, args.tag, args.base)


if __name__ == "__main__":
    main()
