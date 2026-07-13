#!/usr/bin/env python3
"""
Helper script for running Buck2 target determination (tdutil) with common patterns.

This script simplifies the most common tdutil invocations and provides better output.
It only uses Python standard library to remain portable.
"""

import argparse
import os
import shlex
import subprocess
import sys
import tempfile

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
    print(f"  $ {shlex.join(cmd)}")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            print(f"✗ Error (exit code {result.returncode}):", file=sys.stderr)
            if result.stderr:
                print(result.stderr.rstrip(), file=sys.stderr)
            raise subprocess.CalledProcessError(
                result.returncode,
                cmd,
                output=result.stdout,
                stderr=result.stderr,
            )
        return result.stdout.strip()
    except FileNotFoundError:
        print(f"✗ Error: Command not found: {cmd[0]}", file=sys.stderr)
        raise


def count_targets(target_file):
    """Count lines in target file."""
    with open(target_file, "r", encoding="utf-8") as f:
        return sum(1 for _ in f)


def preview_targets(target_file, limit=10):
    """Show preview of targets."""
    try:
        with open(target_file, "r", encoding="utf-8") as f:
            targets = [line.strip() for line in f if line.strip()]

        if not targets:
            return []

        if len(targets) <= limit:
            return targets
        else:
            return targets[:limit] + [f"... and {len(targets) - limit} more"]
    except OSError:
        return []


def create_targets_file():
    """Create a private, unpredictable at-file and return its path."""
    fd, path = tempfile.mkstemp(prefix="tdutil-helper-", suffix=".txt")
    os.close(fd)
    return path


def remove_targets_file(path):
    """Remove a temporary at-file, tolerating external cleanup."""
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError as error:
        print(f"⚠️  Could not remove temporary target file: {error}", file=sys.stderr)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Helper for Buck2 target determination (tdutil)",
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
    args = parser.parse_args(argv)

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

    # Run tdutil
    print("🔍 Running target determination...")
    print(f"   Scope: {args.scope}")
    print()

    target_file = None
    retain_targets = False
    target_count = 0

    try:
        target_file = create_targets_file()
        cmd = [
            "buck2", "run", "root//buck/tools/tdutil:tdutil", "--",
            "--output", target_file,
            "--from", from_rev,
            "--to", to_rev,
            "--universe", args.scope,
        ]

        run_command(cmd, "Determining affected targets")

        # Show results
        print()
        target_count = count_targets(target_file)

        if target_count == 0:
            print("⚠️  No targets affected")
            print()
            print("Possible reasons:")
            print("  • No files changed (check: jj diff)")
            print("  • Changes only to files not in BUILD targets")
            print("  • Scope too narrow (try: depot//...)")
            print("  • Selected JJ revisions have no relevant tree changes")
            return 0

        # A nonempty list is the helper's useful output. Keep it after all
        # normal workflows, including successful build/test actions.
        retain_targets = True

        print(f"✓ Found {target_count} affected target(s)")
        print()

        # Show preview
        if args.preview > 0:
            print(f"Preview (first {args.preview}):")
            for target in preview_targets(target_file, args.preview):
                print(f"  {target}")
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

        print(f"Target file retained at: {shlex.quote(target_file)}")
        print()

        # With no action, print copy-pasteable, shell-quoted commands.
        if not args.build and not args.test:
            target_arg = shlex.quote(f"@{target_file}")
            print("To build/test these targets:")
            print(f"  buck2 build {target_arg}")
            print(f"  buck2 test {target_arg}")
            print()
            print("Or use an environment variable:")
            print(f"  TARGETS={shlex.quote(target_file)}")
            print('  buck2 build "@$TARGETS"')
            print('  buck2 test "@$TARGETS"')
            print()

        print(f"Remove it when finished: rm -f -- {shlex.quote(target_file)}")

        return 0

    except subprocess.CalledProcessError as error:
        if target_count > 0 and target_file:
            retain_targets = True
            print(
                f"Affected-target file retained at: {shlex.quote(target_file)}",
                file=sys.stderr,
            )
            print(
                f"Remove it when finished: rm -f -- {shlex.quote(target_file)}",
                file=sys.stderr,
            )
        return error.returncode or 1
    except FileNotFoundError:
        if target_count > 0 and target_file:
            retain_targets = True
            print(
                f"Affected-target file retained at: {shlex.quote(target_file)}",
                file=sys.stderr,
            )
            print(
                f"Remove it when finished: rm -f -- {shlex.quote(target_file)}",
                file=sys.stderr,
            )
        return 1
    except Exception as error:
        print(f"Unexpected error: {error}", file=sys.stderr)
        if target_count > 0 and target_file:
            retain_targets = True
            print(
                f"Affected-target file retained at: {shlex.quote(target_file)}",
                file=sys.stderr,
            )
            print(
                f"Remove it when finished: rm -f -- {shlex.quote(target_file)}",
                file=sys.stderr,
            )
        return 1
    except BaseException:
        if target_count > 0 and target_file:
            retain_targets = True
            print(
                f"Affected-target file retained at: {shlex.quote(target_file)}",
                file=sys.stderr,
            )
            print(
                f"Remove it when finished: rm -f -- {shlex.quote(target_file)}",
                file=sys.stderr,
            )
        raise
    finally:
        if target_file and not retain_targets:
            remove_targets_file(target_file)


if __name__ == "__main__":
    sys.exit(main())
