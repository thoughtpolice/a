# SPDX-FileCopyrightText: © 2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
OCI (Open Container Initiative) image manipulation for Buck2.

This module provides comprehensive OCI image support including:
- Pulling images from registries (oci_pull)
- Building images from base + layers (oci_image)
- Unpacking images to filesystems (oci_unpack)
- Repacking filesystems to images (oci_repack)
- Multi-platform image indexes (oci_index)

Implementation uses:
- skopeo for registry operations
- umoci for unpack/repack operations
- Pure Python for manifest/config manipulation
"""

load(":image.bzl", _oci_image = "oci_image")
load(":index.bzl", _oci_index = "oci_index")
load(":pull.bzl", _oci_pull = "oci_pull")
load(":repack.bzl", _oci_repack = "oci_repack")
load(":unpack.bzl", _oci_unpack = "oci_unpack")

# Export all rules
oci_pull = _oci_pull
oci_image = _oci_image
oci_unpack = _oci_unpack
oci_repack = _oci_repack
oci_index = _oci_index
