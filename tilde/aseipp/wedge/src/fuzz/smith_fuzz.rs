// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Fozzie harness: every module wasm-smith draws from the input compiles to a
//! verified program, and the validator agrees with the compiler about it.

#![no_main]

#[cfg(not(fozzie_asan))]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fozzie::fuzz_target!(|data: &[u8]| -> i32 {
    let Some(module) = wedge_testing::smith::module(data) else {
        return 0;
    };
    match wedge_testing::oracle::check_module(&module) {
        Ok(_) => 0,
        Err(failure) => {
            eprintln!("{failure}\n{}", wedge_testing::smith::text(&module));
            failure.code()
        }
    }
});
