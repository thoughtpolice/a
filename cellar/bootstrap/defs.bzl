# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

_CPUS = {
    "amd64": "config//cpu/constraints:x86_64",
    "arm64": "config//cpu/constraints:arm64",
}
_LINUX = "config//os/constraints:linux"

def linux_constraints(cpu):
    """The constraints of static Linux programs for `cpu`, amd64 or arm64."""
    return [_CPUS[cpu], _LINUX]

# Every seed and every stage up to the x86_64 toolchains is a static x86_64
# Linux executable, and each stage runs the previous stage's programs, so
# those rules require x86_64 Linux of both the target and the executor:
# locally on an x86_64 Linux client, and on remote x86_64 Linux workers from
# any other.
NATIVE_CONSTRAINTS = linux_constraints("amd64")

def native_attrs(kwargs, toolchain = False):
    """Require the bootstrap's native ABI for both outputs and action tools.

    `target_cpu` builds for that CPU instead, and the target's actions run on
    the executor of `exec_cpu`, amd64 unless given. An exec dep is configured
    by its own package and target modifiers whichever executor runs it, so a
    tool cannot choose its executor; a rule whose actions run where its
    `toolchain_dep` compiler does passes `toolchain` and leaves the choice to
    the toolchain's own `exec_cpu`.
    """
    result = dict(kwargs)
    cpu = result.pop("target_cpu", None)
    exec_cpu = result.pop("exec_cpu", "amd64")
    target = NATIVE_CONSTRAINTS
    if cpu != None:
        target = linux_constraints(cpu)
        result.setdefault("modifiers", target)
    result["target_compatible_with"] = target + result.get("target_compatible_with", [])
    if not toolchain:
        result["exec_compatible_with"] = linux_constraints(exec_cpu) + result.get("exec_compatible_with", [])
    return result

def _to_amd64_impl(platform: PlatformInfo, refs: struct) -> PlatformInfo:
    constraints = dict(platform.configuration.constraints)
    for ref in [refs.cpu, refs.os]:
        value = ref[ConstraintValueInfo]
        constraints[value.setting.label] = value
    return PlatformInfo(
        # The name the prelude's modifiers give a configuration with no named
        # constraints, as every x86_64 cellar target's is. The same name and
        # constraints make the same configuration, so the seed chain's
        # artifacts stay shared.
        label = "cfg:<empty>",
        configuration = ConfigurationInfo(
            constraints = constraints,
            values = platform.configuration.values,
        ),
    )

_to_amd64 = transition(
    impl = _to_amd64_impl,
    refs = {
        "cpu": _CPUS["amd64"],
        "os": _LINUX,
    },
)

def _alias_impl(ctx: AnalysisContext) -> list[Provider]:
    return ctx.attrs.actual.providers

# `actual` as x86_64 Linux builds it, however the target reaching it is
# configured: a fixed predecessor keeps its configuration when an AArch64
# stage consumes its sources or tools.
amd64_dep = rule(impl = _alias_impl, cfg = _to_amd64, attrs = {
    "actual": attrs.dep(),
})

alias = rule(impl = _alias_impl, attrs = {"actual": attrs.dep()})

def cpu_alias(name, actual, **kwargs):
    """`name` gives the providers of `actual[cpu]` for the configuration's
    CPU, amd64 or arm64; built from the command line, the client's own."""
    alias(
        name = name,
        actual = select({_CPUS[cpu]: label for cpu, label in actual.items()}),
        modifiers = linux_constraints("arm64" if host_info().arch.is_aarch64 else "amd64"),
        **kwargs
    )

def __export_file_impl(ctx: AnalysisContext) -> list[Provider]:
    return [
        DefaultInfo(default_output = ctx.attrs.src),
    ]

__export_file = rule(impl = __export_file_impl, attrs = {
    "src": attrs.source(),
})

def export_file(name, **kwargs):
    __export_file(
        name = name,
        src = name,
        **kwargs
    )

def __filegroup_impl(ctx: AnalysisContext) -> list[Provider]:
    if type(ctx.attrs.srcs) == type({}):
        srcs = ctx.attrs.srcs
    else:
        srcs = {src.short_path: src for src in ctx.attrs.srcs}

    # Buck records a copied directory's contents by inserting each source in
    # turn, and a directory replaces whatever lies at its path, while the
    # copy on disk merges them. A source inside another would differ between
    # the local tree and what remote workers receive, so none may overlap.
    projections = dict(srcs)
    for path in srcs:
        parts = path.split("/")
        for end in range(1, len(parts)):
            parent = "/".join(parts[:end])
            if parent in srcs:
                fail("{} lies inside {}, which is also a source".format(path, parent))
            projections[parent] = None
    output = ctx.actions.copied_dir(ctx.label.name, srcs)
    return [DefaultInfo(default_output = output, sub_targets = {
        path: [DefaultInfo(default_output = output.project(path))]
        for path in projections
    })]

