# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", "shims")

[
    shims.export_file(
        name=file,
        src=file,
    )
    for file in glob(["*"], exclude=["BUILD", "PACKAGE"])
]
