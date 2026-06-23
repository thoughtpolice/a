// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! CLI entry point.

use jj_cli::cli_util::CliRunner;

// ---------------------------------------------------------------------------------------------------------------------

fn main() -> std::process::ExitCode {
    let result = CliRunner::init()
        .name("qq")
        .about("Austin's Experimental Funtime Jujutsu Adventure Game")
        .version("0.20.0-remix+0")
        .add_store_factories(qq_rpc_backend::store_factories())
        .add_subcommand(commands::rpc::rpc_cmd)
        .add_global_args(allocator::heap_stats_enable)
        .run();
    allocator::maybe_print_stats();
    result.into()
}

// ---------------------------------------------------------------------------------------------------------------------

mod allocator;
mod commands;

// ---------------------------------------------------------------------------------------------------------------------
