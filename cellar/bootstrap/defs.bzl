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

    output = ctx.actions.copied_dir(ctx.label.name, srcs)
    return [DefaultInfo(default_output = output)]

filegroup = rule(
    doc = """Create a directory that contains links to a list of srcs.

    Each symlink is based on the shortpath for the given `srcs[x]`. The output
    directory uses `name` for its name.
    """,
    impl = __filegroup_impl,
    attrs = {
        "srcs": attrs.option(attrs.named_set(attrs.source(), sorted = False), default = None),
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
        supports_test_execution_caching = external.supports_test_execution_caching,
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
        return tests

    def parse_test_result(stdout: str, stderr: str, exit_code: int) -> list[dict]:
        _ = stderr
        entries = []
        for line in stdout.splitlines():
            entry = _answer_entry(line.strip())
            if entry != None:
                entries.append(entry)

        # The harness prints the expected entry before execing sha256sum,
        # which prints the actual entry. Let Buck synthesize a result from a
        # failed process or output that does not satisfy that contract.
        if exit_code != 0 or len(entries) != 2 or entries[0][1] != entries[1][1]:
            return []

        expected, path = entries[0]
        actual = entries[1][0]
        if actual == expected:
            status = "PASS"
            message = None
        else:
            status = "FAIL"
            message = "expected " + expected + ", got " + actual

        return [{
            "name": target + " - " + path,
            "status": status,
            "message": message,
            "duration": None,
        }]

    external = ExternalRunnerTestInfo(type = "simple", command = command)

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

stage0_answer_test = rule(impl = __stage0_answer_test, attrs = {
    "chdirexec": attrs.dep(),
    "command": attrs.dep(),
    "input": attrs.dep(),
    "runner": attrs.dep(),
})
