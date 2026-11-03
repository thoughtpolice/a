// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Small synchronization primitives.
//!
//! - [`KeyedLock`]: one holder per key at a time, so concurrent requests
//!   for the same thing wait for one of them to do it (single flight).
//! - [`ByteBudget`]: a byte count shared by threads, taken before work that
//!   holds memory and given back when it is done, with waits a flag can
//!   stop.

mod budget;
mod keyed;

pub use budget::{ByteBudget, Held, Stopped};
pub use keyed::KeyedLock;
