// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Generates the Rust code for gonzo's own protocols. The REAPI messages they
//! use come from the `protos` crate rather than being generated again.

use std::{env, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let srcdir = PathBuf::from(env::var("SRCDIR").unwrap_or_else(|_| ".".to_string()));
    let reapi = PathBuf::from(env::var("REAPI_PROTOS")?);
    let out_dir = PathBuf::from(env::var("OUT")?);

    tonic_prost_build::configure()
        .build_server(true)
        .build_client(true)
        .bytes(".")
        .extern_path(
            ".build.bazel.remote.execution.v2",
            "::protos::build::bazel::remote::execution::v2",
        )
        .extern_path(".build.bazel.semver", "::protos::build::bazel::semver")
        .extern_path(".google.longrunning", "::protos::google::longrunning")
        .extern_path(".google.rpc", "::protos::google::rpc")
        .extern_path(".google.api", "::protos::google::api")
        .out_dir(&out_dir)
        .file_descriptor_set_path(out_dir.join("gonzo_descriptor.bin"))
        .compile_protos(
            &[srcdir.join("gonzo/worker/v1/worker.proto")],
            &[srcdir, reapi],
        )?;

    Ok(())
}
