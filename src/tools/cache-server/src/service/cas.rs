// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use std::sync::Arc;

use bytes::Bytes;
use dial9::Dial9TokioHandle;
use futures::{StreamExt as _, TryStreamExt as _};
use prost::Message;
use tokio_stream::wrappers::ReceiverStream;

use protos::build::bazel::remote::execution::v2::{
    BatchReadBlobsRequest, BatchReadBlobsResponse, BatchUpdateBlobsRequest,
    BatchUpdateBlobsResponse, Digest, Directory, FindMissingBlobsRequest, FindMissingBlobsResponse,
    GetTreeRequest, GetTreeResponse, SpliceBlobRequest, SpliceBlobResponse, SplitBlobRequest,
    SplitBlobResponse, batch_read_blobs_response, batch_update_blobs_response,
    content_addressable_storage_server,
};

use crate::store::{
    CacheStore, Compression, ContentDigest, MAX_BLOB_REASSEMBLE_SIZE, MAX_MANIFEST_CHUNK_COUNT,
};

use super::helpers::{
    MAX_BATCH_TOTAL_SIZE, get_blob, instrumented_rpc, parse_and_validate_digest,
    parse_and_validate_digest_ref, resolve_digest_function, rpc_status, rpc_status_ok,
    store_error_to_status, validate_blob_data,
};

const MAX_BATCH_DIGESTS: usize = 10_000;

// ---------------------------------------------------------------------------------------------------------------------

#[derive(Clone)]
pub struct ContentAddressableStorageService {
    store: Arc<CacheStore>,
    handle: Dial9TokioHandle,
}

impl std::fmt::Debug for ContentAddressableStorageService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ContentAddressableStorageService")
            .field("store", &self.store)
            .finish_non_exhaustive()
    }
}

impl ContentAddressableStorageService {
    pub fn new(store: Arc<CacheStore>, handle: Dial9TokioHandle) -> Self {
        Self { store, handle }
    }
}

