// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A proc macro for the language server's smoke test.

use proc_macro::TokenStream;

/// Defines `fn answer() -> u32`.
#[proc_macro]
pub fn make_answer(_input: TokenStream) -> TokenStream {
    "pub fn answer() -> u32 { 42 }".parse().unwrap()
}
