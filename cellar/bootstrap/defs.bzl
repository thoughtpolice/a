# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap/platforms:rules.bzl", "native_attrs")

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
    output = ctx.actions.copied_dir(ctx.label.name, srcs, has_content_based_path = False)
    return [DefaultInfo(default_output = output, sub_targets = {
        path: [DefaultInfo(default_output = output.project(path))]
        for path in projections
    })]

filegroup = rule(
    doc = """Create a directory that contains links to a list of srcs.

    Each symlink is based on the shortpath for the given `srcs[x]`. The output
    directory uses `name` for its name.
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

def _internal_runner_from_external(
        external,
        command,
        listing_command,
        parse_test_listing,
        parse_test_result):
    # Keep this adapter local to cellar//bootstrap: that cell is intentionally
    # unable to depend on the equivalent helper under root//buck/shims.
    return InternalRunnerTestInfo(
        type = external.test_type,
        command = command,
        listing_command = listing_command,
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
        parse_test_listing = parse_test_listing,
        parse_test_result = parse_test_result,
    )

def __stage0_answer_test(ctx: AnalysisContext) -> list[Provider]:
    bindir = ctx.attrs.input[DefaultInfo].default_outputs[0]
    sha256sum = ctx.attrs.command[DefaultInfo].default_outputs[0]
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

    external = ExternalRunnerTestInfo(
        type = "simple",
        command = command,
        run_from_project_root = True,
        use_project_relative_paths = True,
    )

    return [
        DefaultInfo(),
        _internal_runner_from_external(
            external = external,
            command = command,
            listing_command = listing_command,
            parse_test_listing = parse_test_listing,
            parse_test_result = parse_test_result,
        ),
    ]

_stage0_answer_test_rule = rule(impl = __stage0_answer_test, attrs = {
    "chdirexec": attrs.exec_dep(),
    "command": attrs.exec_dep(),
    "input": attrs.dep(),
    "runner": attrs.exec_dep(),
})

def stage0_answer_test(**kwargs):
    _stage0_answer_test_rule(**native_attrs(kwargs))
