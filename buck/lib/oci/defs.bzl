# SPDX-FileCopyrightText: © 2024-2025 Benjamin Brittain
# SPDX-License-Identifier: Apache-2.0

load(":image.bzl", "oci_image")
load(":pull.bzl", "oci_pull")
load(":push.bzl", "oci_push")

oci_image = oci_image
oci_pull = oci_pull
oci_push = oci_push
