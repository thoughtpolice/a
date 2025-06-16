# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Language-specific rules
def cxx_library(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.cxx_library() instead')

def cxx_binary(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.cxx_binary() instead')

def cxx_genrule(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.cxx_genrule() instead')

def prebuilt_cxx_library(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.prebuilt_cxx_library() instead')

def rust_library(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.rust_library() instead')

def rust_binary(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.rust_binary() instead')

def rust_test(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.rust_test() instead')

def ocaml_library(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.ocaml_library() instead')

def ocaml_binary(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.ocaml_binary() instead')

# File and utility rules
def export_file(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.export_file() instead')

def genrule(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.genrule() instead')

def filegroup(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.filegroup() instead')

# Platform and constraint rules
def constraint_setting(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.constraint() instead')

def constraint_value(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.constraint() instead')

def platform(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.platform() instead')

# Test rules
def sh_test(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.command_test() instead')

def python_test(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.command_test() instead')

# Build rules
def rule(**_kwargs):
    fail('define custom rules in appropriate toolchain files, not in BUILD files')

# Other common rules that should be shimmed
def sh_binary(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.command() instead')

def python_binary(**_kwargs):
    fail('use appropriate language-specific toolchain instead of native python_binary')

def python_library(**_kwargs):
    fail('use appropriate language-specific toolchain instead of native python_library')

def java_binary(**_kwargs):
    fail('use appropriate language-specific toolchain instead of native java_binary')

def java_library(**_kwargs):
    fail('use appropriate language-specific toolchain instead of native java_library')

def go_binary(**_kwargs):
    fail('use appropriate language-specific toolchain instead of native go_binary')

def go_library(**_kwargs):
    fail('use appropriate language-specific toolchain instead of native go_library')

# Archive and fetch rules
def http_archive(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.http_archive() instead')

def git_fetch(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.git_fetch() instead')

# Configuration and modifiers
def select(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.select() instead')

def configured_alias(**_kwargs):
    fail('use appropriate toolchain configuration instead of configured_alias')

def alias(**_kwargs):
    fail('use appropriate dependency specification instead of alias')

def toolchain_alias(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.toolchain_alias() instead')

def config_setting(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.config_setting() instead')
