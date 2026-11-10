# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# Voice over iroh: Opus, a jitter buffer and a mixer, and the sound server
# (PulseAudio's simple API on Linux, Core Audio on macOS, WASAPI on
# Windows).

load("@root//buck/shims:shims.bzl", "shims")

DEPS = [
    "//aseipp/quad/kernel/chez-rs:chez",
    "//aseipp/quad/kernel/mesh:mesh",
    "third-party//by-name/op/opus:opus",
    "third-party//rust:bytes",
    "third-party//rust:iroh",
    "third-party//rust:libc",
    "third-party//rust:tokio",
] + shims.select({
    "config//os:windows": ["third-party//rust:windows"],
    "DEFAULT": [],
})

shims.rust_library(
    name = "voice",
    srcs = glob(["*.rs"]),
    crate = "quad_voice",
    crate_root = "lib.rs",
    tests = [":voice-test"],
    visibility = ["//aseipp/quad/..."],
    deps = DEPS,
)

shims.rust_test(
    name = "voice-test",
    srcs = glob(["*.rs"]),
    crate = "quad_voice",
    crate_root = "lib.rs",
    deps = DEPS + ["third-party//rust:hegeltest"],
)
