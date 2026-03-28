// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use std::future::Future;
use std::sync::Arc;
use std::time::Instant;

use bytes::Bytes;
use tonic::Status;

use crate::store::{
    CacheStore, Compression, ContentDigest, DigestFn, StoreError, parse_digest_hash,
};

/// Maximum total size for batch requests (4 MB).
pub const MAX_BATCH_TOTAL_SIZE: i64 = 4_000_000;

/// Map a [`StoreError`] to an appropriate [`tonic::Status`].
///
/// - `BlobTooLarge` / `DigestMismatch` → `INVALID_ARGUMENT`
/// - Retryable `Database` errors → `UNAVAILABLE`
/// - Everything else → `INTERNAL`
pub fn store_error_to_status(e: StoreError) -> tonic::Status {
    match &e {
        StoreError::BlobTooLarge { .. } | StoreError::DigestMismatch { .. } => {
            tonic::Status::invalid_argument(e.to_string())
        }
        StoreError::ChunkMissing { .. } => tonic::Status::not_found(e.to_string()),
        StoreError::Database(_) if e.is_retryable() => tonic::Status::unavailable(e.to_string()),
        _ => tonic::Status::internal(format!("storage error: {e}")),
    }
}

/// Resolve a `digest_function` proto i32 to a [`DigestFn`].
///
/// Proto value 0 (UNKNOWN) is treated as SHA-256 for backward compatibility.
pub fn resolve_digest_function(v: i32) -> Result<DigestFn, Status> {
    if v == 0 {
        return Ok(DigestFn::Sha256);
    }
    DigestFn::from_proto_i32(v)
        .ok_or_else(|| Status::invalid_argument(format!("unsupported digest function: {v}")))
}

/// Validate and parse an `Option<Digest>` proto into a [`ContentDigest`].
pub fn parse_and_validate_digest(
    digest: &Option<protos::build::bazel::remote::execution::v2::Digest>,
    digest_fn: DigestFn,
) -> Result<ContentDigest, Status> {
    let d = digest
        .as_ref()
        .ok_or_else(|| Status::invalid_argument("missing digest"))?;
    parse_and_validate_digest_ref(d, digest_fn)
}

/// Validate and parse a `Digest` proto reference into a [`ContentDigest`].
pub fn parse_and_validate_digest_ref(
    digest: &protos::build::bazel::remote::execution::v2::Digest,
    digest_fn: DigestFn,
) -> Result<ContentDigest, Status> {
    if digest.size_bytes < 0 {
        return Err(Status::invalid_argument(format!(
            "size_bytes must be non-negative, got {}",
            digest.size_bytes
        )));
    }
    let hash = parse_digest_hash(&digest.hash)
        .ok_or_else(|| Status::invalid_argument(format!("invalid digest hash: {}", digest.hash)))?;
    Ok(ContentDigest::new(digest_fn, hash))
}

/// Validate blob data: check hash and size match the claimed digest.
pub fn validate_blob_data(
    digest: &Option<protos::build::bazel::remote::execution::v2::Digest>,
    data: &[u8],
    digest_fn: DigestFn,
) -> Result<ContentDigest, Status> {
    let d = digest
        .as_ref()
        .ok_or_else(|| Status::invalid_argument("missing digest"))?;
    let hash = parse_digest_hash(&d.hash)
        .ok_or_else(|| Status::invalid_argument(format!("invalid digest hash: {}", d.hash)))?;

    if d.size_bytes != data.len() as i64 {
        return Err(Status::invalid_argument(format!(
            "size mismatch: expected {}, got {}",
            d.size_bytes,
            data.len()
        )));
    }

    let computed = digest_fn.hash_data(data);
    if computed != hash {
        return Err(Status::invalid_argument(format!(
            "digest mismatch: expected {}, got {}",
            hex::encode(hash),
            hex::encode(computed)
        )));
    }

    Ok(ContentDigest::new(digest_fn, hash))
}

/// Build a `google.rpc.Status` proto with the given code and message.
pub fn rpc_status(code: i32, msg: impl Into<String>) -> protos::google::rpc::Status {
    protos::google::rpc::Status {
        code,
        message: msg.into(),
        details: vec![],
    }
}

/// Build a `google.rpc.Status` proto representing OK.
pub fn rpc_status_ok() -> protos::google::rpc::Status {
    rpc_status(0, "")
}

/// Parsed digest tail: the `{hash}/{size}` or `{digest_fn}/{hash}/{size}` suffix
/// common to both read and write resource names.
struct ParsedDigestTail {
    hash: String,
    size: i64,
    digest_fn: DigestFn,
}

