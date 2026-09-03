// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Buck-native coverage-guided fuzzing for compiled Rust and C/C++ targets.

mod artifact;
mod cli;
mod corpus;
mod engine;
mod executor;
mod mutate;
mod protocol;
mod shm;

use anyhow::Result;
use clap::Parser;
use std::process::ExitCode;

pub fn run_cli() -> Result<ExitCode> {
    engine::run(cli::Cli::parse())
}
