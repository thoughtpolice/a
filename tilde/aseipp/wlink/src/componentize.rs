// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Wrapping a core module into a component against a WIT world.
//!
//! This is a thin front over `wit-component`, present so the SDK build needs
//! no tool outside the build graph: the core module's imports and exports
//! must already follow the canonical ABI names and signatures the world
//! implies, which `wit-component` verifies.

use std::path::Path;

use anyhow::{Context, Result, bail};
use wit_component::{ComponentEncoder, StringEncoding};
use wit_parser::Resolve;

/// Encodes `core` as a component implementing `world`.
///
/// `wit` names WIT files or package directories in dependency order; the
/// last one is the package the world is selected from.
pub fn componentize(core: &[u8], wit: &[impl AsRef<Path>], world: Option<&str>) -> Result<Vec<u8>> {
    let mut resolve = Resolve::default();
    let mut main = None;
    for path in wit {
        let path = path.as_ref();
        let (package, _) = resolve
            .push_path(path)
            .with_context(|| format!("parsing WIT at {}", path.display()))?;
        main = Some(package);
    }
    let Some(main) = main else {
        bail!("componentize needs at least one WIT file or directory")
    };
    let world = resolve
        .select_world(&[main], world)
        .context("selecting the world")?;

    let mut module = core.to_vec();
    wit_component::embed_component_metadata(&mut module, &resolve, world, StringEncoding::UTF8)
        .context("embedding the component type")?;
    let mut encoder = ComponentEncoder::default();
    encoder
        .validate(true)
        .module(&module)
        .context("the core module does not implement the world")?;
    encoder.encode().context("encoding the component")
}
