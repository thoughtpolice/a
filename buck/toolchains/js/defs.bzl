# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Reusable source libraries."""

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

js = struct(library = js_library)
