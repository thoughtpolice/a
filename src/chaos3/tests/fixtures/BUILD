# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

depot.python_binary(
    name = "generate",
    main = "generate.py",
)

depot.genrule(
    name = "fixtures",
    out = "fixtures",
    cmd = '$(exe :generate) "$OUT"',
    visibility = ["PUBLIC"],
)
