# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# check-spdx: a script to check the SPDX license headers of all files in the
# repository that are source code, and ensure they are correct. Run on change
# integration.

import sys, subprocess

# MARK: Bad file prefixes, suffixes, and exact matches
BAD_PREFIXES = [
    # dev files
    ".devcontainer",
    ".envrc",
    ".git",
    ".github",
    # editors
    ".helix",
    ".vscode",
    ".zed",
    # buck stuff: fixups, etc
    "buck/third-party/",
    "buck/prelude/",
]

BAD_SUFFIXES = [
    ".md",
    ".lock",
    ".txt",
    ".jsonc",
    ".exe",
    ".gitattributes",
    ".gitignore",
    ".ignore",
    ".buckconfig",
    ".buckroot",
    ".generated.bzl",
    "Cargo.toml",
    "reindeer.toml",
]

BAD_FILES = [
    # REASON: autogenerated
    "buck/third-party/rust/BUILD",
    # REASON: these get put on command lines, and are not source code
    "buck/mode/local",
    "buck/mode/cached",
    "buck/mode/cached-upload",
    "buck/mode/remote",
    "buck/mode/debug",
    "buck/mode/release",
    # REASON FIXME TODO (aseipp): this file is technically MIT and not
    # Apache-2.0, and it has a modified copyright year.
    "buck/third-party/mimalloc/rust/lib.rs",
]


def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)


# MARK: SPDX check
def has_spdx_header(file: str, lines: list[str]) -> bool:
    years = "2024-2025"
    bzl_style_header = [
        "# SPDX-FileCopyrightText: © {} ".format(years),
        "# SPDX-License-Identifier: Apache-2.0",
    ]

    cxx_style_header = [
        "// SPDX-FileCopyrightText: © {} ".format(years),
        "// SPDX-License-Identifier: Apache-2.0",
    ]

    old_cxx_style_header = [
        "/* SPDX-FileCopyrightText: © {} ".format(years),
        "/* SPDX-License-Identifier: Apache-2.0 */",
    ]

    file_matches = {
        ".py": bzl_style_header,
        "BUILD": bzl_style_header,
        "PACKAGE": bzl_style_header,
        ".bzl": bzl_style_header,
        ".bxl": bzl_style_header,
        ".rs": cxx_style_header,
        ".cpp": cxx_style_header,
        ".hpp": cxx_style_header,
        ".h": cxx_style_header,
        ".c": cxx_style_header,
        ".ts": cxx_style_header,
        ".js": cxx_style_header,
        ".nix": bzl_style_header,
        ".capnp": bzl_style_header,
        ".S": cxx_style_header,
        ".ld": old_cxx_style_header,
    }

    file_ext = None
    for key, value in file_matches.items():
        if file == key or file.endswith(key):
            file_ext = key
            break
    if file_ext is None:
        eprint(f"Error: {file} is an unknown file type, hard failing!")
        return False

    matches = file_matches[file_ext]
    for i, line in enumerate(lines):
        if i >= len(matches):
            break
        line = line.strip()

        # TODO FIXME (aseipp): match the actual name exactly rather than a
        # prefix match; this is for flexibility, right now.
        if not line.strip().startswith(matches[i]):
            eprint(f"Error: {file} does not have the correct SPDX header!")
            return False

    return True


# MARK: Entry point
def main():
    # run 'jj files' command and get line-by-line output
    files = (
        subprocess.run(
            ["jj", "file", "list"],
            stdout=subprocess.PIPE,
            check=True,
        )
        .stdout.decode("utf-8")
        .strip()
        .splitlines()
    )

    exit_code = 0
    for file in files:
        # normalize \ to / on Windows
        file = file.replace("\\", "/")
        # skip exact matches
        if file in BAD_FILES:
            continue
        # skip files that have bad prefixes
        if any(file.startswith(prefix) for prefix in BAD_PREFIXES):
            continue
        # and bad suffixes
        if any(file.endswith(suffix) for suffix in BAD_SUFFIXES):
            continue

        print(f"Checking {file}...")
        with open(file, "r", encoding="utf-8") as f:
            lines = f.readlines()
            # quick path: if the file starts with '#!' it's a script, skip it
            if lines[0].startswith("#!"):
                continue
            if not has_spdx_header(file, lines):
                exit_code = 1
    exit(exit_code)


if __name__ == "__main__":
    main()
