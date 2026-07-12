# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Rust tests driven by Buck2's in-process test runner.

The stock `rust_test` rule surfaces a whole libtest binary as one opaque
test: ten `#[test]` functions still show up as a single unit of work. The
`rust_test_internal` rule instead hands the binary to Buck2's internal
runner via `InternalRunnerTestInfo`, which

  1. runs `<binary> --list --format terse` to discover individual tests,
  2. runs `<binary> --exact <name>` once per discovered test, and
  3. parses each run's libtest output into a per-test result.

This is the same "libtest CLI as a stable interface" contract cargo-nextest
builds on: stable flags only, one process per test, results recovered from
the human-readable harness report. It composes with `-Zpanic_abort_tests`
(the toolchain default here) since that changes how the harness executes
tests, not how it reports them.

The runner appends each test's `filter` string as the final argument of
`command`, hence `command` ends with `--exact` so the appended name selects
exactly one test. Results the parsers cannot make sense of (e.g. the harness
died before printing anything) yield no entries, and the runner synthesizes
a PASS/FAIL from the exit code instead.

Reported test names are prefixed with the owning target as
`<package>:<name> - <test path>`, matching how other test rules display, so
one test appearing under several targets (say a per-module target and an
all-in-one target compiling the same module) stays distinguishable. The
parse callbacks are constructed per target during analysis to capture that
label; only the bare test path is used as the execution filter.
"""

_LISTING_SUFFIX = ": test"
_RESULT_SEP = " ... "
_SHOULD_PANIC = " - should panic"

def _listing_names(listing_content: str) -> list[str]:
    # `--list --format terse` prints one `<name>: test` line per test
    # (benchmarks would print `<name>: benchmark`). The name doubles as the
    # `--exact` filter used to run it.
    names = []
    for line in listing_content.splitlines():
        line = line.strip()
        if line.endswith(_LISTING_SUFFIX):
            name = line[:len(line) - len(_LISTING_SUFFIX)]
            if name:
                names.append(name)
    return names

def _float_or_none(text: str) -> [None, float]:
    # float() fails hard on malformed input, so vet the characters first.
    if not text:
        return None
    dots = 0
    for c in text.elems():
        if c == ".":
            dots += 1
        elif not c.isdigit():
            return None
    if dots > 1:
        return None
    return float(text)

def _result_entries(stdout: str) -> list[dict]:
    # A single `--exact` run prints the usual libtest report:
    #
    #   running 1 test
    #   test refs::tests::parse_ref_line ... ok
    #
    #   test result: ok. 1 passed; 0 failed; ...; finished in 0.02s
    #
    # plus a `failures:` section holding the captured output when it failed.
    # `- should panic` annotations sit between the name and the outcome.
    results = []
    duration = None
    panic_line = None
    lines = stdout.splitlines()
    for i in range(len(lines)):
        line = lines[i].strip()
        if line.startswith("test result:"):
            idx = line.find("finished in ")
            if idx != -1:
                value = line[idx + len("finished in "):].strip()
                if value.endswith("s"):
                    value = value[:len(value) - 1]
                duration = _float_or_none(value)
        elif line.startswith("test ") and _RESULT_SEP in line:
            head = line[len("test "):]
            sep = head.find(_RESULT_SEP)
            name = head[:sep]
            outcome = head[sep + len(_RESULT_SEP):].strip()
            if name.endswith(_SHOULD_PANIC):
                name = name[:len(name) - len(_SHOULD_PANIC)]
            if outcome == "ok":
                results.append({"name": name, "status": "PASS", "message": None})
            elif outcome == "FAILED":
                results.append({"name": name, "status": "FAIL", "message": None})
            elif outcome == "ignored" or outcome.startswith("ignored,"):
                results.append({"name": name, "status": "SKIP", "message": outcome})
        elif panic_line == None and "panicked at" in line:
            # "thread 'x' panicked at src/foo.rs:1:5:" — the panic payload
            # sits on the following line under the current rustc format.
            panic_line = line
            if i + 1 < len(lines) and lines[i + 1].strip():
                panic_line += " " + lines[i + 1].strip()

    for result in results:
        # One test per invocation, so the harness elapsed time is that
        # test's own (modulo process startup).
        result["duration"] = duration if len(results) == 1 else None
        if result["status"] == "FAIL" and result["message"] == None:
            result["message"] = panic_line
    return results

def _rust_test_internal_impl(ctx: AnalysisContext) -> list[Provider]:
    binary = ctx.attrs.binary
    default_info = binary[DefaultInfo]

    # Closures capturing the target label, so reported names read
    # `src/tools/cache-server/storage:tests-concurrency - cas::get_blob`
    # while the execution filter stays the bare test path.
    target = ctx.label.package + ":" + ctx.label.name

    def parse_test_listing(listing_content: str) -> list[dict[str, str]]:
        return [
            {"name": target + " - " + name, "filter": name}
            for name in _listing_names(listing_content)
        ]

    def parse_test_result(stdout: str, stderr: str, exit_code: int) -> list[dict]:
        _ = (stderr, exit_code)  # runner synthesizes from exit code if we return []
        results = _result_entries(stdout)
        for result in results:
            result["name"] = target + " - " + result["name"]
        return results

    return [
        # Forward the harness binary so `buck2 build` and `buck2 run` on the
        # test target behave like they did for `rust_test`. Unlike the old
        # rule, RunInfo does not inject `env` — that only affected `buck2
        # run`, never test execution.
        DefaultInfo(
            default_outputs = default_info.default_outputs,
            other_outputs = default_info.other_outputs,
        ),
        RunInfo(args = cmd_args(binary[RunInfo])),
        InternalRunnerTestInfo(
            type = "rust",
            command = [cmd_args(binary[RunInfo]), "--exact"],
            listing_command = [cmd_args(binary[RunInfo]), "--list", "--format", "terse"],
            env = ctx.attrs.env,
            labels = ctx.attrs.labels,
            contacts = ctx.attrs.contacts,
            run_from_project_root = True,
            use_project_relative_paths = True,
            parse_test_listing = parse_test_listing,
            parse_test_result = parse_test_result,
        ),
    ]

rust_test_internal = rule(
    impl = _rust_test_internal_impl,
    attrs = {
        "binary": attrs.dep(
            providers = [RunInfo],
            doc = "The libtest harness executable (a rust_binary compiled with --test).",
        ),
        "contacts": attrs.list(attrs.string(), default = []),
        "env": attrs.dict(key = attrs.string(), value = attrs.arg(), sorted = False, default = {}),
        "labels": attrs.list(attrs.string(), default = []),
    },
    doc = "Runs a libtest binary through Buck2's internal runner, one process per discovered test.",
)
