#!/usr/bin/env python3
"""
Helper script for running Buck2 target determination (quicktd) with common patterns.

This script simplifies the most common quicktd invocations and provides better output.
It only uses Python standard library to remain portable.
"""

import argparse
import subprocess
import sys
import os

# Common revset patterns
PATTERNS = {
    "current": ("@-", "@", "Changes in current commit"),
    "trunk": ("trunk()", "@", "Changes since trunk"),
    "full": ("root()", "@", "Full repository scan"),
}

DEFAULT_SCOPE = "depot//src/..."


def run_command(cmd, description=""):
    """Run a command and handle errors."""
    if description:
        print(f"→ {description}")
    print(f"  $ {' '.join(cmd)}")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            print(f"✗ Error (exit code {result.returncode}):", file=sys.stderr)
            print(result.stderr, file=sys.stderr)
            sys.exit(result.returncode)
        return result.stdout.strip()
    except FileNotFoundError:
        print(f"✗ Error: Command not found: {cmd[0]}", file=sys.stderr)
        sys.exit(1)


def count_targets(target_file):
    """Count lines in target file."""
    try:
        with open(target_file, 'r') as f:
            return sum(1 for _ in f)
    except FileNotFoundError:
        return 0


def preview_targets(target_file, limit=10):
    """Show preview of targets."""
    try:
        with open(target_file, 'r') as f:
            targets = [line.strip() for line in f if line.strip()]

        if not targets:
            return []

        if len(targets) <= limit:
            return targets
        else:
            return targets[:limit] + [f"... and {len(targets) - limit} more"]
    except FileNotFoundError:
        return []


def main():
    parser = argparse.ArgumentParser(
        description="Helper for Buck2 target determination (quicktd)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Interactive mode
  %(prog)s

  # Quick patterns
  %(prog)s --pattern current
  %(prog)s --pattern trunk --test
  %(prog)s --pattern full --build --test

  # Custom revsets
  %(prog)s --from '@---' --to '@'
  %(prog)s --from 'trunk()' --to '@' --scope depot//src/myproject/...

  # Auto-build and test
  %(prog)s --pattern current --build --test
        """
    )

    parser.add_argument(
        "--pattern",
        choices=["current", "trunk", "full"],
        help="Use a common revset pattern"
    )
    parser.add_argument(
        "--from",
        dest="from_rev",
        help="From revset (e.g., '@-', 'trunk()')"
    )
    parser.add_argument(
        "--to",
        dest="to_rev",
        help="To revset (e.g., '@')"
    )
    parser.add_argument(
        "--scope",
        default=DEFAULT_SCOPE,
        help=f"Target scope pattern (default: {DEFAULT_SCOPE})"
    )
    parser.add_argument(
        "--build",
        action="store_true",
        help="Automatically build affected targets"
    )
    parser.add_argument(
        "--test",
        action="store_true",
        help="Automatically test affected targets"
    )
    parser.add_argument(
        "--preview",
        type=int,
        default=10,
        metavar="N",
        help="Show N target previews (default: 10)"
    )

    args = parser.parse_args()

    # Determine revsets
    if args.pattern:
        from_rev, to_rev, desc = PATTERNS[args.pattern]
        print(f"📋 Pattern: {args.pattern}")
        print(f"   {desc}")
        print(f"   From: {from_rev}")
        print(f"   To: {to_rev}")
        print()
    elif args.from_rev and args.to_rev:
        from_rev = args.from_rev
        to_rev = args.to_rev
        print(f"📋 Custom revsets:")
        print(f"   From: {from_rev}")
        print(f"   To: {to_rev}")
        print()
    else:
        # Interactive mode
        print("📋 Buck2 Target Determination")
        print()
        print("Common patterns:")
        for name, (f, t, desc) in PATTERNS.items():
            print(f"  {name:8} - {desc} ({f} → {t})")
        print()

        pattern = input("Select pattern (current/trunk/full) or press Enter for custom: ").strip()

        if pattern in PATTERNS:
            from_rev, to_rev, _ = PATTERNS[pattern]
        else:
            from_rev = input(f"From revset (default: @-): ").strip() or "@-"
            to_rev = input(f"To revset (default: @): ").strip() or "@"

        custom_scope = input(f"Scope (default: {DEFAULT_SCOPE}): ").strip()
        if custom_scope:
            args.scope = custom_scope

        print()

    # Run quicktd
    print("🔍 Running target determination...")
    print(f"   Scope: {args.scope}")
    print()

    cmd = [
        "buck2", "run", "root//buck/tools/quicktd", "--",
        from_rev, to_rev, args.scope
    ]

    target_file = run_command(cmd, "Determining affected targets")

    # Show results
    print()
    count = count_targets(target_file)

    if count == 0:
        print("⚠️  No targets affected")
        print()
        print("Possible reasons:")
        print("  • No files changed (check: jj diff)")
        print("  • Changes only to files not in BUILD targets")
        print("  • Scope too narrow (try: depot//...)")
        print("  • Files not committed (check: jj status)")
        sys.exit(0)

    print(f"✓ Found {count} affected target(s)")
    print()

    # Show preview
    if args.preview > 0:
        print(f"Preview (first {args.preview}):")
        for target in preview_targets(target_file, args.preview):
            print(f"  {target}")
        print()

    print(f"Target file: {target_file}")
    print()

    # Build if requested
    if args.build:
        print("🔨 Building affected targets...")
        build_cmd = ["buck2", "build", f"@{target_file}"]
        run_command(build_cmd, "Building")
        print("✓ Build complete")
        print()

    # Test if requested
    if args.test:
        print("🧪 Testing affected targets...")
        test_cmd = ["buck2", "test", f"@{target_file}"]
        run_command(test_cmd, "Testing")
        print("✓ Tests complete")
        print()

    # Show usage hint
    if not args.build and not args.test:
        print("To build/test these targets:")
        print(f"  buck2 build @{target_file}")
        print(f"  buck2 test @{target_file}")
        print()
        print("Or use environment variable:")
        print(f"  TARGETS={target_file}")
        print(f"  buck2 build @$TARGETS")
        print(f"  buck2 test @$TARGETS")


if __name__ == "__main__":
    main()
