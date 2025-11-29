#!/usr/bin/env python3

# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
Claude Code Sandbox Launcher

Fetches and installs Claude Code from npm, then runs it inside a bubblewrap
sandbox for security isolation (Linux only; macOS runs unsandboxed).
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

NPM_REGISTRY_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest"
DEFAULT_PREFIX = Path.home() / ".claude" / "sandbox"
IS_MACOS = platform.system() == "Darwin"
IS_LINUX = platform.system() == "Linux"


def get_latest_claude_version() -> str:
    """Fetch the latest Claude Code version from npm registry."""
    with urllib.request.urlopen(NPM_REGISTRY_URL, timeout=30) as response:
        data = json.loads(response.read().decode("utf-8"))
        return data["version"]


def get_installed_version(prefix: Path) -> str | None:
    """Get the installed Claude Code version, or None if not installed."""
    claude_bin = prefix / "bin" / "claude"
    if not claude_bin.exists():
        return None
    try:
        result = subprocess.run(
            [str(claude_bin), "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            # Output is "2.0.55 (Claude Code)" - take first part
            version = result.stdout.strip().split()[0]
            return version
        return None
    except (subprocess.TimeoutExpired, OSError):
        return None


def install_claude(prefix: Path, version: str, verbose: bool = False) -> None:
    """Install Claude Code to the given prefix using npm."""
    npm = shutil.which("npm")
    if npm is None:
        raise RuntimeError("npm not found in PATH - please install Node.js")

    prefix.mkdir(parents=True, exist_ok=True)
    package = f"@anthropic-ai/claude-code@{version}"

    if verbose:
        print(f"Installing {package}...", file=sys.stderr)

    result = subprocess.run(
        [npm, "install", "--prefix", str(prefix), "-g", package],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        raise RuntimeError(f"npm install failed: {result.stderr}")


def build_bwrap_command(
    prefix: Path,
    workdir: Path,
    claude_args: list[str] | None = None,
    passthrough_env: list[str] | None = None,
) -> list[str]:
    """Build the bwrap command for sandboxed execution (Linux only)."""
    bwrap = shutil.which("bwrap")
    if bwrap is None:
        raise RuntimeError("bwrap not found - install bubblewrap")

    node = shutil.which("node")
    if node is None:
        raise RuntimeError("node not found - install Node.js")
    node_bin_dir = Path(node).resolve().parent

    claude_home = prefix / "home"
    claude_home.mkdir(parents=True, exist_ok=True)

    uid = os.getuid()
    xdg_runtime_dir = f"/run/user/{uid}"

    cmd: list[str] = [bwrap]
    cmd.extend(["--unshare-all", "--share-net"])
    cmd.extend(["--die-with-parent", "--new-session"])

    # Read-only system mounts
    for path in ["/usr", "/etc", "/bin", "/sbin", "/lib", "/lib64"]:
        if Path(path).exists():
            cmd.extend(["--ro-bind", path, path])

    # Mount node and its dependencies (Nix needs entire /nix for libraries)
    if str(node_bin_dir).startswith("/nix/"):
        cmd.extend(["--ro-bind", "/nix", "/nix"])
    else:
        cmd.extend(["--ro-bind", str(node_bin_dir.parent), str(node_bin_dir.parent)])

    cmd.extend(["--proc", "/proc"])
    cmd.extend(["--dev", "/dev"])
    cmd.extend(["--tmpfs", "/tmp"])

    # Bind /run for DNS resolver (systemd-resolved uses /run/systemd/resolve)
    if Path("/run").exists():
        cmd.extend(["--ro-bind", "/run", "/run"])

    # Sandbox home and npm installation
    cmd.extend(["--bind", str(claude_home), "/claude"])
    if (prefix / "lib").exists():
        cmd.extend(["--ro-bind", str(prefix / "lib"), "/claude/.local/lib"])
    if (prefix / "bin").exists():
        cmd.extend(["--ro-bind", str(prefix / "bin"), "/claude/.local/bin"])

    # Mount real Claude config for credentials, history, settings
    real_claude_dir = Path.home() / ".claude"
    if real_claude_dir.exists():
        cmd.extend(["--bind", str(real_claude_dir), "/claude/.claude"])
    real_claude_json = Path.home() / ".claude.json"
    if real_claude_json.exists():
        cmd.extend(["--bind", str(real_claude_json), "/claude/.claude.json"])

    # Project directory
    cmd.extend(["--bind", str(workdir.resolve()), "/work"])
    cmd.extend(["--chdir", "/work"])

    # Environment
    cmd.extend(["--setenv", "HOME", "/claude"])
    cmd.extend([
        "--setenv", "PATH",
        f"{node_bin_dir}:/claude/.local/bin:/usr/local/bin:/usr/bin:/bin"
    ])
    cmd.extend(["--setenv", "XDG_RUNTIME_DIR", xdg_runtime_dir])

    if passthrough_env:
        for var in passthrough_env:
            value = os.environ.get(var)
            if value:
                cmd.extend(["--setenv", var, value])

    cmd.append("/claude/.local/bin/claude")
    if claude_args:
        cmd.extend(claude_args)

    return cmd


def build_direct_command(
    prefix: Path,
    claude_args: list[str] | None = None,
) -> list[str]:
    """Build command for direct execution without sandbox (macOS)."""
    claude_bin = prefix / "bin" / "claude"
    cmd = [str(claude_bin)]
    if claude_args:
        cmd.extend(claude_args)
    return cmd


def main() -> int:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Run Claude Code (sandboxed on Linux, direct on macOS)",
    )
    parser.add_argument("--prefix", type=Path, default=DEFAULT_PREFIX)
    parser.add_argument("--workdir", type=Path, default=Path.cwd())
    parser.add_argument("--print-only", action="store_true",
                        help="Print command without executing")
    parser.add_argument("--version", dest="target_version",
                        help="Install specific version")
    parser.add_argument("--skip-install", action="store_true")
    parser.add_argument("--env", action="append", default=[], metavar="VAR",
                        help="Pass through environment variable")
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument("claude_args", nargs="*")

    args = parser.parse_args()

    try:
        # Determine target version
        if args.target_version:
            target_version = args.target_version
        else:
            target_version = get_latest_claude_version()

        # Check/install if needed
        if not args.skip_install:
            installed = get_installed_version(args.prefix)
            if installed != target_version:
                if args.verbose and installed:
                    print(f"Upgrading {installed} -> {target_version}", file=sys.stderr)
                install_claude(args.prefix, target_version, args.verbose)

        # Build command based on platform
        if IS_LINUX:
            passthrough_env = list(args.env)
            if "ANTHROPIC_API_KEY" not in passthrough_env and os.environ.get("ANTHROPIC_API_KEY"):
                passthrough_env.append("ANTHROPIC_API_KEY")
            cmd = build_bwrap_command(
                args.prefix, args.workdir, args.claude_args, passthrough_env
            )
        else:
            # macOS: run directly without sandbox
            if IS_MACOS and args.verbose:
                print("Note: sandboxing not available on macOS", file=sys.stderr)
            cmd = build_direct_command(args.prefix, args.claude_args)

        if args.print_only or args.verbose:
            print(" ".join(cmd), file=sys.stderr)

        if args.print_only:
            return 0

        os.execvp(cmd[0], cmd)

    except KeyboardInterrupt:
        return 130
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
