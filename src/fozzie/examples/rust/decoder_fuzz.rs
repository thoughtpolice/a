// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#![no_main]

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fozzie::fuzz_target!(|data: &[u8]| {
    let _ = decoder::decode(data);
});
