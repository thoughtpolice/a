// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Shared helpers for tests over the assembled `tests/*.wat` fixtures.

#![allow(dead_code)]

use wedge::Compiler;
use wedge::ir::{Block, BlockId, ExportItem, Function, FunctionBody, Instruction, Program};

/// The assembled bytes of `tests/<name>.wat`, a resource of the test target.
pub fn fixture(name: &str) -> Vec<u8> {
    let path = buck_resources::get(format!("aseipp/wedge/{name}.wasm"))
        .unwrap_or_else(|error| panic!("locate compiled WAT fixture {name}: {error}"));
    std::fs::read(path).unwrap_or_else(|error| panic!("read compiled WAT fixture {name}: {error}"))
}

/// Compiles a fixture and checks that the result verifies.
pub fn compile_fixture(name: &str) -> Program {
    let program = Compiler::default()
        .compile(&fixture(name))
        .unwrap_or_else(|error| panic!("compile {name}.wat: {error}"));
    program
        .verify()
        .unwrap_or_else(|errors| panic!("frontend emitted invalid IR for {name}.wat:\n{errors}"));
    program
}

pub fn exported_function<'a>(program: &'a Program, name: &str) -> &'a Function {
    let id = program
        .exports
        .iter()
        .find_map(|export| match export.item {
            ExportItem::Function(id) if export.name == name => Some(id),
            _ => None,
        })
        .unwrap_or_else(|| panic!("missing function export {name:?}"));
    &program.functions[id.index()]
}

pub fn exported_body<'a>(program: &'a Program, name: &str) -> &'a FunctionBody {
    exported_function(program, name)
        .body
        .as_ref()
        .unwrap_or_else(|| panic!("exported function {name:?} has no body"))
}

pub fn block(body: &FunctionBody, id: BlockId) -> &Block {
    body.block(id).unwrap_or_else(|| panic!("missing {id}"))
}

pub fn instructions(body: &FunctionBody) -> impl Iterator<Item = &Instruction> {
    body.blocks.iter().flat_map(|block| &block.instructions)
}
