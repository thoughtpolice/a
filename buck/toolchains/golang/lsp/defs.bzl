# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Go commands built from pinned modules by the go command itself.

`go_module_binary` builds a command such as gopls from its own module and
the modules its go.sum names, none of which the repository's Go rules can
build: they come from outside golang.org/x (see ../x/defs.bzl). Each module
proxy file is an ordinary pinned download, laid out as a module proxy
directory that the go command reads with GOPROXY=file://, so the build is
offline. The go command checks every download against the module's go.sum,
as it would when fetching from the network.

The pins live in a lock file that lock.go writes; see BUILD.
"""

load("@prelude//decls:toolchains_common.bzl", "toolchains_common")
load("@prelude//go:toolchain.bzl", "GoToolchainInfo")
load("@root//buck/shims:shims.bzl", "shims")

_PROXY = "https://proxy.golang.org"

def _escape(s: str) -> str:
    """The module proxy's case encoding: each upper-case letter becomes '!'
    and its lower-case form."""
    out = ""
    for c in s.elems():
        if c.isupper():
            out += "!" + c.lower()
        else:
            out += c
    return out

def _proxy_path(path: str, version: str, ext: str) -> str:
    return "{}/@v/{}.{}".format(_escape(path), _escape(version), ext)

def _target_name(prefix: str, path: str, version: str, ext: str) -> str:
    name = "{}-{}@{}.{}".format(prefix, path, version, ext)
    return "".join([c if c.isalnum() or c in "._-" else "_" for c in name.elems()])

def _go_module_binary_impl(ctx: AnalysisContext) -> list[Provider]:
    if ctx.attrs.stale:
        fail(ctx.attrs.stale)
    go_toolchain = ctx.attrs._go_toolchain[GoToolchainInfo]
    proxy = ctx.actions.symlinked_dir("proxy", ctx.attrs.proxy)
    suffix = ".exe" if go_toolchain.env_go_os == "windows" else ""
    out = ctx.actions.declare_output(ctx.label.name + suffix)
    ctx.actions.run(
        [
            ctx.attrs._modbuild[RunInfo],
            "-go",
            go_toolchain.go,
            "-proxy",
            proxy,
            "-src",
            ctx.attrs.src,
            "-o",
            out.as_output(),
            "-goos",
            go_toolchain.env_go_os,
            "-goarch",
            go_toolchain.env_go_arch,
            "-ldflags",
            " ".join(ctx.attrs.ldflags),
            ctx.attrs.package,
        ],
        category = "go_module_build",
    )
    return [
        DefaultInfo(default_output = out),
        RunInfo(args = cmd_args(out)),
    ]

_go_module_binary = rule(
    impl = _go_module_binary_impl,
    attrs = {
        "ldflags": attrs.list(attrs.string(), default = []),
        "package": attrs.string(default = "."),
        "proxy": attrs.dict(attrs.string(), attrs.source(), default = {}),
        "src": attrs.option(attrs.source(allow_directory = True), default = None),
        # Set when the lock pins another module; the package still loads, so
        # that the lock target can regenerate it.
        "stale": attrs.option(attrs.string(), default = None),
        "_go_toolchain": toolchains_common.go(),
        "_modbuild": attrs.default_only(attrs.exec_dep(providers = [RunInfo], default = "toolchains//golang/lsp:modbuild")),
    },
)

def go_module_binary(
        name: str,
        module: str,
        lock: dict,
        regenerate: str,
        package: str = ".",
        ldflags: list[str] = [],
        visibility: list[str] = []):
    """Build `package` of `module`, from the files `lock` pins, as `:<name>`.

    Args:
        name: Name of the binary target.
        module: The command's module, as path@version.
        lock: The dictionary lock.go wrote for it.
        regenerate: The command that rewrites the lock, for the error a stale
            one gives.
        package: The command's package, relative to its module root.
        ldflags: Flags for the linker, such as `-X main.version=...`.
        visibility: Visibility of the binary target.
    """
    if lock["module"] != module:
        _go_module_binary(
            name = name,
            stale = "the lock pins {}, not {}; regenerate it with\n\n  {}".format(lock["module"] or "nothing", module, regenerate),
            visibility = visibility,
        )
        return

    path, version = module.split("@")
    src = name + "-src"
    shims.http_archive(
        name = src,
        sha256 = lock["zip"],
        strip_prefix = "{}@{}".format(path, version),
        type = "zip",
        urls = ["{}/{}".format(_PROXY, _proxy_path(path, version, "zip"))],
        visibility = [],
    )

    proxy = {}
    for (dep_path, dep_version, ext), sha256 in lock["deps"].items():
        file = _proxy_path(dep_path, dep_version, ext)
        target = _target_name(name, dep_path, dep_version, ext)
        shims.http_file(
            name = target,
            sha256 = sha256,
            urls = ["{}/{}".format(_PROXY, file)],
            visibility = [],
        )
        proxy[file] = ":" + target

    _go_module_binary(
        name = name,
        ldflags = ldflags,
        package = package,
        proxy = proxy,
        src = ":" + src,
        visibility = visibility,
    )
