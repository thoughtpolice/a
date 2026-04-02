// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::{env, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let srcdir = env::var("SRCDIR").unwrap_or_else(|_| ".".to_string());
    let out_dir =
        PathBuf::from(env::var("OUT_DIR").or_else(|_| env::var("OUT").map_err(|_| "OUT not set"))?);

    tonic_prost_build::configure()
        .build_server(true)
        .build_client(false)
        .out_dir(out_dir.clone())
        .compile_protos(&[format!("{}/install.proto", srcdir)], &[srcdir])
        .unwrap_or_else(|e| panic!("protobuf compile error: {}", e));

    println!("cargo:rustc-env=PROTOBUFS={}", out_dir.display());

    Ok(())
}
