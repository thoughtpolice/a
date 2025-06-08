// SPDX-FileCopyrightText: © 2024 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! CLI entry point.

use jj_cli::cli_util::CliRunner;

// ---------------------------------------------------------------------------------------------------------------------

fn main() -> std::process::ExitCode {
    let result = CliRunner::init()
        .name("qq")
        .about("Experimental Jujutsu Backend")
        .version("0.20.0-remix+0")
        .add_subcommand(commands::dojo::dojo_cmd)
        .add_global_args(allocator::heap_stats_enable)
        .run();
    allocator::maybe_print_stats();
    result
}

// ---------------------------------------------------------------------------------------------------------------------

mod allocator;
mod commands;

// ---------------------------------------------------------------------------------------------------------------------
