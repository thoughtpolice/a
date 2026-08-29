// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Fozzie harness: the input is the module. Validation and compilation must
//! agree on it, and whatever compiles must verify and print.

#![no_main]

#[cfg(not(fozzie_asan))]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fozzie::fuzz_target!(|data: &[u8]| -> i32 {
    match wedge_testing::oracle::check_module(data) {
        Ok(_) => 0,
        Err(failure) => {
            eprintln!("{failure}");
            failure.code()
        }
    }
});
