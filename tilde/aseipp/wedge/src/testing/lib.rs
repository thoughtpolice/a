// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! What Wedge's fuzz harnesses and generated-module properties share: the
//! contract every module must satisfy, and modules drawn from bytes.

pub mod console;
// The HAL's host side, which witgen generates from the console SDK's WIT.
pub mod differential;
pub mod equivalence;
mod hal;
pub mod oracle;
pub mod smith;
