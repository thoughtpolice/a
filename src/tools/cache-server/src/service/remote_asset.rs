// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use std::sync::Arc;

use protos::build::bazel::remote::asset::v1::{
    FetchBlobRequest, FetchBlobResponse, FetchDirectoryRequest, FetchDirectoryResponse,
    PushBlobRequest, PushBlobResponse, PushDirectoryRequest, PushDirectoryResponse, Qualifier,
    fetch_server, push_server,
};
use protos::build::bazel::remote::execution::v2::Digest;

use crate::store::{AssetEntry, CacheStore, ContentDigest, DigestFn, unix_now_secs};

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

fn reject_vcs_qualifiers(qualifiers: &[Qualifier]) -> Result<(), tonic::Status> {
    for q in qualifiers {
        if q.name == "vcs.branch" || q.name == "vcs.commit" {
            return Err(tonic::Status::invalid_argument(format!(
                "qualifier '{}' is not supported (Git not supported)",
                q.name,
            )));
        }
    }
    Ok(())
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

/// Resolves Push'd asset mappings from the store. HTTP fetching from origin is
/// not currently supported; non-Push'd URIs will return NOT_FOUND in the
/// response status (per spec, a minimal Fetch implementation may support only
/// Push'd content).
#[derive(Debug, Clone)]
pub struct FetchService {
    store: Arc<CacheStore>,
}

impl FetchService {
    pub fn new(store: Arc<CacheStore>) -> Self {
        Self { store }
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
        instrumented_rpc("fetch.fetch_blob", async move {
            let inner = req.into_inner();

            if inner.uris.is_empty() {
                return Err(tonic::Status::invalid_argument(
                    "at least one URI is required",
                ));
            }

            let digest_fn = resolve_digest_function(inner.digest_function)?;
            reject_vcs_qualifiers(&inner.qualifiers)?;
            let qualifiers = extract_qualifiers(&inner.qualifiers);
            let oldest_content_accepted = timestamp_to_secs(&inner.oldest_content_accepted);

            let svc = FetchService { store };

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
        instrumented_rpc("fetch.fetch_directory", async move {
            let inner = req.into_inner();

            if inner.uris.is_empty() {
                return Err(tonic::Status::invalid_argument(
                    "at least one URI is required",
                ));
            }

            let digest_fn = resolve_digest_function(inner.digest_function)?;
            reject_vcs_qualifiers(&inner.qualifiers)?;
            let qualifiers = extract_qualifiers(&inner.qualifiers);
            let oldest_content_accepted = timestamp_to_secs(&inner.oldest_content_accepted);

            let svc = FetchService { store };

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
