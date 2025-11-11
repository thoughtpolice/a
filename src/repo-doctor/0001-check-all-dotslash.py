# SPDX-FileCopyrightText: © 2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Check that dotslash is available in PATH (all platforms)."""

import shutil


ISSUE_INFORMATION = {
    "title": "dotslash not found in PATH",
    "platform": "All",
    "severity": "ERROR",
    "description": """
dotslash is a critical tool required to run build tools in this monorepo.
It downloads and caches executable binaries, allowing the monorepo to provide
consistent tooling across platforms without checking in large binaries.

Without dotslash, you won't be able to run Buck2, jj, or other essential
development tools that are distributed as dotslash executables.
""".strip(),
    "fix": """
1. Download dotslash from:
   - Official site: https://dotslash-cli.com
   - GitHub releases: https://github.com/facebook/dotslash/releases

2. Installation by platform:

   Linux/macOS:
   - Extract the binary: tar -xzf dotslash-*.tar.gz
   - Make it executable: chmod +x dotslash
   - Move to PATH: sudo mv dotslash /usr/local/bin/

   macOS (Homebrew):
   - brew install dotslash

   Windows:
   - Extract dotslash.exe from the zip file
   - Add the directory to your PATH environment variable

3. Verify installation:
   - Run: dotslash --version
   - You should see version information

4. After installation, restart your shell or source your profile:
   - bash/zsh: source ~/.bashrc or source ~/.zshrc
   - fish: source ~/.config/fish/config.fish
""".strip(),
    "related_links": [
        "https://dotslash-cli.com",
        "https://github.com/facebook/dotslash"
    ]
}


def run_check():
    """
    Check if dotslash is available in the system PATH.

    Returns a dict with: name, status, message, help_text (optional)
    Status must be one of: "OK", "WARNING", "ERROR", "SKIP"
    """
    # Check if dotslash is in PATH
    dotslash_path = shutil.which("dotslash")

    if dotslash_path:
        return {
            "name": "dotslash in PATH",
            "status": "OK",
            "message": f"Found at {dotslash_path}"
        }
    else:
        return {
            "name": "dotslash in PATH",
            "status": "ERROR",
            "message": "dotslash not found in PATH",
            "help_text": "Install dotslash from https://dotslash-cli.com and add it to your PATH."
        }
