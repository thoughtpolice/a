// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The content-addressed storage vocabulary of the Remote Execution API, for
//! servers and clients alike:
//!
//! - [`digest`]: the digest functions (SHA-256, BLAKE3, SHA256TREE), typed
//!   digests, and an incremental hasher for each.
//! - [`compression`]: REAPI's compressors, capped against decompression
//!   bombs, with a streaming decompressor.
//! - [`chunking`]: FastCDC 2020 as REAPI's SplitBlob and SpliceBlob use it.
//! - [`resource`]: ByteStream resource names, parsed and built.
//!
//! The `repr(u8)` discriminants of [`DigestFn`] and [`Compression`] are
//! stable: stores put them in keys and values on disk.

pub mod chunking;
pub mod compression;
pub mod digest;
pub mod resource;

pub use chunking::FastCdc2020;
pub use compression::{
    Compression, CompressionError, MAX_CHUNK_DECOMPRESSED_SIZE, StreamingDecompressor,
    UnknownCompressor,
};
pub use digest::{
    ContentDigest, DigestFn, IncrementalHasher, UnknownDigestFunction, parse_digest_hash,
};
pub use resource::{ReadResourceName, ResourceNameError, WriteResourceName};

#[cfg(test)]
mod test_helpers;

#[cfg(test)]
mod test_chunking;
#[cfg(test)]
mod test_compression;
#[cfg(test)]
mod test_digest;
#[cfg(test)]
mod test_resource;
