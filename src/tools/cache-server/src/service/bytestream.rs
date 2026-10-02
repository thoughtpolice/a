// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use std::sync::Arc;

use dial9::Dial9TokioHandle;
use futures::StreamExt as _;
use tokio_stream::wrappers::ReceiverStream;

use protos::google::bytestream::{
    QueryWriteStatusRequest, QueryWriteStatusResponse, ReadRequest, ReadResponse, WriteRequest,
    WriteResponse, byte_stream_server,
};

use crate::store::{
    CacheStore, Compression, ContentDigest, MAX_BLOB_REASSEMBLE_SIZE, parse_digest_hash,
};

use super::helpers::{
    instrumented_rpc, parse_read_resource_name, parse_write_resource_name, store_error_to_status,
};

const READ_CHUNK_SIZE: usize = 2 * 1024 * 1024; // 2 MiB

/// Response messages a Read queues ahead of the client. Each can hold a
/// different chunk in memory, so for a client that stops reading this (plus
/// the chunks read ahead) is what it pins; reading ahead, not this queue,
/// is what hides the store's latency.
const READ_QUEUE_MESSAGES: usize = 4;

/// Chunks a Read keeps in flight ahead of its client, at most.
const READ_AHEAD_CHUNKS: usize = 8;

/// Chunk data all Reads together may hold ahead of their clients (KiB).
const READ_AHEAD_BUDGET_KIB: usize = 1 << 20;

type ChunkFetch = futures::future::BoxFuture<
    'static,
    (
        crate::store::Result<Option<bytes::Bytes>>,
        u64,
        Option<tokio::sync::OwnedSemaphorePermit>,
    ),
>;

/// The chunks of one Read, in order, read ahead of the client.
///
/// Each Read always has its next chunk in flight; it reads further ahead
/// (up to [`READ_AHEAD_CHUNKS`]) only with room in a budget all Reads
/// share, returned once a chunk is handed on. Clients that stop reading
/// cannot pin more than the budget between them (256 stalled readers of
/// 64 MiB blobs held 10 GiB without it), and cannot hold up anyone else's
/// Read either: at worst it reads one chunk at a time.
pub(crate) struct ChunkReader {
    store: Arc<CacheStore>,
    digest_fn: crate::store::DigestFn,
    chunks: std::iter::Peekable<std::vec::IntoIter<([u8; 32], u64)>>,
    in_flight: futures::stream::FuturesOrdered<ChunkFetch>,
    budget: Arc<tokio::sync::Semaphore>,
}

impl ChunkReader {
    pub(crate) fn new(
        store: Arc<CacheStore>,
        digest_fn: crate::store::DigestFn,
        chunks: Vec<([u8; 32], u64)>,
        budget: Arc<tokio::sync::Semaphore>,
    ) -> Self {
        Self {
            store,
            digest_fn,
            chunks: chunks.into_iter().peekable(),
            in_flight: futures::stream::FuturesOrdered::new(),
            budget,
        }
    }

    /// The next chunk (`None` if missing from the store), its size, and the
    /// share of the budget it holds until dropped.
    pub(crate) async fn next(
        &mut self,
    ) -> Option<(
        crate::store::Result<Option<bytes::Bytes>>,
        u64,
        Option<tokio::sync::OwnedSemaphorePermit>,
    )> {
        while self.in_flight.len() < READ_AHEAD_CHUNKS {
            let Some(&(hash, size)) = self.chunks.peek() else {
                break;
            };
            let share = if self.in_flight.is_empty() {
                None
            } else {
                let kib = u32::try_from(size.div_ceil(1024)).unwrap_or(u32::MAX);
                match self.budget.clone().try_acquire_many_owned(kib) {
                    Ok(share) => Some(share),
                    Err(_) => break,
                }
            };
            self.chunks.next();
            let store = self.store.clone();
            let digest = ContentDigest::new(self.digest_fn, hash);
            self.in_flight.push_back(Box::pin(async move {
                (store.cas_get_chunk(&digest).await, size, share)
            }));
        }
        self.in_flight.next().await
    }
}

// ---------------------------------------------------------------------------------------------------------------------

