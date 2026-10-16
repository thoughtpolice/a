// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The REAPI and Remote Asset gRPC services the cache server answers.

pub(crate) mod helpers;
pub use helpers::{
    instrumented_rpc, parse_and_validate_digest, parse_and_validate_digest_ref,
    resolve_digest_function, store_error_to_status,
};

mod action_cache;
pub use action_cache::{ActionCacheService, outputs_stored};

mod bytestream;
pub use bytestream::ByteStreamService;

mod capabilities;
pub use capabilities::CapabilitiesService;

mod cas;
pub use cas::{CasServer, ContentAddressableStorageService};

mod logstream;
pub use logstream::LogStreamSvc;

mod git_clone;
mod oci_image;

mod remote_asset;
pub use remote_asset::{FETCH_TIMEOUT_MARGIN, FetchConfig, FetchService, PushService};

#[cfg(test)]
mod test_helpers;

#[cfg(test_module_action_cache)]
mod test_action_cache;
#[cfg(test_module_bytestream)]
mod test_bytestream;
#[cfg(test_module_cas)]
mod test_cas;
#[cfg(test_module_remote_asset)]
mod test_remote_asset;
#[cfg(test_module_resource_names)]
mod test_resource_names;
#[cfg(test_module_split_splice)]
mod test_split_splice;
