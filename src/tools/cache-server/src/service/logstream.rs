// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use protos::build::bazel::remote::logstream::v1::{
    CreateLogStreamRequest, LogStream, log_stream_service_server,
};

// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct LogStreamSvc {}

#[tonic::async_trait]
impl log_stream_service_server::LogStreamService for LogStreamSvc {
    #[tracing::instrument]
    async fn create_log_stream(
        &self,
        _req: tonic::Request<CreateLogStreamRequest>,
    ) -> Result<tonic::Response<LogStream>, tonic::Status> {
        Err(tonic::Status::unimplemented(
            "create_log_stream is not implemented",
        ))
    }
}

// ---------------------------------------------------------------------------------------------------------------------
