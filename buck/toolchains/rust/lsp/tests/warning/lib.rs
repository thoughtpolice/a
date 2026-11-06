// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A library whose one function has an unused variable, on purpose: the
//! smoke test checks that `rust-project check` reports it.

pub fn unused() {
    let unused_variable = 1;
}
