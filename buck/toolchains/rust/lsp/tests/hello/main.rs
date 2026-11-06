// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A binary for the language server's smoke test, which looks up the
//! definitions of the names main uses.

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

answer::make_answer!();

fn main() -> anyhow::Result<()> {
    let text: String = salutation::greet("world");
    println!("{text} {}", answer());
    Ok(())
}
