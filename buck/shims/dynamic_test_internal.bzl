# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Command tests with dynamically discovered cases via Buck2's internal runner.

`run_test` exposes an arbitrary binary as one opaque test. The rules here are
for binaries that can enumerate their own work: the binary reports which test
cases exist, executes one case per process, and emits any number of per-item
results from that single execution — batching expensive work (network calls,
`buck audit` invocations) in memory while still giving Buck2 a granular
verdict for every item it checked.

The binary must implement a small line protocol on stdout:

  1. `<binary> -list-tests <args...>` prints one `test: <filter> <name>` line
     per test case. Case names must contain no whitespace.
  2. Buck2 runs `<binary> -run-test <args...> <filter>` once per listed case,
     appending the case's filter as the final argument.
  3. The execution prints one `result: <STATUS> <name> <duration> [message]`
     line per checked item, where STATUS is PASS, FAIL, or SKIP, and duration
     is seconds as a float or `-` when unknown. An item's diagnostics follow
     its result line as `result-details: <text>` lines. Result names need not
     match the case name: one case may fan out into many named results.
  4. The process exits 0 when no item failed, 1 when at least one FAIL result
     was reported, and anything else (with no result lines) for infrastructure
     errors, which Buck2 turns into a synthesized failure carrying the raw
     output.

A result set whose FAIL entries disagree with the process exit code is
discarded so Buck2 synthesizes PASS/FAIL from the exit code and retains the
raw process output.

Listings are cacheable actions, so a listing must be a pure function of the
command line: binaries should emit a fixed case list (or derive it only from
declared input artifacts) and defer discovery that reads undeclared state —
lockfiles, `buck audit` output, the network — to case execution, which always
runs fresh. Test execution caching is disabled because results legitimately
change without any input changing (for example, a new advisory published in a
vulnerability database).

Reported names are prefixed with the owning target as `<package>:<name> -
<item>`, matching the other internal-runner rules. `buck2 run` on the target
invokes the plain batch command line without any protocol flags.
"""

load(":test_internal.bzl", "nonnegative_float_or_none")

_LISTING_PREFIX = "test: "
_RESULT_PREFIX = "result: "
_DETAILS_PREFIX = "result-details: "
_STATUSES = ["PASS", "FAIL", "SKIP"]

_ATTRS = {
    "args": attrs.list(attrs.arg(), default = []),
    "contacts": attrs.list(attrs.string(), default = []),
    "dep": attrs.dep(providers = [RunInfo]),
    "env": attrs.dict(attrs.string(), attrs.arg(), default = {}),
    "labels": attrs.list(attrs.string(), default = []),
    "type": attrs.string(default = "custom"),
}

def _result_entries(stdout: str) -> list[dict]:
    results = []
    for raw_line in stdout.splitlines():
        line = raw_line.rstrip()
        if line.startswith(_RESULT_PREFIX):
            fields = line[len(_RESULT_PREFIX):].split(" ")
            if len(fields) < 3 or fields[0] not in _STATUSES or not fields[1]:
                continue
            duration = None
            if fields[2] != "-":
                duration = nonnegative_float_or_none(fields[2])
                if duration == None:
                    continue
            results.append({
                "name": fields[1],
                "status": fields[0],
                "message": " ".join(fields[3:]) if len(fields) > 3 else None,
                "duration": duration,
                "details": "",
            })
        elif line.startswith(_DETAILS_PREFIX) and results:
            detail = raw_line[len(_DETAILS_PREFIX):]
            previous = results[-1]["details"]
            previous = previous + "\n" + detail if previous else detail
            results[-1]["details"] = previous
    return results

def _dynamic_test_impl(ctx: AnalysisContext, internal: bool) -> list[Provider]:
    run = ctx.attrs.dep[RunInfo]
    batch_command = [run.args] + ctx.attrs.args
    providers = [
        DefaultInfo(),
        RunInfo(args = cmd_args(batch_command)),
    ]
    if not internal:
        providers.append(ExternalRunnerTestInfo(
            type = ctx.attrs.type,
            command = batch_command,
            env = ctx.attrs.env,
            labels = ctx.attrs.labels,
            contacts = ctx.attrs.contacts,
        ))
        return providers

    target = ctx.label.package + ":" + ctx.label.name

    def parse_test_listing(listing_content: str) -> list[dict[str, str]]:
        entries = []
        for line in listing_content.splitlines():
            line = line.strip()
            if not line.startswith(_LISTING_PREFIX):
                continue
            fields = line[len(_LISTING_PREFIX):].split(" ")
            if len(fields) != 2 or not fields[0] or not fields[1]:
                continue
            entries.append({
                "name": target + " - " + fields[1],
                "filter": fields[0],
            })
        return entries

    def parse_test_result(stdout: str, stderr: str, exit_code: int) -> list[dict]:
        _ = stderr
        results = _result_entries(stdout)
        if len(results) == 0:
            return []

        # One execution reports many items, so the exit code reflects the
        # worst status: a FAIL entry requires a failing exit and vice versa.
        # Disagreement means the output cannot be trusted; returning no
        # entries asks Buck to synthesize PASS/FAIL from the exit code.
        fails = 0
        for result in results:
            if result["status"] == "FAIL":
                fails += 1
        if (exit_code == 0) != (fails == 0):
            return []

        for result in results:
            result["name"] = target + " - " + result["name"]
        return results

    providers.append(InternalRunnerTestInfo(
        type = ctx.attrs.type,
        command = [run.args, "-run-test"] + ctx.attrs.args,
        listing_command = [run.args, "-list-tests"] + ctx.attrs.args,
        env = ctx.attrs.env,
        labels = ctx.attrs.labels,
        contacts = ctx.attrs.contacts,
        supports_test_execution_caching = False,
        parse_test_listing = parse_test_listing,
        parse_test_result = parse_test_result,
    ))
    return providers

dynamic_test_internal = rule(
    impl = lambda ctx: _dynamic_test_impl(ctx, True),
    attrs = _ATTRS,
    doc = "Protocol-speaking command test driven by Buck2's internal runner.",
)

dynamic_test_external = rule(
    impl = lambda ctx: _dynamic_test_impl(ctx, False),
    attrs = _ATTRS,
    doc = "Fallback that runs the same binary as one opaque external test.",
)
