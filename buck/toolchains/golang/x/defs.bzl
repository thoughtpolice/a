# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""golang.org/x packages built by the Go toolchain, next to the stdlib.

`go_x_library` compiles every package of a fixed set of golang.org/x modules
and hands them to its dependents the way a `go_library` hands over its own
package and those it depends on. The Go shims make it a dependency of every
`go_binary`, `go_library` and `go_test`, so any Go target may import these
packages without naming a dependency, as it does the standard library.

Like the stdlib, every package is built, once per configuration, by the first
link that needs them, and the result is cached. A compile only sees the
packages its sources import.

Go rules pass dependencies as a map from import path to archive, and the keys
must be known before any source has been read. They come from
packages.bzl, which manifest.go writes from the modules themselves for each
platform the toolchain targets. `:manifest-test` fails when that file no
longer matches the pinned modules.
"""

load("@prelude//decls:common.bzl", "buck")
load("@prelude//decls:toolchains_common.bzl", "toolchains_common")
load("@prelude//go:cgo_builder.bzl", "CGoBuildContext")
load("@prelude//go:compile.bzl", "GoPkgCompileInfo")
load("@prelude//go:go_stdlib.bzl", "get_cgo_build_context")
load("@prelude//go:link.bzl", "GoPkgLinkInfo")
load("@prelude//go:package_builder.bzl", "BuildPackageGoList", "BuildPackageParams", "build_package")
load("@prelude//go:packages.bzl", "GoPkg", "GoStdlib", "GoStdlibDynamicValue", "merge_pkgs")
load("@prelude//go:toolchain.bzl", "GoToolchainInfo", "evaluate_cgo_enabled", "get_toolchain_env_vars")
load("@prelude//go/transitions:defs.bzl", "build_tags_attr", "cgo_enabled_attr", "go_stdlib_transition")
load("@prelude//linking:shared_libraries.bzl", "merge_shared_libraries")
load("@root//buck/shims:shims.bzl", "shims")

# The GOOS/GOARCH pairs the toolchain can target; see ../defs.bzl.
GO_X_PLATFORMS = [
    "darwin/amd64",
    "darwin/arm64",
    "linux/amd64",
    "linux/arm64",
    "windows/amd64",
    "windows/arm64",
]

# MARK: Library

def _module_dir(modules: dict[str, Artifact], import_path: str) -> (Artifact, str):
    """The module root holding import_path, and the package's path in it."""
    for module, root in modules.items():
        if import_path == module:
            return root, ""
        if import_path.startswith(module + "/"):
            return root, import_path.removeprefix(module + "/")
    fail("{} is in no golang.org/x module the toolchain pins".format(import_path))

