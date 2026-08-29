// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Fozzie harness: every module wasm-smith draws from the input behaves the
//! same under Wedge's reference interpreter, before or after the
//! simplification pass, and under WABT's.

#![no_main]

use arbitrary::Unstructured;
use wedge::Compiler;
use wedge::simplify;
use wedge_testing::differential::{self, Verdict, Wabt};
use wedge_testing::equivalence;

#[cfg(not(fozzie_asan))]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn wabt() -> &'static Wabt {
    static WABT: std::sync::OnceLock<Wabt> = std::sync::OnceLock::new();
    WABT.get_or_init(|| {
        Wabt::new(
            fozzie::resource("spectest-interp").expect("the harness is given spectest-interp"),
        )
    })
}

fozzie::fuzz_target!(|data: &[u8]| -> i32 {
    // The tail of the input chooses arguments; the rest draws the module.
    // The first argument byte's low bit decides whether the program WABT
    // is held to is the lowered one or the simplified one.
    let split = data.len() - data.len() / 8;
    let (module_bytes, argument_bytes) = data.split_at(split);
    let Some(module) = wedge_testing::smith::executable_module(module_bytes) else {
        return 0;
    };
    let Ok(mut program) = Compiler::new().compile(&module) else {
        return 0;
    };
    let simplified = argument_bytes.first().is_some_and(|byte| byte & 1 == 1);
    if simplified {
        if let Err(error) = simplify::simplify(&mut program) {
            eprintln!(
                "the pass failed: {error}\n{}",
                wedge_testing::smith::text(&module)
            );
            return equivalence::Verdict::UNVERIFIABLE_CODE;
        }
        if let Err(errors) = program.verify() {
            eprintln!("{errors}\n{}", wedge_testing::smith::text(&module));
            return equivalence::Verdict::UNVERIFIABLE_CODE;
        }
    }
    match differential::check_program(
        wabt(),
        &module,
        &program,
        &mut Unstructured::new(argument_bytes),
    ) {
        Verdict::Agree { .. } | Verdict::Inconclusive(_) => 0,
        Verdict::Disagree(why) => {
            eprintln!(
                "{why}\n{}{}",
                if simplified {
                    "after simplification\n"
                } else {
                    ""
                },
                wedge_testing::smith::text(&module)
            );
            Verdict::DISAGREE_CODE
        }
    }
});
