// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Parser)]
#[command(name = "wlink", about = "Static linker for WebAssembly components")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Link components into one core module.
    Link {
        /// Components to link, as binaries or component text. `name=path`
        /// names the component; otherwise the file stem does.
        #[arg(required = true)]
        inputs: Vec<String>,
        /// Where to write the linked module.
        #[arg(short, long)]
        output: PathBuf,
        /// Print what was linked.
        #[arg(long)]
        verbose: bool,
    },
    /// Wrap a core module into a component implementing a WIT world.
    Componentize {
        /// The core module.
        core: PathBuf,
        /// WIT files or package directories, in dependency order.
        #[arg(long, required = true)]
        wit: Vec<PathBuf>,
        /// The world to implement, from the last WIT package.
        #[arg(long)]
        world: Option<String>,
        /// Where to write the component.
        #[arg(short, long)]
        output: PathBuf,
    },
    /// Print a module or component as text.
    Print { file: PathBuf },
}

fn parse_input(spec: &str) -> Result<wlink::Input> {
    let (name, path) = match spec.split_once('=') {
        Some((name, path)) => (name.to_string(), Path::new(path)),
        None => {
            let path = Path::new(spec);
            let name = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .map(str::to_string)
                .with_context(|| format!("cannot derive a component name from {spec}"))?;
            (name, path)
        }
    };
    let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    Ok(wlink::Input { name, bytes })
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Link {
            inputs,
            output,
            verbose,
        } => {
            let inputs = inputs
                .iter()
                .map(|spec| parse_input(spec))
                .collect::<Result<Vec<_>>>()?;
            let linked = wlink::link(&inputs)?;
            if verbose {
                print!("{}", wlink::describe(&linked.plan));
            }
            fs::write(&output, linked.module)
                .with_context(|| format!("writing {}", output.display()))?;
        }
        Command::Componentize {
            core,
            wit,
            world,
            output,
        } => {
            let bytes = fs::read(&core).with_context(|| format!("reading {}", core.display()))?;
            let component = wlink::componentize::componentize(&bytes, &wit, world.as_deref())?;
            fs::write(&output, component)
                .with_context(|| format!("writing {}", output.display()))?;
        }
        Command::Print { file } => {
            let bytes = fs::read(&file).with_context(|| format!("reading {}", file.display()))?;
            if !bytes.starts_with(b"\0asm") {
                bail!("{} is not a WebAssembly binary", file.display());
            }
            print!("{}", wasmprinter::print_bytes(&bytes)?);
        }
    }
    Ok(())
}
