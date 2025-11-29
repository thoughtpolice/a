// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use tonic;

use crate::protos::build::bazel::remote::execution::v2::{
    CacheCapabilities, ExecutionCapabilities, digest_function::Value::Sha256,
    symlink_absolute_path_strategy::Value::Allowed,
};

use crate::protos::build::bazel::remote::execution::v2::{
    ActionCacheUpdateCapabilities, GetCapabilitiesRequest, ServerCapabilities, capabilities_server,
};

use crate::protos::build::bazel::semver::SemVer;

// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct CapabilitiesService {}

#[tonic::async_trait]
impl capabilities_server::Capabilities for CapabilitiesService {
    #[tracing::instrument]
    async fn get_capabilities(
        &self,
        _request: tonic::Request<GetCapabilitiesRequest>,
    ) -> Result<tonic::Response<ServerCapabilities>, tonic::Status> {
        let digests = vec![Sha256.into()];

        let only_version = SemVer {
            major: 2,
            minor: 0,
            patch: 0,
            prerelease: "".to_string(),
        };

        let cache_caps = CacheCapabilities {
            digest_functions: digests.clone(),
            action_cache_update_capabilities: Some(ActionCacheUpdateCapabilities {
                update_enabled: true,
            }),
            cache_priority_capabilities: None,
            max_batch_total_size_bytes: 4000000,
            symlink_absolute_path_strategy: Allowed.into(),
            supported_batch_update_compressors: vec![],
            supported_compressors: vec![],
        };

        let exec_caps = ExecutionCapabilities {
            digest_function: Sha256.into(),
            digest_functions: digests.clone(),
            exec_enabled: false,
            supported_node_properties: vec![],
            execution_priority_capabilities: None,
        };

        let server_capabilities = ServerCapabilities {
            cache_capabilities: Some(cache_caps),
            execution_capabilities: Some(exec_caps),
            deprecated_api_version: None,
            low_api_version: Some(only_version.clone()),
            high_api_version: Some(only_version.clone()),
        };
        Ok(tonic::Response::new(server_capabilities))
    }
}

// ---------------------------------------------------------------------------------------------------------------------