/// Parse the tail portion of a resource name into hash, size, and digest function.
///
/// Accepts either `[hash, size]` (defaults to SHA-256) or
/// `[digest_function, hash, size]`.
fn parse_digest_tail(parts: &[&str], name: &str) -> Result<ParsedDigestTail, Status> {
    match parts.len() {
        // {hash}/{size}
        2 => {
            let hash = parts[0].to_string();
            let size = parts[1].parse::<i64>().map_err(|_| {
                Status::invalid_argument(format!("invalid size in resource name: {name}"))
            })?;
            if size < 0 {
                return Err(Status::invalid_argument("size must be non-negative"));
            }
            Ok(ParsedDigestTail {
                hash,
                size,
                digest_fn: DigestFn::Sha256,
            })
        }
        // {digest_function}/{hash}/{size}
        3 => {
            let digest_fn = DigestFn::from_str_name(parts[0]).ok_or_else(|| {
                Status::invalid_argument(format!(
                    "unsupported digest function '{}' in resource name: {name}",
                    parts[0]
                ))
            })?;
            let hash = parts[1].to_string();
            let size = parts[2].parse::<i64>().map_err(|_| {
                Status::invalid_argument(format!("invalid size in resource name: {name}"))
            })?;
            if size < 0 {
                return Err(Status::invalid_argument("size must be non-negative"));
            }
            Ok(ParsedDigestTail {
                hash,
                size,
                digest_fn,
            })
        }
        _ => Err(Status::invalid_argument(format!(
            "invalid resource name format: {name}"
        ))),
    }
}

/// Parsed components from a ByteStream read resource name.
pub struct ReadResourceName {
    pub hash: String,
    pub size: i64,
    pub digest_fn: DigestFn,
    pub compressor: Compression,
}

/// Parse a ByteStream read resource name.
///
/// Accepted formats:
/// - `blobs/{hash}/{size}`
/// - `blobs/{digest_function}/{hash}/{size}`
/// - `compressed-blobs/{compressor}/{hash}/{size}`
/// - `compressed-blobs/{compressor}/{digest_function}/{hash}/{size}`
/// - `{instance_name}/blobs/{hash}/{size}`
/// - `{instance_name}/blobs/{digest_function}/{hash}/{size}`
/// - `{instance_name}/compressed-blobs/{compressor}/{hash}/{size}`
/// - `{instance_name}/compressed-blobs/{compressor}/{digest_function}/{hash}/{size}`
pub fn parse_read_resource_name(name: &str) -> Result<ReadResourceName, Status> {
    let parts: Vec<&str> = name.split('/').collect();

    // Find "compressed-blobs" or "blobs" segment
    let (blob_idx, compressor) =
        if let Some(idx) = parts.iter().position(|&s| s == "compressed-blobs") {
            let comp_name = parts.get(idx + 1).ok_or_else(|| {
                Status::invalid_argument(format!(
                    "missing compressor after 'compressed-blobs' in resource name: {name}"
                ))
            })?;
            let comp = Compression::from_str_name(comp_name).ok_or_else(|| {
                Status::invalid_argument(format!(
                    "unsupported compressor '{comp_name}' in resource name: {name}"
                ))
            })?;
            (idx + 2, comp) // skip past "compressed-blobs/{compressor}"
        } else if let Some(idx) = parts.iter().position(|&s| s == "blobs") {
            (idx + 1, Compression::Identity)
        } else {
            return Err(Status::invalid_argument(format!(
                "missing 'blobs' or 'compressed-blobs' in resource name: {name}"
            )));
        };

    let after = &parts[blob_idx..];
    let tail = parse_digest_tail(after, name)?;

    Ok(ReadResourceName {
        hash: tail.hash,
        size: tail.size,
        digest_fn: tail.digest_fn,
        compressor,
    })
}

/// Parsed components from a ByteStream write resource name.
pub struct WriteResourceName {
    pub hash: String,
    pub size: i64,
    pub uuid: Option<String>,
    pub digest_fn: DigestFn,
    pub compressor: Compression,
}

