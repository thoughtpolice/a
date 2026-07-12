// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use std::sync::Arc;
use std::time::Duration;

use dial9::Dial9TokioHandle;
use openssl::ssl::SslConnector;

use protos::build::bazel::remote::asset::v1::{
    FetchBlobRequest, FetchBlobResponse, FetchDirectoryRequest, FetchDirectoryResponse,
    PushBlobRequest, PushBlobResponse, PushDirectoryRequest, PushDirectoryResponse, Qualifier,
    fetch_server, push_server,
};
use protos::build::bazel::remote::execution::v2::Digest;

use crate::store::{AssetEntry, CacheStore, Compression, ContentDigest, DigestFn, unix_now_secs};

use super::git_clone;
use super::helpers::{
    instrumented_rpc, parse_and_validate_digest, resolve_digest_function, rpc_status,
    rpc_status_ok, store_error_to_status,
};

// ---------------------------------------------------------------------------------------------------------------------
// Qualifier helpers
// ---------------------------------------------------------------------------------------------------------------------

fn extract_qualifiers(qualifiers: &[Qualifier]) -> Vec<(String, String)> {
    qualifiers
        .iter()
        .map(|q| (q.name.clone(), q.value.clone()))
        .collect()
}

/// Qualifiers understood by `FetchBlob`.
///
/// `bazel.canonical_id` carries no fetch semantics of its own — it exists to
/// salt the cache key, which qualifiers do here by construction (they are
/// part of the asset-cache key). The `vcs.*`/`directory` family is
/// recognized but only actionable on `FetchDirectory`; blob fetches with
/// them fall through to NOT_FOUND rather than being rejected.
const FETCH_BLOB_QUALIFIERS: &[&str] = &[
    "checksum.sri",
    "bazel.canonical_id",
    "resource_type",
    "vcs.branch",
    "vcs.commit",
    "directory",
];

/// Qualifiers understood by `FetchDirectory`. Note `checksum.sri` is absent:
/// there is no checksum-verified directory fetch path.
const FETCH_DIRECTORY_QUALIFIERS: &[&str] = &[
    "vcs.branch",
    "vcs.commit",
    "directory",
    "resource_type",
    "bazel.canonical_id",
];

/// The Remote Asset spec requires servers to reject requests containing
/// qualifiers they do not support with `INVALID_ARGUMENT`; silently ignoring
/// one (say, a misspelled `vcs.commit`) would fetch the wrong content.
fn reject_unsupported_qualifiers(
    qualifiers: &[(String, String)],
    supported: &[&str],
) -> Result<(), tonic::Status> {
    match qualifiers
        .iter()
        .map(|(name, _)| name.as_str())
        .find(|name| !supported.contains(name))
    {
        Some(name) => Err(tonic::Status::invalid_argument(format!(
            "qualifier \"{name}\" not supported (supported: {})",
            supported.join(", ")
        ))),
        None => Ok(()),
    }
}

