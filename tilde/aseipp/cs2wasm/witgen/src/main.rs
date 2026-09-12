// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Parser)]
#[command(name = "witgen", about = "WIT bindings for gameplayc modules")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Generate C# bindings for a WIT world.
    Csharp {
        /// WIT files or package directories, in dependency order; the world
        /// comes from the last one.
        #[arg(required = true)]
        wit: Vec<PathBuf>,
        /// The world to bind; the package's only world by default.
        #[arg(long)]
        world: Option<String>,
        /// The C# namespace; `Ns.Pkg` from the package name by default.
        #[arg(long)]
        namespace: Option<String>,
        /// Where to write the C# file; standard output by default.
        #[arg(short, long)]
        output: Option<PathBuf>,
        /// Fail when any function or type could not be generated.
        #[arg(long)]
        strict: bool,
    },
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Csharp {
            wit,
            world,
            namespace,
            output,
            strict,
        } => {
            let (resolve, world) = witgen::load(&wit, world.as_deref())?;
            // The generated file carries the SPDX lines of the WIT it came from.
            let header = wit
                .last()
                .map(|path| witgen::spdx_header(path))
                .unwrap_or_default();
            let (source, report) = witgen::csharp(&resolve, world, namespace.as_deref(), &header)?;
            eprint!("{}", witgen::describe(&report));
            if strict && !report.skipped.is_empty() {
                anyhow::bail!("{} items were not generated", report.skipped.len());
            }
            match output {
                Some(path) => fs::write(&path, source)
                    .with_context(|| format!("writing {}", path.display()))?,
                None => print!("{source}"),
            }
        }
    }
    Ok(())
}
