// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use tonic;

use protos::google::longrunning::{
    CancelOperationRequest, DeleteOperationRequest, GetOperationRequest, ListOperationsRequest,
    ListOperationsResponse, Operation, WaitOperationRequest, operations_server,
};

// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct OperationsService {}

#[tonic::async_trait]
impl operations_server::Operations for OperationsService {
    #[tracing::instrument]
    async fn list_operations(
        &self,
        _req: tonic::Request<ListOperationsRequest>,
    ) -> Result<tonic::Response<ListOperationsResponse>, tonic::Status> {
        Err(tonic::Status::unimplemented(
            "list_operations is not implemented",
        ))
    }

    #[tracing::instrument]
    async fn get_operation(
        &self,
        _req: tonic::Request<GetOperationRequest>,
    ) -> Result<tonic::Response<Operation>, tonic::Status> {
        Err(tonic::Status::unimplemented(
            "get_operation is not implemented",
        ))
    }

    #[tracing::instrument]
    async fn delete_operation(
        &self,
        _req: tonic::Request<DeleteOperationRequest>,
    ) -> Result<tonic::Response<()>, tonic::Status> {
        Err(tonic::Status::unimplemented(
            "delete_operation is not implemented",
        ))
    }

    #[tracing::instrument]
    async fn cancel_operation(
        &self,
        _req: tonic::Request<CancelOperationRequest>,
    ) -> Result<tonic::Response<()>, tonic::Status> {
        Err(tonic::Status::unimplemented(
            "cancel_operation is not implemented",
        ))
    }

    #[tracing::instrument]
    async fn wait_operation(
        &self,
        _req: tonic::Request<WaitOperationRequest>,
    ) -> Result<tonic::Response<Operation>, tonic::Status> {
        Err(tonic::Status::unimplemented(
            "wait_operation is not implemented",
        ))
    }
}

// ---------------------------------------------------------------------------------------------------------------------
