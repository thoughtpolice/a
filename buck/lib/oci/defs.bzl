# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
OCI (Open Container Initiative) image manipulation for Buck2.

This module provides comprehensive OCI image support including:
- Pulling images from registries (oci_pull)
- Building images from base + layers (oci_image)
- Packaging native binaries and their Nix runtime (oci_native_binary_image)
- Exporting Docker-compatible archives (oci_archive)
- Smoke-testing image layouts under Docker (oci_container_test)
- Unpacking images to filesystems (oci_unpack)
- Repacking filesystems to images (oci_repack)
- Multi-platform image indexes (oci_index)

Implementation uses:
- skopeo for registry operations
- umoci for unpack/repack operations
- Pure Python for manifest/config manipulation
"""

load(":archive.bzl", _oci_archive = "oci_archive")
load(":image.bzl", _oci_image = "oci_image")
load(":index.bzl", _oci_index = "oci_index")
load(":native_binary.bzl", _native_binary_layer = "native_binary_layer", _oci_native_binary_image = "oci_native_binary_image")
load(":pull.bzl", _oci_pull = "oci_pull")
load(":repack.bzl", _oci_repack = "oci_repack")
load(":smoke.bzl", _oci_container_test = "oci_container_test")
load(":unpack.bzl", _oci_unpack = "oci_unpack")

# Export all rules
oci_pull = _oci_pull
oci_image = _oci_image
oci_archive = _oci_archive
oci_container_test = _oci_container_test
native_binary_layer = _native_binary_layer
oci_native_binary_image = _oci_native_binary_image
oci_unpack = _oci_unpack
oci_repack = _oci_repack
oci_index = _oci_index
