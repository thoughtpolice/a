# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@prelude//rust:cargo_package.bzl", "cargo")
load("@prelude//rust:cargo_buildscript.bzl", "buildscript_run")

def _rust_library(**kwargs):
    cargo.rust_library(**kwargs)

def _rust_binary(**kwargs):
    cargo.rust_binary(**kwargs)

def _cxx_library(**kwargs):
    native.cxx_library(**kwargs)

def _prebuilt_cxx_library(**kwargs):
    native.prebuilt_cxx_library(**kwargs)

third_party_rust = struct(
    rust_library = _rust_library,
    rust_binary = _rust_binary,
    cxx_library = _cxx_library,
    prebuilt_cxx_library = _prebuilt_cxx_library,
    buildscript_run = buildscript_run,
)
