// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! What a SlateDB-backed store needs beyond SlateDB itself.
//!
//! - [`Backend`]: memory, a local directory, or S3, as an object store.
//! - [`settings`]: SlateDB settings tuned to the backend (a short WAL tick
//!   on local media, bloom filters on every SST, prompt compaction and
//!   garbage collection), overridable from the environment.
//! - [`QuickDbCache`]: SlateDB's block and metadata caches on quick_cache,
//!   whose hits do not contend.
//! - [`segments`]: one LSM tree per first byte of key, and a block cache
//!   policy keeping bulk data out of the cache.
//! - [`DurableDb`]: writes that pass a [`write_admission`] gate and return
//!   only once durable; reads that honor expiry.
//! - [`open`]: all of the above, from one set of [`OpenOptions`].

mod backend;
mod cache;
mod durable;
mod open;
pub mod segments;
pub mod settings;

pub use backend::Backend;
pub use cache::QuickDbCache;
pub use durable::{DurableDb, Error, durable_reads, now_millis, uncached_reads};
pub use open::{
    DEFAULT_BLOCK_CACHE_BYTES, DEFAULT_META_CACHE_BYTES, ObjectStoreCache, OpenOptions, open,
};

#[cfg(test)]
mod tests;
