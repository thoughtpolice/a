# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test")
load("@cellar//bootstrap:source.bzl", "exact_patch", "write_file")
load("@cellar//bootstrap/stage0-posix/mescc-tools-extra:defs.bzl", "cc")

cc(
    name = "simple-patch",
    src = "simple-patch.c",
    arch = "amd64",
    os = "Linux",
    tools = "cellar//bootstrap/stage0-posix/seeds/linux-amd64:bins",
)

# Include partial-line matches, either side lacking a final newline, and deletion.
[
    [
        write_file(
            name = name + "-input",
            content = source,
        ),
        write_file(
            name = name + "-expected",
            content = expected,
        ),
        exact_patch(
            name = name + "-output",
            src = ":" + name + "-input",
            after = after,
            before = before,
        ),
        command_test(
            name = name,
            args = [
                "$(location :" + name + "-output)",
                "$(location :" + name + "-expected)",
            ],
            tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
        ),
    ]
    for name, source, before, after, expected in [
        ("exact-block", "prefix\nbefore\nsuffix\n", "before\n", "after\nextra\n", "prefix\nafter\nextra\nsuffix\n"),
        ("partial-line", "before beforeX\n", "beforeX", "after", "before after\n"),
        ("remove-newline", "prefix\nbefore\nsuffix\n", "before\n", "after", "prefix\naftersuffix\n"),
        ("add-newline", "before", "before", "after\n", "after\n"),
        ("delete-block", "prefix\nbefore\nsuffix\n", "before\n", "", "prefix\nsuffix\n"),
    ]
]

write_file(
    name = "context.patch",
    content = "--- before\n+++ after\n@@ -1,3 +1,3 @@\n prefix\n-before\n+after\n suffix\n\\ No newline at end of file\n",
)

write_file(
    name = "context-input",
    content = "prefix\nbefore\nsuffix",
)

write_file(
    name = "context-expected",
    content = "prefix\nafter\nsuffix",
)

exact_patch(
    name = "context-output",
    src = ":context-input",
    patch = ":context.patch",
)

command_test(
    name = "context-lines",
    args = [
        "$(location :context-output)",
        "$(location :context-expected)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

write_file(
    name = "input",
    content = "prefix\nbefore\nsuffix\n",
)

write_file(
    name = "duplicate",
    content = "before\nbefore\n",
)

# Reject malformed and ambiguous patches before opening the output. /dev/null
# keeps these cases independent of the test working directory.
[
    [
        write_file(
            name = name + ".patch",
            content = patch,
        ),
        command_test(
            name = name,
            args = [
                "1",
                "$(exe :simple-patch)",
                "$(location " + source + ")",
                "$(location :" + name + ".patch)",
                "/dev/null",
            ],
            tool = "cellar//bootstrap/stage1/tools:expect-exit",
        ),
    ]
    for name, source, patch in [
        ("reject-missing", ":input", "--- before\n+++ after\n@@ -1 +1 @@\n-absent\n+after\n"),
        ("reject-ambiguous", ":duplicate", "--- before\n+++ after\n@@ -1 +1 @@\n-before\n+after\n"),
        ("reject-empty", ":input", "--- before\n+++ after\n@@ -0,0 +1 @@\n+after\n"),
        ("reject-oversize", ":duplicate", "--- before\n+++ after\n@@ -1,3 +1 @@\n-prefix\n-before\n-suffix\n+after\n"),
        ("reject-truncated", ":input", "--- before\n+++ after\n@@ -1,2 +1 @@\n-before\n+after\n"),
        ("reject-extra-line", ":input", "--- before\n+++ after\n@@ -1 +1 @@\n-before\n+after\n+extra\n"),
        ("reject-offset", ":input", "--- before\n+++ after\n@@ -2 +1 @@\n-before\n+after\n"),
        ("reject-huge-count", ":input", "--- before\n+++ after\n@@ -1,99999999999999999999 +1 @@\n-before\n+after\n"),
        ("reject-unterminated", ":input", "--- before\n+++ after\n@@ -1 +1 @@\n-before\n+after"),
        ("reject-orphan-marker", ":input", "--- before\n+++ after\n@@ -1 +1 @@\n\\ No newline at end of file\n-before\n+after\n"),
        ("reject-marker-text", ":input", "--- before\n+++ after\n@@ -1 +1 @@\n-before\n\\ bad marker\n+after\n"),
        ("reject-lines-after-marker", ":input", "--- before\n+++ after\n@@ -1,2 +1 @@\n-before\n\\ No newline at end of file\n-extra\n+after\n"),
        ("reject-second-hunk", ":input", "--- before\n+++ after\n@@ -1 +1 @@\n-before\n+after\n@@ -1 +1 @@\n-before\n+after\n"),
    ]
]

command_test(
    name = "reject-input-as-output",
    args = [
        "1",
        "$(exe :simple-patch)",
        "$(location :context-input)",
        "$(location :context.patch)",
        "$(location :context-input)",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
)
