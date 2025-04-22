# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims/shims.bzl", depot="shims")

depot.ocaml_library(
    name="lib",
    srcs=["lib.ml"],
)

depot.ocaml_binary(
    name="hello",
    srcs=["main.ml"],
    deps=[
        ":lib",
    ],
)

depot.tar_file(
    name="app",
    srcs=[":hello"],
    out="app.tar",
)

depot.oci.pull(
  name = "distroless",
  image = "gcr.io/distroless/cc-debian12",
  digest = "sha256:388145607c79313a1e49b783a7ee71e4ef3df31d87c45adb46bfb9b257b643d1",
  platforms = ["linux/amd64"],
)

depot.oci.image(
  name = "oci-image",
  base = ":distroless",
  tars = [":app"],
  entrypoint = ["./hello"],
)