filegroup = rule(
    doc = """Copy `srcs` into one directory named `name`.

    A dict maps each path in the directory to its source. A list places each
    source at its short path. Every path is also a sub-target.
    """,
    impl = __filegroup_impl,
    attrs = {
        "srcs": attrs.named_set(attrs.source(), sorted = False, default = {}),
    },
)

def _answer_entry(line: str):
    if len(line) < 67 or line[64:66] != "  ":
        return None

    checksum = line[:64]
    for c in checksum.elems():
        if c not in "0123456789abcdef":
            return None

    path = line[66:]
    if not path:
        return None

    return (checksum, path)

def __stage0_answer_test(ctx: AnalysisContext) -> list[Provider]:
    bindir = ctx.attrs.input[DefaultInfo].default_outputs[0]
    sha256sum = ctx.attrs.sha256sum[DefaultInfo].default_outputs[0]
    runner = ctx.attrs.runner[DefaultInfo].default_outputs[0]
    chdirexec = ctx.attrs.chdirexec[DefaultInfo].default_outputs[0]

    harness = [
        cmd_args(chdirexec),
        cmd_args(bindir),
        cmd_args(runner, relative_to = bindir),
    ]
    listing_command = harness + ["--list", "answers"]
    command = harness + [
        "--check",
        cmd_args(sha256sum, relative_to = bindir),
    ]
    target = ctx.label.package + ":" + ctx.label.name

    def parse_test_listing(listing_content: str) -> list[dict[str, str]]:
        tests = []
        for line in listing_content.splitlines():
            entry = _answer_entry(line.strip())
            if entry != None:
                tests.append({
                    "name": target + " - " + entry[1],
                    # The runner receives the complete golden answer as one
                    # argument, prints it, then hashes only the selected path.
                    "filter": line.strip(),
                })

        # An empty listing would otherwise pass with nothing checked. The
        # runner rejects the empty answer, so this case always fails.
        if not tests:
            tests.append({"name": target + " - answers", "filter": ""})
        return tests

    def parse_test_result(stdout: str, stderr: str, exit_code: int) -> list[dict]:
        _ = stderr
        entries = []
        for line in stdout.splitlines():
            entry = _answer_entry(line.strip())
            if entry != None:
                entries.append(entry)

        # The harness prints the expected entry before execing sha256sum,
        # which prints the actual entry. Buck synthesizes a failure from a
        # nonzero exit. A clean exit passes only when sha256sum printed the
        # expected hash for the same path.
        if exit_code != 0:
            return []

        path = entries[0][1] if entries else "answers"
        if len(entries) != 2 or entries[0][1] != entries[1][1]:
            status = "FAIL"
            message = "sha256sum exited 0 without printing one entry for the checked path"
        elif entries[0][0] == entries[1][0]:
            status = "PASS"
            message = None
        else:
            status = "FAIL"
            message = "expected " + entries[0][0] + ", got " + entries[1][0]

        return [{
            "name": target + " - " + path,
            "status": status,
            "message": message,
            "duration": None,
        }]

    return [
        DefaultInfo(),
        InternalRunnerTestInfo(
            type = "simple",
            command = command,
            listing_command = listing_command,
            run_from_project_root = True,
            use_project_relative_paths = True,
            parse_test_listing = parse_test_listing,
            parse_test_result = parse_test_result,
        ),
    ]

# Checks every golden answer in `input`'s `answers` file with `sha256sum`,
# one test case per answer, run from inside `input`.
_stage0_answer_test_rule = rule(impl = __stage0_answer_test, attrs = {
    "input": attrs.dep(),
    "sha256sum": attrs.exec_dep(),
    "chdirexec": attrs.exec_dep(default = "cellar//bootstrap/stage0-posix/cellar-extra:chdirexec"),
    "runner": attrs.exec_dep(default = "cellar//bootstrap/stage0-posix/cellar-extra:answer-test"),
})

def stage0_answer_test(**kwargs):
    _stage0_answer_test_rule(**native_attrs(kwargs))
