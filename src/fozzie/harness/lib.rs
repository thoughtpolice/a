// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The Rust adapter for Fozzie's libFuzzer-compatible target ABI.

use std::path::PathBuf;

/// The path of the resource `name` the engine was started with, if any.
///
/// A `resources` entry on `rust_fuzz_binary` is built outside the
/// instrumented configuration and reaches the target as
/// `--fozzie-resource=NAME=PATH` on its command line, with the path
/// absolute. Resolve it once, outside the hot path.
pub fn resource(name: &str) -> Option<PathBuf> {
    std::env::args_os().find_map(|argument| {
        let argument = argument.into_string().ok()?;
        let (found, path) = argument
            .strip_prefix("--fozzie-resource=")?
            .split_once('=')?;
        (found == name).then(|| PathBuf::from(path))
    })
}

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
///
/// A closure declared `-> i32` returns the harness result itself. Zero is an
/// ordinary run; any other value is a `nonzero_harness` finding whose
/// fingerprint carries the value, so a semantic oracle can give each way of
/// failing its own code and print its diagnostic to stderr before returning.
///
/// ```ignore
/// #![no_main]
/// fozzie::fuzz_target!(|data: &[u8]| -> i32 {
///     match parser::parse(data) {
///         Ok(tree) if tree.encode() != data => 1,
///         _ => 0,
///     }
/// });
/// ```
#[macro_export]
macro_rules! fuzz_target {
    (|$data:ident: &[u8]| -> i32 $body:block) => {
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
            let result: i32 = $body;
            result
        }
    };
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
