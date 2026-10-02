// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Bindings for WIT worlds. witgen reads a world with wit-parser, the crate
//! wlink links components with, and writes code for one side of it:
//!
//! - [`host`]: the side of a world's imports a host implements itself,
//!   under wlink's host ABI, in TypeScript, C (over wasm2c) or Rust.
//!
//! What every backend shares is here: loading WIT, the report of what a
//! backend could not express, the SPDX header generated files carry, the
//! casing of names ([`names`]) and the canonical ABI's layout of values in
//! linear memory ([`abi`]).

use std::fmt::Write as _;
use std::path::Path;

use anyhow::{Context, Result, bail};
use wit_parser::{PackageId, Resolve, TypeDefKind, WorldId};

pub mod abi;
pub mod host;
pub mod names;

/// Parses WIT files or package directories in dependency order and selects a
/// world from the last one.
pub fn load(wit: &[impl AsRef<Path>], world: Option<&str>) -> Result<(Resolve, WorldId)> {
    let mut resolve = Resolve::default();
    let mut main: Option<PackageId> = None;
    for path in wit {
        let path = path.as_ref();
        let (package, _) = resolve
            .push_path(path)
            .with_context(|| format!("parsing WIT at {}", path.display()))?;
        main = Some(package);
    }
    let Some(main) = main else {
        bail!("at least one WIT file or package directory is needed")
    };
    let world = resolve
        .select_world(&[main], world)
        .context("selecting the world")?;
    Ok((resolve, world))
}

/// What the generator could not express, one line per function or type.
#[derive(Debug, Default)]
pub struct Report {
    pub skipped: Vec<String>,
}

/// The SPDX header lines a WIT file starts with, if any: generated code
/// carries the license of the WIT it came from.
pub fn spdx_header(path: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .take_while(|line| line.starts_with("// SPDX-"))
        .map(str::to_string)
        .collect()
}

/// The WIT name of a type definition's kind, for reports.
pub fn kind_name(kind: &TypeDefKind) -> &'static str {
    match kind {
        TypeDefKind::Record(_) => "record",
        TypeDefKind::Resource => "resource",
        TypeDefKind::Handle(_) => "handle",
        TypeDefKind::Flags(_) => "flags",
        TypeDefKind::Tuple(_) => "tuple",
        TypeDefKind::Variant(_) => "variant",
        TypeDefKind::Enum(_) => "enum",
        TypeDefKind::Option(_) => "option",
        TypeDefKind::Result(_) => "result",
        TypeDefKind::List(_) => "list",
        TypeDefKind::Map(..) => "map",
        TypeDefKind::FixedLengthList(..) => "fixed-length list",
        TypeDefKind::Future(_) => "future",
        TypeDefKind::Stream(_) => "stream",
        TypeDefKind::Type(_) => "alias",
        TypeDefKind::Unknown => "unknown",
    }
}

/// Renders the report as one line per skipped item.
pub fn describe(report: &Report) -> String {
    let mut text = String::new();
    for item in &report.skipped {
        let _ = writeln!(text, "witgen: not generated: {item}");
    }
    text
}
