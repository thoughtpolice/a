// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail, ensure};
use clap::{Parser, ValueEnum};
use wedge::Compiler;
use wedge::dump::CfgDump;
use wedge::ir::{FunctionId, Program};

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Debug, Parser)]
#[command(about = "Compile WebAssembly into Wedge's dataflow IR")]
struct Arguments {
    /// Core WebAssembly module to compile: a binary, or a text-format `.wat`
    /// file assembled with WABT's `wat2wasm`.
    #[arg(value_name = "MODULE.wasm|MODULE.wat")]
    input: PathBuf,

    /// Compiler representation to print.
    #[arg(long, value_enum, default_value_t = Emit::Ir)]
    emit: Emit,

    /// Restrict the dump to one function: a function-index-space index
    /// (`12` or `func12`), its `name` section name, or a function export name.
    #[arg(long, value_name = "INDEX|NAME")]
    function: Option<String>,

    /// Run the simplification pass (constant folding, branch resolution,
    /// jump threading, block merging, dead code removal) before printing,
    /// and report what it changed on standard error.
    #[arg(long)]
    simplify: bool,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Emit {
    /// Owned, typed WebAssembly semantic IR.
    Ir,
    /// Target-neutral CFG topology and shared analyses.
    Cfg,
}

/// The Core WebAssembly 3.0 features WABT leaves disabled by default.
const WAT2WASM_FEATURES: &[&str] = &["--enable-function-references", "--enable-gc"];

/// Reads a module, assembling it first when it lacks the binary magic and so
/// must be WebAssembly text.
fn read_module(input: &Path) -> Result<Vec<u8>> {
    let contents =
        std::fs::read(input).with_context(|| format!("could not read {}", input.display()))?;
    if contents.starts_with(b"\0asm") {
        Ok(contents)
    } else {
        assemble(input).with_context(|| format!("could not assemble {}", input.display()))
    }
}

/// Assembles a text-format module with the `wat2wasm` the build provides as a
/// resource of this binary, so no separate toolchain installation is needed.
fn assemble(input: &Path) -> Result<Vec<u8>> {
    let wat2wasm = buck_resources::get("aseipp/wedge/wat2wasm")
        .context("locate the wat2wasm resource; run wedge from its build output")?;
    let output = std::env::temp_dir().join(format!(
        "wedge-{}-{}.wasm",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos())
    ));
    let status = Command::new(&wat2wasm)
        .args(WAT2WASM_FEATURES)
        .arg("-o")
        .arg(&output)
        .arg(input)
        .output()
        .with_context(|| format!("run {}", wat2wasm.display()))?;
    if !status.status.success() {
        let _ = std::fs::remove_file(&output);
        bail!(
            "wat2wasm failed with {}:\n{}",
            status.status,
            String::from_utf8_lossy(&status.stderr).trim_end()
        );
    }
    let assembled = std::fs::read(&output).with_context(|| format!("read {}", output.display()));
    let _ = std::fs::remove_file(&output);
    assembled
}

/// Resolves a `--function` selector. A number is an index. Otherwise a
/// `name` section entry or a function export must match exactly, and only
/// failing that is `funcN` read as an index, so a real name is never
/// shadowed by the dump's own numbering.
fn select_function(program: &Program, selector: &str) -> Result<FunctionId> {
    let by_index = |index: u32| -> Result<FunctionId> {
        ensure!(
            (index as usize) < program.functions.len(),
            "function index {index} is out of range: the module has {} functions",
            program.functions.len()
        );
        Ok(FunctionId(index))
    };
    if let Ok(index) = selector.parse::<u32>() {
        return by_index(index);
    }
    let named = program.functions_named(selector);
    match named.as_slice() {
        [function] => Ok(*function),
        [] => match selector.strip_prefix("func").map(str::parse::<u32>) {
            Some(Ok(index)) => by_index(index),
            _ => bail!(
                "no function is named {selector:?}; --function takes a function index, \
                 a name-section name, or a function export name"
            ),
        },
        many => bail!(
            "{selector:?} names {} functions: {}; select one by index",
            many.len(),
            many.iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

fn main() -> Result<()> {
    let arguments = Arguments::parse();
    let wasm = read_module(&arguments.input)?;
    let mut artifact = Compiler::default()
        .compile(&wasm)
        .with_context(|| format!("could not compile {}", arguments.input.display()))?;
    if arguments.simplify {
        let statistics = wedge::simplify::simplify(&mut artifact)
            .with_context(|| format!("could not simplify {}", arguments.input.display()))?;
        artifact.verify().with_context(|| {
            format!(
                "simplifying {} produced invalid IR",
                arguments.input.display()
            )
        })?;
        eprintln!("simplify: {statistics}");
    }
    let function = arguments
        .function
        .as_deref()
        .map(|selector| select_function(&artifact, selector))
        .transpose()?;
    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    let result = match (arguments.emit, function) {
        (Emit::Ir, None) => write!(stdout, "{artifact}"),
        (Emit::Ir, Some(function)) => {
            let display = artifact
                .function_display(function)
                .expect("the selector resolved to a function of the module");
            write!(stdout, "{display}")
        }
        (Emit::Cfg, None) => write!(stdout, "{}", CfgDump::new(&artifact)),
        (Emit::Cfg, Some(function)) => {
            ensure!(
                artifact.functions[function.index()].body.is_some(),
                "{function} is imported and has no function body to dump"
            );
            write!(stdout, "{}", CfgDump::new(&artifact).function(function))
        }
    };
    result.context("could not write compiler output")?;
    stdout.flush().context("could not write compiler output")?;
    Ok(())
}
