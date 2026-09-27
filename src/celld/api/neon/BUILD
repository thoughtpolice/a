# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@toolchains//celld:defs.bzl", "celld")

# The client, parameter and value encoding, and `./testing`. Retries and the
# runtime are `@celld/http`, bounded reads `@celld/core/bounds`; reflection
# discovery is a target of its own, so the core does not depend on exedev.
celld.library(
    name = "neon",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/api/neon",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./testing": "src/testing.ts",
    },
    deps = [
        "root//src/celld/core:core",
        "root//src/celld/http:http",
    ],
)

# Integration discovery through exe.dev's reflection service.
celld.library(
    name = "reflection",
    srcs = ["bridges/reflection.ts"],
    import_name = "@celld/api/neon/reflection",
    visibility = ["PUBLIC"],
    exports = {".": "bridges/reflection.ts"},
    deps = [
        "root//src/celld/api/exedev:exedev",
        ":neon",
    ],
)

# A live smoke test against a real Neon database behind an exe.dev HTTP
# proxy integration, bundled into one ESM file for Deno on an exe.dev VM.
# Nothing runs it automatically; see the README's "Live smoke test".
celld.worker(
    name = "live-smoke",
    main = "tests/live/smoke.ts",
    deps = [":neon"],
)

depot.python_binary(
    name = "live-smoke-runner",
    main = "tests/live_smoke.py",
)

# `buck2 run :live-smoke-run -- my-vm.exe.xyz --integration neon-serverless`
depot.command(
    name = "live-smoke-run",
    cmd = [
        "$(exe :live-smoke-runner)",
        "$(location :live-smoke)",
        "$(location root//buck/bin:deno)",
    ],
)

# The encoders and parsers, the client against FakeNeon, and discovery.
celld.test(
    name = "codec-test",
    srcs = ["tests/codec_test.ts"],
    deps = [
        "root//src/celld/core:core",
        ":neon",
    ],
)

celld.test(
    name = "client-test",
    srcs = ["tests/client_test.ts"],
    deps = [
        "root//src/celld/core:core",
        "root//src/celld/http:http",
        ":neon",
    ],
)

celld.test(
    name = "reflection-test",
    srcs = ["tests/reflection_test.ts"],
    deps = [
        "root//src/celld/core:core",
        ":neon",
        ":reflection",
    ],
)