#[tonic::async_trait]
impl content_addressable_storage_server::ContentAddressableStorage
    for ContentAddressableStorageService
{
    #[tracing::instrument(skip(self, req))]
    async fn find_missing_blobs(
        &self,
        req: tonic::Request<FindMissingBlobsRequest>,
    ) -> Result<tonic::Response<FindMissingBlobsResponse>, tonic::Status> {
        let store = self.store.clone();
        instrumented_rpc("cas.find_missing_blobs", async move {
            let inner = req.into_inner();
            let digest_fn = resolve_digest_function(inner.digest_function)?;

            if inner.blob_digests.len() > MAX_BATCH_DIGESTS {
                return Err(tonic::Status::invalid_argument(format!(
                    "too many digests: {} exceeds limit {MAX_BATCH_DIGESTS}",
                    inner.blob_digests.len(),
                )));
            }

            let blob_count = inner.blob_digests.len() as i64;
            telemetry::wide!("batch.blob_count", blob_count);

            // Parse all digests upfront so a malformed digest fails the
            // entire request before any I/O.
            let parsed: Vec<_> = inner
                .blob_digests
                .into_iter()
                .map(|pd| {
                    let cd = parse_and_validate_digest_ref(&pd, digest_fn)?;
                    Ok((cd, pd))
                })
                .collect::<Result<Vec<_>, tonic::Status>>()?;

            let missing: Vec<_> = futures::stream::iter(parsed)
                .map(move |(cd, proto_digest)| {
                    let store = store.clone();
                    async move {
                        match store.cas_blob_exists(&cd).await {
                            Ok(false) => Ok(Some(proto_digest)),
                            Ok(true) => Ok(None),
                            Err(e) => Err(store_error_to_status(e)),
                        }
                    }
                })
                .buffered(64)
                .try_filter_map(|opt| async { Ok(opt) })
                .try_collect()
                .await?;

            let missing_count = missing.len() as i64;
            let hit_count = blob_count - missing_count;
            telemetry::wide!("batch.missing_count", missing_count);

            let m = telemetry::metrics();
            let svc_attr = telemetry::KeyValue::new("service", "cas");
            if hit_count > 0 {
                m.cache_hits.add(hit_count as u64, &[svc_attr.clone()]);
            }
            if missing_count > 0 {
                m.cache_misses.add(missing_count as u64, &[svc_attr]);
            }

            Ok(tonic::Response::new(FindMissingBlobsResponse {
                missing_blob_digests: missing,
            }))
        })
        .await
    }

    #[tracing::instrument(skip(self, req))]
    async fn batch_update_blobs(
        &self,
        req: tonic::Request<BatchUpdateBlobsRequest>,
    ) -> Result<tonic::Response<BatchUpdateBlobsResponse>, tonic::Status> {
        let store = self.store.clone();
        instrumented_rpc("cas.batch_update_blobs", async move {
            let inner = req.into_inner();
            let digest_fn = resolve_digest_function(inner.digest_function)?;

            if inner.requests.len() > MAX_BATCH_DIGESTS {
                return Err(tonic::Status::invalid_argument(format!(
                    "too many requests: {} exceeds limit {MAX_BATCH_DIGESTS}",
                    inner.requests.len(),
                )));
            }

            let blob_count = inner.requests.len() as i64;
            let total_size: i64 = inner
                .requests
                .iter()
                .try_fold(0i64, |acc, r| acc.checked_add(r.data.len() as i64))
                .ok_or_else(|| tonic::Status::invalid_argument("total batch size overflowed"))?;
            telemetry::wide!("batch.blob_count", blob_count);
            telemetry::wide!("batch.total_bytes", total_size);

            if total_size > MAX_BATCH_TOTAL_SIZE {
                return Err(tonic::Status::invalid_argument(format!(
                    "total batch size {total_size} exceeds limit {MAX_BATCH_TOTAL_SIZE}"
                )));
            }

            let m = telemetry::metrics();
            let svc_attr = telemetry::KeyValue::new("service", "cas");

            let responses: Vec<_> = futures::stream::iter(inner.requests.into_iter())
                .map(|upload_req| {
                    let store = store.clone();
                    let m = m.clone();
                    let svc_attr = svc_attr.clone();
                    async move {
                        let compressor = match Compression::from_proto_i32(upload_req.compressor) {
                            Some(c) => c,
                            None => {
                                return batch_update_blobs_response::Response {
                                    digest: upload_req.digest.clone(),
                                    status: Some(rpc_status(
                                        tonic::Code::InvalidArgument as i32,
                                        format!(
                                            "unsupported compressor: {}",
                                            upload_req.compressor
                                        ),
                                    )),
                                };
                            }
                        };

                        let data: Bytes = if compressor != Compression::Identity {
                            let size_hint = upload_req
                                .digest
                                .as_ref()
                                .map(|d| {
                                    if d.size_bytes > 0 {
                                        d.size_bytes as usize
                                    } else {
                                        0
                                    }
                                })
                                .unwrap_or(0)
                                .min(MAX_BLOB_REASSEMBLE_SIZE);
                            match compressor.decompress_with_size_hint(&upload_req.data, size_hint)
                            {
                                Ok(d) => Bytes::from(d.into_owned()),
                                Err(e) => {
                                    return batch_update_blobs_response::Response {
                                        digest: upload_req.digest.clone(),
                                        status: Some(rpc_status(
                                            tonic::Code::InvalidArgument as i32,
                                            format!("decompression error: {e}"),
                                        )),
                                    };
                                }
                            }
                        } else {
                            upload_req.data
                        };

                        let result = validate_blob_data(&upload_req.digest, &data, digest_fn);
                        match result {
                            Ok(cd) => {
                                let data_len = data.len() as u64;
                                m.blob_size.record(data_len, &[svc_attr.clone()]);
                                match store.cas_put_blob(&cd, data, Compression::Identity).await {
                                    Ok(()) => {
                                        m.bytes_written.add(data_len, &[svc_attr.clone()]);
                                        batch_update_blobs_response::Response {
                                            digest: upload_req.digest.clone(),
                                            status: Some(rpc_status_ok()),
                                        }
                                    }
                                    Err(e) => {
                                        let status = store_error_to_status(e);
                                        batch_update_blobs_response::Response {
                                            digest: upload_req.digest.clone(),
                                            status: Some(rpc_status(
                                                status.code() as i32,
                                                status.message(),
                                            )),
                                        }
                                    }
                                }
                            }
                            Err(status) => batch_update_blobs_response::Response {
                                digest: upload_req.digest.clone(),
                                status: Some(rpc_status(
                                    tonic::Code::InvalidArgument as i32,
                                    status.message(),
                                )),
                            },
                        }
                    }
                })
                .buffered(32)
                .collect()
                .await;

            Ok(tonic::Response::new(BatchUpdateBlobsResponse { responses }))
        })
        .await
    }

    async fn batch_read_blobs(
        &self,
        req: tonic::Request<BatchReadBlobsRequest>,
    ) -> Result<tonic::Response<BatchReadBlobsResponse>, tonic::Status> {
        let store = self.store.clone();
        instrumented_rpc("cas.batch_read_blobs", async move {
            let inner = req.into_inner();
            let digest_fn = resolve_digest_function(inner.digest_function)?;

            if inner.digests.len() > MAX_BATCH_DIGESTS {
                return Err(tonic::Status::invalid_argument(format!(
                    "too many digests: {} exceeds limit {MAX_BATCH_DIGESTS}",
                    inner.digests.len(),
                )));
            }

            let blob_count = inner.digests.len() as i64;
            telemetry::wide!("batch.blob_count", blob_count);

            let total_size: i64 = inner
                .digests
                .iter()
                .try_fold(0i64, |acc, d| acc.checked_add(d.size_bytes))
                .ok_or_else(|| tonic::Status::invalid_argument("total batch size overflowed"))?;
            if total_size > MAX_BATCH_TOTAL_SIZE {
                return Err(tonic::Status::invalid_argument(format!(
                    "total batch size {total_size} exceeds limit {MAX_BATCH_TOTAL_SIZE}"
                )));
            }

            let response_compressor = inner
                .acceptable_compressors
                .iter()
                .find_map(|&v| {
                    let c = Compression::from_proto_i32(v)?;
                    if c == Compression::Zstd {
                        Some(c)
                    } else {
                        None
                    }
                })
                .unwrap_or(Compression::Identity);

            telemetry::wide!(
                "response.compressor",
                if response_compressor != Compression::Identity {
                    "zstd"
                } else {
                    "identity"
                }
            );

            let m = telemetry::metrics();
            let svc_attr = telemetry::KeyValue::new("service", "cas");

            let responses: Vec<_> = futures::stream::iter(inner.digests.into_iter())
                .map(|proto_digest| {
                    let store = store.clone();
                    let m = m.clone();
                    let svc_attr = svc_attr.clone();
                    async move {
                        let cd =
                            match parse_and_validate_digest_ref(&proto_digest, digest_fn) {
                                Ok(cd) => cd,
                                Err(status) => {
                                    return batch_read_blobs_response::Response {
                                        digest: Some(proto_digest),
                                        data: Bytes::new(),
                                        compressor: 0,
                                        status: Some(rpc_status(
                                            tonic::Code::InvalidArgument as i32,
                                            status.message(),
                                        )),
                                    };
                                }
                            };

                        match get_blob(&store, &cd).await {
                            Ok(Some(data)) => {
                                let data_len = data.len() as u64;
                                m.cache_hits.add(1, &[svc_attr.clone()]);
                                m.bytes_read.add(data_len, &[svc_attr.clone()]);
                                m.blob_size.record(data_len, &[svc_attr.clone()]);
                                telemetry::wide_inc!("batch.hit_count");

                                let (resp_data, comp_val) = if response_compressor
                                    != Compression::Identity
                                {
                                    let digest_str = &proto_digest.hash;
                                    match response_compressor.compress_async(data.clone()).await {
                                        Ok(compressed) => {
                                            (compressed, response_compressor.to_proto_i32())
                                        }
                                        Err(e) => {
                                            tracing::warn!(method = "batch_read_blobs", %digest_str, "compression failed: {e}");
                                            return batch_read_blobs_response::Response {
                                                digest: Some(proto_digest.clone()),
                                                data: Bytes::new(),
                                                compressor: 0,
                                                status: Some(rpc_status(
                                                    tonic::Code::Internal as i32,
                                                    format!("response compression failed: {e}"),
                                                )),
                                            };
                                        }
                                    }
                                } else {
                                    (data, 0)
                                };
                                batch_read_blobs_response::Response {
                                    digest: Some(proto_digest),
                                    data: resp_data,
                                    compressor: comp_val,
                                    status: Some(rpc_status_ok()),
                                }
                            }
                            Ok(None) => {
                                m.cache_misses.add(1, &[svc_attr.clone()]);
                                telemetry::wide_inc!("batch.miss_count");
                                batch_read_blobs_response::Response {
                                    digest: Some(proto_digest),
                                    data: Bytes::new(),
                                    compressor: 0,
                                    status: Some(rpc_status(
                                        tonic::Code::NotFound as i32,
                                        "blob not found",
                                    )),
                                }
                            }
                            Err(e) => batch_read_blobs_response::Response {
                                digest: Some(proto_digest),
                                data: Bytes::new(),
                                compressor: 0,
                                status: Some(rpc_status(e.code() as i32, e.message())),
                            },
                        }
                    }
                })
                .buffered(32)
                .collect()
                .await;

            Ok(tonic::Response::new(BatchReadBlobsResponse { responses }))
        })
        .await
    }

    type GetTreeStream = ReceiverStream<Result<GetTreeResponse, tonic::Status>>;

    async fn get_tree(
        &self,
        req: tonic::Request<GetTreeRequest>,
    ) -> Result<tonic::Response<Self::GetTreeStream>, tonic::Status> {
        let store = self.store.clone();
        let handle = self.handle.clone();
        instrumented_rpc("cas.get_tree", async move {
            let inner = req.into_inner();
            let digest_fn = resolve_digest_function(inner.digest_function)?;
            let root_cd = parse_and_validate_digest(&inner.root_digest, digest_fn)?;

            telemetry::wide!("tree.root_digest", hex::encode(root_cd.hash));

            const MAX_TREE_DIRECTORIES: usize = 100_000;
            const MAX_TREE_BYTES: u64 = 256 * 1024 * 1024;

            // Pre-check root exists so missing root returns a proper RPC error
            if !store
                .cas_blob_exists(&root_cd)
                .await
                .map_err(store_error_to_status)?
            {
                return Err(tonic::Status::not_found(format!(
                    "directory blob not found: {root_cd}"
                )));
            }

            // Stream directories as they are decoded instead of
            // accumulating them all in memory first.
            let (tx, rx) = tokio::sync::mpsc::channel(32);
            handle.spawn(async move {
                let mut queue = std::collections::VecDeque::new();
                let mut visited = std::collections::HashSet::new();
                queue.push_back(root_cd.clone());
                visited.insert(root_cd);
                let mut dir_count: usize = 0;
                let mut total_bytes_read: u64 = 0;

                while let Some(dir_digest) = queue.pop_front() {
                    if dir_count >= MAX_TREE_DIRECTORIES {
                        let _ = tx
                            .send(Err(tonic::Status::resource_exhausted(format!(
                                "get_tree exceeded maximum of {MAX_TREE_DIRECTORIES} directories"
                            ))))
                            .await;
                        return;
                    }

                    let data = match get_blob(&store, &dir_digest).await {
                        Ok(Some(d)) => d,
                        Ok(None) => {
                            let _ = tx
                                .send(Err(tonic::Status::not_found(format!(
                                    "directory blob not found: {dir_digest}"
                                ))))
                                .await;
                            return;
                        }
                        Err(e) => {
                            let _ = tx.send(Err(e)).await;
                            return;
                        }
                    };

                    total_bytes_read = match total_bytes_read.checked_add(data.len() as u64) {
                        Some(v) => v,
                        None => {
                            let _ = tx
                                .send(Err(tonic::Status::resource_exhausted(
                                    "get_tree total bytes overflowed u64",
                                )))
                                .await;
                            return;
                        }
                    };
                    if total_bytes_read > MAX_TREE_BYTES {
                        let _ = tx
                            .send(Err(tonic::Status::resource_exhausted(format!(
                                "get_tree response exceeded {MAX_TREE_BYTES} byte limit"
                            ))))
                            .await;
                        return;
                    }

                    let dir = match Directory::decode(data.as_ref()) {
                        Ok(d) => d,
                        Err(e) => {
                            let _ = tx
                                .send(Err(tonic::Status::internal(format!(
                                    "failed to decode directory: {e}"
                                ))))
                                .await;
                            return;
                        }
                    };

                    for sub_dir_node in &dir.directories {
                        if let Some(ref d) = sub_dir_node.digest {
                            if let Some(hash) = crate::store::parse_digest_hash(&d.hash) {
                                let sub_cd = ContentDigest::new(digest_fn, hash);
                                if visited.insert(sub_cd.clone()) {
                                    queue.push_back(sub_cd);
                                }
                            }
                        }
                    }

                    dir_count += 1;
                    if tx
                        .send(Ok(GetTreeResponse {
                            directories: vec![dir],
                            next_page_token: String::new(),
                        }))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }

                telemetry::metrics().bytes_read.add(
                    total_bytes_read,
                    &[telemetry::KeyValue::new("service", "cas")],
                );
            });

            Ok(tonic::Response::new(ReceiverStream::new(rx)))
        })
        .await
    }

    #[tracing::instrument(skip(self, req))]
    async fn split_blob(
        &self,
        req: tonic::Request<SplitBlobRequest>,
    ) -> Result<tonic::Response<SplitBlobResponse>, tonic::Status> {
        let store = self.store.clone();
        instrumented_rpc("cas.split_blob", async move {
            let inner = req.into_inner();
            let digest_fn = resolve_digest_function(inner.digest_function)?;
            let blob_cd = parse_and_validate_digest(&inner.blob_digest, digest_fn)?;

            telemetry::wide!("blob.digest", hex::encode(blob_cd.hash));

            let (manifest, _compression) = store
                .cas_get_manifest(&blob_cd)
                .await
                .map_err(store_error_to_status)?
                .ok_or_else(|| tonic::Status::not_found("blob not found"))?;

            let chunk_digests: Vec<Digest> = manifest
                .chunks
                .iter()
                .map(|ci| Digest {
                    hash: hex::encode(ci.hash),
                    size_bytes: ci.size as i64,
                })
                .collect();

            telemetry::wide!("chunk.count", chunk_digests.len() as i64);

            Ok(tonic::Response::new(SplitBlobResponse {
                chunk_digests,
                chunking_function: 0, // CHUNK_FUNCTION_UNSPECIFIED
            }))
        })
        .await
    }

    #[tracing::instrument(skip(self, req))]
    async fn splice_blob(
        &self,
        req: tonic::Request<SpliceBlobRequest>,
    ) -> Result<tonic::Response<SpliceBlobResponse>, tonic::Status> {
        let store = self.store.clone();
        instrumented_rpc("cas.splice_blob", async move {
            let inner = req.into_inner();
            let digest_fn = resolve_digest_function(inner.digest_function)?;
            let blob_cd = parse_and_validate_digest(&inner.blob_digest, digest_fn)?;
            let chunk_digests = inner.chunk_digests;
            let blob_digest_proto = inner.blob_digest;

            telemetry::wide!("blob.digest", hex::encode(blob_cd.hash));
            telemetry::wide!("chunk.count", chunk_digests.len() as i64);

            if chunk_digests.len() > MAX_MANIFEST_CHUNK_COUNT {
                return Err(tonic::Status::invalid_argument(format!(
                    "too many chunk digests: {} exceeds limit {MAX_MANIFEST_CHUNK_COUNT}",
                    chunk_digests.len(),
                )));
            }

            // If the blob already exists, short-circuit
            if store
                .cas_blob_exists(&blob_cd)
                .await
                .map_err(store_error_to_status)?
            {
                telemetry::wide!("splice.already_existed", true);
                return Ok(tonic::Response::new(SpliceBlobResponse {
                    blob_digest: blob_digest_proto,
                }));
            }
            telemetry::wide!("splice.already_existed", false);

            // Pre-flight size check using claimed sizes to reject obviously
            // oversized requests before fetching any chunks.
            // Reject zero/negative size chunks — they are nonsensical and
            // would create meaningless manifest entries.
            if let Some(bad) = chunk_digests.iter().find(|d| d.size_bytes <= 0) {
                return Err(tonic::Status::invalid_argument(format!(
                    "splice_blob: chunk size_bytes must be positive, got {}",
                    bad.size_bytes
                )));
            }
            let claimed_total: u64 = chunk_digests
                .iter()
                .try_fold(0u64, |acc, d| acc.checked_add(d.size_bytes as u64))
                .ok_or_else(|| {
                    tonic::Status::invalid_argument("splice_blob total size overflowed u64")
                })?;
            if claimed_total > MAX_BLOB_REASSEMBLE_SIZE as u64 {
                return Err(tonic::Status::invalid_argument(format!(
                    "splice total claimed size {} exceeds limit {}",
                    claimed_total, MAX_BLOB_REASSEMBLE_SIZE
                )));
            }

            // Parse all digests upfront (CPU-only, no I/O)
            let parsed: Vec<_> = chunk_digests
                .iter()
                .map(|pd| {
                    let cd = parse_and_validate_digest_ref(pd, digest_fn)?;
                    Ok::<_, tonic::Status>((cd, pd.hash.clone()))
                })
                .collect::<Result<Vec<_>, _>>()?;

            // Fetch all chunks concurrently (up to 32 in-flight)
            let chunk_pairs: Vec<(ContentDigest, Bytes)> = futures::stream::iter(parsed)
                .map(|(chunk_cd, hash_str)| {
                    let store = store.clone();
                    async move {
                        let chunk_data = store
                            .cas_get_chunk(&chunk_cd)
                            .await
                            .map_err(store_error_to_status)?
                            .ok_or_else(|| {
                                tonic::Status::not_found(format!("chunk not found: {}", hash_str))
                            })?;
                        Ok::<_, tonic::Status>((chunk_cd, chunk_data))
                    }
                })
                .buffered(32)
                .collect::<Vec<_>>()
                .await
                .into_iter()
                .collect::<Result<Vec<_>, _>>()?;

            // Verify actual total size after fetching
            let total_bytes: u64 = chunk_pairs
                .iter()
                .try_fold(0u64, |acc, (_, data)| acc.checked_add(data.len() as u64))
                .ok_or_else(|| {
                    tonic::Status::invalid_argument("splice_blob total size overflowed u64")
                })?;
            if total_bytes > MAX_BLOB_REASSEMBLE_SIZE as u64 {
                return Err(tonic::Status::invalid_argument(format!(
                    "splice total size {} exceeds limit {}",
                    total_bytes, MAX_BLOB_REASSEMBLE_SIZE
                )));
            }

            // Splice via the storage layer (atomic verification + write)
            store
                .cas_splice_blob(&blob_cd, chunk_pairs, Compression::Identity)
                .await
                .map_err(store_error_to_status)?;

            telemetry::metrics()
                .bytes_written
                .add(total_bytes, &[telemetry::KeyValue::new("service", "cas")]);

            Ok(tonic::Response::new(SpliceBlobResponse {
                blob_digest: blob_digest_proto,
            }))
        })
        .await
    }
}

// ---------------------------------------------------------------------------------------------------------------------
