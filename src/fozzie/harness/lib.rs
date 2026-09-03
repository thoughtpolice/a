// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The Rust adapter for Fozzie's libFuzzer-compatible target ABI.

/// Define `LLVMFuzzerTestOneInput` from a closure over an input byte slice.
///
/// A fuzz binary is a `#![no_main]` crate built with
/// `rust_fuzz_binary()`. Panics abort the target process and are reported as
/// findings by the out-of-process Fozzie controller.
///
/// ```ignore
/// #![no_main]
/// fozzie::fuzz_target!(|data: &[u8]| {
///     let _ = parser::parse(data);
/// });
/// ```
#[macro_export]
macro_rules! fuzz_target {
    (|$data:ident: &[u8]| $body:block) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn LLVMFuzzerTestOneInput(
            fozzie_data: *const u8,
            fozzie_size: usize,
        ) -> i32 {
            // SAFETY: Fozzie's target runtime passes a valid mapped input
            // region containing at least `fozzie_size` initialized bytes.
            let $data: &[u8] = unsafe {
                ::core::slice::from_raw_parts(fozzie_data, fozzie_size)
            };
            $body
            0
        }
    };
}
