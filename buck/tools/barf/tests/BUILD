# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load("@root//buck/tools/barf:defs.bzl", "barf")

# A strict stand-in executable validates how barf.test renders its command.
# barf itself is covered by ../:unit and chaos3's HTTP scenarios; these two
# tests need no server or network access.
shims.go_binary(
    name = "check-arguments",
    srcs = ["check_arguments.go"],
    cgo_enabled = False,
    link_mode = "internal",
)

shims.write_file(
    name = "generated-input",
    contents = ["a generated fixture"],
)

shims.copy_files(
    name = "fixtures",
    srcs = {"input.txt": ":generated-input"},
)

barf.test(
    name = "default-arguments",
    src = "arguments.barf",
    _barf = ":check-arguments",
)

barf.test(
    name = "custom-arguments",
    src = "arguments.barf",
    _barf = ":check-arguments",
    connect_timeout = "1200ms",
    data = ["hidden.txt"],
    env = {"BARF_RULE_CASE": "custom"},
    file_root = ":fixtures",
    request_timeout = "9s",
    variables = {
        "fixture": "$(location :generated-input)",
        "value": "spaces and an = sign",
    },
)
