// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Read-through caches for values that expire: what a read of a store
//! found, served from memory until the expiry that read saw.
//!
//! A store whose values only disappear by expiring (a content-addressed
//! store, say) can answer a repeated read from memory for as long as the
//! value it read lives. These caches keep such answers under a budget, on
//! [`quick_cache`], whose hits take a shared lock and set a bit rather than
//! moving the entry, so hot keys read from every core do not contend:
//!
//! - [`ExpiringCache`]: values under a byte budget, each served until the
//!   expiry its read saw (less a margin).
//! - [`PresenceCache`]: no values, just that a key is stored and until
//!   when, under an entry budget; for existence checks.
//! - [`InvalidatingCache`]: an [`ExpiringCache`] of values that can also be
//!   overwritten, with writes dropping what reads under way would keep.
//!
//! Every entry, however long its value lives, is served for at most its
//! [`Policy::revalidate_ms`] before it is read again: a guard against the
//! store losing data underneath its readers (an operator restoring an old
//! bucket, say).
//!
//! Times are milliseconds since the Unix epoch, as `i64`, passed in by the
//! caller, so the caches take the same clock as the store's expiry times
//! and tests can move time at will. An expiry of `None` is never.

mod expiring;
mod invalidating;
mod presence;
mod shards;
mod uniform;

pub use expiring::{ExpiringCache, Freshness, Policy, Weigh};
pub use invalidating::{InvalidatingCache, ReadStart};
pub use presence::PresenceCache;
pub use shards::shard_options;
pub use uniform::{UniformHashBuilder, UniformHasher};

/// How long an entry is served, however long its value lives, before it
/// is read again, unless a [`Policy`] says otherwise: ten minutes.
pub const DEFAULT_REVALIDATE_MS: i64 = 10 * 60 * 1000;
