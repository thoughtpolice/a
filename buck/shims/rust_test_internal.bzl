# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Rust tests driven by Buck2's in-process test runner.

The stock `rust_test` rule surfaces a whole libtest binary as one opaque
test: ten `#[test]` functions still show up as a single unit of work. When the
root `test.use_internal_runner` setting enables the `rust` framework, the
public `depot.rust_test` macro selects the private rule in this file. It
compiles the exact same harness — reusing the prelude `rust_test` attrs and
implementation — but swaps
`ExternalRunnerTestInfo` for `InternalRunnerTestInfo`, which

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

Delegation makes these targets indistinguishable from `rust_test` outside
of `buck2 test`: `buck2 run` behaves identically (env injection included),
`DefaultInfo` keeps its sub-targets (rust-analyzer materializes `sources`),
and `RustAnalyzerInfo` carries target kind "test" so rust-project discovers
the target through the `_rust_analyzer_target_kind` attribute. For unit
tests sharing a library's crate root, name the target `<library>-unittest`
and list it in the library's `tests` attribute: rust-project then folds the
test into the library crate (activating cfg(test) and the test-only deps)
instead of emitting a second crate with a duplicate root.
"""

load("@prelude//decls:rust_rules.bzl", _prelude_rust_test = "rust_test")

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
    in_failure_output = False
    lines = stdout.splitlines()
    for i in range(len(lines)):
        line = lines[i].strip()
        if line == "failures:":
            # Captured output follows this marker and is arbitrary user text;
            # do not interpret status-shaped lines inside it as harness output.
            in_failure_output = True
        elif line.startswith("test result:"):
            idx = line.find("finished in ")
            if idx != -1:
                value = line[idx + len("finished in "):].strip()
                if value.endswith("s"):
                    value = value[:len(value) - 1]
                duration = _float_or_none(value)
        elif not in_failure_output and line.startswith("test ") and _RESULT_SEP in line:
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
        _ = stderr
        results = _result_entries(stdout)

        # An exact invocation must produce exactly one result whose status
        # agrees with the process exit. Returning no entries asks Buck to
        # synthesize PASS/FAIL from that exit code and retain the raw output.
        if len(results) != 1:
            return []
        if exit_code == 0 and results[0]["status"] == "FAIL":
            return []
        if exit_code != 0 and results[0]["status"] != "FAIL":
            return []

        for result in results:
            result["name"] = target + " - " + result["name"]
        return results

    # The external-runner provider carries the bare harness invocation; keep
    # that as our command base and drop the provider itself so `buck2 test`
    # only ever sees the internal runner. Everything else passes through.
    providers = []
    external = None
    for p in _prelude_rust_test.impl(ctx):
        if isinstance(p, ExternalRunnerTestInfo):
            external = p
        else:
            providers.append(p)
    if external == None:
        fail("prelude rust_test impl returned no ExternalRunnerTestInfo")

    harness = list(external.command)
    providers.append(InternalRunnerTestInfo(
        # The provider constructor calls this `type`, while its readable field
        # is exposed as `test_type`.
        type = external.test_type,
        command = harness + ["--exact"],
        listing_command = harness + ["--list", "--format", "terse"],
        env = external.env,
        labels = external.labels,
        contacts = external.contacts,
        run_from_project_root = external.run_from_project_root,
        use_project_relative_paths = external.use_project_relative_paths,
        default_executor = external.default_executor,
        executor_overrides = external.executor_overrides,
        local_resources = external.local_resources,
        required_local_resources = external.required_local_resources,
        worker = external.worker,
        supports_test_execution_caching = external.supports_test_execution_caching,
        parse_test_listing = parse_test_listing,
        parse_test_result = parse_test_result,
    ))
    return providers

rust_test_internal = rule(
    impl = _rust_test_internal_impl,
    attrs = _prelude_rust_test.attrs,
    uses_plugins = _prelude_rust_test.uses_plugins,
    supports_incoming_transition = _prelude_rust_test.supports_incoming_transition,
    doc = "rust_test whose harness runs through Buck2's internal runner, one process per discovered test.",
)
