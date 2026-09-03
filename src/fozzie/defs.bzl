# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Buck rules for instrumented Fozzie binaries and campaigns."""

load("@root//buck/shims:shims.bzl", depot = "shims")

_ENGINE = "root//src/fozzie/engine:fozzie"
_HARNESS = "root//src/fozzie/harness:fozzie"
_RUNTIME = "root//src/fozzie/runtime:runtime"
_MIMALLOC = "third-party//by-name/mi/mimalloc:rust"
_LINUX = "config//os:linux"

_SELF_CONTAINED_LINKER_FLAGS = [
    "-static-libgcc",
    "-static-libstdc++",
]

_FOZZIE_TRANSITION_REFS = {
    "instrumentation": "toolchains//cfg/instrumentation:instrumentation[fozzie]",
}

def _fozzie_transition_impl(platform: PlatformInfo, refs: struct) -> PlatformInfo:
    instrumentation = refs.instrumentation[ConstraintValueInfo]
    constraints = dict(platform.configuration.constraints)
    constraints[instrumentation.setting.label] = instrumentation
    return PlatformInfo(
        label = platform.label,
        configuration = ConfigurationInfo(
            constraints = constraints,
            values = platform.configuration.values,
        ),
    )

_fozzie_transition = transition(
    impl = _fozzie_transition_impl,
    refs = _FOZZIE_TRANSITION_REFS,
)

def _check_nonnegative(name: str, value: int):
    if value < 0:
        fail("{} must be nonnegative, got {}".format(name, value))

def _fuzz_command(ctx: AnalysisContext, target: Artifact) -> cmd_args:
    command = cmd_args(ctx.attrs._engine[RunInfo].args)
    command.add("fuzz")
    command.add("--target", target)
    command.add("--target-label", str(ctx.label.raw_target()))
    command.add("--timeout-ms", str(ctx.attrs.timeout_ms))
    command.add("--max-input", str(ctx.attrs.max_input))
    command.add("--jobs", str(ctx.attrs.jobs))
    for source in ctx.attrs.corpus:
        command.add("--corpus", source)
    for source in ctx.attrs.dictionaries:
        command.add("--dictionary", source)
    return command

def _fozzie_fuzz_binary_impl(ctx: AnalysisContext) -> list[Provider]:
    _check_nonnegative("duration_seconds", ctx.attrs.duration_seconds)
    _check_nonnegative("runs", ctx.attrs.runs)
    _check_nonnegative("jobs", ctx.attrs.jobs)
    _check_nonnegative("test_seed", ctx.attrs.test_seed)
    if ctx.attrs.timeout_ms <= 0:
        fail("timeout_ms must be positive, got {}".format(ctx.attrs.timeout_ms))
    if ctx.attrs.max_input <= 0:
        fail("max_input must be positive, got {}".format(ctx.attrs.max_input))
    if ctx.attrs.duration_seconds == 0 and ctx.attrs.runs == 0:
        fail("a fuzz test needs a nonzero duration_seconds or runs budget")

    outputs = ctx.attrs.target[DefaultInfo].default_outputs
    if len(outputs) != 1:
        fail("{} must produce exactly one output, got {}".format(
            ctx.attrs.target.label.raw_target(),
            len(outputs),
        ))
    target = outputs[0]

    # `buck2 run` is an unlimited durable campaign. The caller supplies its
    # destination as `-- --workdir PATH`; omitting it deliberately lets the
    # engine use a temporary directory.
    campaign_command = _fuzz_command(ctx, target)
    campaign_command.add("--duration", "0")
    campaign_command.add("--runs", "0")

    # `buck2 test` is deterministic and bounded. It deliberately omits
    # --workdir so the engine owns and removes its temporary directory.
    test_command = _fuzz_command(ctx, target)
    test_command.add("--duration", str(ctx.attrs.duration_seconds))
    test_command.add("--runs", str(ctx.attrs.runs))
    test_command.add("--seed", str(ctx.attrs.test_seed))
    test_command.add("--test-mode")

    return [
        DefaultInfo(default_output = target),
        RunInfo(args = campaign_command),
        ExternalRunnerTestInfo(
            type = "fozzie",
            command = [test_command],
            default_executor = CommandExecutorConfig(
                local_enabled = True,
                remote_enabled = False,
                remote_cache_enabled = False,
            ),
            supports_test_execution_caching = False,
        ),
    ]