#[derive(Clone)]
pub struct ByteStreamService {
    store: Arc<CacheStore>,
    handle: Dial9TokioHandle,
    /// The read-ahead budget every Read shares, in KiB.
    read_ahead: Arc<tokio::sync::Semaphore>,
}

impl std::fmt::Debug for ByteStreamService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ByteStreamService")
            .field("store", &self.store)
            .finish_non_exhaustive()
    }
}

impl ByteStreamService {
    pub fn new(store: Arc<CacheStore>, handle: Dial9TokioHandle) -> Self {
        Self {
            store,
            handle,
            read_ahead: Arc::new(tokio::sync::Semaphore::new(READ_AHEAD_BUDGET_KIB)),
        }
    }

    /// Process a sequence of write messages and store the resulting blob.
    ///
    /// Thin wrapper around [`write_core`] that adapts an in-memory iterator
    /// (used by tests) into the stream interface.
    pub(crate) async fn write_from_messages(
        &self,
        messages: impl IntoIterator<Item = WriteRequest>,
    ) -> Result<WriteResponse, tonic::Status> {
        let mut iter = messages.into_iter();
        let first = iter
            .next()
            .ok_or_else(|| tonic::Status::invalid_argument("empty write stream"))?;
        let mut rest = futures::stream::iter(iter.map(Ok));
        self.write_core(first, &mut rest).await
    }

    /// Core write logic shared by both the gRPC handler (streaming) and
    /// `write_from_messages` (iterator-based, used by tests).
    pub(crate) async fn write_core(
        &self,
        first: WriteRequest,
        rest: &mut (impl futures::Stream<Item = Result<WriteRequest, tonic::Status>> + Unpin),
    ) -> Result<WriteResponse, tonic::Status> {
        let mut wire_bytes: i64 = 0;

        if first.resource_name.is_empty() {
            return Err(tonic::Status::invalid_argument(
                "first WriteRequest must contain resource_name",
            ));
        }
        if first.write_offset != 0 {
            return Err(tonic::Status::invalid_argument(
                "resumable writes are not supported; write_offset must be 0",
            ));
        }
        let parsed = parse_write_resource_name(&first.resource_name)?;

        if parsed.size as u64 > MAX_BLOB_REASSEMBLE_SIZE as u64 {
            return Err(tonic::Status::invalid_argument(format!(
                "declared size {} exceeds limit {}",
                parsed.size, MAX_BLOB_REASSEMBLE_SIZE
            )));
        }

        telemetry::wide!("blob.digest", parsed.hash.clone());
        telemetry::wide!("blob.size_bytes", parsed.size);
        telemetry::wide!(
            "compression.client",
            if parsed.compressor != Compression::Identity {
                "zstd"
            } else {
                "identity"
            }
        );

        let hash = parse_digest_hash(&parsed.hash).ok_or_else(|| {
            tonic::Status::invalid_argument(format!("invalid digest hash: {}", parsed.hash))
        })?;
        let expected_cd = ContentDigest::new(parsed.digest_fn, hash);

        // Already stored (with enough of its TTL left): say so now rather
        // than take in the rest. REAPI has the server answer at once in that
        // case, with the full size for an uncompressed upload and -1 for a
        // compressed one, and the client stop sending.
        if self
            .store
            .cas_blob_fresh(&expected_cd)
            .await
            .map_err(store_error_to_status)?
        {
            telemetry::wide!("blob.already_stored", true);
            return Ok(WriteResponse {
                committed_size: if parsed.compressor == Compression::Identity {
                    parsed.size
                } else {
                    -1
                },
            });
        }

        let decompressor_limit = (parsed.size as usize).min(MAX_BLOB_REASSEMBLE_SIZE);
        let mut decompressor = if parsed.compressor != Compression::Identity {
            Some(
                parsed
                    .compressor
                    .streaming_decompressor(decompressor_limit)
                    .map_err(store_error_to_status)?,
            )
        } else {
            None
        };

        let mut writer = self
            .store
            .cas_blob_writer(parsed.digest_fn, Compression::Identity);

        wire_bytes = wire_bytes
            .checked_add(first.data.len() as i64)
            .ok_or_else(|| tonic::Status::invalid_argument("write size overflow"))?;
        match decompressor.as_mut() {
            Some(dec) => {
                let decompressed = dec.write(&first.data).map_err(store_error_to_status)?;
                if !decompressed.is_empty() {
                    writer
                        .write(&decompressed)
                        .await
                        .map_err(store_error_to_status)?;
                }
            }
            None => {
                if !first.data.is_empty() {
                    writer
                        .write(&first.data)
                        .await
                        .map_err(store_error_to_status)?;
                }
            }
        }

        while let Some(msg_result) = rest.next().await {
            let msg = msg_result?;
            if msg.write_offset != wire_bytes {
                return Err(tonic::Status::invalid_argument(format!(
                    "write_offset mismatch: expected {wire_bytes}, got {}",
                    msg.write_offset
                )));
            }
            wire_bytes = wire_bytes
                .checked_add(msg.data.len() as i64)
                .ok_or_else(|| tonic::Status::invalid_argument("write size overflow"))?;
            match decompressor.as_mut() {
                Some(dec) => {
                    let decompressed = dec.write(&msg.data).map_err(store_error_to_status)?;
                    if !decompressed.is_empty() {
                        writer
                            .write(&decompressed)
                            .await
                            .map_err(store_error_to_status)?;
                    }
                }
                None => {
                    if !msg.data.is_empty() {
                        writer
                            .write(&msg.data)
                            .await
                            .map_err(store_error_to_status)?;
                    }
                }
            }
        }

        if let Some(dec) = decompressor {
            let remaining = dec.finish().map_err(store_error_to_status)?;
            if !remaining.is_empty() {
                writer
                    .write(&remaining)
                    .await
                    .map_err(store_error_to_status)?;
            }
        }

        if writer.bytes_written() as i64 != parsed.size {
            return Err(tonic::Status::invalid_argument(format!(
                "size mismatch: expected {}, got {}",
                parsed.size,
                writer.bytes_written()
            )));
        }

        writer
            .finalize_verified(&expected_cd)
            .await
            .map_err(store_error_to_status)?;

        telemetry::wide!("wire.bytes", wire_bytes);
        let m = telemetry::metrics();
        let svc_attr = telemetry::KeyValue::new("service", "bytestream");
        m.bytes_written.add(parsed.size as u64, &[svc_attr.clone()]);
        m.blob_size.record(parsed.size as u64, &[svc_attr]);

        Ok(WriteResponse {
            committed_size: wire_bytes,
        })
    }
}

