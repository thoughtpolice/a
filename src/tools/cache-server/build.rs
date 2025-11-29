// SPDX-FileCopyrightText: © 2023 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use std::{env, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base_protos = [
        "protos/google/bytestream/bytestream.proto",
        "protos/google/longrunning/operations.proto",
        "protos/google/rpc/code.proto",
        "protos/build/bazel/remote/execution/v2/remote_execution.proto",
        "protos/build/bazel/semver/semver.proto",
    ];

    let prefix = env::var("SRCDIR").unwrap_or_else(|_| ".".to_string());
    let protos = base_protos
        .iter()
        .map(|p| format!("{}/{}", prefix, p))
        .collect::<Vec<_>>();

    // try $OUT_DIR, then $OUT, then fail
    let out_dir =
        PathBuf::from(env::var("OUT_DIR").or_else(|_| env::var("OUT").map_err(|_| "OUT not set"))?);

    tonic_prost_build::configure()
        .build_server(true)
        .build_client(false)
        .out_dir(out_dir.clone())
        .file_descriptor_set_path(out_dir.join("reapi_descriptor.bin"))
        .compile_protos(&protos, &["protos".to_owned()])
        .unwrap_or_else(|e| panic!("protobuf compile error: {}", e));

    // add PROTOBUFS=out_dir to the environment so we can include the generated files
    println!("cargo:rustc-env=PROTOBUFS={}", out_dir.display());

    Ok(())
}
