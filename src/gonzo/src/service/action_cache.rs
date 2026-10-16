// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use std::sync::Arc;

use bytes::Bytes;
use prost::Message;

use futures::StreamExt as _;
use protos::build::bazel::remote::execution::v2::{
    ActionResult, Digest, GetActionResultRequest, Tree, UpdateActionResultRequest,
    action_cache_server,
};

use crate::store::{CacheStore, DigestFn};

use super::helpers::{
    instrumented_rpc, parse_and_validate_digest, parse_and_validate_digest_ref,
    resolve_digest_function, store_error_to_status,
};

// ---------------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct ActionCacheService {
    store: Arc<CacheStore>,
}

impl ActionCacheService {
    pub fn new(store: Arc<CacheStore>) -> Self {
        Self { store }
    }
}

#[tonic::async_trait]
impl action_cache_server::ActionCache for ActionCacheService {
    #[tracing::instrument(skip(self, req))]
    async fn get_action_result(
        &self,
        req: tonic::Request<GetActionResultRequest>,
    ) -> Result<tonic::Response<ActionResult>, tonic::Status> {
        let store = self.store.clone();
        instrumented_rpc("ac.get_action_result", async move {
            let inner = req.into_inner();
            let digest_fn = resolve_digest_function(inner.digest_function)?;
            let action_cd = parse_and_validate_digest(&inner.action_digest, digest_fn)?;

            telemetry::wide!("digest", hex::encode(action_cd.hash));

            let data = telemetry::wide_timed!(
                "store.lookup_ms",
                store
                    .ac_get(&action_cd)
                    .await
                    .map_err(store_error_to_status)
            )?;

            let m = telemetry::metrics();
            let svc_attr = telemetry::KeyValue::new("service", "ac");
            match data {
                Some(data) => {
                    let result = ActionResult::decode(data.as_ref()).map_err(|e| {
                        tonic::Status::internal(format!("failed to decode action result: {e}"))
                    })?;
                    if !outputs_stored(&store, digest_fn, &result).await? {
                        m.cache_misses.add(1, &[svc_attr]);
                        telemetry::wide!("cache.hit", false);
                        telemetry::wide!("cache.outputs_missing", true);
                        return Err(tonic::Status::not_found(
                            "action result found, but not all of its outputs are still stored",
                        ));
                    }
                    m.cache_hits.add(1, &[svc_attr]);
                    telemetry::wide!("cache.hit", true);
                    Ok(tonic::Response::new(result))
                }
                None => {
                    m.cache_misses.add(1, &[svc_attr]);
                    telemetry::wide!("cache.hit", false);
                    Err(tonic::Status::not_found("action result not found"))
                }
            }
        })
        .await
    }

    #[tracing::instrument(skip(self, req))]
    async fn update_action_result(
        &self,
        req: tonic::Request<UpdateActionResultRequest>,
    ) -> Result<tonic::Response<ActionResult>, tonic::Status> {
        let store = self.store.clone();
        instrumented_rpc("ac.update_action_result", async move {
            let inner = req.into_inner();
            let digest_fn = resolve_digest_function(inner.digest_function)?;
            let action_cd = parse_and_validate_digest(&inner.action_digest, digest_fn)?;

            telemetry::wide!("digest", hex::encode(action_cd.hash));

            let action_result = inner
                .action_result
                .ok_or_else(|| tonic::Status::invalid_argument("missing action_result"))?;

            let encoded = action_result.encode_to_vec();
            let encoded_len = encoded.len() as i64;
            telemetry::wide!("data.size_bytes", encoded_len);

            store
                .ac_put(&action_cd, Bytes::from(encoded))
                .await
                .map_err(store_error_to_status)?;

            telemetry::metrics().bytes_written.add(
                encoded_len as u64,
                &[telemetry::KeyValue::new("service", "ac")],
            );

            Ok(tonic::Response::new(action_result))
        })
        .await
    }
}

// ---------------------------------------------------------------------------------------------------------------------

/// Output lookups an action cache hit keeps in flight.
const OUTPUT_CHECKS_IN_FLIGHT: usize = 32;

/// Whether every blob `result` names is stored, by the rule FindMissingBlobs
/// answers with: output files, the files of output directories (and their
/// Tree blobs), stdout, and stderr.
///
/// A client told an action ran need not download its outputs (Bazel's
/// "build without the bytes"); it later names them as inputs, or fetches
/// them at the end. A hit whose outputs have expired, or are close enough to
/// it that FindMissingBlobs already calls them missing, would fail that
/// client later, so it is reported as a miss instead: the client runs the
/// action again, and uploading its outputs renews them.
async fn outputs_stored(
    store: &CacheStore,
    digest_fn: DigestFn,
    result: &ActionResult,
) -> Result<bool, tonic::Status> {
    let mut named = Vec::new();
    let mut trees = Vec::new();
    for file in &result.output_files {
        named.extend(file.digest.clone());
    }
    for dir in &result.output_directories {
        named.extend(dir.root_directory_digest.clone());
        if let Some(tree) = &dir.tree_digest {
            named.push(tree.clone());
            trees.push(tree.clone());
        }
    }
    named.extend(result.stdout_digest.clone());
    named.extend(result.stderr_digest.clone());
    if !all_stored(store, digest_fn, named).await? {
        return Ok(false);
    }

    for tree in trees {
        let Ok(tree_cd) = parse_and_validate_digest_ref(&tree, digest_fn) else {
            return Ok(false);
        };
        let Some(data) = store
            .cas_get_blob(&tree_cd)
            .await
            .map_err(store_error_to_status)?
        else {
            return Ok(false);
        };
        let Ok(tree) = Tree::decode(data.as_ref()) else {
            return Ok(false);
        };
        let files = tree
            .root
            .iter()
            .chain(&tree.children)
            .flat_map(|dir| &dir.files)
            .filter_map(|file| file.digest.clone())
            .collect();
        if !all_stored(store, digest_fn, files).await? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Whether every one of `digests` is stored with at least half its TTL left;
/// a malformed one counts as missing.
async fn all_stored(
    store: &CacheStore,
    digest_fn: DigestFn,
    digests: Vec<Digest>,
) -> Result<bool, tonic::Status> {
    let mut parsed = Vec::with_capacity(digests.len());
    for digest in &digests {
        match parse_and_validate_digest_ref(digest, digest_fn) {
            Ok(cd) => parsed.push(cd),
            Err(_) => return Ok(false),
        }
    }
    let mut checks = futures::stream::iter(parsed)
        .map(|cd| async move { store.cas_blob_fresh(&cd).await })
        .buffer_unordered(OUTPUT_CHECKS_IN_FLIGHT);
    while let Some(fresh) = checks.next().await {
        if !fresh.map_err(store_error_to_status)? {
            return Ok(false);
        }
    }
    Ok(true)
}

// ---------------------------------------------------------------------------------------------------------------------
