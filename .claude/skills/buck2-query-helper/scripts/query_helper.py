#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
Buck2 query helper - enhanced queries with better formatting.

Provides shortcuts for common Buck2 query patterns with improved output.
"""

import argparse
import json
import subprocess
import sys
from typing import List, Optional


class Buck2Query:
    """Helper for running Buck2 queries with enhanced output."""

    def __init__(self, verbose: bool = False):
        self.verbose = verbose

    def run_query(self, query: str, output_json: bool = False) -> List[str]:
        """Run a buck2 query and return results."""
        cmd = ["buck2", "query", query]
        if output_json:
            cmd.append("--json")

        if self.verbose:
            print(f"Running: {' '.join(cmd)}", file=sys.stderr)

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, check=True
            )
            if output_json:
                return json.loads(result.stdout)
            return [line.strip() for line in result.stdout.splitlines() if line.strip()]
        except subprocess.CalledProcessError as e:
            print(f"Query failed: {e.stderr}", file=sys.stderr)
            sys.exit(1)

    def deps(
        self,
        target: str,
        transitive: bool = False,
        depth: Optional[int] = None,
        show_kind: bool = False,
        exclude: Optional[str] = None,
    ) -> None:
        """Show dependencies of a target."""
        if depth is not None and transitive:
            query = f"deps('{target}', {depth})"
        elif depth is not None:
            query = f"deps('{target}', {depth})"
        else:
            query = f"deps('{target}')"

        if exclude:
            query = f"{query} - {exclude}"

        results = self.run_query(query)

        if show_kind:
            self._show_with_kind(results)
        else:
            for result in results:
                print(result)

    def rdeps(
        self,
        target: str,
        scope: str = "//...",
        depth: Optional[int] = None,
        show_kind: bool = False,
        explain: bool = False,
    ) -> None:
        """Show reverse dependencies of a target."""
        if depth is not None:
            query = f"rdeps('{scope}', '{target}', {depth})"
        else:
            query = f"rdeps('{scope}', '{target}')"

        results = self.run_query(query)

        if explain:
            self._explain_deps(results, target)
        elif show_kind:
            self._show_with_kind(results)
        else:
            for result in results:
                print(result)

    def kind(self, kind_pattern: str, scope: str) -> None:
        """Filter targets by rule type."""
        query = f"kind('{kind_pattern}', '{scope}')"
        results = self.run_query(query)

        for result in results:
            print(result)

    def attrs(
        self,
        target: str,
        fields: Optional[str] = None,
        output_json: bool = False,
        raw: bool = False,
    ) -> None:
        """Show target attributes."""
        if fields:
            # Use output-attribute for specific fields
            cmd = ["buck2", "query", target, "--output-attribute", fields]
        else:
            # Show all attributes as JSON
            cmd = ["buck2", "query", target, "--json"]

        if self.verbose:
            print(f"Running: {' '.join(cmd)}", file=sys.stderr)

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)

            if output_json or not fields:
                data = json.loads(result.stdout)
                print(json.dumps(data, indent=2))
            elif raw:
                print(result.stdout)
            else:
                # Pretty print the output
                for line in result.stdout.splitlines():
                    if line.strip():
                        print(line)

        except subprocess.CalledProcessError as e:
            print(f"Query failed: {e.stderr}", file=sys.stderr)
            sys.exit(1)

    def path(self, from_target: str, to_target: str) -> None:
        """Find dependency path between two targets."""
        query = f"allpaths('{from_target}', '{to_target}')"
        results = self.run_query(query)

        if not results:
            print(f"No path found from {from_target} to {to_target}")
        else:
            print(f"Paths from {from_target} to {to_target}:")
            for result in results:
                print(f"  {result}")

    def cycles(self, scope: str) -> None:
        """Detect dependency cycles in scope."""
        # Buck2 doesn't have a built-in cycle detector in query language
        # This would require analyzing the graph
        print("Checking for cycles...")
        query = f"deps('{scope}')"
        # This is a simplified version - real cycle detection is complex
        print("Note: Full cycle detection requires graph analysis")
        print("Try: buck2 build --keep-going to detect cycles during build")

    def _show_with_kind(self, targets: List[str]) -> None:
        """Show targets with their rule types."""
        for target in targets:
            # Query the kind for each target
            try:
                cmd = ["buck2", "query", target, "--output-attribute", "buck.type"]
                result = subprocess.run(
                    cmd, capture_output=True, text=True, check=True
                )
                # Parse out the type from the output
                for line in result.stdout.splitlines():
                    if "buck.type" in line:
                        kind = line.split(":")[-1].strip().strip('"')
                        print(f"{target:60} [{kind}]")
                        break
                else:
                    print(f"{target:60} [unknown]")
            except subprocess.CalledProcessError:
                print(f"{target:60} [error]")

    def _explain_deps(self, targets: List[str], original_target: str) -> None:
        """Explain why each target depends on the original."""
        for target in targets:
            if target == original_target:
                continue

            # Find path from this target to original
            query = f"allpaths('{target}', '{original_target}')"
            try:
                paths = self.run_query(query)
                if paths:
                    print(f"\n{target}:")
                    # Show first few items in path
                    for i, path_item in enumerate(paths[:3]):
                        if path_item != target:
                            print(f"  -> {path_item}")
                    if len(paths) > 3:
                        print(f"  ... ({len(paths) - 3} more)")
            except:
                print(f"{target}: [unable to determine path]")


def main():
    parser = argparse.ArgumentParser(
        description="Buck2 query helper with enhanced output",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Find dependencies
  %(prog)s deps //src/tools:mytool
  %(prog)s deps --transitive --show-kind //src/tools:mytool

  # Find reverse dependencies
  %(prog)s rdeps //src/lib:common
  %(prog)s rdeps --scope //src/... --explain //src/lib:common

  # Filter by type
  %(prog)s kind rust_binary //src/...
  %(prog)s kind "rust_.*" //src/...

  # Inspect attributes
  %(prog)s attrs //src/lib:mylib
  %(prog)s attrs --fields srcs,deps //src/lib:mylib
        """,
    )

    parser.add_argument(
        "-v", "--verbose", action="store_true", help="Verbose output"
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    # deps command
    deps_parser = subparsers.add_parser("deps", help="Show dependencies")
    deps_parser.add_argument("target", help="Target to query")
    deps_parser.add_argument(
        "--transitive", action="store_true", help="Include transitive dependencies"
    )
    deps_parser.add_argument("--depth", type=int, help="Limit depth")
    deps_parser.add_argument(
        "--show-kind", action="store_true", help="Show rule type"
    )
    deps_parser.add_argument(
        "--exclude", help="Exclude pattern (e.g., //third-party/...)"
    )

    # rdeps command
    rdeps_parser = subparsers.add_parser(
        "rdeps", help="Show reverse dependencies"
    )
    rdeps_parser.add_argument("target", help="Target to query")
    rdeps_parser.add_argument(
        "--scope", default="//...", help="Search scope (default: //...)"
    )
    rdeps_parser.add_argument("--depth", type=int, help="Limit depth")
    rdeps_parser.add_argument(
        "--show-kind", action="store_true", help="Show rule type"
    )
    rdeps_parser.add_argument(
        "--explain", action="store_true", help="Explain dependency chains"
    )

    # kind command
    kind_parser = subparsers.add_parser("kind", help="Filter by rule type")
    kind_parser.add_argument("pattern", help="Rule type pattern")
    kind_parser.add_argument("scope", help="Scope to search")

    # attrs command
    attrs_parser = subparsers.add_parser("attrs", help="Inspect attributes")
    attrs_parser.add_argument("target", help="Target to inspect")
    attrs_parser.add_argument(
        "--fields", help="Comma-separated fields to show"
    )
    attrs_parser.add_argument(
        "--json", action="store_true", dest="output_json", help="JSON output"
    )
    attrs_parser.add_argument(
        "--raw", action="store_true", help="Raw output"
    )

    # path command
    path_parser = subparsers.add_parser(
        "path", help="Find dependency path"
    )
    path_parser.add_argument("from_target", help="Source target")
    path_parser.add_argument("to_target", help="Destination target")

    # cycles command
    cycles_parser = subparsers.add_parser(
        "cycles", help="Detect dependency cycles"
    )
    cycles_parser.add_argument("scope", help="Scope to check")

    args = parser.parse_args()

    query = Buck2Query(verbose=args.verbose)

    if args.command == "deps":
        query.deps(
            args.target,
            transitive=args.transitive,
            depth=args.depth,
            show_kind=args.show_kind,
            exclude=args.exclude,
        )
    elif args.command == "rdeps":
        query.rdeps(
            args.target,
            scope=args.scope,
            depth=args.depth,
            show_kind=args.show_kind,
            explain=args.explain,
        )
    elif args.command == "kind":
        query.kind(args.pattern, args.scope)
    elif args.command == "attrs":
        query.attrs(
            args.target,
            fields=args.fields,
            output_json=args.output_json,
            raw=args.raw,
        )
    elif args.command == "path":
        query.path(args.from_target, args.to_target)
    elif args.command == "cycles":
        query.cycles(args.scope)


if __name__ == "__main__":
    main()
