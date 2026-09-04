// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::process::ExitCode;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() -> ExitCode {
    match fozzie_engine::run_cli() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("fozzie: {error:#}");
            ExitCode::from(2)
        }
    }
}
