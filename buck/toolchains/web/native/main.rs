// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

mod compile;
mod diagnostics;
mod emit;
mod inspect;
mod minify;
mod quality;

use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::Result;
use clap::{Parser, Subcommand};
use serde::Serialize;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Parser)]
#[command(name = "web", about = "Native runtime-neutral Svelte and JavaScript tooling", version = option_env!("depot_VERSION").unwrap_or("dev"))]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Compile a manifest of components and rune modules for client, SSR and checking.
    Compile {
        #[arg(long)]
        manifest: PathBuf,
        #[arg(long)]
        out_dir: PathBuf,
    },
    /// Inspect imports and source directives without rewriting source.
    Inspect {
        #[arg(required = true)]
        paths: Vec<PathBuf>,
    },
    /// Emit relocatable, unbundled ESM modules and optional isolated declarations.
    Emit {
        #[arg(long)]
        manifest: PathBuf,
        #[arg(long)]
        out_dir: PathBuf,
    },
    /// Run native Svelte rules and selected Oxc correctness rules.
    Lint {
        #[arg(long)]
        deny_warnings: bool,
        #[arg(required = true)]
        paths: Vec<PathBuf>,
    },
    /// Format explicit files; by default return the formatted source as JSON.
    Format {
        #[arg(long, conflicts_with = "write")]
        check: bool,
        #[arg(long, conflicts_with = "check")]
        write: bool,
        #[arg(required = true)]
        paths: Vec<PathBuf>,
    },
    /// Minify an ESM bundle with native Oxc and composed authored maps.
    Minify {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
        #[arg(long, requires = "output_map")]
        input_map: Option<PathBuf>,
        #[arg(long)]
        output_map: Option<PathBuf>,
    },
}

pub(crate) fn print_json(value: &impl Serialize) -> Result<()> {
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    serde_json::to_writer(&mut stdout, value)?;
    writeln!(stdout)?;
    Ok(())
}

fn run() -> Result<bool> {
    match Cli::parse().command {
        Command::Compile { manifest, out_dir } => compile::run(&manifest, &out_dir),
        Command::Inspect { paths } => inspect::run(&paths),
        Command::Emit { manifest, out_dir } => emit::run(&manifest, &out_dir),
        Command::Lint {
            paths,
            deny_warnings,
        } => quality::lint(&paths, deny_warnings),
        Command::Format {
            paths,
            check,
            write,
        } => quality::format(&paths, check, write),
        Command::Minify {
            input,
            output,
            input_map,
            output_map,
        } => minify::run(&input, &output, input_map.as_deref(), output_map.as_deref()),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("web: {error:#}");
            ExitCode::FAILURE
        }
    }
}