def _go_x_library_impl(ctx: AnalysisContext) -> list[Provider]:
    go_toolchain = ctx.attrs._go_toolchain[GoToolchainInfo]
    go_stdlib = ctx.attrs._go_stdlib[GoStdlib]
    platform = "{}/{}".format(go_toolchain.env_go_os, go_toolchain.env_go_arch)
    if platform not in GO_X_PLATFORMS:
        fail("golang.org/x packages are not listed for {}; add it to GO_X_PLATFORMS and regenerate packages.bzl".format(platform))

    cgo_enabled = evaluate_cgo_enabled(ctx.attrs._cgo_enabled)
    cgo_build_context = get_cgo_build_context(ctx)
    tags = go_toolchain.build_tags + ctx.attrs._build_tags

    # Declare every package up front: these are the keys dependents see.
    import_paths = sorted([
        import_path
        for import_path, platforms in ctx.attrs.packages.items()
        if platforms == None or platform in platforms
    ])
    pkgs = {}
    for import_path in import_paths:
        pkgs[import_path] = GoPkg(
            archive_file = ctx.actions.declare_output(import_path, "non-shared.a", has_content_based_path = True),
            archive_file_shared = ctx.actions.declare_output(import_path, "shared.a", has_content_based_path = True),
            export_file = ctx.actions.declare_output(import_path, "non-shared.x", has_content_based_path = True),
            export_file_shared = ctx.actions.declare_output(import_path, "shared.x", has_content_based_path = True),
            coverage_instrumented = False,
        )

    for import_path, pkg in pkgs.items():
        root, rel = _module_dir(ctx.attrs.modules, import_path)
        pkg_dir = root.project(rel) if rel else root

        # pkg_analyzer is the `go list` that go_library uses: it reads the
        # one directory, so nothing outside the package is an input.
        analysis = ctx.actions.declare_output(import_path, "go_list.json", has_content_based_path = True)
        ctx.actions.run(
            [
                go_toolchain.pkg_analyzer,
                ["-o", analysis.as_output()],
                ["-goos", go_toolchain.env_go_os],
                ["-goarch", go_toolchain.env_go_arch],
                ["-tags", ",".join(tags)] if tags else [],
                ["-race"] if go_toolchain.race and cgo_enabled else [],
                ["-asan"] if go_toolchain.asan and cgo_enabled else [],
                ["-cgo"] if cgo_enabled else [],
                pkg_dir,
            ],
            env = get_toolchain_env_vars(go_toolchain),
            category = "go_list",
            identifier = import_path,
            allow_cache_upload = go_toolchain.allow_cache_upload,
        )

        ctx.actions.dynamic_output_new(_build_x_package(
            target_label = ctx.label,
            go_toolchain = go_toolchain,
            cgo_build_context = cgo_build_context,
            go_stdlib_value = go_stdlib.dynamic_value,
            analysis = analysis,
            import_path = import_path,
            pkg_dir = pkg_dir,
            platform = platform,
            x_pkgs = pkgs,
            out_a = pkg.archive_file.as_output(),
            out_x = pkg.export_file.as_output(),
            out_a_shared = pkg.archive_file_shared.as_output(),
            out_x_shared = pkg.export_file_shared.as_output(),
        ))

    return [
        DefaultInfo(default_outputs = [pkg.archive_file for pkg in pkgs.values()]),
        GoPkgCompileInfo(pkgs = pkgs),
        GoPkgLinkInfo(pkgs = pkgs),
        # A go_library requires one from each of its dependencies. These
        # packages bring no shared libraries.
        merge_shared_libraries(ctx.actions),
    ]

def _build_x_package_impl(
        actions: AnalysisActions,
        target_label: Label,
        go_toolchain: GoToolchainInfo,
        cgo_build_context: None | CGoBuildContext,
        go_stdlib_value: ResolvedDynamicValue,
        analysis: ArtifactValue,
        import_path: str,
        pkg_dir: Artifact,
        platform: str,
        x_pkgs: dict[str, GoPkg],
        out_a: OutputArtifact,
        out_x: OutputArtifact,
        out_a_shared: OutputArtifact,
        out_x_shared: OutputArtifact) -> list[Provider]:
    go_list = analysis.read_json()
    if go_list.get("Error"):
        fail("{}: {}".format(import_path, go_list["Error"]["Err"]))

    def files(key):
        return [pkg_dir.project(f) for f in go_list.get(key, [])]

    go_files = files("GoFiles")
    if not go_files:
        fail("{} has no Go files for {}, but packages.bzl lists it there; regenerate it with\n\n  buck2 run toolchains//golang/x:manifest -- -w buck/toolchains/golang/x/packages.bzl".format(import_path, platform))

    # go:embed patterns are relative to the package directory. Hand the
    # embedcfg generator each top-level entry a pattern names.
    embed_patterns = go_list.get("EmbedPatterns", [])
    embed_srcs = {}
    for pattern in embed_patterns:
        top = pattern.removeprefix("all:").split("/")[0]
        if not top or "*" in top or "?" in top or "[" in top:
            fail("{}: unsupported go:embed pattern {}".format(import_path, pattern))
        embed_srcs[pkg_dir.short_path + "/" + top] = pkg_dir.project(top)

    stdlib = go_stdlib_value.providers[GoStdlibDynamicValue]
    result = build_package(
        actions = actions,
        target_label = target_label,
        go_toolchain = go_toolchain,
        cgo_build_context = cgo_build_context,
        go_list = BuildPackageGoList(
            pkg_name = go_list["Name"],
            go_files = go_files,
            cgo_files = files("CgoFiles"),
            s_files = files("SFiles"),
            h_files = files("HFiles"),
            c_cxx_files = files("CFiles") + files("CXXFiles"),
            syso_files = [],
            imports = set(go_list.get("Imports", [])),
            embed_patterns = embed_patterns,
            cgo_cflags = go_list.get("CgoCFLAGS", []),
            cgo_cppflags = go_list.get("CgoCPPFLAGS", []),
        ),
        params = BuildPackageParams(
            main = False,
            standard = False,
            pkg_import_path = import_path,
            package_root = pkg_dir.short_path,
            embed_srcs = embed_srcs,
            compiler_flags = [],
            assembler_flags = [],
            coverage_enabled = False,
            coverage_mode = None,
            deps = merge_pkgs([stdlib.pkgs, x_pkgs]),
            import_map = None,
        ),
    )
    actions.copy_file(out_a, result.a_file)
    actions.copy_file(out_x, result.x_file)
    actions.copy_file(out_a_shared, result.a_file_shared)
    actions.copy_file(out_x_shared, result.x_file_shared)
    return []

