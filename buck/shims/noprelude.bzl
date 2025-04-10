# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

def cxx_library(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.cxx_library() instead')

def cxx_binary(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.cxx_binary() instead')

def prebuilt_cxx_library(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.prebuilt_cxx_library() instead')

def rust_library(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.rust_library() instead')

def rust_binary(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.rust_binary() instead')

def ocaml_library(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.ocaml_library() instead')

def ocaml_binary(**_kwargs):
    fail('use load("@root//buck/shims/shims.bzl", "shims") and call shims.ocaml_binary() instead')
