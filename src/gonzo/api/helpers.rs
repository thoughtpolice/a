// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use std::future::Future;
use std::sync::Arc;
use std::time::Instant;

use bytes::Bytes;
use tonic::Status;

use storage::{CacheStore, ContentDigest, Digest, DigestFn, StoreError};

/// Maximum total size for batch requests (4 MB).
pub const MAX_BATCH_TOTAL_SIZE: i64 = 4_000_000;

/// Map a [`StoreError`] to an appropriate [`tonic::Status`].
///
/// - `BlobTooLarge` / `DigestMismatch` → `INVALID_ARGUMENT`
/// - `DiskFull`, `Behind` → `RESOURCE_EXHAUSTED`
/// - Retryable `Database` errors, and a stopped database → `UNAVAILABLE`,
///   so clients retry elsewhere
/// - Everything else → `INTERNAL`
pub fn store_error_to_status(e: StoreError) -> tonic::Status {
    match &e {
        StoreError::BlobTooLarge { .. } | StoreError::DigestMismatch { .. } => {
            tonic::Status::invalid_argument(e.to_string())
        }
        StoreError::ChunkMissing { .. } => tonic::Status::not_found(e.to_string()),
        StoreError::DiskFull { .. } | StoreError::Behind { .. } => {
            tonic::Status::resource_exhausted(e.to_string())
        }
        StoreError::Database(_) if e.is_retryable() || e.is_closed() => {
            tonic::Status::unavailable(e.to_string())
        }
        _ => tonic::Status::internal(format!("storage error: {e}")),
    }
}

/// Resolve a `digest_function` proto i32 to a [`DigestFn`].
///
/// Proto value 0 (UNKNOWN) is treated as SHA-256 for backward compatibility.
pub fn resolve_digest_function(v: i32) -> Result<DigestFn, Status> {
    DigestFn::of_request(v)
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

/// Parse a `Digest` proto, rejecting a malformed one as `INVALID_ARGUMENT`.
pub fn parse_digest(
    digest: &protos::build::bazel::remote::execution::v2::Digest,
) -> Result<Digest, Status> {
    Digest::from_proto(digest).map_err(|e| Status::invalid_argument(e.to_string()))
}

/// Validate and parse a `Digest` proto reference into a [`ContentDigest`].
pub fn parse_and_validate_digest_ref(
    digest: &protos::build::bazel::remote::execution::v2::Digest,
    digest_fn: DigestFn,
) -> Result<ContentDigest, Status> {
    Ok(parse_digest(digest)?.content(digest_fn))
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
    let d = parse_digest(d)?;
    let hash = d.hash;

    if d.size != data.len() as u64 {
        return Err(Status::invalid_argument(format!(
            "size mismatch: expected {}, got {}",
            d.size,
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

/// The value of the qualifier called `name`, if the request has one.
pub fn qualifier<'a>(qualifiers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    qualifiers
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, value)| value.as_str())
}

/// The fetch timeout a request asked for, with negative parts as zero.
pub fn request_timeout(timeout: Option<&prost_types::Duration>) -> Option<std::time::Duration> {
    timeout.map(|d| {
        std::time::Duration::from_secs(d.seconds.max(0) as u64)
            + std::time::Duration::from_nanos(d.nanos.max(0) as u64)
    })
}

/// The gRPC code reporting that an origin answered with HTTP `status`.
pub fn http_status_code(status: u16) -> tonic::Code {
    match status {
        404 => tonic::Code::NotFound,
        401 | 403 => tonic::Code::PermissionDenied,
        _ => tonic::Code::Unavailable,
    }
}

/// The status reporting a failed HTTP fetch.
pub fn http_fetch_status(e: &fetch_http::HttpFetchError) -> protos::google::rpc::Status {
    use fetch_http::HttpFetchError;
    use tonic::Code;
    let code = match e {
        HttpFetchError::RequestFailed(_) => Code::Unavailable,
        HttpFetchError::HttpStatus(status, _) => http_status_code(*status),
        HttpFetchError::TooLarge { .. } => Code::ResourceExhausted,
        HttpFetchError::IntegrityMismatch(_) => Code::Aborted,
        HttpFetchError::InvalidUri(_) => Code::InvalidArgument,
        HttpFetchError::BlockedAddress(_) => Code::PermissionDenied,
    };
    let message = match e {
        HttpFetchError::RequestFailed(msg)
        | HttpFetchError::IntegrityMismatch(msg)
        | HttpFetchError::InvalidUri(msg)
        | HttpFetchError::BlockedAddress(msg) => msg.clone(),
        other => other.to_string(),
    };
    rpc_status(code as i32, message)
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

pub use reapi_cas::{ReadResourceName, WriteResourceName};

/// Parse a ByteStream read resource name (see [`reapi_cas::resource`]); a
/// malformed one is `INVALID_ARGUMENT`.
pub fn parse_read_resource_name(name: &str) -> Result<ReadResourceName, Status> {
    reapi_cas::resource::parse_read(name).map_err(|e| Status::invalid_argument(e.0))
}

/// Parse a ByteStream write resource name (see [`reapi_cas::resource`]); a
/// malformed one is `INVALID_ARGUMENT`.
pub fn parse_write_resource_name(name: &str) -> Result<WriteResourceName, Status> {
    reapi_cas::resource::parse_write(name).map_err(|e| Status::invalid_argument(e.0))
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
