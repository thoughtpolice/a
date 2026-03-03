// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use protos::build::bazel::remote::asset::v1::{
    FetchBlobRequest, FetchBlobResponse, FetchDirectoryRequest, FetchDirectoryResponse,
    PushBlobRequest, PushBlobResponse, PushDirectoryRequest, PushDirectoryResponse, fetch_server,
    push_server,
};

// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct FetchService {}

#[tonic::async_trait]
impl fetch_server::Fetch for FetchService {
    #[tracing::instrument]
    async fn fetch_blob(
        &self,
        _req: tonic::Request<FetchBlobRequest>,
    ) -> Result<tonic::Response<FetchBlobResponse>, tonic::Status> {
        Err(tonic::Status::unimplemented(
            "fetch_blob is not implemented",
        ))
    }

    #[tracing::instrument]
    async fn fetch_directory(
        &self,
        _req: tonic::Request<FetchDirectoryRequest>,
    ) -> Result<tonic::Response<FetchDirectoryResponse>, tonic::Status> {
        Err(tonic::Status::unimplemented(
            "fetch_directory is not implemented",
        ))
    }
}

// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct PushService {}

#[tonic::async_trait]
impl push_server::Push for PushService {
    #[tracing::instrument]
    async fn push_blob(
        &self,
        _req: tonic::Request<PushBlobRequest>,
    ) -> Result<tonic::Response<PushBlobResponse>, tonic::Status> {
        Err(tonic::Status::unimplemented("push_blob is not implemented"))
    }

    #[tracing::instrument]
    async fn push_directory(
        &self,
        _req: tonic::Request<PushDirectoryRequest>,
    ) -> Result<tonic::Response<PushDirectoryResponse>, tonic::Status> {
        Err(tonic::Status::unimplemented(
            "push_directory is not implemented",
        ))
    }
}

// ---------------------------------------------------------------------------------------------------------------------