/// The longest a Write's unread remainder is drained after its answer.
const DRAIN_LIMIT: std::time::Duration = std::time::Duration::from_secs(10);

/// Read and discard what is left of a Write's request stream, for at most
/// [`DRAIN_LIMIT`].
///
/// A Write can be answered before the client has sent everything (the blob
/// was already stored, or the request is bad). Dropping the stream then
/// would make HTTP/2 reset it, and the client's frames already in flight
/// would arrive for a stream the server has forgotten (h2 remembers 50
/// resets, for a second). h2 answers each with a reset of its own and counts
/// those against a per-connection limit (1024, against "MadeYouReset"
/// floods), past which it closes the connection with every other request
/// on it. Reading the stream to its end instead resets nothing; clients stop
/// sending once they have the answer, so there is little left to read.
fn drain_in_background(handle: &Dial9TokioHandle, mut stream: tonic::Streaming<WriteRequest>) {
    handle.spawn(async move {
        let drain = async { while let Ok(Some(_)) = stream.message().await {} };
        let _ = tokio::time::timeout(DRAIN_LIMIT, drain).await;
    });
}

#[tonic::async_trait]
impl byte_stream_server::ByteStream for ByteStreamService {
    type ReadStream = ReceiverStream<Result<ReadResponse, tonic::Status>>;

