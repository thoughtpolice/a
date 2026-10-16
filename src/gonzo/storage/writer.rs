// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Streaming blob writer for building CAS blobs incrementally.

use bytes::BytesMut;
use slatedb::WriteBatch;
use tracing::{debug, instrument};

use super::compression::Compression;
use super::error::{Result, StoreError};
use super::hashing::{ContentDigest, DigestFn, IncrementalHasher};
use super::manifest::{BlobManifest, ChunkInfo, INLINE_BLOB_MAX, unix_now_secs};
use super::{
    CDC_MAX_SIZE, CacheStore, MAX_BLOB_REASSEMBLE_SIZE, PREFIX_CHUNK, PREFIX_MANIFEST,
    SMALL_BLOB_THRESHOLD, cdc_ranges, compress_and_batch_chunks, prefixed_key, tagged_chunk,
};

/// Streaming writer that builds a CAS blob incrementally from arbitrary-sized pieces.
///
/// Internally accumulates data, runs FastCDC when the buffer is large enough,
/// and hands complete chunks to the store every [`WRITE_AHEAD_BYTES`], so a
/// blob of any size holds only a few MiB here; the store's own write
/// backpressure bounds the rest. On [`finalize`](Self::finalize), the
/// remaining buffer is flushed as the final chunk and the manifest written
/// last. The blob exists for readers only once its manifest does, and the
/// manifest is committed (and waited on) after every chunk, so a reader never
/// sees a blob with chunks missing; an upload abandoned partway leaves chunks
/// no manifest names, which expire with the default TTL.
pub struct CasBlobWriter<'a> {
    store: &'a CacheStore,
    pub(crate) digest_fn: DigestFn,
    pub(crate) compression: Compression,
    hasher: IncrementalHasher,
    buffer: BytesMut,
    chunk_infos: Vec<ChunkInfo>,
    batch: WriteBatch,
    /// Chunk bytes in `batch`.
    batch_bytes: usize,
    bytes_written: usize,
}

/// Chunks are handed to the store once this many bytes of them are pending.
pub(crate) const WRITE_AHEAD_BYTES: usize = 8 * 1024 * 1024;

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
            batch_bytes: 0,
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
        let mut last_end = 0;
        let mut ranges = Vec::new();
        for (offset, length) in cdc_ranges(&self.buffer) {
            let end = offset + length;
            // Only take chunks that are fully within the buffer (not the tail)
            if end > self.buffer.len().saturating_sub(CDC_MAX_SIZE) {
                break;
            }
            ranges.push((offset, length));
            last_end = end;
        }

        if last_end > 0 {
            // O(1) split — no memmove of the tail
            let consumed = self.buffer.split_to(last_end).freeze();

            let new_chunks = compress_and_batch_chunks(
                &consumed,
                &ranges,
                self.digest_fn,
                self.compression,
                &mut self.batch,
            )
            .await?;
            self.chunk_infos.extend(new_chunks);
            self.batch_bytes += consumed.len();
            if self.batch_bytes >= WRITE_AHEAD_BYTES {
                self.batch_bytes = 0;
                self.store
                    .write_ahead(std::mem::take(&mut self.batch))
                    .await?;
            }
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

        // A blob small enough is stored in its manifest. It is all still
        // buffered: chunks are cut only from megabytes of buffer.
        let inline = (total_bytes > 0 && total_bytes <= INLINE_BLOB_MAX)
            .then(|| std::mem::take(&mut self.buffer).freeze());
        let blob_hash = self.hasher.finalize();

        // Empty blob (0 bytes written): skip chunk processing entirely.
        // The manifest will have an empty chunk list, which cas_get_blob
        // handles by returning empty Bytes. Hash verification and manifest
        // creation proceed normally below.
        if !self.buffer.is_empty() {
            if total_bytes < SMALL_BLOB_THRESHOLD {
                // Small blob: single chunk, no CDC, the blob itself.
                let chunk_hash = blob_hash;
                let buf_size = self.buffer.len() as u64;
                let compressed = self
                    .compression
                    .compress_async(std::mem::take(&mut self.buffer).freeze())
                    .await?;
                let tagged = tagged_chunk(self.compression, &compressed);
                let chunk_key = prefixed_key(PREFIX_CHUNK, self.digest_fn, &chunk_hash);
                self.batch
                    .put_bytes(bytes::Bytes::copy_from_slice(&chunk_key), tagged);
                self.chunk_infos.push(ChunkInfo {
                    hash: chunk_hash,
                    size: buf_size,
                });
            } else {
                // Run CDC on the remaining buffer: collect chunk ranges first,
                // then convert buffer to Bytes for zero-copy slicing.
                let chunk_ranges: Vec<_> = cdc_ranges(&self.buffer).collect();
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

        if let Some(exp) = expected {
            if blob_hash != exp.hash {
                return Err(StoreError::DigestMismatch {
                    expected: hex::encode(exp.hash),
                    actual: hex::encode(blob_hash),
                });
            }
        }

        let manifest = match inline {
            Some(data) => BlobManifest::inline(blob_hash, data),
            None => BlobManifest {
                chunks: self.chunk_infos,
                created_at: unix_now_secs(),
                inline: None,
            },
        };
        let manifest_key = prefixed_key(PREFIX_MANIFEST, self.digest_fn, &blob_hash);
        self.batch.put_bytes(
            bytes::Bytes::copy_from_slice(&manifest_key),
            manifest.to_bytes(self.compression)?,
        );
        // Durable in order: once the manifest is, so are the chunks written
        // ahead of it.
        let digest = ContentDigest::new(self.digest_fn, blob_hash);
        self.store.commit_blobs(self.batch, [digest]).await?;

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
