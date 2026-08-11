// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

pub(crate) mod helpers;

mod action_cache;
pub use action_cache::ActionCacheService;

mod bytestream;
pub use bytestream::ByteStreamService;

mod capabilities;
pub use capabilities::CapabilitiesService;

mod cas;
pub use cas::ContentAddressableStorageService;

mod execution;
pub use execution::ExecutionService;

mod logstream;
pub use logstream::LogStreamSvc;

mod operations;
pub use operations::OperationsService;

mod git_clone;

mod remote_asset;
pub use remote_asset::{FetchService, PushService};

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
