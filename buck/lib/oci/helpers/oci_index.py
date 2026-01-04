# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
Create OCI image indexes for multi-platform images.
"""

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import List


class OciIndexBuilder:
    """Build multi-platform OCI image indexes"""

    def __init__(self, output_path: str):
        self.output_path = Path(output_path)
        self.output_path.mkdir(parents=True, exist_ok=True)

        # Initialize blobs directory
        (self.output_path / "blobs" / "sha256").mkdir(parents=True, exist_ok=True)

    def add_image(self, image_path: str, platform: str):
        """
        Add a platform-specific image to the index.

        Args:
            image_path: Path to OCI image layout
            platform: Platform string (e.g., "linux/amd64")
        """
        image = Path(image_path)

        print(f"Adding {platform} image from {image_path}", file=sys.stderr)

        # Load the image's index to get its manifest
        with open(image / "index.json") as f:
            image_index = json.load(f)

        # Get the manifest descriptor (assume first manifest)
        manifest_desc = image_index["manifests"][0]

        # Copy all blobs from this image
        src_blobs = image / "blobs"
        dst_blobs = self.output_path / "blobs"

        for algo_dir in src_blobs.iterdir():
            if algo_dir.is_dir():
                dst_algo = dst_blobs / algo_dir.name
                dst_algo.mkdir(exist_ok=True)

                for blob_file in algo_dir.iterdir():
                    dst_file = dst_algo / blob_file.name
                    if not dst_file.exists():
                        shutil.copy2(blob_file, dst_file)

        # Parse platform
        os_name, arch = platform.split("/", 1)
        platform_desc = {
            "architecture": arch,
            "os": os_name,
        }

        # Return manifest descriptor with platform info
        return {
            "mediaType": manifest_desc.get(
                "mediaType", "application/vnd.oci.image.manifest.v1+json"
            ),
            "digest": manifest_desc["digest"],
            "size": manifest_desc["size"],
            "platform": platform_desc,
        }

    def build(self, images: List[tuple[str, str]]):
        """
        Build the multi-platform index.

        Args:
            images: List of (image_path, platform) tuples
        """
        print("Building multi-platform OCI image index...", file=sys.stderr)

        manifest_descriptors = []

        for image_path, platform in images:
            desc = self.add_image(image_path, platform)
            manifest_descriptors.append(desc)

        # Create the index
        index = {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": manifest_descriptors,
        }

        # Write index.json
        with open(self.output_path / "index.json", "w") as f:
            json.dump(index, f, indent=2, sort_keys=True)

        # Write oci-layout marker
        oci_layout = {"imageLayoutVersion": "1.0.0"}
        with open(self.output_path / "oci-layout", "w") as f:
            json.dump(oci_layout, f, indent=2)

        print(
            f"Successfully created multi-platform index with {len(manifest_descriptors)} platforms",
            file=sys.stderr,
        )


def main():
    parser = argparse.ArgumentParser(
        description="Create multi-platform OCI image indexes"
    )
    parser.add_argument("--output", required=True, help="Output OCI image directory")
    parser.add_argument(
        "--image",
        action="append",
        required=True,
        help="Image to add (format: path:platform, e.g., /path/to/image:linux/amd64)",
    )

    args = parser.parse_args()

    # Parse image arguments
    images = []
    for img_arg in args.image:
        if ":" not in img_arg:
            print(f"Invalid image format: {img_arg}", file=sys.stderr)
            print("Expected format: path:platform", file=sys.stderr)
            sys.exit(1)
        path, platform = img_arg.rsplit(":", 1)
        images.append((path, platform))

    # Build the index
    builder = OciIndexBuilder(args.output)
    builder.build(images)


if __name__ == "__main__":
    main()
