# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
Unpack OCI images to filesystem bundles using umoci.
"""

import argparse
import subprocess
import sys
from pathlib import Path


def unpack_image(umoci_path: str, image_path: str, tag: str, bundle_path: str):
    """
    Unpack an OCI image to an OCI runtime bundle.

    Args:
        umoci_path: Path to umoci binary
        image_path: Path to OCI image layout directory
        tag: Tag to unpack (e.g., "latest")
        bundle_path: Output bundle directory
    """
    bundle = Path(bundle_path)
    bundle.mkdir(parents=True, exist_ok=True)

    cmd = [
        umoci_path,
        "unpack",
        "--rootless",
        "--image",
        f"{image_path}:{tag}",
        bundle_path,
    ]

    print(f"Unpacking image from {image_path}:{tag}", file=sys.stderr)
    print(f"Command: {' '.join(cmd)}", file=sys.stderr)

    try:
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
        if result.stdout:
            print(result.stdout, file=sys.stderr)
        if result.stderr:
            print(result.stderr, file=sys.stderr)
        print(f"Successfully unpacked to {bundle_path}", file=sys.stderr)
    except subprocess.CalledProcessError as e:
        print(f"Failed to unpack image: {e}", file=sys.stderr)
        if e.stdout:
            print(f"stdout: {e.stdout}", file=sys.stderr)
        if e.stderr:
            print(f"stderr: {e.stderr}", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description="Unpack OCI images to filesystem bundles"
    )
    parser.add_argument("--umoci", required=True, help="Path to umoci binary")
    parser.add_argument("--image", required=True, help="OCI image layout directory")
    parser.add_argument("--tag", default="latest", help="Image tag to unpack")
    parser.add_argument("--output", required=True, help="Output bundle directory")

    args = parser.parse_args()
    unpack_image(args.umoci, args.image, args.tag, args.output)


if __name__ == "__main__":
    main()