    async fn read(
        &self,
        req: tonic::Request<ReadRequest>,
    ) -> Result<tonic::Response<Self::ReadStream>, tonic::Status> {
        let store = self.store.clone();
        let handle = self.handle.clone();
        let read_ahead = self.read_ahead.clone();
        instrumented_rpc("bytestream.read", async move {
            let inner = req.into_inner();
            let parsed = parse_read_resource_name(&inner.resource_name)?;

            telemetry::wide!("blob.digest", parsed.hash.clone());
            telemetry::wide!("blob.size_bytes", parsed.size);
            telemetry::wide!(
                "compression.requested",
                if parsed.compressor != Compression::Identity {
                    "zstd"
                } else {
                    "identity"
                }
            );

            if inner.read_offset < 0 {
                return Err(tonic::Status::invalid_argument(format!(
                    "read_offset must be non-negative, got {}",
                    inner.read_offset
                )));
            }
            if inner.read_limit < 0 {
                return Err(tonic::Status::invalid_argument(format!(
                    "read_limit must be non-negative, got {}",
                    inner.read_limit
                )));
            }

            if parsed.compressor != Compression::Identity && inner.read_limit > 0 {
                return Err(tonic::Status::invalid_argument(
                    "read_limit must be 0 for compressed-blobs reads",
                ));
            }
            if parsed.compressor != Compression::Identity && inner.read_offset > 0 {
                return Err(tonic::Status::invalid_argument(
                    "read_offset must be 0 for compressed-blobs reads",
                ));
            }

            let hash = parse_digest_hash(&parsed.hash).ok_or_else(|| {
                tonic::Status::invalid_argument(format!("invalid digest hash: {}", parsed.hash))
            })?;
            let cd = ContentDigest::new(parsed.digest_fn, hash);

            let (manifest, _compression) = store
                .cas_get_manifest(&cd)
                .await
                .map_err(store_error_to_status)?
                .ok_or_else(|| tonic::Status::not_found("blob not found"))?;

            let total_blob_size: u64 = manifest.chunks.iter().map(|ci| ci.size).sum();
            if inner.read_offset as u64 > total_blob_size {
                return Err(tonic::Status::out_of_range(format!(
                    "read_offset {} exceeds blob size {total_blob_size}",
                    inner.read_offset,
                )));
            }

            let offset = inner.read_offset as usize;
            let limit = if inner.read_limit > 0 {
                inner.read_limit as usize
            } else {
                usize::MAX
            };

            let chunk_specs: Vec<([u8; 32], u64)> = manifest
                .chunks
                .iter()
                .map(|ci| (ci.hash, ci.size))
                .collect();
            let digest_fn = parsed.digest_fn;
            let compressor = parsed.compressor;
            let (tx, rx) = tokio::sync::mpsc::channel(READ_QUEUE_MESSAGES);
            let read_ahead = read_ahead.clone();

            handle.spawn(async move {
                let m = telemetry::metrics();
                let svc_attr = telemetry::KeyValue::new("service", "bytestream");

                if compressor != Compression::Identity {
                    // Stream compressed reads per-chunk: compress each chunk
                    // independently and send compressed frames. Zstd frames are
                    // concatenable so the client decoder handles multi-frame
                    // streams transparently. Peak memory is O(prefetch * max_chunk)
                    // instead of O(blob).
                    let mut total_read: u64 = 0;
                    let mut chunks = ChunkReader::new(store, digest_fn, chunk_specs, read_ahead);

                    while let Some((result, _chunk_size, _ahead)) = chunks.next().await {
                        let chunk_data = match result {
                            Ok(Some(d)) => d,
                            Ok(None) => {
                                let _ = tx
                                    .send(Err(tonic::Status::not_found(
                                        "blob data incomplete: chunk missing from storage",
                                    )))
                                    .await;
                                return;
                            }
                            Err(e) => {
                                let _ = tx.send(Err(store_error_to_status(e))).await;
                                return;
                            }
                        };
                        total_read += chunk_data.len() as u64;

                        let compressed = match compressor.compress_async(chunk_data).await {
                            Ok(c) => c,
                            Err(e) => {
                                let _ = tx
                                    .send(Err(tonic::Status::internal(format!(
                                        "compression error: {e}"
                                    ))))
                                    .await;
                                return;
                            }
                        };

                        let mut pos = 0;
                        while pos < compressed.len() {
                            let end = (pos + READ_CHUNK_SIZE).min(compressed.len());
                            let chunk = compressed.slice(pos..end);
                            if tx.send(Ok(ReadResponse { data: chunk })).await.is_err() {
                                return;
                            }
                            pos = end;
                        }
                    }

                    m.bytes_read.add(total_read, &[svc_attr]);
                } else {
                    // Skip chunks entirely before read_offset to avoid
                    // unnecessary fetches, then read the rest ahead.
                    let mut pre_skip_pos: usize = 0;
                    let relevant_chunks: Vec<_> = chunk_specs
                        .into_iter()
                        .filter(|&(_hash, chunk_size)| {
                            if let Some(end) = pre_skip_pos.checked_add(chunk_size as usize) {
                                if end <= offset {
                                    pre_skip_pos = end;
                                    return false;
                                }
                            }
                            true
                        })
                        .collect();
                    let mut global_pos = pre_skip_pos;
                    let mut bytes_remaining = limit;
                    let mut total_sent: u64 = 0;

                    let mut chunks =
                        ChunkReader::new(store, digest_fn, relevant_chunks, read_ahead);

                    while let Some((result, chunk_size, _ahead)) = chunks.next().await {
                        let chunk_end = match global_pos.checked_add(chunk_size as usize) {
                            Some(v) => v,
                            None => {
                                let _ = tx
                                    .send(Err(tonic::Status::internal("chunk offset overflow")))
                                    .await;
                                return;
                            }
                        };

                        let chunk_data = match result {
                            Ok(Some(d)) => d,
                            Ok(None) => {
                                let _ = tx
                                    .send(Err(tonic::Status::not_found(
                                        "blob data incomplete: chunk missing from storage",
                                    )))
                                    .await;
                                return;
                            }
                            Err(e) => {
                                let _ = tx.send(Err(store_error_to_status(e))).await;
                                return;
                            }
                        };

                        let skip = if global_pos < offset {
                            (offset - global_pos).min(chunk_data.len())
                        } else {
                            0
                        };
                        let usable = chunk_data.len().saturating_sub(skip).min(bytes_remaining);
                        let usable_end = skip + usable;
                        let to_send = usable;

                        let mut pos = skip;
                        while pos < usable_end {
                            let end = (pos + READ_CHUNK_SIZE).min(usable_end);
                            let sub = chunk_data.slice(pos..end);
                            if tx.send(Ok(ReadResponse { data: sub })).await.is_err() {
                                return;
                            }
                            pos = end;
                        }

                        total_sent += to_send as u64;
                        bytes_remaining -= to_send;
                        if bytes_remaining == 0 {
                            break;
                        }
                        global_pos = chunk_end;
                    }

                    m.bytes_read.add(total_sent, &[svc_attr]);
                }
            });

            Ok(tonic::Response::new(ReceiverStream::new(rx)))
        })
        .await
    }

    #[tracing::instrument(skip(self, req))]
    async fn write(
        &self,
        req: tonic::Request<tonic::Streaming<WriteRequest>>,
    ) -> Result<tonic::Response<WriteResponse>, tonic::Status> {
        let svc = self.clone();
        instrumented_rpc("bytestream.write", async move {
            let mut stream = req.into_inner();
            let first = stream
                .message()
                .await?
                .ok_or_else(|| tonic::Status::invalid_argument("empty write stream"))?;
            let result = svc.write_core(first, &mut stream).await;
            drain_in_background(&svc.handle, stream);
            Ok(tonic::Response::new(result?))
        })
        .await
    }

    #[tracing::instrument(skip(self, _req))]
    async fn query_write_status(
        &self,
        _req: tonic::Request<QueryWriteStatusRequest>,
    ) -> Result<tonic::Response<QueryWriteStatusResponse>, tonic::Status> {
        instrumented_rpc("bytestream.query_write_status", async {
            Err(tonic::Status::unimplemented(
                "resumable writes are not supported",
            ))
        })
        .await
    }
}

// ---------------------------------------------------------------------------------------------------------------------
