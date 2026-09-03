// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! `wlink`: a static linker for WebAssembly components.
//!
//! Given a set of components whose imports and exports plug into each other,
//! the linker evaluates the whole instantiation graph ahead of time and
//! emits a single core module. Calls that cross a component boundary go
//! through fused adapters generated as ordinary wasm code, so the output runs
//! on any core WebAssembly engine, including ahead-of-time translators such
//! as `wasm2c`. Whatever the package does not satisfy itself stays an import
//! of the output module, in the flat form the canonical ABI prescribes for a
//! lowered function.
//!
//! The pipeline is [`component::parse`], [`plan::link`], [`merge::merge`].

pub mod adapter;
pub mod component;
pub mod componentize;
pub mod handles;
pub mod merge;
pub mod plan;
pub mod types;

use std::fmt::Write;

use anyhow::{Context, Result};

/// One component to link, in binary or text form.
#[derive(Clone, Debug)]
pub struct Input {
    pub name: String,
    pub bytes: Vec<u8>,
}

/// The result of a link.
pub struct Linked {
    pub module: Vec<u8>,
    pub plan: plan::Plan,
}

/// Links `inputs` into one core module.
pub fn link(inputs: &[Input]) -> Result<Linked> {
    let mut components = Vec::with_capacity(inputs.len());
    for input in inputs {
        let component = component::parse_source(&input.bytes)
            .with_context(|| format!("decoding component `{}`", input.name))?;
        components.push((input.name.clone(), component));
    }
    let plan = plan::link(&components)?;
    let module = merge::merge(&plan)?;
    Ok(Linked { module, plan })
}

/// A human-readable account of what a plan links.
pub fn describe(plan: &plan::Plan) -> String {
    let mut out = String::new();
    for instance in &plan.instances {
        let _ = writeln!(
            out,
            "instance {} = module {}",
            instance.name, instance.module
        );
        for arg in &instance.args {
            let _ = writeln!(
                out,
                "  import {} {} <- {:?}",
                arg.module, arg.field, arg.item
            );
        }
    }
    for (index, resource) in plan.resources.iter().enumerate() {
        let owner = match resource.owner {
            Some(frame) => plan.frames[frame].name.as_str(),
            None => "host",
        };
        let _ = writeln!(
            out,
            "resource {index} {} owner={owner} dtor={:?}",
            resource.name, resource.dtor
        );
    }
    for builtin in &plan.builtins {
        let _ = writeln!(
            out,
            "builtin {} {} in {}",
            builtin.kind.describe(),
            plan.resources[builtin.resource].name,
            plan.frames[builtin.frame].name
        );
    }
    for adapter in &plan.adapters {
        let _ = writeln!(
            out,
            "adapter {}: {} -> {:?}",
            adapter.name, adapter.ty, adapter.callee
        );
    }
    for import in &plan.imports {
        let signature = types::lower_signature(&import.ty);
        let _ = writeln!(
            out,
            "import {} {}: {} as {:?} -> {:?}",
            import.module, import.name, import.ty, signature.params, signature.results
        );
    }
    for export in &plan.exports {
        let _ = writeln!(
            out,
            "export {}: {} <- {:?}",
            export.name, export.ty, export.func
        );
    }
    for export in &plan.resource_exports {
        let _ = writeln!(
            out,
            "export {}: destructor of {}",
            export.name, plan.resources[export.resource].name
        );
    }
    out
}
