// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use tonic;

use protos::build::bazel::remote::execution::v2::{
    CacheCapabilities, ExecutionCapabilities, FastCdc2020Params,
    compressor::Value::Zstd,
    digest_function::Value::{Blake3, Sha256, Sha256tree},
    symlink_absolute_path_strategy::Value::Allowed,
};

use protos::build::bazel::remote::execution::v2::{
    ActionCacheUpdateCapabilities, GetCapabilitiesRequest, ServerCapabilities, capabilities_server,
};

use protos::build::bazel::semver::SemVer;

// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct CapabilitiesService {}

#[tonic::async_trait]
impl capabilities_server::Capabilities for CapabilitiesService {
    #[tracing::instrument(skip(self, _request))]
    async fn get_capabilities(
        &self,
        _request: tonic::Request<GetCapabilitiesRequest>,
    ) -> Result<tonic::Response<ServerCapabilities>, tonic::Status> {
        let digests = vec![Sha256.into(), Blake3.into(), Sha256tree.into()];

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
            supported_batch_update_compressors: vec![Zstd.into()],
            supported_compressors: vec![Zstd.into()],
            max_cas_blob_size_bytes: crate::store::MAX_BLOB_REASSEMBLE_SIZE as i64,
            split_blob_support: true,
            splice_blob_support: true,
            fast_cdc_2020_params: Some(FastCdc2020Params {
                avg_chunk_size_bytes: 524288,
                seed: 0,
            }),
            rep_max_cdc_params: None,
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
