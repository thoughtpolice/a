// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Fozzie harness: every module wasm-smith draws from the input simplifies
//! to a program that verifies and behaves like the original under the
//! reference interpreter.

#![no_main]

use arbitrary::Unstructured;
use wedge_testing::equivalence::{self, Verdict};

#[cfg(not(fozzie_asan))]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fozzie::fuzz_target!(|data: &[u8]| -> i32 {
    // The tail of the input chooses arguments; the rest draws the module.
    let split = data.len() - data.len() / 8;
    let (module_bytes, argument_bytes) = data.split_at(split);
    let Some(module) = wedge_testing::smith::executable_module(module_bytes) else {
        return 0;
    };
    match equivalence::check_simplified(&module, &mut Unstructured::new(argument_bytes)) {
        Verdict::Equivalent { .. } | Verdict::Inconclusive(_) => 0,
        Verdict::Unverifiable(why) => {
            eprintln!("{why}\n{}", wedge_testing::smith::text(&module));
            Verdict::UNVERIFIABLE_CODE
        }
        Verdict::Divergent(why) => {
            eprintln!("{why}\n{}", wedge_testing::smith::text(&module));
            Verdict::DIVERGENT_CODE
        }
    }
});
