// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use std::sync::Arc;

use tokio_stream::wrappers::ReceiverStream;

use protos::google::bytestream::{
    QueryWriteStatusRequest, QueryWriteStatusResponse, ReadRequest, ReadResponse, WriteRequest,
    WriteResponse, byte_stream_server,
};

use crate::store::CacheStore;

// ---------------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct ByteStreamService {
    #[allow(dead_code)]
    store: Arc<CacheStore>,
}

impl ByteStreamService {
    pub fn new(store: Arc<CacheStore>) -> Self {
        Self { store }
    }
}

#[tonic::async_trait]
impl byte_stream_server::ByteStream for ByteStreamService {
    type ReadStream = ReceiverStream<Result<ReadResponse, tonic::Status>>;

    #[tracing::instrument]
    async fn read(
        &self,
        _req: tonic::Request<ReadRequest>,
    ) -> Result<tonic::Response<Self::ReadStream>, tonic::Status> {
        Err(tonic::Status::unimplemented("read is not implemented"))
    }

    #[tracing::instrument]
    async fn write(
        &self,
        _req: tonic::Request<tonic::Streaming<WriteRequest>>,
    ) -> Result<tonic::Response<WriteResponse>, tonic::Status> {
        Err(tonic::Status::unimplemented("write is not implemented"))
    }

    #[tracing::instrument]
    async fn query_write_status(
        &self,
        _req: tonic::Request<QueryWriteStatusRequest>,
    ) -> Result<tonic::Response<QueryWriteStatusResponse>, tonic::Status> {
        Err(tonic::Status::unimplemented(
            "query_write_status is not implemented",
        ))
    }
}

// ---------------------------------------------------------------------------------------------------------------------
