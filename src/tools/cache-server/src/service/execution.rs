// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use tokio_stream::wrappers::ReceiverStream;
use tonic;

use crate::protos::build::bazel::remote::execution::v2::{
    ExecuteRequest, WaitExecutionRequest, execution_server,
};

use crate::protos::google::longrunning;

// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct ExecutionService {}

#[tonic::async_trait]
impl execution_server::Execution for ExecutionService {
    type ExecuteStream = ReceiverStream<Result<longrunning::Operation, tonic::Status>>;

    #[tracing::instrument]
    async fn execute(
        &self,
        _req: tonic::Request<ExecuteRequest>,
    ) -> Result<tonic::Response<Self::ExecuteStream>, tonic::Status> {
        Err(tonic::Status::unimplemented("execute is not implemented"))
    }

    type WaitExecutionStream = ReceiverStream<Result<longrunning::Operation, tonic::Status>>;

    #[tracing::instrument]
    async fn wait_execution(
        &self,
        _req: tonic::Request<WaitExecutionRequest>,
    ) -> Result<tonic::Response<Self::WaitExecutionStream>, tonic::Status> {
        Err(tonic::Status::unimplemented(
            "wait_execution is not implemented",
        ))
    }
}

// ---------------------------------------------------------------------------------------------------------------------