_build_x_package = dynamic_actions(
    impl = _build_x_package_impl,
    attrs = {
        "analysis": dynattrs.artifact_value(),
        "cgo_build_context": dynattrs.value(None | CGoBuildContext),
        "go_stdlib_value": dynattrs.dynamic_value(),
        "go_toolchain": dynattrs.value(GoToolchainInfo),
        "import_path": dynattrs.value(str),
        "out_a": dynattrs.output(),
        "out_a_shared": dynattrs.output(),
        "out_x": dynattrs.output(),
        "out_x_shared": dynattrs.output(),
        "pkg_dir": dynattrs.value(Artifact),
        "platform": dynattrs.value(str),
        "target_label": dynattrs.value(Label),
        "x_pkgs": dynattrs.value(dict[str, GoPkg]),
    },
)

go_x_library = rule(
    impl = _go_x_library_impl,
    # The stdlib's transition, so both are built in the same configuration.
    cfg = go_stdlib_transition,
    attrs = {
        "modules": attrs.dict(attrs.string(), attrs.source(allow_directory = True)),
        "packages": attrs.dict(attrs.string(), attrs.option(attrs.list(attrs.string()))),
        "_build_tags": build_tags_attr,
        "_cgo_enabled": cgo_enabled_attr,
        "_cxx_toolchain": toolchains_common.cxx(),
        "_exec_os_type": buck.exec_os_type_arg(),
        "_go_stdlib": attrs.default_only(attrs.dep(default = "prelude//go/tools:stdlib")),
        "_go_toolchain": toolchains_common.go(),
    },
)

# MARK: Manifest

def _go_x_manifest_impl(ctx: AnalysisContext) -> list[Provider]:
    args = cmd_args(ctx.attrs.generator[RunInfo])
    for platform in GO_X_PLATFORMS:
        args.add("-platform", platform)
    for module, root in ctx.attrs.modules.items():
        args.add("-module", cmd_args(module, "=", root, delimiter = ""))
    return [DefaultInfo(), RunInfo(args = args)]

# `buck2 run` this with `-w FILE` or `-check FILE`; see manifest.go.
go_x_manifest = rule(
    impl = _go_x_manifest_impl,
    attrs = {
        "generator": attrs.exec_dep(providers = [RunInfo]),
        "modules": attrs.dict(attrs.string(), attrs.source(allow_directory = True)),
    },
)

# MARK: Macro

def go_x(name: str, modules: dict[str, (str, str)], packages: dict[str, None | list[str]]):
    """Declare the golang.org/x library `:<name>` and its manifest targets.

    Args:
        name: Name of the library target the Go shims depend on.
        modules: Module import path to (version, sha256 of its proxy zip).
        packages: X_PACKAGES from packages.bzl.
    """
    roots = {}
    for module, (version, sha256) in modules.items():
        archive = "module-" + module.removeprefix("golang.org/x/")
        shims.http_archive(
            name = archive,
            sha256 = sha256,
            strip_prefix = "{}@{}".format(module, version),
            type = "zip",
            urls = ["https://proxy.golang.org/{}/@v/{}.zip".format(module, version)],
            visibility = [],
        )
        roots[module] = ":" + archive

    go_x_library(
        name = name,
        modules = roots,
        packages = packages,
    )

    # Built by the bootstrap toolchain, as the prelude's own Go tools are: an
    # ordinary go_binary would depend on the library this keeps up to date.
    native.go_bootstrap_binary(
        name = "manifest-generator",
        srcs = ["manifest.go"],
        build_args = ["manifest.go"],
        visibility = [],
    )

    go_x_manifest(
        name = "manifest",
        generator = ":manifest-generator",
        modules = roots,
    )

    shims.export_file(
        name = "packages.bzl",
        visibility = [],
    )

    shims.run_test(
        name = "manifest-test",
        dep = ":manifest",
        args = ["-check", "$(location :packages.bzl)"],
    )