/// Parse a ByteStream write resource name.
///
/// Accepted formats:
/// - `uploads/{uuid}/blobs/{hash}/{size}`
/// - `uploads/{uuid}/blobs/{digest_function}/{hash}/{size}`
/// - `uploads/{uuid}/compressed-blobs/{compressor}/{hash}/{size}`
/// - `uploads/{uuid}/compressed-blobs/{compressor}/{digest_function}/{hash}/{size}`
/// - `{instance_name}/uploads/{uuid}/blobs/{hash}/{size}`
/// - `{instance_name}/uploads/{uuid}/blobs/{digest_function}/{hash}/{size}`
/// - `{instance_name}/uploads/{uuid}/compressed-blobs/{compressor}/{hash}/{size}`
/// - `{instance_name}/uploads/{uuid}/compressed-blobs/{compressor}/{digest_function}/{hash}/{size}`
pub fn parse_write_resource_name(name: &str) -> Result<WriteResourceName, Status> {
    let parts: Vec<&str> = name.split('/').collect();

    // Find the "uploads" segment
    let uploads_idx = parts.iter().position(|&s| s == "uploads").ok_or_else(|| {
        Status::invalid_argument(format!("missing 'uploads' in resource name: {name}"))
    })?;

    let after_uploads = &parts[uploads_idx + 1..];

    if after_uploads.len() < 4 {
        return Err(Status::invalid_argument(format!(
            "invalid write resource name format: {name}"
        )));
    }

    let uuid = after_uploads[0].to_string();

    let (blob_parts, compressor) = if after_uploads[1] == "compressed-blobs" {
        if after_uploads.len() < 5 {
            return Err(Status::invalid_argument(format!(
                "invalid write resource name format: {name}"
            )));
        }
        let comp = Compression::from_str_name(after_uploads[2]).ok_or_else(|| {
            Status::invalid_argument(format!(
                "unsupported compressor '{}' in resource name: {name}",
                after_uploads[2]
            ))
        })?;
        (&after_uploads[3..], comp)
    } else if after_uploads[1] == "blobs" {
        (&after_uploads[2..], Compression::Identity)
    } else {
        return Err(Status::invalid_argument(format!(
            "expected 'blobs' or 'compressed-blobs' segment in resource name: {name}"
        )));
    };

    let tail = parse_digest_tail(blob_parts, name)?;

    Ok(WriteResourceName {
        hash: tail.hash,
        size: tail.size,
        uuid: Some(uuid),
        digest_fn: tail.digest_fn,
        compressor,
    })
}

/// Run an RPC handler with standard instrumentation.
///
/// Tracks active requests, records duration and completion status, and wraps
/// the handler body in a wide event context for per-request telemetry.
pub async fn instrumented_rpc<F, T>(
    method: &'static str,
    f: F,
) -> Result<tonic::Response<T>, tonic::Status>
where
    F: Future<Output = Result<tonic::Response<T>, tonic::Status>>,
{
    let m = telemetry::metrics();
    let method_attr = telemetry::KeyValue::new("method", method);
    m.active_requests.add(1, &[method_attr.clone()]);

    let start = Instant::now();
    let result = telemetry::with_wide_context(method, f).await;
    let duration = start.elapsed().as_secs_f64();

    m.active_requests.add(-1, &[method_attr.clone()]);
    m.request_duration.record(duration, &[method_attr.clone()]);

    let status_str: &'static str = match &result {
        Ok(_) => "ok",
        Err(s) => match s.code() {
            tonic::Code::Ok => "ok",
            tonic::Code::NotFound => "not_found",
            tonic::Code::InvalidArgument => "invalid_argument",
            tonic::Code::Internal => "internal",
            tonic::Code::Unimplemented => "unimplemented",
            tonic::Code::Unavailable => "unavailable",
            _ => "error",
        },
    };
    let attrs = [method_attr, telemetry::KeyValue::new("status", status_str)];
    m.completed_requests.add(1, &attrs);
    if let Err(s) = &result {
        match s.code() {
            tonic::Code::NotFound | tonic::Code::AlreadyExists => {
                tracing::debug!(
                    rpc.method = method,
                    rpc.status = status_str,
                    rpc.duration_s = duration,
                    "{}",
                    s.message(),
                );
            }
            _ => {
                m.errors.add(1, &attrs);
                tracing::warn!(
                    rpc.method = method,
                    rpc.status = status_str,
                    rpc.duration_s = duration,
                    "{}",
                    s.message(),
                );
            }
        }
    }

    tracing::debug!(
        method,
        status = status_str,
        duration_ms = (duration * 1000.0) as u64,
        "rpc completed"
    );

    result
}

/// Fetch and reassemble a blob from its manifest and chunks.
///
/// Thin wrapper around [`CacheStore::cas_get_blob`] that maps
/// [`StoreError`] to [`tonic::Status`].
pub async fn get_blob(
    store: &Arc<CacheStore>,
    digest: &ContentDigest,
) -> Result<Option<Bytes>, Status> {
    store
        .cas_get_blob(digest)
        .await
        .map_err(store_error_to_status)
}
