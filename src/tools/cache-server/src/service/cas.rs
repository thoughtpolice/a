// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use tokio_stream::wrappers::ReceiverStream;

use crate::protos::build::bazel::remote::execution::v2::{
    BatchReadBlobsRequest, BatchReadBlobsResponse, BatchUpdateBlobsRequest,
    BatchUpdateBlobsResponse, FindMissingBlobsRequest, FindMissingBlobsResponse, GetTreeRequest,
    GetTreeResponse, content_addressable_storage_server,
};

// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct ContentAddressableStorageService {}

#[tonic::async_trait]
impl content_addressable_storage_server::ContentAddressableStorage
    for ContentAddressableStorageService
{
    #[tracing::instrument]
    async fn find_missing_blobs(
        &self,
        _req: tonic::Request<FindMissingBlobsRequest>,
    ) -> Result<tonic::Response<FindMissingBlobsResponse>, tonic::Status> {
        Err(tonic::Status::unimplemented(
            "find_missing_blobs is not implemented",
        ))
    }

    #[tracing::instrument]
    async fn batch_update_blobs(
        &self,
        _req: tonic::Request<BatchUpdateBlobsRequest>,
    ) -> Result<tonic::Response<BatchUpdateBlobsResponse>, tonic::Status> {
        Err(tonic::Status::unimplemented(
            "batch_update_blobs is not implemented",
        ))
    }

    #[tracing::instrument]
    async fn batch_read_blobs(
        &self,
        _req: tonic::Request<BatchReadBlobsRequest>,
    ) -> Result<tonic::Response<BatchReadBlobsResponse>, tonic::Status> {
        Err(tonic::Status::unimplemented(
            "batch_read_blobs is not implemented",
        ))
    }

    type GetTreeStream = ReceiverStream<Result<GetTreeResponse, tonic::Status>>;

    #[tracing::instrument]
    async fn get_tree(
        &self,
        _req: tonic::Request<GetTreeRequest>,
    ) -> Result<tonic::Response<Self::GetTreeStream>, tonic::Status> {
        Err(tonic::Status::unimplemented("get_tree is not implemented"))
    }
}

// ---------------------------------------------------------------------------------------------------------------------
