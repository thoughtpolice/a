# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Go tests driven by Buck2's in-process test runner.

The stock prelude `go_test` exposes the generated test binary as one opaque
test. This rule delegates compilation and every non-runner provider to that
implementation, replacing only `ExternalRunnerTestInfo` with
`InternalRunnerTestInfo`.

Go's generated test harness provides the discovery and execution interface:

  1. `<binary> -test.list .` lists registered top-level tests, fuzz tests,
     examples, and benchmarks without executing them;
  2. benchmarks are discarded because ordinary `go test` does not run them;
  3. every remaining item is run in its own process with
     `<binary> -test.v -test.run ^<name>$`; and
  4. the verbose `--- PASS`, `--- FAIL`, and `--- SKIP` line is converted to
     an internal-runner result.

The Go harness intentionally lists top-level tests only. Subtests still run in
their parent's isolated process, exactly as they do for an anchored `-run`
selection. A result that cannot be parsed, or whose status disagrees with the
process exit code, is omitted so Buck synthesizes PASS/FAIL from the exit and
retains the raw process output.
"""

load("@prelude//:rules.bzl", "clone_rule")
load("@prelude//go:go_test.bzl", _prelude_go_test_impl = "go_test_impl")
load(":test_internal.bzl", "internal_runner_from_external", "nonnegative_float_or_none")

_RESULT_PREFIXES = [
    ("--- PASS: ", "PASS"),
    ("--- FAIL: ", "FAIL"),
    ("--- SKIP: ", "SKIP"),
]

def _is_test_name(name: str) -> bool:
    # `-test.list` also emits benchmarks. Restricting the accepted names has
    # the additional benefit of ignoring unrelated stdout from package init
    # functions that execute before flag handling.
    return (
        name.startswith("Test") or
        name.startswith("Fuzz") or
        name.startswith("Example")
    ) and " " not in name and "\t" not in name

def _listing_names(listing_content: str) -> list[str]:
    names = []
    for line in listing_content.splitlines():
        name = line.strip()
        if _is_test_name(name):
            names.append(name)
    return names

def _result_entries(stdout: str) -> list[dict]:
    results = []
    for raw_line in stdout.splitlines():
        line = raw_line.strip()
        for prefix, status in _RESULT_PREFIXES:
            if not line.startswith(prefix):
                continue

            value = line[len(prefix):]
            duration = None
            duration_start = value.find(" (")
            if duration_start != -1 and value.endswith("s)"):
                duration = nonnegative_float_or_none(value[duration_start + 2:len(value) - 2])
                name = value[:duration_start]
            else:
                name = value

            # Verbose output contains a result for every subtest. Only the
            # top-level item was discovered and scheduled as a process.
            if name and "/" not in name:
                results.append({
                    "name": name,
                    "status": status,
                    "message": None,
                    "duration": duration,
                })
            break
    return results

def _go_test_internal_impl(ctx: AnalysisContext) -> list[Provider]:
    target = ctx.label.package + ":" + ctx.label.name

    def parse_test_listing(listing_content: str) -> list[dict[str, str]]:
        return [
            {
                "name": target + " - " + name,
                # Go's -run value is a regular expression. Registered
                # top-level names are Go identifiers, so anchors are enough
                # to make this an exact selection.
                "filter": "^" + name + "$",
            }
            for name in _listing_names(listing_content)
        ]

    def parse_test_result(stdout: str, stderr: str, exit_code: int) -> list[dict]:
        _ = stderr
        results = _result_entries(stdout)
        if len(results) != 1:
            return []
        if exit_code == 0 and results[0]["status"] == "FAIL":
            return []
        if exit_code != 0 and results[0]["status"] != "FAIL":
            return []

        results[0]["name"] = target + " - " + results[0]["name"]
        return results

    providers = []
    external = None
    for p in _prelude_go_test_impl(ctx):
        if isinstance(p, ExternalRunnerTestInfo):
            external = p
        else:
            providers.append(p)
    if external == None:
        fail("prelude go_test impl returned no ExternalRunnerTestInfo")

    harness = list(external.command)
    providers.append(internal_runner_from_external(
        external = external,
        command = harness + ["-test.v", "-test.run"],
        listing_command = harness + ["-test.list", "."],
        parse_test_listing = parse_test_listing,
        parse_test_result = parse_test_result,
    ))
    return providers

# clone_rule preserves the prelude's generated/private attributes and its Go
# configuration transition. Re-declaring the public attrs by hand is subtly
# wrong because the implementation also consumes toolchain and helper attrs
# contributed by rules_impl.bzl.
go_test_internal = clone_rule("go_test", impl_override = _go_test_internal_impl)
