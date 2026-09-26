# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap/platforms:rules.bzl", "native_attrs")

def c_strings(name, values):
    """Declare a NULL-terminated C array of string constants."""
    return "static const char *const {}[] = {{{}}};".format(
        name,
        ", ".join([json.encode(value) for value in values] + ["NULL"]),
    )

def _alias_impl(ctx):
    return ctx.attrs.actual.providers

_alias_rule = rule(impl = _alias_impl, attrs = {
    "actual": attrs.dep(),
})

def alias(**kwargs):
    """Give another target's outputs and providers a second label."""
    _alias_rule(**native_attrs(kwargs))
