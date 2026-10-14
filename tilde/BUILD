# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

# Dotfiles are read by the programs they configure, not by the build. They are
# named from here rather than from a BUILD file of their own, which would be
# installed along with them.
shims.lint_files(
    name = "dotfiles",
    srcs = glob([
        "aseipp/dotfiles/direnv/direnvrc",
        "aseipp/dotfiles/fish/**/*.fish",
        "aseipp/dotfiles/helix/*.toml",
        "aseipp/dotfiles/jj/*.toml",
        "aseipp/dotfiles/nixpkgs/*.nix",
    ]),
)
