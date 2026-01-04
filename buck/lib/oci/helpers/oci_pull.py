# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
Pull OCI images from registries using skopeo.
"""

import argparse
import subprocess
import sys
from pathlib import Path


def pull_image(skopeo_path: str, image: str, digest: str, platform: str, output: str):
    """
    Pull an OCI image from a registry using skopeo.

    Args:
        skopeo_path: Path to the skopeo binary
        image: Image name (e.g., "docker.io/library/alpine")
        digest: Image digest (e.g., "sha256:...")
        platform: Platform string (e.g., "linux/amd64")
        output: Output directory for OCI image layout
    """
    # Construct full image reference with digest
    if digest:
        full_image = f"{image}@{digest}"
    else:
        full_image = image

    # Ensure output directory exists
    output_path = Path(output)
    output_path.mkdir(parents=True, exist_ok=True)

    # Use skopeo to copy image to OCI layout
    # Format: oci:path:tag
    cmd = [
        skopeo_path,
        "copy",
        f"--override-os={platform.split('/')[0]}",
        f"--override-arch={platform.split('/')[1]}",
        f"docker://{full_image}",
        f"oci:{output}:latest",
    ]

    print(f"Pulling image: {full_image} for platform {platform}", file=sys.stderr)
    print(f"Command: {' '.join(cmd)}", file=sys.stderr)

    try:
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
        if result.stdout:
            print(result.stdout, file=sys.stderr)
        print(f"Successfully pulled image to {output}", file=sys.stderr)
    except subprocess.CalledProcessError as e:
        print(f"Failed to pull image: {e}", file=sys.stderr)
        if e.stdout:
            print(f"stdout: {e.stdout}", file=sys.stderr)
        if e.stderr:
            print(f"stderr: {e.stderr}", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description="Pull OCI images from registries using skopeo"
    )
    parser.add_argument("--skopeo", required=True, help="Path to skopeo binary")
    parser.add_argument("--image", required=True, help="Image name to pull")
    parser.add_argument(
        "--digest", required=False, default="", help="Image digest (optional)"
    )
    parser.add_argument(
        "--platform", required=True, help="Platform (e.g., linux/amd64)"
    )
    parser.add_argument("--output", required=True, help="Output directory")

    args = parser.parse_args()
    pull_image(args.skopeo, args.image, args.digest, args.platform, args.output)


if __name__ == "__main__":
    main()