fn qualifiers_to_proto(quals: &[(String, String)]) -> Vec<Qualifier> {
    quals
        .iter()
        .map(|(n, v)| Qualifier {
            name: n.clone(),
            value: v.clone(),
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------------------------------------------------

fn timestamp_to_secs(ts: &Option<prost_types::Timestamp>) -> u64 {
    match ts {
        Some(t) if t.seconds > 0 => t.seconds as u64,
        _ => 0,
    }
}

fn secs_to_timestamp(secs: u64) -> Option<prost_types::Timestamp> {
    if secs == 0 {
        None
    } else {
        Some(prost_types::Timestamp {
            seconds: secs as i64,
            nanos: 0,
        })
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// FetchService
// ---------------------------------------------------------------------------------------------------------------------

/// Resolves Push'd asset mappings from the store. For HTTP/HTTPS URIs with a
/// `checksum.sri` qualifier, fetches content from origin, validates its
/// integrity, stores it in CAS, and creates an asset mapping.
#[derive(Clone)]
pub struct FetchService {
    store: Arc<CacheStore>,
    ssl_connector: SslConnector,
    handle: Dial9TokioHandle,
    /// Directory for spooling git packfiles during clones (system temp when
    /// `None`).
    git_spool_dir: Option<std::path::PathBuf>,
}

impl std::fmt::Debug for FetchService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FetchService").finish_non_exhaustive()
    }
}

impl FetchService {
    pub fn new(
        store: Arc<CacheStore>,
        handle: Dial9TokioHandle,
        git_spool_dir: Option<std::path::PathBuf>,
    ) -> Self {
        Self {
            store,
            ssl_connector: fetch_http::build_ssl_connector(),
            handle,
            git_spool_dir,
        }
    }

    /// Try to resolve a URI from the asset cache. Returns Some(entry) if found
    /// and valid (not expired, not too old, referenced content still in CAS).
    async fn try_cached_lookup(
        &self,
        digest_fn: DigestFn,
        uri: &str,
        qualifiers: &[(String, String)],
        oldest_content_accepted: u64,
        expect_directory: bool,
    ) -> Result<Option<AssetEntry>, tonic::Status> {
        let entry = match self
            .store
            .asset_get(digest_fn, uri, qualifiers)
            .await
            .map_err(store_error_to_status)?
        {
            Some(e) => e,
            None => return Ok(None),
        };

        if entry.is_directory != expect_directory {
            return Ok(None);
        }

        // Check expiry
        if entry.expires_at != 0 && unix_now_secs() >= entry.expires_at {
            return Ok(None);
        }

        // Check oldest_content_accepted
        if oldest_content_accepted != 0 && entry.created_at < oldest_content_accepted {
            return Ok(None);
        }

        // Verify referenced content still exists in CAS
        let cd = ContentDigest::new(digest_fn, entry.digest_hash);
        let exists = self
            .store
            .cas_blob_exists(&cd)
            .await
            .map_err(store_error_to_status)?;
        if !exists {
            return Ok(None);
        }

        Ok(Some(entry))
    }
}

#[tonic::async_trait]
impl fetch_server::Fetch for FetchService {
    #[tracing::instrument(skip(self, req))]
    async fn fetch_blob(
        &self,
        req: tonic::Request<FetchBlobRequest>,
    ) -> Result<tonic::Response<FetchBlobResponse>, tonic::Status> {
        let store = self.store.clone();
        let ssl_connector = self.ssl_connector.clone();
        let handle = self.handle.clone();
        let git_spool_dir = self.git_spool_dir.clone();
        instrumented_rpc("fetch.fetch_blob", async move {
            let inner = req.into_inner();

            if inner.uris.is_empty() {
                return Err(tonic::Status::invalid_argument(
                    "at least one URI is required",
                ));
            }

            let digest_fn = resolve_digest_function(inner.digest_function)?;
            let qualifiers = extract_qualifiers(&inner.qualifiers);
            reject_unsupported_qualifiers(&qualifiers, FETCH_BLOB_QUALIFIERS)?;
            let oldest_content_accepted = timestamp_to_secs(&inner.oldest_content_accepted);

            let svc = FetchService {
                store: store.clone(),
                ssl_connector: ssl_connector.clone(),
                handle: handle.clone(),
                git_spool_dir: git_spool_dir.clone(),
            };

            // Phase 1: try cached lookups
            for uri in &inner.uris {
                if let Some(entry) = svc
                    .try_cached_lookup(digest_fn, uri, &qualifiers, oldest_content_accepted, false)
                    .await?
                {
                    return Ok(tonic::Response::new(FetchBlobResponse {
                        status: Some(rpc_status_ok()),
                        uri: uri.clone(),
                        qualifiers: qualifiers_to_proto(&entry.qualifiers),
                        expires_at: secs_to_timestamp(entry.expires_at),
                        blob_digest: Some(Digest {
                            hash: hex::encode(entry.digest_hash),
                            size_bytes: entry.digest_size_bytes,
                        }),
                        digest_function: digest_fn.to_proto_i32(),
                    }));
                }
            }

            // Phase 2: try HTTP fetch for http(s) URIs
            let has_http_uris = inner.uris.iter().any(|u| fetch_http::is_http_uri(u));
            if has_http_uris {
                // Parse SRI checksums if provided; empty vec means no validation
                let sri_checksums =
                    if let Some(sri_value) = fetch_http::find_sri_qualifier(&qualifiers) {
                        match fetch_http::parse_sri(sri_value) {
                            Ok(c) => c,
                            Err(msg) => {
                                return Ok(tonic::Response::new(FetchBlobResponse {
                                    status: Some(rpc_status(
                                        tonic::Code::InvalidArgument as i32,
                                        format!("invalid checksum.sri: {msg}"),
                                    )),
                                    uri: inner.uris.first().cloned().unwrap_or_default(),
                                    qualifiers: qualifiers_to_proto(&qualifiers),
                                    expires_at: None,
                                    blob_digest: None,
                                    digest_function: digest_fn.to_proto_i32(),
                                }));
                            }
                        }
                    } else {
                        vec![]
                    };

                let timeout = inner.timeout.as_ref().map(|d| {
                    Duration::from_secs(d.seconds.max(0) as u64)
                        + Duration::from_nanos(d.nanos.max(0) as u64)
                });

                let mut last_error = None;
                for uri in &inner.uris {
                    if !fetch_http::is_http_uri(uri) {
                        continue;
                    }

                    match fetch_http::fetch_http_blob(
                        &ssl_connector,
                        uri,
                        timeout,
                        &sri_checksums,
                        digest_fn,
                        &handle,
                    )
                    .await
                    {
                        Ok(result) => {
                            let cd = ContentDigest::new(digest_fn, result.digest_hash);
                            store
                                .cas_put_blob(&cd, result.data, Compression::Identity)
                                .await
                                .map_err(store_error_to_status)?;

                            let entry = AssetEntry {
                                digest_hash: result.digest_hash,
                                digest_size_bytes: result.digest_size,
                                created_at: unix_now_secs(),
                                expires_at: 0,
                                is_directory: false,
                                qualifiers: qualifiers.clone(),
                            };
                            store
                                .asset_put(digest_fn, uri, &qualifiers, &entry)
                                .await
                                .map_err(store_error_to_status)?;

                            return Ok(tonic::Response::new(FetchBlobResponse {
                                status: Some(rpc_status_ok()),
                                uri: uri.clone(),
                                qualifiers: qualifiers_to_proto(&entry.qualifiers),
                                expires_at: None,
                                blob_digest: Some(Digest {
                                    hash: hex::encode(result.digest_hash),
                                    size_bytes: result.digest_size,
                                }),
                                digest_function: digest_fn.to_proto_i32(),
                            }));
                        }
                        Err(e) => {
                            tracing::warn!(uri, error = %e, "HTTP fetch failed, trying next URI");
                            last_error = Some(e);
                        }
                    }
                }

                // All HTTP URIs failed — return the last error
                if let Some(e) = last_error {
                    return Ok(tonic::Response::new(FetchBlobResponse {
                        status: Some(e.to_rpc_status()),
                        uri: inner.uris.first().cloned().unwrap_or_default(),
                        qualifiers: qualifiers_to_proto(&qualifiers),
                        expires_at: None,
                        blob_digest: None,
                        digest_function: digest_fn.to_proto_i32(),
                    }));
                }
            }

            Ok(tonic::Response::new(FetchBlobResponse {
                status: Some(rpc_status(
                    tonic::Code::NotFound as i32,
                    "no matching content found for any URI",
                )),
                uri: inner.uris.first().cloned().unwrap_or_default(),
                qualifiers: qualifiers_to_proto(&qualifiers),
                expires_at: None,
                blob_digest: None,
                digest_function: digest_fn.to_proto_i32(),
            }))
        })
        .await
    }

    #[tracing::instrument(skip(self, req))]
    async fn fetch_directory(
        &self,
        req: tonic::Request<FetchDirectoryRequest>,
    ) -> Result<tonic::Response<FetchDirectoryResponse>, tonic::Status> {
        let store = self.store.clone();
        let ssl_connector = self.ssl_connector.clone();
        let handle = self.handle.clone();
        let git_spool_dir = self.git_spool_dir.clone();
        instrumented_rpc("fetch.fetch_directory", async move {
            let inner = req.into_inner();

            if inner.uris.is_empty() {
                return Err(tonic::Status::invalid_argument(
                    "at least one URI is required",
                ));
            }

            let digest_fn = resolve_digest_function(inner.digest_function)?;
            let qualifiers = extract_qualifiers(&inner.qualifiers);
            reject_unsupported_qualifiers(&qualifiers, FETCH_DIRECTORY_QUALIFIERS)?;
            let oldest_content_accepted = timestamp_to_secs(&inner.oldest_content_accepted);

            let svc = FetchService {
                store: store.clone(),
                ssl_connector: ssl_connector.clone(),
                handle: handle.clone(),
                git_spool_dir: git_spool_dir.clone(),
            };

            // Phase 1: try cached lookups
            for uri in &inner.uris {
                if let Some(entry) = svc
                    .try_cached_lookup(digest_fn, uri, &qualifiers, oldest_content_accepted, true)
                    .await?
                {
                    return Ok(tonic::Response::new(FetchDirectoryResponse {
                        status: Some(rpc_status_ok()),
                        uri: uri.clone(),
                        qualifiers: qualifiers_to_proto(&entry.qualifiers),
                        expires_at: secs_to_timestamp(entry.expires_at),
                        root_directory_digest: Some(Digest {
                            hash: hex::encode(entry.digest_hash),
                            size_bytes: entry.digest_size_bytes,
                        }),
                        digest_function: digest_fn.to_proto_i32(),
                    }));
                }
            }

            // Phase 2: try git clone for git URIs with VCS qualifiers
            if git_clone::has_vcs_qualifiers(&qualifiers) {
                let timeout = inner.timeout.as_ref().map(|d| {
                    Duration::from_secs(d.seconds.max(0) as u64)
                        + Duration::from_nanos(d.nanos.max(0) as u64)
                });

                let mut last_error = None;
                for uri in &inner.uris {
                    if !git_clone::is_git_uri(uri, &qualifiers) {
                        continue;
                    }

                    match git_clone::fetch_git_directory(
                        &ssl_connector,
                        &store,
                        uri,
                        &qualifiers,
                        timeout,
                        digest_fn,
                        git_spool_dir.as_deref(),
                        &handle,
                    )
                    .await
                    {
                        Ok(result) => {
                            let entry = AssetEntry {
                                digest_hash: result.root_digest_hash,
                                digest_size_bytes: result.root_digest_size,
                                created_at: unix_now_secs(),
                                expires_at: 0,
                                is_directory: true,
                                qualifiers: qualifiers.clone(),
                            };
                            store
                                .asset_put(digest_fn, uri, &qualifiers, &entry)
                                .await
                                .map_err(store_error_to_status)?;

                            return Ok(tonic::Response::new(FetchDirectoryResponse {
                                status: Some(rpc_status_ok()),
                                uri: uri.clone(),
                                qualifiers: qualifiers_to_proto(&entry.qualifiers),
                                expires_at: None,
                                root_directory_digest: Some(Digest {
                                    hash: hex::encode(result.root_digest_hash),
                                    size_bytes: result.root_digest_size,
                                }),
                                digest_function: digest_fn.to_proto_i32(),
                            }));
                        }
                        Err(e) => {
                            tracing::warn!(uri, error = %e, "git clone failed, trying next URI");
                            last_error = Some(e);
                        }
                    }
                }

                if let Some(e) = last_error {
                    return Ok(tonic::Response::new(FetchDirectoryResponse {
                        status: Some(e.to_rpc_status()),
                        uri: inner.uris.first().cloned().unwrap_or_default(),
                        qualifiers: qualifiers_to_proto(&qualifiers),
                        expires_at: None,
                        root_directory_digest: None,
                        digest_function: digest_fn.to_proto_i32(),
                    }));
                }
            }

            Ok(tonic::Response::new(FetchDirectoryResponse {
                status: Some(rpc_status(
                    tonic::Code::NotFound as i32,
                    "no matching directory found for any URI",
                )),
                uri: inner.uris.first().cloned().unwrap_or_default(),
                qualifiers: qualifiers_to_proto(&qualifiers),
                expires_at: None,
                root_directory_digest: None,
                digest_function: digest_fn.to_proto_i32(),
            }))
        })
        .await
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// PushService
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct PushService {
    store: Arc<CacheStore>,
}

impl PushService {
    pub fn new(store: Arc<CacheStore>) -> Self {
        Self { store }
    }
}

#[tonic::async_trait]
impl push_server::Push for PushService {
    #[tracing::instrument(skip(self, req))]
    async fn push_blob(
        &self,
        req: tonic::Request<PushBlobRequest>,
    ) -> Result<tonic::Response<PushBlobResponse>, tonic::Status> {
        let store = self.store.clone();
        instrumented_rpc("push.push_blob", async move {
            let inner = req.into_inner();

            if inner.uris.is_empty() {
                return Err(tonic::Status::invalid_argument(
                    "at least one URI is required",
                ));
            }

            let digest_fn = resolve_digest_function(inner.digest_function)?;
            let blob_cd = parse_and_validate_digest(&inner.blob_digest, digest_fn)?;

            if !store
                .cas_blob_exists(&blob_cd)
                .await
                .map_err(store_error_to_status)?
            {
                return Err(tonic::Status::not_found(format!(
                    "blob {} not found in CAS",
                    hex::encode(blob_cd.hash),
                )));
            }

            let qualifiers = extract_qualifiers(&inner.qualifiers);
            let expires_at = timestamp_to_secs(&inner.expire_at);
            let size_bytes = inner
                .blob_digest
                .as_ref()
                .map(|d| d.size_bytes)
                .unwrap_or(0);

            let entry = AssetEntry {
                digest_hash: blob_cd.hash,
                digest_size_bytes: size_bytes,
                created_at: unix_now_secs(),
                expires_at,
                is_directory: false,
                qualifiers: qualifiers.clone(),
            };

            for uri in &inner.uris {
                store
                    .asset_put(digest_fn, uri, &qualifiers, &entry)
                    .await
                    .map_err(store_error_to_status)?;
            }

            Ok(tonic::Response::new(PushBlobResponse {}))
        })
        .await
    }

    #[tracing::instrument(skip(self, req))]
    async fn push_directory(
        &self,
        req: tonic::Request<PushDirectoryRequest>,
    ) -> Result<tonic::Response<PushDirectoryResponse>, tonic::Status> {
        let store = self.store.clone();
        instrumented_rpc("push.push_directory", async move {
            let inner = req.into_inner();

            if inner.uris.is_empty() {
                return Err(tonic::Status::invalid_argument(
                    "at least one URI is required",
                ));
            }

            let digest_fn = resolve_digest_function(inner.digest_function)?;
            let dir_cd = parse_and_validate_digest(&inner.root_directory_digest, digest_fn)?;

            if !store
                .cas_blob_exists(&dir_cd)
                .await
                .map_err(store_error_to_status)?
            {
                return Err(tonic::Status::not_found(format!(
                    "directory {} not found in CAS",
                    hex::encode(dir_cd.hash),
                )));
            }

            let qualifiers = extract_qualifiers(&inner.qualifiers);
            let expires_at = timestamp_to_secs(&inner.expire_at);
            let size_bytes = inner
                .root_directory_digest
                .as_ref()
                .map(|d| d.size_bytes)
                .unwrap_or(0);

            let entry = AssetEntry {
                digest_hash: dir_cd.hash,
                digest_size_bytes: size_bytes,
                created_at: unix_now_secs(),
                expires_at,
                is_directory: true,
                qualifiers: qualifiers.clone(),
            };

            for uri in &inner.uris {
                store
                    .asset_put(digest_fn, uri, &qualifiers, &entry)
                    .await
                    .map_err(store_error_to_status)?;
            }

            Ok(tonic::Response::new(PushDirectoryResponse {}))
        })
        .await
    }
}

// ---------------------------------------------------------------------------------------------------------------------
