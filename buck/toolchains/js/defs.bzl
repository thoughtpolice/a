# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Reusable source libraries and relocatable ESM distribution packages."""

load("@toolchains//web:toolchain.bzl", "WebToolchain", "web_toolchain_attr")
load(":providers.bzl", "JsLibraryInfo", "JsPackageInfo", "record_json")
load(":units.bzl", "LIBRARY_ATTRS", "make_library", "with_tests")

def _js_library_impl(ctx: AnalysisContext) -> list[Provider]:
    return make_library(ctx)

_js_library = rule(
    impl = _js_library_impl,
    attrs = LIBRARY_ATTRS | {
        "lib": attrs.list(attrs.string(), default = ["esnext"]),
        "platform_name": attrs.string(default = "js"),
    },
)

def js_library(name: str, **kwargs):
    """Declared JS/TS sources, explicit public exports, and shared library deps.

    TypeScript is checked; check_js opts JavaScript into strict JSDoc checking.
    No browser, Deno, or Worker globals are implicitly part of this library.
    """
    _js_library(name = name, **with_tests(name, kwargs, ["check", "lint"]))

def _js_package_impl(ctx: AnalysisContext) -> list[Provider]:
    library = ctx.attrs.library[JsLibraryInfo]
    manifest = ctx.actions.write_json("package-manifest.json", {
        "unit": record_json(library.tset.value),
        "libraries": library.tset.project_as_json("json"),
        "format": ctx.attrs.format,
        "version": ctx.attrs.version,
        "dependencies": ctx.attrs.dependencies,
        "declarations": ctx.attrs.declarations,
        "license": ctx.attrs.license,
    })
    directory = ctx.actions.declare_output("package", dir = True)
    tarball = ctx.actions.declare_output("package.tgz") if ctx.attrs.format == "npm" else None
    ctx.actions.run(
        cmd_args(
            ctx.attrs._package_driver[RunInfo].args,
            "--manifest",
            manifest,
            "--native",
            ctx.attrs._web_toolchain[WebToolchain].native,
            "--out-dir",
            directory.as_output(),
            ["--tarball", tarball.as_output()] if tarball else [],
            hidden = [library.tset.project_as_args("srcs"), ctx.attrs.library[DefaultInfo].default_outputs],
        ),
        category = "js_package",
        allow_cache_upload = True,
    )
    return [
        DefaultInfo(
            default_output = directory,
            sub_targets = {"tarball": [DefaultInfo(default_output = tarball)]} if tarball else {},
        ),
        JsPackageInfo(directory = directory, format = ctx.attrs.format, tarball = tarball),
    ]

js_package = rule(
    impl = _js_package_impl,
    attrs = {
        "library": attrs.dep(providers = [JsLibraryInfo]),
        "format": attrs.enum(["npm", "deno"]),
        "version": attrs.string(),
        "dependencies": attrs.dict(attrs.string(), attrs.string(), default = {}),
        "declarations": attrs.bool(default = False),
        "license": attrs.string(default = "Apache-2.0"),
        "_package_driver": attrs.exec_dep(default = "toolchains//js:package-driver", providers = [RunInfo]),
        "_web_toolchain": web_toolchain_attr(),
    },
    doc = "Unbundled, relocatable ESM package; npm emits JS, Deno preserves sources. Never installs or publishes.",
)

js = struct(library = js_library, package = js_package)
