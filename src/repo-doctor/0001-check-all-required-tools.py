# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Check that required host tools are available in PATH (all platforms)."""

import platform
import shutil


# Each entry: (executable, platforms where it is required, short install hint).
# A platforms value of None means every platform. Nix only supports Linux and
# macOS, and the recommended .envrc uses it through direnv, so neither is
# required on Windows.
REQUIRED_TOOLS = [
    ("dotslash", None, "https://dotslash-cli.com"),
    ("nix", {"Linux", "Darwin"}, "https://nixos.org/download"),
    ("direnv", {"Linux", "Darwin"}, "https://direnv.net/docs/installation.html"),
]


ISSUE_INFORMATION = {
    "title": "Required tools not found in PATH",
    "platform": "All",
    "severity": "ERROR",
    "description": """
Working in this monorepo requires a few tools to be installed on the host:

- dotslash downloads and caches executable binaries, allowing the monorepo to
  provide consistent tooling across platforms without checking in large
  binaries. Without it, you can't run Buck2, jj, or other development tools
  that are distributed as dotslash executables under buck/bin/.

- Nix (Linux and macOS) provides the development shell defined by the flake in
  buck/nix, which supplies toolchains and utilities the build expects.

- direnv (Linux and macOS) loads .envrc when you enter the repository, putting
  buck/bin on your PATH and, through .envrc.nix.recommended, entering the Nix
  development shell automatically.
""".strip(),
    "fix": """
1. dotslash:
   - Official site: https://dotslash-cli.com
   - GitHub releases: https://github.com/facebook/dotslash/releases
   - Linux/macOS: extract the release tarball (tar -xzf dotslash-*.tar.gz)
     and move the dotslash binary somewhere on your PATH
   - macOS (Homebrew): brew install dotslash
   - Windows: extract dotslash.exe from the zip file and add its directory to
     your PATH environment variable

2. Nix (Linux and macOS):
   - Follow https://nixos.org/download, or use the Determinate Systems
     installer: https://determinate.systems/nix-installer
   - Make sure flakes are enabled (experimental-features = nix-command flakes
     in nix.conf); the Determinate installer enables them by default

3. direnv (Linux and macOS):
   - Install it from your package manager (e.g. dnf install direnv,
     apt install direnv, brew install direnv) or with
     nix profile install nixpkgs#direnv
   - Hook it into your shell: https://direnv.net/docs/hook.html
   - Enable the Nix environment for this repository:
       ln -s .envrc.nix.recommended .envrc.local
       direnv allow

4. Verify installation:
   - dotslash --version
   - nix --version
   - direnv --version

5. After installation, restart your shell or source your profile:
   - bash/zsh: source ~/.bashrc or source ~/.zshrc
   - fish: source ~/.config/fish/config.fish
""".strip(),
    "related_links": [
        "https://dotslash-cli.com",
        "https://github.com/facebook/dotslash",
        "https://nixos.org/download",
        "https://direnv.net",
        "https://github.com/nix-community/nix-direnv",
    ],
}


def run_check():
    """
    Check that every tool required on this platform is available in PATH.

    Returns a dict with: name, status, message, help_text (optional)
    Status must be one of: "OK", "WARNING", "ERROR", "SKIP"
    """
    system = platform.system()
    found = []
    missing = []

    for tool, platforms, hint in REQUIRED_TOOLS:
        if platforms is not None and system not in platforms:
            continue
        if shutil.which(tool):
            found.append(tool)
        else:
            missing.append((tool, hint))

    if not missing:
        return {
            "name": "Required tools in PATH",
            "status": "OK",
            "message": f"Found {', '.join(found)}",
        }

    names = ", ".join(tool for tool, _ in missing)
    return {
        "name": "Required tools in PATH",
        "status": "ERROR",
        "message": f"Not found in PATH: {names}",
        "help_text": "\n".join(f"Install {tool}: {hint}" for tool, hint in missing),
    }
