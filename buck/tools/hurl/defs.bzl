# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Pinned Hurl executables and HTTP-contract tests with optional local resources.

Hurl is an ordinary executable dependency, selected for the execution platform
by attrs.exec_dep. Each test runs one Hurl scenario; Buck provisions any declared
LocalResourceInfo dependencies and injects their environment only during
execution, not listing. There is no application-specific fixture logic here.
"""

def _archive_binary_impl(ctx: AnalysisContext) -> list[Provider]:
    archive = ctx.attrs.archive
    binary = archive.project("bin/hurl")
    return [
        DefaultInfo(
            default_output = binary,
            sub_targets = {"distribution": [DefaultInfo(default_output = archive)]},
        ),
        RunInfo(args = cmd_args(binary)),
    ]

_archive_binary = rule(
    impl = _archive_binary_impl,
    attrs = {"archive": attrs.source(allow_directory = True)},
)

def download_hurl(name: str, version: str, triple: str, sha256: str):
    """Downloads a checksum-verified release and exposes its Hurl executable.

    The [distribution] subtarget retains hurlfmt, man pages, and completions.
    These upstream binaries use host libraries; see README.md for requirements.
    """
    archive_name = name + "-archive"
    basename = "hurl-{}-{}".format(version, triple)
    native.http_archive(
        name = archive_name,
        sha256 = sha256,
        strip_prefix = basename,
        type = "tar.gz",
        urls = ["https://github.com/Orange-OpenSource/hurl/releases/download/{}/{}.tar.gz".format(version, basename)],
        visibility = [],
    )
    _archive_binary(name = name, archive = ":" + archive_name)

def _hurl_test_impl(ctx: AnalysisContext) -> list[Provider]:
    command = cmd_args(
        ctx.attrs._hurl[RunInfo].args,
        "--test",
        "--no-color",
        "--error-format",
        "long",
        "--connect-timeout",
        ctx.attrs.connect_timeout,
        "--max-time",
        ctx.attrs.max_time,
        # Also override HURL_RETRY inherited from the caller: failures must be
        # visible immediately, especially for state-changing HTTP scenarios.
        "--retry",
        "0",
    )
    for name, value in ctx.attrs.variables.items():
        if not name or "=" in name:
            fail("hurl.test variable names must be nonempty and cannot contain '='")
        command.add("--variable", cmd_args(name, "=", value, delimiter = ""))
    if ctx.attrs.file_root != None:
        command.add("--file-root", ctx.attrs.file_root)
    command.add(ctx.attrs.src, cmd_args(hidden = ctx.attrs.data))
    return [
        DefaultInfo(),
        RunInfo(args = command),
        ExternalRunnerTestInfo(
            type = "hurl",
            command = [command],
            contacts = ctx.attrs.contacts,
            env = ctx.attrs.env,
            labels = ctx.attrs.labels,
            local_resources = {name: dep.label for name, dep in ctx.attrs.local_resources.items()},
            required_local_resources = [
                RequiredTestLocalResource(name, listing = False, execution = True)
                for name in ctx.attrs.local_resources
            ],
            run_from_project_root = True,
            use_project_relative_paths = True,
            # HTTP results depend on live state, even without a Buck resource.
            supports_test_execution_caching = False,
        ),
    ]

hurl_test = rule(
    impl = _hurl_test_impl,
    attrs = {
        "connect_timeout": attrs.string(default = "5s", doc = "Connection timeout per request, in Hurl duration syntax."),
        "contacts": attrs.list(attrs.string(), default = []),
        "data": attrs.list(attrs.source(allow_directory = True), default = [], doc = "Additional runtime inputs referenced by the scenario."),
        "env": attrs.dict(attrs.string(), attrs.arg(), default = {}, doc = "Test environment; resource environment is added by Buck."),
        "file_root": attrs.option(attrs.source(allow_directory = True), default = None, doc = "Directory artifact used by Hurl file bodies and file predicates."),
        "labels": attrs.list(attrs.string(), default = []),
        "local_resources": attrs.dict(attrs.string(), attrs.dep(providers = [LocalResourceInfo]), default = {}, doc = "Named Buck-managed services, needed only during execution."),
        "max_time": attrs.string(default = "30s", doc = "Maximum request/response duration, not the whole scenario timeout."),
        "src": attrs.source(doc = "One .hurl file, reported as one Buck test."),
        "variables": attrs.dict(attrs.string(), attrs.arg(), default = {}, doc = "Static Hurl variables; artifacts remain tracked inputs."),
        "_hurl": attrs.exec_dep(default = "root//buck/tools/hurl:hurl", providers = [RunInfo]),
    },
    doc = "Runs one HTTP-contract scenario with bounded requests and no automatic retries.",
)

hurl = struct(
    test = hurl_test,
)
