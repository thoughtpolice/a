# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

VERSION = "2.304"

# The static fonts, by style: JetBrainsMono-<style>.ttf.
STYLES = [
    "Regular",
    "Bold",
    "Italic",
    "BoldItalic",
]

shims.http_archive(
    name = "release",
    sha256 = "6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf",
    sub_targets = ["fonts/ttf/JetBrainsMono-{}.ttf".format(s) for s in STYLES] + ["OFL.txt"],
    type = "zip",
    urls = [
        "https://github.com/JetBrains/JetBrainsMono/releases/download/v{0}/JetBrainsMono-{0}.zip".format(VERSION),
    ],
)

# Each style's font file: :Regular, :Bold, :Italic, :BoldItalic.
[
    shims.alias(
        name = style,
        actual = ":release[fonts/ttf/JetBrainsMono-{}.ttf]".format(style),
    )
    for style in STYLES
]

shims.alias(
    name = "license",
    actual = ":release[OFL.txt]",
)
