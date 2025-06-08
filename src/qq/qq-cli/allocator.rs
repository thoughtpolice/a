// SPDX-FileCopyrightText: © 2024 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::sync::OnceLock;

use anyhow::Result;
use jj_cli::command_error::CommandError;

#[global_allocator]
static ALLOC: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// Lazy global static. Used only to defer printing mimalloc stats until the
/// program exits, if set to `true`.
static PRINT_HEAP_STATS: OnceLock<bool> = OnceLock::new();

#[derive(clap::Args, Clone, Debug)]
pub(crate) struct ShowAllocStats {
    /// Show memory allocation statistics from the internal heap allocator
    /// on `stderr`, when the program exits.
    #[arg(long, global = true)]
    show_heap_stats: bool,
}

/// Enable heap statistics for the user interface.
///
/// Should be used with [`CliRunner::add_global_args`]. Does nothing if the
/// memory allocator is unused, i.e. `#[global_allocator]` is not set to
/// mimalloc in your program.
pub(crate) fn heap_stats_enable(
    _ui: &mut jj_cli::ui::Ui,
    opts: ShowAllocStats,
) -> Result<(), CommandError> {
    if opts.show_heap_stats {
        PRINT_HEAP_STATS.set(true).unwrap();
    }
    Ok(())
}

/// Returns `true` if the user has requested that memory allocation statistics
/// should be printed when the program exits.
pub(crate) fn maybe_print_stats() {
    if *PRINT_HEAP_STATS.get().unwrap_or(&false) {
        eprintln!("========================================");
        eprintln!("mimalloc memory allocation statistics:\n");
        mimalloc::stats_print(&|l| {
            eprint!("{}", l.to_string_lossy());
        });
    }
}
