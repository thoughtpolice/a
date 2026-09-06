# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load("@root//buck/tools/hurl:defs.bzl", "hurl")

shims.export_file(
    name = "version-check-source",
    src = "version.check",
)

# A strict stand-in executable validates how hurl.test renders its command.
# The real distribution is independently exercised by ../:version-check and
# mems3's HTTP scenarios; these two tests need no server or network access.
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

hurl.test(
    name = "default-arguments",
    src = "arguments.hurl",
    _hurl = ":check-arguments",
)

hurl.test(
    name = "custom-arguments",
    src = "arguments.hurl",
    _hurl = ":check-arguments",
    connect_timeout = "1200ms",
    data = ["hidden.txt"],
    env = {"HURL_RULE_CASE": "custom"},
    file_root = ":fixtures",
    max_time = "9s",
    variables = {
        "fixture": "$(location :generated-input)",
        "value": "spaces and an = sign",
    },
)
