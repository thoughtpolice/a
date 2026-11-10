// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Jujutsu's `jj` command, as upstream's `cli/src/main.rs` makes it.

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use jj_cli::cli_util::CliRunner;

fn main() -> std::process::ExitCode {
    CliRunner::init().version("0.47.1").run().into()
}
