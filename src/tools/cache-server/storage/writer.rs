// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Streaming blob writer for building CAS blobs incrementally.

use bytes::BytesMut;
use slatedb::WriteBatch;
use tracing::{debug, instrument};

use super::compression::Compression;
use super::error::{Result, StoreError};
use super::hashing::{ContentDigest, DigestFn, IncrementalHasher};
use super::manifest::{BlobManifest, ChunkInfo, unix_now_secs};
use super::{
    CDC_AVG_SIZE, CDC_MAX_SIZE, CDC_MIN_SIZE, CacheStore, MAX_BLOB_REASSEMBLE_SIZE, PREFIX_CHUNK,
    PREFIX_MANIFEST, SMALL_BLOB_THRESHOLD, compress_and_batch_chunks, prefixed_key, tagged_chunk,
};

/// Streaming writer that builds a CAS blob incrementally from arbitrary-sized pieces.
///
/// Internally accumulates data, runs FastCDC when the buffer is large enough,
/// and writes complete chunks to a `WriteBatch`. On [`finalize`](Self::finalize),
/// the remaining buffer is flushed as the final chunk, the manifest is written,
/// and the entire batch is committed atomically.
pub struct CasBlobWriter<'a> {
    store: &'a CacheStore,
    pub(crate) digest_fn: DigestFn,
    pub(crate) compression: Compression,
    hasher: IncrementalHasher,
    buffer: BytesMut,
    chunk_infos: Vec<ChunkInfo>,
    batch: WriteBatch,
    bytes_written: usize,
}

impl<'a> CasBlobWriter<'a> {
    pub(crate) fn new(
        store: &'a CacheStore,
        digest_fn: DigestFn,
        compression: Compression,
    ) -> Self {
        CasBlobWriter {
            store,
            digest_fn,
            compression,
            hasher: IncrementalHasher::new(digest_fn, 0),
            buffer: BytesMut::new(),
            chunk_infos: Vec::new(),
            batch: WriteBatch::new(),
            bytes_written: 0,
        }
    }

    /// Total bytes written so far.
    pub fn bytes_written(&self) -> usize {
        self.bytes_written
    }

    /// Append data to the writer. Runs CDC chunking when the buffer exceeds
    /// `CDC_MAX_SIZE * 2`, extracting all complete chunks and retaining the
    /// unprocessed tail.
    pub async fn write(&mut self, data: &[u8]) -> Result<()> {
        self.hasher.update(data);
        self.buffer.extend_from_slice(data);
        self.bytes_written += data.len();

        if self.bytes_written > MAX_BLOB_REASSEMBLE_SIZE {
            return Err(StoreError::BlobTooLarge {
                size: self.bytes_written,
                limit: MAX_BLOB_REASSEMBLE_SIZE,
            });
        }

        // Run CDC when buffer is large enough to produce complete chunks
        while self.buffer.len() >= CDC_MAX_SIZE * 2 {
            self.extract_chunks().await?;
        }
        Ok(())
    }

    /// Process the buffer through FastCDC, writing complete chunks to the batch
    /// and retaining the unprocessed tail.
    async fn extract_chunks(&mut self) -> Result<()> {
        let chunker = fastcdc::v2020::FastCDC::with_level(
            &self.buffer,
            CDC_MIN_SIZE,
            CDC_AVG_SIZE,
            CDC_MAX_SIZE,
            fastcdc::v2020::Normalization::Level2,
        );

        let mut last_end = 0;
        let mut pending_chunks = Vec::new();
        for chunk in chunker {
            let end = chunk.offset + chunk.length;
            // Only take chunks that are fully within the buffer (not the tail)
            if end > self.buffer.len().saturating_sub(CDC_MAX_SIZE) {
                break;
            }
            pending_chunks.push((chunk.offset, end, chunk.length));
            last_end = end;
        }

        if last_end > 0 {
            // O(1) split — no memmove of the tail
            let consumed = self.buffer.split_to(last_end).freeze();

            let ranges: Vec<_> = pending_chunks
                .iter()
                .map(|&(offset, _end, length)| (offset, length))
                .collect();
            let new_chunks = compress_and_batch_chunks(
                &consumed,
                &ranges,
                self.digest_fn,
                self.compression,
                &mut self.batch,
            )
            .await?;
            self.chunk_infos.extend(new_chunks);
        }
        Ok(())
    }