_fozzie_fuzz_binary = rule(
    impl = _fozzie_fuzz_binary_impl,
    attrs = {
        "_engine": attrs.default_only(attrs.exec_dep(
            default = _ENGINE,
            providers = [RunInfo],
        )),
        "corpus": attrs.list(attrs.source(allow_directory = True), default = []),
        "dictionaries": attrs.list(attrs.source(), default = []),
        "duration_seconds": attrs.int(default = 10),
        "jobs": attrs.int(default = 0),
        "max_input": attrs.int(default = 65536),
        "runs": attrs.int(default = 0),
        "target": attrs.transition_dep(
            cfg = _fozzie_transition,
            providers = [DefaultInfo],
        ),
        "test_seed": attrs.int(default = 0xF0221E),
        "timeout_ms": attrs.int(default = 1000),
    },
)

def _compatibility(binary_kwargs: dict):
    compatible_with = binary_kwargs.pop("target_compatible_with", [])
    if compatible_with == None:
        compatible_with = []
    return compatible_with + [_LINUX]

def _require_static(binary_kwargs: dict):
    requested = binary_kwargs.pop("link_style", None)
    if requested != None and requested != "static":
        fail("Fozzie binaries require link_style = \"static\"")

def _declare_wrapper(
        name: str,
        target: str,
        corpus,
        dictionaries,
        duration_seconds: int,
        runs: int,
        timeout_ms: int,
        max_input: int,
        jobs: int,
        test_seed: int,
        visibility,
        target_compatible_with):
    kwargs = {
        "name": name,
        "target": target,
        "corpus": corpus,
        "dictionaries": dictionaries,
        "duration_seconds": duration_seconds,
        "runs": runs,
        "timeout_ms": timeout_ms,
        "max_input": max_input,
        "jobs": jobs,
        "test_seed": test_seed,
        "target_compatible_with": target_compatible_with,
    }
    if visibility != None:
        kwargs["visibility"] = visibility
    _fozzie_fuzz_binary(**kwargs)

def cxx_fuzz_binary(
        name: str,
        srcs,
        deps = [],
        corpus = [],
        dictionaries = [],
        duration_seconds: int = 10,
        runs: int = 0,
        timeout_ms: int = 1000,
        max_input: int = 65536,
        jobs: int = 0,
        test_seed: int = 0xF0221E,
        visibility = None,
        **binary_kwargs):
    """Build a C/C++ `LLVMFuzzerTestOneInput` harness and expose it as a test."""
    target_compatible_with = _compatibility(binary_kwargs)
    _require_static(binary_kwargs)
    linker_flags = binary_kwargs.pop("linker_flags", []) + _SELF_CONTAINED_LINKER_FLAGS
    target_name = name + "-target"
    depot.cxx_binary(
        name = target_name,
        srcs = srcs,
        deps = deps + [_RUNTIME],
        link_style = "static",
        linker_flags = linker_flags,
        target_compatible_with = target_compatible_with,
        visibility = [],
        **binary_kwargs
    )
    _declare_wrapper(
        name = name,
        target = ":" + target_name,
        corpus = corpus,
        dictionaries = dictionaries,
        duration_seconds = duration_seconds,
        runs = runs,
        timeout_ms = timeout_ms,
        max_input = max_input,
        jobs = jobs,
        test_seed = test_seed,
        visibility = visibility,
        target_compatible_with = target_compatible_with,
    )

def rust_fuzz_binary(
        name: str,
        srcs,
        deps = [],
        corpus = [],
        dictionaries = [],
        duration_seconds: int = 10,
        runs: int = 0,
        timeout_ms: int = 1000,
        max_input: int = 65536,
        jobs: int = 0,
        test_seed: int = 0xF0221E,
        visibility = None,
        **binary_kwargs):
    """Build a `#![no_main]` Rust Fozzie harness and expose it as a test."""
    target_compatible_with = _compatibility(binary_kwargs)
    _require_static(binary_kwargs)
    rustc_flags = binary_kwargs.pop("rustc_flags", []) + ["-Cpanic=abort"]
    linker_flags = binary_kwargs.pop("linker_flags", []) + _SELF_CONTAINED_LINKER_FLAGS
    if "crate_root" not in binary_kwargs and type(srcs) == "list" and len(srcs) == 1:
        binary_kwargs["crate_root"] = srcs[0]
    target_name = name + "-target"
    depot.rust_binary(
        name = target_name,
        srcs = srcs,
        deps = deps + [_HARNESS, _RUNTIME, _MIMALLOC],
        link_style = "static",
        linker_flags = linker_flags,
        rustc_flags = rustc_flags,
        target_compatible_with = target_compatible_with,
        visibility = [],
        **binary_kwargs
    )
    _declare_wrapper(
        name = name,
        target = ":" + target_name,
        corpus = corpus,
        dictionaries = dictionaries,
        duration_seconds = duration_seconds,
        runs = runs,
        timeout_ms = timeout_ms,
        max_input = max_input,
        jobs = jobs,
        test_seed = test_seed,
        visibility = visibility,
        target_compatible_with = target_compatible_with,
    )
