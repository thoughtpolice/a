// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The parts of a Remote Execution API worker that do not depend on who
//! schedules its actions or how it runs them:
//!
//! - [`platform`]: which workers may run which actions, by platform
//!   properties.
//! - [`inputs`]: laying out an action's input root from the CAS, through a
//!   [`reflink_cache::FileCache`] that fetches from it.
//! - [`outputs`]: preparing for an action's outputs, then collecting and
//!   uploading what it produced.
//!
//! The CAS is `reapi_client`'s [`Cas`], which moves many blobs at once,
//! batched or streamed by size. Digests are [`reapi_cas::Digest`]s,
//! converted to and from the protos at the edges.

pub mod inputs;
pub mod outputs;
pub mod platform;

pub use reapi_client::{Blob, Cas};

/// The blobs an operation found missing from the CAS, if that is why it
/// failed. A worker reports such a failure as `FAILED_PRECONDITION`, which
/// tells the client to upload them again.
pub fn missing(error: &anyhow::Error) -> Option<&[reapi_cas::Digest]> {
    match error.downcast_ref::<reapi_client::Error>()? {
        reapi_client::Error::Missing(digests) => Some(digests),
        _ => None,
    }
}
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
