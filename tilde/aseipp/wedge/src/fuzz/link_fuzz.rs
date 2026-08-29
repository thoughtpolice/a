// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Fozzie harness: whatever wlink links, Wedge compiles.
//!
//! The input is one binary component, or component text in which
//! `(;wlink-fuzz-split;)` separates the components of a package, the form
//! `tilde//aseipp/wlink:fuzz-seeds` packs every linked fixture set into.
//! Linking may fail, but a module that comes out is held to the contract of
//! any other: it is a standard core module, validation and compilation agree
//! on it, its program verifies and prints, and its plan describes itself.

#![no_main]

use wlink::Input;

#[cfg(not(fozzie_asan))]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

const SEPARATOR: &str = "(;wlink-fuzz-split;)";

/// The harness result for a linked module that is not a standard core
/// module, after the codes `wedge_testing::oracle::Failure` returns.
const NOT_A_MODULE: i32 = 4;

fn inputs(data: &[u8]) -> Vec<Input> {
    let text = match std::str::from_utf8(data) {
        Ok(text) if !data.starts_with(b"\0asm") => text,
        _ => {
            return vec![Input {
                name: "c0".into(),
                bytes: data.to_vec(),
            }];
        }
    };
    text.split(SEPARATOR)
        .enumerate()
        .map(|(index, part)| Input {
            name: format!("c{index}"),
            bytes: part.as_bytes().to_vec(),
        })
        .collect()
}

fozzie::fuzz_target!(|data: &[u8]| -> i32 {
    let Ok(linked) = wlink::link(&inputs(data)) else {
        return 0;
    };
    let _ = wlink::describe(&linked.plan);
    if let Err(error) = wedge::Compiler::new().validate(&linked.module) {
        eprintln!("the linked module is not a standard core module: {error}");
        return NOT_A_MODULE;
    }
    match wedge_testing::oracle::check_module(&linked.module) {
        Ok(_) => 0,
        Err(failure) => {
            eprintln!("{failure}");
            failure.code()
        }
    }
});
