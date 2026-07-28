# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")

# Shared deps for REAPI client code (no TUI).
#
# The protocol lives in //src/crates/reapi-client, which keeps tonic, prost and
# the generated protos private — hence none of them appear here.
REAPI_CLIENT_DEPS = [
    "third-party//by-name/mi/mimalloc:rust",

    # protocol
    "//src/crates/reapi-client:reapi-client",

    # runtime
    "third-party//rust:tokio",

    # cli
    "third-party//rust:clap",

    # utilities
    "third-party//rust:anyhow",
    "third-party//rust:bytes",
]

depot.rust_binary(
    name = "client",
    srcs = glob(
        ["**/*.rs"],
        exclude = ["buck_log_*.rs"],
    ),
    crate_root = "main.rs",
    visibility = ["PUBLIC"],
    deps = REAPI_CLIENT_DEPS + [
        # tui
        "third-party//rust:ratatui",
        "third-party//rust:crossterm",
    ],
)

depot.rust_binary(
    name = "buck-log-uploader",
    srcs = [
        "buck_log_uploader.rs",
        "client.rs",
    ],
    crate_root = "buck_log_uploader.rs",
    visibility = ["PUBLIC"],
    deps = REAPI_CLIENT_DEPS,
)

depot.rust_binary(
    name = "buck-log-downloader",
    srcs = [
        "buck_log_downloader.rs",
        "client.rs",
    ],
    crate_root = "buck_log_downloader.rs",
    visibility = ["PUBLIC"],
    deps = REAPI_CLIENT_DEPS,
)
