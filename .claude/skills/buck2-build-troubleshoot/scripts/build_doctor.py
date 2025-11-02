#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
Buck2 build doctor - diagnose build failures systematically.

Analyzes error logs, checks common issues, and suggests fixes.
"""

import argparse
import json
import re
import subprocess
import sys
from typing import Dict, List, Optional, Tuple


class BuildDoctor:
    """Diagnoses Buck2 build failures and suggests fixes."""

    def __init__(self, verbose: bool = False):
        self.verbose = verbose
        self.issues = []
        self.suggestions = []

    def log(self, message: str) -> None:
        """Log message if verbose."""
        if self.verbose:
            print(f"[DEBUG] {message}", file=sys.stderr)

    def run_command(
        self, cmd: List[str], check: bool = False
    ) -> Tuple[int, str, str]:
        """Run command and return (returncode, stdout, stderr)."""
        self.log(f"Running: {' '.join(cmd)}")
        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, check=check
            )
            return result.returncode, result.stdout, result.stderr
        except subprocess.CalledProcessError as e:
            return e.returncode, e.stdout, e.stderr

    def check_what_failed(self) -> List[str]:
        """Check what failed recently using buck2 log."""
        self.log("Checking recent failures...")
        returncode, stdout, stderr = self.run_command(
            ["buck2", "log", "what-failed"]
        )

        if returncode != 0:
            self.issues.append("Cannot access buck2 logs")
            return []

        failed_targets = []
        for line in stdout.splitlines():
            line = line.strip()
            if line and line.startswith("//"):
                failed_targets.append(line)

        if failed_targets:
            self.issues.append(
                f"Recent failures: {', '.join(failed_targets[:5])}"
            )
            if len(failed_targets) > 5:
                self.issues.append(f"... and {len(failed_targets) - 5} more")

        return failed_targets

    def analyze_logs(self, show_logs: bool = False) -> None:
        """Analyze buck2 build logs for common issues."""
        self.log("Analyzing build logs...")
        returncode, stdout, stderr = self.run_command(["buck2", "log", "last"])

        if returncode != 0:
            self.issues.append("Cannot read build logs")
            return

        if show_logs:
            print("\n=== Build Log ===")
            print(stdout)
            print("=== End Log ===\n")

        # Common error patterns
        patterns = {
            "visibility": r"cannot depend on .* \(not visible\)",
            "cycle": r"cycle detected|circular dependency",
            "missing_dep": r"unresolved import|cannot find",
            "compilation": r"rustc failed|error: could not compile",
            "linking": r"undefined reference|ld returned",
            "cache": r"cache.*error|remote execution failed",
        }

        for issue_type, pattern in patterns.items():
            if re.search(pattern, stdout, re.IGNORECASE) or re.search(
                pattern, stderr, re.IGNORECASE
            ):
                self.issues.append(f"Detected {issue_type} error in logs")
                self._suggest_fix(issue_type)

    def _suggest_fix(self, issue_type: str) -> None:
        """Suggest fixes for specific issue types."""
        fixes = {
            "visibility": "Check target visibility in BUILD file. Add target to visibility list or set to PUBLIC.",
            "cycle": "Find cycle with: buck2 query \"allpaths('//target/a', '//target/b')\". Break cycle by extracting shared code.",
            "missing_dep": "Add missing dependency to BUILD file deps list.",
            "compilation": "Fix syntax errors in source code. Check BUILD file has correct srcs.",
            "linking": "Verify all library dependencies are in BUILD file. Check link order for C++.",
            "cache": "Try: buck2 clean && buck2 build //target --no-remote-cache",
        }

        if issue_type in fixes:
            self.suggestions.append(fixes[issue_type])

    def check_target_exists(self, target: str) -> bool:
        """Check if target exists."""
        self.log(f"Checking if target exists: {target}")
        returncode, stdout, stderr = self.run_command(
            ["buck2", "targets", target]
        )

        if returncode != 0:
            self.issues.append(f"Target {target} does not exist")
            self.suggestions.append(
                f"Check target name and BUILD file. List available: buck2 targets {target.rsplit(':', 1)[0]}:"
            )
            return False

        return True

    def check_visibility(self, target: str) -> None:
        """Check target visibility settings."""
        self.log(f"Checking visibility for {target}")
        returncode, stdout, stderr = self.run_command(
            ["buck2", "query", target, "--output-attribute", "visibility"]
        )

        if returncode != 0:
            self.issues.append(f"Cannot query visibility for {target}")
            return

        self.log(f"Visibility output: {stdout}")

        if "[]" in stdout or not stdout.strip():
            self.issues.append(f"{target} has private visibility")
            self.suggestions.append(
                f"Target is private. Update BUILD file to add visibility or set to PUBLIC."
            )

    def check_dependencies(self, target: str) -> None:
        """Check target dependencies."""
        self.log(f"Checking dependencies for {target}")
        returncode, stdout, stderr = self.run_command(
            ["buck2", "query", f"deps('{target}', 1)"]
        )

        if returncode != 0:
            self.issues.append(f"Cannot query dependencies for {target}")
            return

        deps = [line.strip() for line in stdout.splitlines() if line.strip()]
        self.log(f"Found {len(deps)} direct dependencies")

        # Check for common issues
        if len(deps) > 100:
            self.issues.append(f"{target} has {len(deps)} direct dependencies (very high)")
            self.suggestions.append(
                "Consider reducing direct dependencies or using intermediate libraries."
            )

    def check_cycles(self, scope: str) -> None:
        """Check for dependency cycles."""
        self.log(f"Checking for cycles in {scope}")
        # This is a simplified check - real cycle detection is complex
        self.suggestions.append(
            f"To detect cycles, try: buck2 build {scope} --keep-going"
        )

    def check_cache(self) -> None:
        """Check for cache issues."""
        self.log("Checking cache configuration...")
        returncode, stdout, stderr = self.run_command(
            ["buck2", "audit", "config", "cache"]
        )

        if returncode != 0:
            self.issues.append("Cannot check cache configuration")
        else:
            self.log(f"Cache config: {stdout}")

        self.suggestions.append(
            "If cache issues suspected, try: buck2 clean && buck2 kill"
        )

    def diagnose(
        self,
        targets: Optional[List[str]] = None,
        check_cache: bool = False,
        check_visibility_flag: bool = False,
        check_cycles_flag: bool = False,
        all_checks: bool = False,
        show_logs: bool = False,
    ) -> Dict:
        """Run diagnostics and return results."""
        print("Buck2 Build Doctor")
        print("=" * 60)

        # Check what failed recently
        failed = self.check_what_failed()

        # Analyze logs
        self.analyze_logs(show_logs=show_logs)

        # Check specific targets
        if targets:
            for target in targets:
                if self.check_target_exists(target):
                    if all_checks or check_visibility_flag:
                        self.check_visibility(target)
                    if all_checks:
                        self.check_dependencies(target)

        # Additional checks
        if all_checks or check_cache:
            self.check_cache()

        if all_checks or check_cycles_flag:
            scope = targets[0] if targets else "//src/..."
            self.check_cycles(scope)

        return {
            "issues": self.issues,
            "suggestions": self.suggestions,
            "failed_targets": failed,
        }

    def report(self, results: Dict, output_json: bool = False) -> None:
        """Print diagnosis report."""
        if output_json:
            print(json.dumps(results, indent=2))
            return

        print("\n" + "=" * 60)
        print("DIAGNOSIS")
        print("=" * 60)

        if results["issues"]:
            print("\nIssues Found:")
            for i, issue in enumerate(results["issues"], 1):
                print(f"  {i}. {issue}")
        else:
            print("\nNo obvious issues detected.")

        if results["suggestions"]:
            print("\nSuggested Fixes:")
            for i, suggestion in enumerate(results["suggestions"], 1):
                print(f"  {i}. {suggestion}")

        if not results["issues"] and not results["suggestions"]:
            print("\nTry:")
            print("  - buck2 build //target -v 2  (verbose output)")
            print("  - buck2 clean && buck2 build //target  (clean build)")
            print("  - buck2 kill && buck2 build //target  (restart daemon)")

        print("\n" + "=" * 60)


def main():
    parser = argparse.ArgumentParser(
        description="Buck2 build doctor - diagnose build failures",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Diagnose last failure
  %(prog)s

  # Diagnose specific target
  %(prog)s //src/tools:mytool

  # Run all checks
  %(prog)s --all-checks //target

  # Show build logs
  %(prog)s --show-logs //target
        """,
    )

    parser.add_argument(
        "targets",
        nargs="*",
        help="Targets to diagnose (optional)",
    )

    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Verbose output",
    )

    parser.add_argument(
        "--check-cache",
        action="store_true",
        help="Check cache configuration",
    )

    parser.add_argument(
        "--check-visibility",
        action="store_true",
        help="Check target visibility",
    )

    parser.add_argument(
        "--check-cycles",
        action="store_true",
        help="Check for dependency cycles",
    )

    parser.add_argument(
        "--all-checks",
        action="store_true",
        help="Run all diagnostic checks",
    )

    parser.add_argument(
        "--show-logs",
        action="store_true",
        help="Show build logs",
    )

    parser.add_argument(
        "--json",
        action="store_true",
        dest="output_json",
        help="Output as JSON",
    )

    args = parser.parse_args()

    doctor = BuildDoctor(verbose=args.verbose)

    results = doctor.diagnose(
        targets=args.targets if args.targets else None,
        check_cache=args.check_cache,
        check_visibility_flag=args.check_visibility,
        check_cycles_flag=args.check_cycles,
        all_checks=args.all_checks,
        show_logs=args.show_logs,
    )

    doctor.report(results, output_json=args.output_json)

    # Exit with error code if issues found
    return 1 if results["issues"] else 0


if __name__ == "__main__":
    sys.exit(main())
