// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Parser)]
#[command(name = "witgen", about = "Bindings for WIT worlds")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Generate C# bindings for a WIT world, for gameplayc.
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
    /// Generate the bindings of a host that implements a world's imports,
    /// under wlink's host ABI.
    Host {
        /// WIT files or package directories, in dependency order; the world
        /// comes from the last one.
        #[arg(required = true)]
        wit: Vec<PathBuf>,
        /// The world whose imports the host implements; the package's only
        /// world by default.
        #[arg(long)]
        world: Option<String>,
        /// The language of the host.
        #[arg(long, value_enum)]
        lang: Lang,
        /// Where to write the bindings; standard output by default.
        #[arg(short, long)]
        output: Option<PathBuf>,
        /// Fail when any function could not be generated.
        #[arg(long)]
        strict: bool,
        /// C: the prefix of the types and of the functions the host
        /// implements.
        #[arg(long)]
        c_prefix: Option<String>,
        /// C: the prefix of the imports the bindings define and of their
        /// memories and allocators, as the host aliases wasm2c's names.
        #[arg(long)]
        c_flat_prefix: Option<String>,
        /// C: the type of the imports' context argument.
        #[arg(long)]
        c_context: Option<String>,
    },
    /// Generate a C guest's bindings, with wit-bindgen's C generator.
    C {
        #[command(flatten)]
        guest: Guest,
        #[command(flatten)]
        opts: wit_bindgen_c::Opts,
    },
    /// Generate a Rust guest's bindings, with wit-bindgen's Rust generator.
    Rust {
        #[command(flatten)]
        guest: Guest,
        #[command(flatten)]
        opts: wit_bindgen_rust::Opts,
    },
}

/// What a guest's bindings are generated from, and where they go.
#[derive(clap::Args)]
struct Guest {
    /// WIT files or package directories, in dependency order; the world comes
    /// from the last one.
    #[arg(required = true)]
    wit: Vec<PathBuf>,
    /// The world the guest implements; the package's only world by default.
    #[arg(long)]
    world: Option<String>,
    /// The directory the generator's files are written to.
    #[arg(long, default_value = ".")]
    out_dir: PathBuf,
}

impl Guest {
    /// Runs a wit-bindgen generator over the world and writes its files.
    fn generate(&self, mut generator: Box<dyn wit_bindgen_core::WorldGenerator>) -> Result<()> {
        let (mut resolve, world) = witgen::load(&self.wit, self.world.as_deref())?;
        let mut files = wit_bindgen_core::Files::default();
        generator.generate(&mut resolve, world, &mut files)?;
        fs::create_dir_all(&self.out_dir)
            .with_context(|| format!("creating {}", self.out_dir.display()))?;
        for (name, contents) in files.iter() {
            let path = self.out_dir.join(name);
            fs::write(&path, contents).with_context(|| format!("writing {}", path.display()))?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, ValueEnum)]
enum Lang {
    C,
    Rust,
    Ts,
}

/// Writes generated code where it was asked for, after the report.
fn finish(
    source: String,
    report: &witgen::Report,
    strict: bool,
    output: Option<&Path>,
) -> Result<()> {
    eprint!("{}", witgen::describe(report));
    if strict && !report.skipped.is_empty() {
        anyhow::bail!("{} items were not generated", report.skipped.len());
    }
    match output {
        Some(path) => {
            fs::write(path, source).with_context(|| format!("writing {}", path.display()))
        }
        None => {
            print!("{source}");
            Ok(())
        }
    }
}

/// The SPDX lines of the WIT the world comes from, which generated code
/// carries.
fn header(wit: &[PathBuf]) -> Vec<String> {
    wit.last()
        .map(|path| witgen::spdx_header(path))
        .unwrap_or_default()
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
            let (source, report) =
                witgen::csharp::csharp(&resolve, world, namespace.as_deref(), &header(&wit))?;
            finish(source, &report, strict, output.as_deref())
        }
        Command::Host {
            wit,
            world,
            lang,
            output,
            strict,
            c_prefix,
            c_flat_prefix,
            c_context,
        } => {
            let (resolve, world) = witgen::load(&wit, world.as_deref())?;
            let lang = match lang {
                Lang::C => witgen::host::Lang::C,
                Lang::Rust => witgen::host::Lang::Rust,
                Lang::Ts => witgen::host::Lang::Ts,
            };
            let c = witgen::host::COptions {
                prefix: c_prefix,
                flat_prefix: c_flat_prefix,
                context: c_context,
            };
            let (source, report) = witgen::host::host(&resolve, world, lang, &c, &header(&wit))?;
            finish(source, &report, strict, output.as_deref())
        }
        Command::C { guest, opts } => guest.generate(opts.build()),
        Command::Rust { guest, opts } => guest.generate(Box::new(opts.build())),
    }
}
