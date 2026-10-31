// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT
//
// Ported from radamsa, © 2013 Aki Helin. See LICENSE.

//! Kermit is radamsa's black-box mutation engine, ported to Rust.
//!
//! All randomness comes through a [`Source`], so the same seed reproduces
//! the same outputs, and a property-testing engine can drive and shrink
//! the choices.

mod source;

pub use source::{Rng, Source};
