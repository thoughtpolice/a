// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#![no_main]

// ASan must own allocations in address-sanitized targets so its redzones are
// effective. The ordinary coverage-only profile follows the repository's
// target allocator convention.
#[cfg(not(fozzie_asan))]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fozzie::fuzz_target!(|data: &[u8]| {
    let _ = decoder::decode(data);
});