    /// Internal finalize: flush remaining buffer, compute hash, optionally verify
    /// against `expected`, write manifest, and commit.
    async fn finalize_inner(
        mut self,
        expected: Option<&ContentDigest>,
    ) -> Result<(ContentDigest, usize)> {
        let total_bytes = self.bytes_written;

        if total_bytes > MAX_BLOB_REASSEMBLE_SIZE {
            return Err(StoreError::BlobTooLarge {
                size: total_bytes,
                limit: MAX_BLOB_REASSEMBLE_SIZE,
            });
        }

        // Empty blob (0 bytes written): skip chunk processing entirely.
        // The manifest will have an empty chunk list, which cas_get_blob
        // handles by returning empty Bytes. Hash verification and manifest
        // creation proceed normally below.
        if !self.buffer.is_empty() {
            if total_bytes < SMALL_BLOB_THRESHOLD {
                // Small blob: single chunk, no CDC
                let chunk_hash = self.digest_fn.hash_data(&self.buffer);
                let buf_size = self.buffer.len() as u64;
                let compressed = self
                    .compression
                    .compress_async(std::mem::take(&mut self.buffer).freeze())
                    .await?;
                let tagged = tagged_chunk(self.compression, &compressed);
                let chunk_key = prefixed_key(PREFIX_CHUNK, self.digest_fn, &chunk_hash);
                self.batch.put(chunk_key, tagged.as_ref());
                self.chunk_infos.push(ChunkInfo {
                    hash: chunk_hash,
                    size: buf_size,
                });
            } else {
                // Run CDC on the remaining buffer: collect chunk ranges first,
                // then convert buffer to Bytes for zero-copy slicing.
                let chunker = fastcdc::v2020::FastCDC::with_level(
                    &self.buffer,
                    CDC_MIN_SIZE,
                    CDC_AVG_SIZE,
                    CDC_MAX_SIZE,
                    fastcdc::v2020::Normalization::Level2,
                );
                let chunk_ranges: Vec<_> = chunker.map(|c| (c.offset, c.length)).collect();
                let buffer_bytes = std::mem::take(&mut self.buffer).freeze();

                let new_chunks = compress_and_batch_chunks(
                    &buffer_bytes,
                    &chunk_ranges,
                    self.digest_fn,
                    self.compression,
                    &mut self.batch,
                )
                .await?;
                self.chunk_infos.extend(new_chunks);
            }
        }

        let blob_hash = self.hasher.finalize();

        if let Some(exp) = expected {
            if blob_hash != exp.hash {
                return Err(StoreError::DigestMismatch {
                    expected: hex::encode(exp.hash),
                    actual: hex::encode(blob_hash),
                });
            }
        }

        let manifest = BlobManifest {
            chunks: self.chunk_infos,
            created_at: unix_now_secs(),
        };
        let manifest_key = prefixed_key(PREFIX_MANIFEST, self.digest_fn, &blob_hash);
        self.batch
            .put(manifest_key, manifest.to_bytes(self.compression)?);
        self.store.db.write(self.batch).await?;

        debug!(
            total_bytes,
            chunk_count = manifest.chunks.len(),
            "blob writer finalized"
        );

        Ok((ContentDigest::new(self.digest_fn, blob_hash), total_bytes))
    }

    /// Finalize the writer: process remaining buffer as final chunk(s), write the
    /// manifest, and commit the batch atomically.
    ///
    /// Returns `(digest, total_bytes)` where `digest` is the whole-blob digest.
    #[instrument(skip(self), fields(%self.digest_fn, %self.compression))]
    pub async fn finalize(self) -> Result<(ContentDigest, usize)> {
        self.finalize_inner(None).await
    }

    /// Like [`finalize`](Self::finalize), but verifies the computed hash matches
    /// `expected` before committing. Returns [`StoreError::DigestMismatch`]
    /// without committing if they differ.
    #[instrument(skip(self), fields(%self.digest_fn, %self.compression, %expected))]
    pub async fn finalize_verified(
        self,
        expected: &ContentDigest,
    ) -> Result<(ContentDigest, usize)> {
        self.finalize_inner(Some(expected)).await
    }
}
