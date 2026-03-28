// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Blob manifest serialization: chunk lists with creation metadata.

use std::time::SystemTime;

use bytes::{Buf, BufMut, Bytes, BytesMut};

use super::compression::Compression;
use super::error::{Result, StoreError};

// Maximum number of chunks in a manifest
pub const MAX_MANIFEST_CHUNK_COUNT: usize = 100_000;

/// A single chunk within a blob manifest.
#[derive(Debug)]
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
}

/// Return the current time as unix seconds, or 0 if the clock is unavailable.
pub fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl BlobManifest {
    /// Serialize to V3 binary format:
    /// `[u8 version=3] [u8 compression] [u64 BE created_at] [u32 BE chunk_count] [32-byte hash | u64 BE size] ...`
    pub fn to_bytes(&self, compression: Compression) -> Result<Bytes> {
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

    /// Deserialize from V3 binary format:
    /// `[u8 version=3] [u8 compression] [u64 BE created_at] [u32 BE chunk_count] [32-byte hash | u64 BE size] ...`
    pub fn from_bytes(mut data: Bytes) -> Result<(Self, Compression)> {
        // Minimum: 1 version + 1 compression + 8 created_at + 4 count = 14
        if data.len() < 14 {
            return Err(StoreError::ManifestCorrupted("manifest too short".into()));
        }

        let version = data.get_u8();
        if version != 3 {
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
        Ok((BlobManifest { chunks, created_at }, compression))
    }
}
