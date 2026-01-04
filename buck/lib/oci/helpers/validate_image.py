# SPDX-FileCopyrightText: © 2024-2026 Benjamin Brittain
# SPDX-License-Identifier: Apache-2.0

"""
OCI Image Structure Validation Script

Validates that OCI images conform to the OCI Image Specification v1.0.
"""

import sys
import json
import hashlib
from pathlib import Path


def sha256_file(path: Path) -> str:
    """Compute SHA256 digest of a file."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(8192):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


def validate_oci_layout(image_dir: Path) -> bool:
    """Validate oci-layout file."""
    layout_file = image_dir / "oci-layout"
    if not layout_file.exists():
        print(f"ERROR: oci-layout file not found at {layout_file}")
        return False

    try:
        with open(layout_file) as f:
            layout = json.load(f)

        if "imageLayoutVersion" not in layout:
            print("ERROR: oci-layout missing imageLayoutVersion")
            return False

        if layout["imageLayoutVersion"] != "1.0.0":
            print(f"ERROR: Unsupported imageLayoutVersion: {layout['imageLayoutVersion']}")
            return False

        print(f"✓ Valid oci-layout with version {layout['imageLayoutVersion']}")
        return True
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON in oci-layout: {e}")
        return False


def validate_index(image_dir: Path) -> tuple[bool, dict]:
    """Validate index.json file."""
    index_file = image_dir / "index.json"
    if not index_file.exists():
        print(f"ERROR: index.json not found at {index_file}")
        return False, {}

    try:
        with open(index_file) as f:
            index = json.load(f)

        # Check required fields
        if "schemaVersion" not in index:
            print("ERROR: index.json missing schemaVersion")
            return False, {}

        if index["schemaVersion"] != 2:
            print(f"ERROR: Unsupported schemaVersion: {index['schemaVersion']}")
            return False, {}

        if "mediaType" not in index:
            print("ERROR: index.json missing mediaType")
            return False, {}

        expected_media_type = "application/vnd.oci.image.index.v1+json"
        if index["mediaType"] != expected_media_type:
            print(f"ERROR: Unexpected mediaType: {index['mediaType']}")
            return False, {}

        if "manifests" not in index:
            print("ERROR: index.json missing manifests")
            return False, {}

        print(f"✓ Valid index.json with {len(index['manifests'])} manifest(s)")
        return True, index
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON in index.json: {e}")
        return False, {}


def validate_blob(image_dir: Path, digest: str, expected_size: int = None) -> bool:
    """Validate that a blob exists and matches its digest."""
    if not digest.startswith("sha256:"):
        print(f"ERROR: Invalid digest format: {digest}")
        return False

    blob_hash = digest.split(":", 1)[1]
    blob_path = image_dir / "blobs" / "sha256" / blob_hash

    if not blob_path.exists():
        print(f"ERROR: Blob not found: {blob_path}")
        return False

    # Verify digest
    actual_digest = sha256_file(blob_path)
    if actual_digest != digest:
        print(f"ERROR: Blob digest mismatch for {blob_path}")
        print(f"  Expected: {digest}")
        print(f"  Actual:   {actual_digest}")
        return False

    # Verify size if provided
    if expected_size is not None:
        actual_size = blob_path.stat().st_size
        if actual_size != expected_size:
            print(f"ERROR: Blob size mismatch for {blob_path}")
            print(f"  Expected: {expected_size}")
            print(f"  Actual:   {actual_size}")
            return False

    return True


def validate_manifest(image_dir: Path, manifest_descriptor: dict) -> bool:
    """Validate a manifest blob."""
    digest = manifest_descriptor["digest"]
    size = manifest_descriptor["size"]

    # Validate blob exists and matches digest
    if not validate_blob(image_dir, digest, size):
        return False

    # Load and validate manifest content
    blob_hash = digest.split(":", 1)[1]
    manifest_path = image_dir / "blobs" / "sha256" / blob_hash

    try:
        with open(manifest_path) as f:
            manifest = json.load(f)

        # Check required fields
        required_fields = ["schemaVersion", "mediaType", "config", "layers"]
        for field in required_fields:
            if field not in manifest:
                print(f"ERROR: Manifest missing required field: {field}")
                return False

        if manifest["schemaVersion"] != 2:
            print(f"ERROR: Unsupported manifest schemaVersion: {manifest['schemaVersion']}")
            return False

        # Validate config blob
        config_digest = manifest["config"]["digest"]
        config_size = manifest["config"]["size"]
        if not validate_blob(image_dir, config_digest, config_size):
            print(f"ERROR: Invalid config blob: {config_digest}")
            return False

        # Validate config is valid JSON
        config_hash = config_digest.split(":", 1)[1]
        config_path = image_dir / "blobs" / "sha256" / config_hash
        try:
            with open(config_path) as f:
                config = json.load(f)
            print(f"  ✓ Valid config with {len(config.get('rootfs', {}).get('diff_ids', []))} layer(s)")
        except json.JSONDecodeError as e:
            print(f"ERROR: Invalid JSON in config blob: {e}")
            return False

        # Validate all layer blobs
        for i, layer in enumerate(manifest["layers"]):
            layer_digest = layer["digest"]
            layer_size = layer["size"]
            if not validate_blob(image_dir, layer_digest, layer_size):
                print(f"ERROR: Invalid layer blob {i}: {layer_digest}")
                return False

        print(f"✓ Valid manifest with {len(manifest['layers'])} layer(s)")
        return True
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON in manifest: {e}")
        return False


def validate_oci_image(image_dir: Path) -> bool:
    """
    Validate complete OCI image structure.

    Checks:
    - oci-layout file
    - index.json file
    - All referenced blobs exist
    - All digests match
    - All JSON is valid
    """
    print(f"\nValidating OCI image at: {image_dir}")
    print("=" * 70)

    # Validate oci-layout
    if not validate_oci_layout(image_dir):
        return False

    # Validate index.json
    success, index = validate_index(image_dir)
    if not success:
        return False

    # Validate blobs directory exists
    blobs_dir = image_dir / "blobs" / "sha256"
    if not blobs_dir.exists():
        print(f"ERROR: Blobs directory not found: {blobs_dir}")
        return False

    print(f"✓ Blobs directory exists: {blobs_dir}")

    # Validate each manifest
    for i, manifest_desc in enumerate(index["manifests"]):
        print(f"\nValidating manifest {i + 1}/{len(index['manifests'])}")
        if not validate_manifest(image_dir, manifest_desc):
            return False

    print("\n" + "=" * 70)
    print("✓ OCI image structure is VALID")
    return True


def main():
    if len(sys.argv) < 2:
        print("Usage: validate_image.py <oci_image_directory> [test_name]")
        sys.exit(1)

    image_path = Path(sys.argv[1])
    test_name = sys.argv[2] if len(sys.argv) > 2 else "unknown"

    if not image_path.exists():
        print(f"ERROR: Image directory does not exist: {image_path}")
        sys.exit(1)

    if not image_path.is_dir():
        print(f"ERROR: Path is not a directory: {image_path}")
        sys.exit(1)

    print(f"Test: {test_name}")

    success = validate_oci_image(image_path)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    import os
    main()
