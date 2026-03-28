// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use std::sync::Arc;

use bytes::Bytes;
use prost::Message;

use protos::build::bazel::remote::execution::v2::{
    ActionResult, GetActionResultRequest, UpdateActionResultRequest, action_cache_server,
};

use crate::store::CacheStore;

use super::helpers::{
    instrumented_rpc, parse_and_validate_digest, resolve_digest_function, store_error_to_status,
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
                    m.cache_hits.add(1, &[svc_attr]);
                    telemetry::wide!("cache.hit", true);

                    let result = ActionResult::decode(data.as_ref()).map_err(|e| {
                        tonic::Status::internal(format!("failed to decode action result: {e}"))
                    })?;
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
