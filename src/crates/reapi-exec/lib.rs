// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The parts of a Remote Execution API worker that do not depend on who
//! schedules its actions or how it runs them:
//!
//! - [`platform`]: which workers may run which actions, by platform
//!   properties.
//! - [`cas`]: a CAS client for bulk reads and writes, batched or streamed by
//!   size and checked against digests; it is a [`reflink_cache::Fetch`].
//! - [`inputs`]: laying out an action's input root from the CAS, through a
//!   [`reflink_cache::FileCache`].
//! - [`outputs`]: preparing for an action's outputs, then collecting and
//!   uploading what it produced.
//!
//! Digests are [`reapi_cas::Digest`]s, converted to and from the protos at
//! the edges.

pub mod cas;
pub mod inputs;
pub mod outputs;
pub mod platform;

pub use cas::{Blob, Cas, Missing};
pub use inputs::Inputs;
pub use outputs::Produced;
pub use platform::{Offer, Requirements};

#[cfg(test)]
mod test_cas;

#[cfg(test)]
mod test_copy;
#[cfg(test)]
mod test_inputs;
#[cfg(test)]
mod test_outputs;
