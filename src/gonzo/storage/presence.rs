// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Blobs known to be stored, and until when.
//!
//! Builds ask about the same inputs over and over (every action names the
//! same toolchain and headers), and each FindMissingBlobs answer would
//! otherwise be a point lookup through every SST of the manifest segment.
//! A blob only disappears by expiring, so "durably stored, expiring at T"
//! stays true until T: such answers are kept here and served without the
//! LSM. Only durable, positive answers are kept; absent blobs are always
//! looked up, since they may arrive at any moment.
//!
//! As a guard against the store losing data underneath the server (an
//! operator restoring an old bucket, say), an entry is only trusted for
//! [`expiring_cache::DEFAULT_REVALIDATE_MS`] before it is looked up again.

use expiring_cache::UniformHashBuilder;

use reapi_cas::ContentDigest;

/// Entries kept: about 80 bytes each.
pub(crate) const DEFAULT_ENTRIES: usize = 1 << 20;

/// Blobs known durably stored, by digest. Digests are uniformly random, so
/// they hash by their first bytes.
pub(crate) type PresenceCache = expiring_cache::PresenceCache<ContentDigest, UniformHashBuilder>;
