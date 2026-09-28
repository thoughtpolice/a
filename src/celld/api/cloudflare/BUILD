# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@toolchains//celld:defs.bzl", "celld")

celld.library(
    name = "cloudflare",
    srcs = glob(["src/*.ts"]),
    import_name = "@celld/api/cloudflare",
    visibility = ["PUBLIC"],
    exports = {
        ".": "src/mod.ts",
        "./cache": "src/cache.ts",
        "./investigate": "src/investigate.ts",
        "./testing": "src/testing.ts",
        "./tunnels": "src/tunnels.ts",
        "./turnstile": "src/turnstile.ts",
        "./zones": "src/zones.ts",
    },
    deps = [
        "root//src/celld/core:core",
        "root//src/celld/http:http",
    ],
)

# Integration discovery through exe.dev's reflection service, a target of
# its own so the library does not depend on exedev.
celld.library(
    name = "reflection",
    srcs = ["bridges/reflection.ts"],
    import_name = "@celld/api/cloudflare/reflection",
    visibility = ["PUBLIC"],
    exports = {".": "bridges/reflection.ts"},
    deps = [
        "root//src/celld/api/exedev:exedev",
        ":cloudflare",
    ],
)

# A live smoke test against the real API, bundled into one ESM file for
# Deno. Nothing runs it automatically; see the README's "Live smoke test".
celld.worker(
    name = "live-smoke",
    main = "tests/live/smoke.ts",
    deps = [":cloudflare"],
)

depot.python_binary(
    name = "live-smoke-runner",
    main = "tests/live_smoke.py",
)

# `CLOUDFLARE_API_TOKEN=... buck2 run :live-smoke-run -- --zone example.com`,
# or `buck2 run :live-smoke-run -- --vm my-vm.exe.xyz` through the integration.
depot.command(
    name = "live-smoke-run",
    cmd = [
        "$(exe :live-smoke-runner)",
        "$(location :live-smoke)",
        "$(location root//buck/bin:deno)",
    ],
)

celld.test(
    name = "reflection-test",
    srcs = ["tests/reflection_test.ts"],
    deps = [
        "root//src/celld/core:core",
        ":cloudflare",
        ":reflection",
    ],
)

celld.test(
    name = "zones-test",
    srcs = ["tests/zones_test.ts"],
    deps = [
        "root//src/celld/core:core",
        ":cloudflare",
    ],
)

celld.test(
    name = "turnstile-test",
    srcs = ["tests/turnstile_test.ts"],
    deps = [
        "root//src/celld/core:core",
        "root//src/celld/http:http",
        ":cloudflare",
    ],
)

celld.test(
    name = "tunnels-test",
    srcs = ["tests/tunnels_test.ts"],
    deps = [
        "root//src/celld/core:core",
        ":cloudflare",
    ],
)

celld.test(
    name = "cache-test",
    srcs = ["tests/cache_test.ts"],
    deps = [
        "root//src/celld/core:core",
        "root//src/celld/http:http",
        ":cloudflare",
    ],
)

celld.test(
    name = "investigate-test",
    srcs = ["tests/investigate_test.ts"],
    deps = [
        "root//src/celld/core:core",
        "root//src/celld/http:http",
        ":cloudflare",
    ],
)

celld.test(
    name = "client-test",
    srcs = ["tests/client_test.ts"],
    deps = [
        "root//src/celld/core:core",
        "root//src/celld/http:http",
        ":cloudflare",
    ],
)
