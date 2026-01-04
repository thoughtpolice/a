#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
doctor.py - Diagnostic tool for monorepo development environment

This tool checks that your system is properly configured for working with
this monorepo, including Buck2, file watching, and other requirements.

Check modules are dynamically loaded from src/repo-doctor/check-*.py
"""

import sys
sys.dont_write_bytecode = True

import os
import platform
import importlib.util
import argparse
from pathlib import Path
from enum import Enum


class CheckStatus(Enum):
    """Status of a diagnostic check."""
    OK = "OK"
    WARNING = "WARNING"
    ERROR = "ERROR"
    SKIP = "SKIP"


def get_distro_name():
    """Attempt to detect the Linux distribution name."""
    if platform.system() != "Linux":
        return None

    try:
        if os.path.exists("/etc/os-release"):
            with open("/etc/os-release", "r") as f:
                for line in f:
                    if line.startswith("ID="):
                        return line.split("=")[1].strip().strip('"')
    except Exception:
        pass

    return None


def load_check_modules(checks_dir):
    """
    Dynamically load all [0-9]{4}-check-*.py modules from the checks directory.

    Returns a list of tuples: (module, issue_id, issue_info) where:
    - module: The loaded Python module
    - issue_id: Extracted from filename (e.g., "0001-check-all-dotslash.py" → "DOC-0001")
    - issue_info: The module's ISSUE_INFORMATION dict (or None if not present)
    """
    modules = []
    checks_path = Path(checks_dir)

    if not checks_path.exists():
        print(f"Warning: Checks directory not found: {checks_dir}", file=sys.stderr)
        return modules

    # Look for files matching pattern: [0-9]{4}-check-*.py
    import re
    pattern = re.compile(r'^(\d{4})-check-.*\.py$')

    for check_file in sorted(checks_path.glob("[0-9][0-9][0-9][0-9]-check-*.py")):
        try:
            # Extract issue number from filename
            match = pattern.match(check_file.name)
            if not match:
                print(f"Warning: {check_file.name} doesn't match expected pattern", file=sys.stderr)
                continue

            issue_number = match.group(1)
            issue_id = f"DOC-{issue_number}"

            # Load the module dynamically
            spec = importlib.util.spec_from_file_location(check_file.stem, check_file)
            if spec and spec.loader:
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)

                # Verify it has a run_check function
                if hasattr(module, "run_check") and callable(module.run_check):
                    # Get ISSUE_INFORMATION if available
                    issue_info = getattr(module, "ISSUE_INFORMATION", None)
                    if not issue_info:
                        print(f"Warning: {check_file.name} missing ISSUE_INFORMATION", file=sys.stderr)
                    modules.append((module, issue_id, issue_info))
                else:
                    print(f"Warning: {check_file.name} missing run_check() function", file=sys.stderr)
        except Exception as e:
            print(f"Warning: Failed to load {check_file.name}: {e}", file=sys.stderr)

    return modules


def print_result(result, use_color=True):
    """Print a check result with appropriate formatting."""
    status_symbols = {
        "OK": "✓",
        "WARNING": "⚠",
        "ERROR": "✗",
        "SKIP": "-"
    }

    status_colors = {
        "OK": "\033[32m",      # Green
        "WARNING": "\033[33m", # Yellow
        "ERROR": "\033[31m",   # Red
        "SKIP": "\033[90m"     # Gray
    }

    reset = "\033[0m"
    status = result.get("status", "ERROR")
    issue_id = result.get("issue_id")

    # Format issue ID part if present
    issue_tag = ""
    if issue_id:
        if use_color:
            issue_tag = f" \033[90m[{issue_id}]\033[0m"
        else:
            issue_tag = f" [{issue_id}]"

    if use_color:
        color = status_colors.get(status, "")
        symbol = status_symbols.get(status, "?")
        print(f"{color}{symbol}{reset}{issue_tag} {result['name']}: {result['message']}")
    else:
        symbol = status_symbols.get(status, "?")
        print(f"[{status}]{issue_tag} {result['name']}: {result['message']}")

    if "help_text" in result and result["help_text"]:
        print()
        for line in result["help_text"].split("\n"):
            print(f"  {line}")
        # If there's an issue_id, add the --explain reference
        if issue_id:
            print(f"  Run 'doctor.py --explain {issue_id}' for detailed instructions.")
        print()


def run_diagnostics():
    """Run all diagnostic checks and return exit code."""
    print("=" * 70)
    print("Monorepo Environment Diagnostics")
    print("=" * 70)
    print()
    print(f"Platform: {platform.system()} {platform.release()}")
    print(f"Machine: {platform.machine()}")
    print(f"Python: {sys.version.split()[0]}")

    distro = get_distro_name()
    if distro:
        print(f"Distribution: {distro}")

    print()
    print("-" * 70)
    print()

    # Determine if we should use colors
    use_color = (
        sys.stdout.isatty() and
        os.getenv("NO_COLOR") is None and
        platform.system() != "Windows"
    )

    # Find the checks directory relative to this script
    script_dir = Path(__file__).parent
    checks_dir = script_dir / "src" / "repo-doctor"

    # Load all check modules
    check_modules = load_check_modules(checks_dir)

    if not check_modules:
        print("Error: No check modules found!", file=sys.stderr)
        return 1

    # Run all checks
    results = []
    for module, issue_id, issue_info in check_modules:
        try:
            result = module.run_check()
            if result and isinstance(result, dict):
                # Add issue_id to result - but only if status is not OK or SKIP
                if result.get("status") not in ["OK", "SKIP"]:
                    result["issue_id"] = issue_id
                else:
                    result["issue_id"] = None
                results.append(result)
            else:
                print(f"Warning: Check returned invalid result: {module.__name__}", file=sys.stderr)
        except Exception as e:
            print(f"Error running check {module.__name__}: {e}", file=sys.stderr)

    # Group skipped checks by platform
    skipped_by_platform = {}
    active_results = []

    for result in results:
        if result.get("status") == "SKIP":
            # Extract platform from check name or message
            name = result.get("name", "")
            if "linux" in name.lower() or "inotify" in name.lower():
                plat = "Linux"
            elif "macos" in name.lower() or "darwin" in name.lower():
                plat = "macOS"
            elif "windows" in name.lower():
                plat = "Windows"
            else:
                plat = "other platform"

            if plat not in skipped_by_platform:
                skipped_by_platform[plat] = []
            skipped_by_platform[plat].append(result.get("name", "unknown"))
        else:
            active_results.append(result)

    # Print active (non-skipped) results
    for result in active_results:
        print_result(result, use_color=use_color)

    # Print consolidated skip message
    if skipped_by_platform:
        skip_messages = []
        for plat, checks in sorted(skipped_by_platform.items()):
            count = len(checks)
            skip_messages.append(f"{count} {plat} check{'s' if count > 1 else ''}")

        skip_text = ", ".join(skip_messages)
        if use_color:
            print(f"\033[90m-\033[0m Skipped {skip_text}")
        else:
            print(f"[-] Skipped {skip_text}")

    # Summary
    error_count = sum(1 for r in active_results if r.get("status") == "ERROR")
    warning_count = sum(1 for r in active_results if r.get("status") == "WARNING")
    ok_count = sum(1 for r in active_results if r.get("status") == "OK")
    total_skip_count = sum(len(checks) for checks in skipped_by_platform.values())

    print("-" * 70)
    print()
    print(f"Summary: {ok_count} OK, {warning_count} warning(s), {error_count} error(s), {total_skip_count} skipped")
    print()

    if error_count > 0:
        print("⚠  Please fix the errors above before continuing development.")
        print()
        print("   Use --explain <issue-id> for detailed fix instructions")
        return 1
    elif warning_count > 0:
        print("⚠  Warnings detected. Your environment may work but could have issues.")
        print()
        print("   Use --explain <issue-id> for detailed fix instructions")
        return 0
    else:
        print("✓  All checks passed! Your environment is properly configured.")
        return 0


def show_issue_explanation(issue_id):
    """Display detailed explanation for a specific issue."""
    script_dir = Path(__file__).parent
    checks_dir = script_dir / "src" / "repo-doctor"

    # Load all check modules to find the one with this issue_id
    check_modules = load_check_modules(checks_dir)

    # Find the module with this issue_id
    for module, mod_issue_id, issue_info in check_modules:
        if mod_issue_id == issue_id:
            if not issue_info:
                print(f"Error: Issue {issue_id} found but has no ISSUE_INFORMATION", file=sys.stderr)
                return 1

            # Format and print the explanation
            lines = []
            lines.append("=" * 70)
            lines.append(f"{issue_id}: {issue_info['title']}")
            lines.append("=" * 70)
            lines.append(f"Platform: {issue_info['platform']}")
            lines.append(f"Severity: {issue_info['severity']}")
            lines.append("")
            lines.append("DESCRIPTION")
            lines.append("-" * 70)
            lines.append(issue_info['description'])
            lines.append("")
            lines.append("HOW TO FIX")
            lines.append("-" * 70)
            lines.append(issue_info['fix'])

            if issue_info.get('related_links'):
                lines.append("")
                lines.append("RELATED LINKS")
                lines.append("-" * 70)
                for link in issue_info['related_links']:
                    lines.append(f"  - {link}")

            lines.append("")
            print("\n".join(lines))
            return 0

    # Issue not found
    print(f"Error: Unknown issue ID '{issue_id}'", file=sys.stderr)
    print()
    print("Use --list-issues to see all available issue IDs")
    return 1


def list_all_issues():
    """List all known issues."""
    script_dir = Path(__file__).parent
    checks_dir = script_dir / "src" / "repo-doctor"

    # Load all check modules
    check_modules = load_check_modules(checks_dir)

    print("=" * 70)
    print("All Known Issues")
    print("=" * 70)
    print()

    # Group by platform
    by_platform = {}
    for module, issue_id, issue_info in check_modules:
        if not issue_info:
            continue

        platform_name = issue_info['platform']
        title = issue_info['title']
        severity = issue_info['severity']

        if platform_name not in by_platform:
            by_platform[platform_name] = []
        by_platform[platform_name].append((issue_id, title, severity))

    # Print grouped by platform
    for platform_name in sorted(by_platform.keys()):
        print(f"{platform_name}:")
        print("-" * 70)
        for issue_id, title, severity in by_platform[platform_name]:
            severity_tag = f"[{severity}]".ljust(9)
            print(f"  {issue_id}  {severity_tag}  {title}")
        print()

    print("Use --explain <issue-id> for detailed information about any issue")
    print()
    return 0


def main():
    """Main entry point with argument parsing."""
    parser = argparse.ArgumentParser(
        description="Diagnostic tool for monorepo development environment",
        epilog="Use --explain <issue-id> to get detailed fix instructions for specific issues"
    )

    parser.add_argument(
        "--explain",
        metavar="ISSUE_ID",
        help="Show detailed explanation and fix instructions for a specific issue (e.g., DOC-0001)"
    )

    parser.add_argument(
        "--list-issues",
        action="store_true",
        help="List all known issues and their IDs"
    )

    args = parser.parse_args()

    # Handle different modes
    if args.explain:
        return show_issue_explanation(args.explain)
    elif args.list_issues:
        return list_all_issues()
    else:
        return run_diagnostics()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n\nInterrupted by user")
        sys.exit(130)
