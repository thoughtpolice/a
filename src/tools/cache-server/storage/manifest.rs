// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Blob manifest serialization: chunk lists with creation metadata, or for
//! a small blob, the blob itself.

use std::borrow::Cow;
use std::time::SystemTime;

use bytes::{Buf, BufMut, Bytes, BytesMut};

use super::compression::Compression;
use super::error::{Result, StoreError};

// Maximum number of chunks in a manifest
pub const MAX_MANIFEST_CHUNK_COUNT: usize = 100_000;

/// Blobs at most this large are written into their manifest rather than as
/// a chunk beside it ([`BlobManifest::inline`]): one key to write and one
/// to read instead of two. Most blobs in a build are this small (Directory
/// and Command protos, small sources and outputs), and they are read over
/// and over: reading them in one lookup more than doubles how many a server
/// reads a second. The price is a manifest tree that carries their data, so
/// a lookup of a blob it lacks (a FindMissingBlobs miss) has more SSTs to
/// rule out. The limit is a SlateDB block, so a manifest never costs much
/// more than one block to read.
pub const INLINE_BLOB_MAX: usize = 4096;

/// Most an inline blob may decompress to when read: far above
/// [`INLINE_BLOB_MAX`], so the limit can move without stranding blobs
/// stored under an older one, and far below anything a corrupt payload
/// could make a reader allocate.
const INLINE_BLOB_DECODE_MAX: usize = 1024 * 1024;

/// A single chunk within a blob manifest.
#[derive(Debug, Clone, Copy)]
pub struct ChunkInfo {
    pub hash: [u8; 32],
    pub size: u64,
}

/// Ordered list of chunks that compose a blob, with creation metadata.
#[derive(Debug)]
pub struct BlobManifest {
    pub chunks: Vec<ChunkInfo>,
    /// Unix timestamp (seconds since epoch) when the manifest was created.
    pub created_at: u64,
    /// The blob itself, for one stored in its manifest (no larger than
    /// [`INLINE_BLOB_MAX`]); its chunk list is then the blob as one chunk,
    /// which no chunk key holds.
    pub inline: Option<Bytes>,
}

/// Return the current time as unix seconds, or 0 if the clock is unavailable.
pub fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl BlobManifest {
    /// The manifest of a blob stored in it: `data`, whose hash is `hash`.
    pub fn inline(hash: [u8; 32], data: Bytes) -> Self {
        BlobManifest {
            chunks: vec![ChunkInfo {
                hash,
                size: data.len() as u64,
            }],
            created_at: unix_now_secs(),
            inline: Some(data),
        }
    }

    /// Serialize to binary: V4 for an inline blob, whose payload is stored
    /// compressed only if that makes it smaller,
    /// `[u8 version=4] [u8 compression] [u64 BE created_at] [payload]`,
    /// and V3 for a list of chunks,
    /// `[u8 version=3] [u8 compression] [u64 BE created_at] [u32 BE chunk_count] [32-byte hash | u64 BE size] ...`
    pub fn to_bytes(&self, compression: Compression) -> Result<Bytes> {
        if let Some(data) = &self.inline {
            let packed = compression.compress(data)?;
            let (compression, payload) = if packed.len() < data.len() {
                (compression, packed)
            } else {
                (Compression::Identity, Cow::Borrowed(&data[..]))
            };
            let mut buf = BytesMut::with_capacity(10 + payload.len());
            buf.put_u8(4); // version
            buf.put_u8(compression as u8);
            buf.put_u64(self.created_at);
            buf.put_slice(&payload);
            return Ok(buf.freeze());
        }
        let chunk_count: u32 = self.chunks.len().try_into().map_err(|_| {
            StoreError::ManifestCorrupted(format!(
                "chunk count {} exceeds u32::MAX",
                self.chunks.len(),
            ))
        })?;
        // 1 version + 1 compression + 8 created_at + 4 count + chunks * 40
        let len = 14 + self.chunks.len() * 40;
        let mut buf = BytesMut::with_capacity(len);
        buf.put_u8(3); // version
        buf.put_u8(compression as u8);
        buf.put_u64(self.created_at);
        buf.put_u32(chunk_count);
        for chunk in &self.chunks {
            buf.put_slice(&chunk.hash);
            buf.put_u64(chunk.size);
        }
        Ok(buf.freeze())
    }

    /// Deserialize from the V3 or V4 binary format (see
    /// [`to_bytes`](Self::to_bytes)).
    ///
    /// An inline blob's manifest does not record the blob's hash (its key
    /// does), so it comes back with `inline` set and no chunks: the caller,
    /// who knows the hash, names the blob as its chunk.
    pub fn from_bytes(mut data: Bytes) -> Result<(Self, Compression)> {
        // Minimum: 1 version + 1 compression + 8 created_at
        if data.len() < 10 {
            return Err(StoreError::ManifestCorrupted("manifest too short".into()));
        }

        let version = data.get_u8();
        if version != 3 && version != 4 {
            return Err(StoreError::ManifestCorrupted(format!(
                "unknown manifest version: {}",
                version
            )));
        }
        let comp_byte = data.get_u8();
        let compression = Compression::from_u8(comp_byte).ok_or_else(|| {
            StoreError::ManifestCorrupted(format!("unknown compression byte: {}", comp_byte))
        })?;
        let created_at = data.get_u64();

        if version == 4 {
            let inline = match compression.decompress_at_most(&data, INLINE_BLOB_DECODE_MAX)? {
                Cow::Borrowed(same) => data.slice_ref(same),
                Cow::Owned(unpacked) => Bytes::from(unpacked),
            };
            let manifest = BlobManifest {
                chunks: Vec::new(),
                created_at,
                inline: Some(inline),
            };
            return Ok((manifest, compression));
        }

        if data.len() < 4 {
            return Err(StoreError::ManifestCorrupted("manifest too short".into()));
        }
        let count = data.get_u32() as usize;

        if count > MAX_MANIFEST_CHUNK_COUNT {
            return Err(StoreError::ManifestCorrupted(format!(
                "chunk count {} exceeds maximum {}",
                count, MAX_MANIFEST_CHUNK_COUNT,
            )));
        }

        let required_bytes = count.checked_mul(40).ok_or_else(|| {
            StoreError::ManifestCorrupted(format!(
                "chunk count {} overflows size calculation",
                count,
            ))
        })?;
        if data.remaining() < required_bytes {
            return Err(StoreError::ManifestCorrupted(format!(
                "manifest truncated: expected {} chunk entries ({} bytes), got {} bytes",
                count,
                required_bytes,
                data.remaining(),
            )));
        }
        let mut chunks = Vec::with_capacity(count);
        for _ in 0..count {
            let mut hash = [0u8; 32];
            data.copy_to_slice(&mut hash);
            let size = data.get_u64();
            chunks.push(ChunkInfo { hash, size });
        }
        let manifest = BlobManifest {
            chunks,
            created_at,
            inline: None,
        };
        Ok((manifest, compression))
    }
}
