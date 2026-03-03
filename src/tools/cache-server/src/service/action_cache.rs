// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use std::sync::Arc;

use protos::build::bazel::remote::execution::v2::{
    ActionResult, GetActionResultRequest, UpdateActionResultRequest, action_cache_server,
};

use crate::store::{self as storage, CacheStore};

// ---------------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct ActionCacheService {
    #[allow(dead_code)]
    store: Arc<CacheStore>,
}

impl ActionCacheService {
    pub fn new(store: Arc<CacheStore>) -> Self {
        Self { store }
    }
}

#[tonic::async_trait]
impl action_cache_server::ActionCache for ActionCacheService {
    #[tracing::instrument]
    async fn get_action_result(
        &self,
        _req: tonic::Request<GetActionResultRequest>,
    ) -> Result<tonic::Response<ActionResult>, tonic::Status> {
        Err(tonic::Status::unimplemented(
            "get_action_result is not implemented",
        ))
    }

    #[tracing::instrument]
    async fn update_action_result(
        &self,
        _req: tonic::Request<UpdateActionResultRequest>,
    ) -> Result<tonic::Response<ActionResult>, tonic::Status> {
        Err(tonic::Status::unimplemented(
            "update_action_result is not implemented",
        ))
    }
}

// ---------------------------------------------------------------------------------------------------------------------
