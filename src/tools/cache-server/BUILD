# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

BUILD_DEPS = [
    # 3p deps
    "third-party//by-name/mi/mimalloc:rust",
    # local deps
    "//src/crates/accept:accept",
    "//src/crates/dial9-tonic:dial9-tonic",
    "//src/crates/rustls-boring:rustls-boring",
    "//src/crates/rustls-transport:rustls-transport",
    "//src/tools/cache-server/protos:protos",
    "//src/tools/cache-server/runtime:runtime",
    "//src/tools/cache-server/storage:storage",
    "//src/tools/cache-server/telemetry:telemetry",
    # crates.io
    "third-party//rust:bytes",
    "third-party//rust:futures",
    "third-party//rust:hex",
    "third-party//rust:jiff",
    "third-party//rust:sha2",
    "third-party//rust:anyhow",
    "third-party//rust:clap",
    "third-party//rust:dial9",
    "third-party//rust:console-subscriber",
    "third-party//rust:prost",
    "third-party//rust:prost-types",
    "third-party//rust:rustls",
    "third-party//rust:tokio",
    "third-party//rust:tokio-stream",
    "third-party//rust:tonic",
    "third-party//rust:tower",
    "third-party//rust:hyper",
    "third-party//rust:hyper-util",
    "third-party//rust:tonic-prost",
    "third-party//rust:tonic-health",
    "third-party//rust:tonic-reflection",
    "third-party//rust:tracing",
    "third-party//rust:tracing-subscriber",
]

depot.rust_binary(
    name = "cache-server",
    srcs = glob(["src/**/*.rs"]),
    visibility = ["PUBLIC"],
    deps = BUILD_DEPS,
)

# glibc-dynamic is a pinned Wolfi/Chainguard runtime containing glibc 2.42
# and the GCC 15.2 libraries used by the Nix toolchain. Repointing the ELF at
# those ABI-compatible paths keeps the image small; native_binary_layer can
# instead preserve and package the exact Nix closure for other base images.
depot.oci.native_binary_image(
    name = "cache-server-image",
    base = "third-party//oci-images:chainguard_glibc_dynamic_amd64",
    binary = ":cache-server",
    cmd = [
        "serve",
        "--address",
        "0.0.0.0:8080",
    ],
    destination = "/usr/local/bin/cache-server",
    docker_image_name = "cache-server",
    exposed_ports = ["8080/tcp"],
    image_labels = {
        "org.opencontainers.image.description": "Buck2 Remote Execution API cache server",
        "org.opencontainers.image.licenses": "Apache-2.0 OR MIT",
        "org.opencontainers.image.source": "https://github.com/thoughtpolice/a",
        "org.opencontainers.image.title": "cache-server",
        "org.opencontainers.image.version": "dev",
    },
    include_nix_store = False,
    interpreter = "/lib64/ld-linux-x86-64.so.2",
    rpath = "/usr/lib",
    strip = "debug",
    target_compatible_with = [
        "config//os:linux",
        "config//cpu:x86_64",
    ],
    visibility = ["PUBLIC"],
    working_dir = "/",
)

depot.oci.container_test(
    name = "cache-server-image-smoke",
    image = ":cache-server-image",
    ready_log = "cache-server ready",
    timeout_seconds = 15,
)

TEST_MODULES = {
    "cas": {},
    "dial9": {},
    "split_splice": {},
    "action_cache": {},
    "bytestream": {},
    "resource_names": {},
    "remote_asset": {},
    "tls": {
        "resources": {
            "cert.pem": "//src/crates/rustls-transport:test-cert",
            "key.pem": "//src/crates/rustls-transport:test-key",
        },
    },
}

ALL_TEST_RESOURCES = {
    "cert.pem": "//src/crates/rustls-transport:test-cert",
    "key.pem": "//src/crates/rustls-transport:test-key",
}

TEST_DEPS = BUILD_DEPS + [
    "third-party//rust:buck-resources",
    "third-party//rust:tempfile",
]

# Per-module test targets
[depot.rust_test(
    name = "tests-" + name,
    srcs = glob(["src/**/*.rs"]),
    crate_root = "src/main.rs",
    resources = config.get("resources", {}),
    rustc_flags = ["--cfg=test_module_" + name],
    deps = TEST_DEPS,
) for name, config in TEST_MODULES.items()]

# All-in-one target
depot.rust_test(
    name = "tests",
    srcs = glob(["src/**/*.rs"]),
    crate_root = "src/main.rs",
    resources = ALL_TEST_RESOURCES,
    rustc_flags = ["--cfg=test_module_" + name for name in TEST_MODULES],
    deps = TEST_DEPS,
)
