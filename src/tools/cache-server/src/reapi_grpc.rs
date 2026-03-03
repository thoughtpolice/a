// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use std::{net::SocketAddr, sync::Arc, time::Duration};

use crate::store::CacheStore;

use protos::google::bytestream::byte_stream_server::ByteStreamServer;

use protos::build::bazel::remote::asset::v1::{fetch_server::FetchServer, push_server::PushServer};
use protos::build::bazel::remote::execution::v2::{
    action_cache_server::ActionCacheServer, capabilities_server::CapabilitiesServer,
    content_addressable_storage_server::ContentAddressableStorageServer,
    execution_server::ExecutionServer,
};
use protos::build::bazel::remote::logstream::v1::log_stream_service_server::LogStreamServiceServer;
use protos::google::longrunning::operations_server::OperationsServer;

// ---------------------------------------------------------------------------------------------------------------------

pub async fn start_reapi_grpc(
    address: SocketAddr,
    shutdown: impl Future<Output = ()> + Send + 'static,
    store: Arc<CacheStore>,
) -> Result<(), Box<dyn std::error::Error>> {
    use crate::service;

    let (health_reporter, health_service) = tonic_health::server::health_reporter();
    health_reporter
        .set_serving::<CapabilitiesServer<service::CapabilitiesService>>()
        .await;
    health_reporter
        .set_serving::<ContentAddressableStorageServer<service::ContentAddressableStorageService>>()
        .await;
    health_reporter
        .set_serving::<ActionCacheServer<service::ActionCacheService>>()
        .await;
    health_reporter
        .set_serving::<ExecutionServer<service::ExecutionService>>()
        .await;
    health_reporter
        .set_serving::<ByteStreamServer<service::ByteStreamService>>()
        .await;
    health_reporter
        .set_serving::<FetchServer<service::FetchService>>()
        .await;
    health_reporter
        .set_serving::<PushServer<service::PushService>>()
        .await;
    health_reporter
        .set_serving::<LogStreamServiceServer<service::LogStreamSvc>>()
        .await;

    let cas_service = service::ContentAddressableStorageService::new(store.clone());
    let action_cache_service = service::ActionCacheService::new(store.clone());
    let bytestream_service = service::ByteStreamService::new(store.clone());
    let execution_service = service::ExecutionService::default();
    let capabilities_service = service::CapabilitiesService::default();
    let operations_service = service::OperationsService::default();
    let fetch_service = service::FetchService::default();
    let push_service = service::PushService::default();
    let logstream_service = service::LogStreamSvc::default();
    let reflection_service = tonic_reflection::server::Builder::configure()
        .register_encoded_file_descriptor_set(protos::FILE_DESCRIPTOR_SET)
        .register_encoded_file_descriptor_set(tonic_health::pb::FILE_DESCRIPTOR_SET)
        .build_v1()
        .unwrap();

    tonic::transport::Server::builder()
        .initial_connection_window_size(16 * 1024 * 1024) // 16 MiB
        .initial_stream_window_size(8 * 1024 * 1024) // 8 MiB
        .http2_adaptive_window(Some(true))
        .max_frame_size(Some(1024 * 1024)) // 1 MiB (default 16 KiB)
        .tcp_nodelay(true)
        .tcp_keepalive(Some(std::time::Duration::from_secs(60)))
        .http2_keepalive_interval(Some(std::time::Duration::from_secs(30)))
        .http2_keepalive_timeout(Some(std::time::Duration::from_secs(10)))
        .concurrency_limit_per_connection(256)
        .add_service(CapabilitiesServer::new(capabilities_service))
        .add_service(ContentAddressableStorageServer::new(cas_service))
        .add_service(ActionCacheServer::new(action_cache_service))
        .add_service(ExecutionServer::new(execution_service))
        .add_service(ByteStreamServer::new(bytestream_service))
        .add_service(OperationsServer::new(operations_service))
        .add_service(FetchServer::new(fetch_service))
        .add_service(PushServer::new(push_service))
        .add_service(LogStreamServiceServer::new(logstream_service))
        .add_service(health_service)
        .add_service(reflection_service)
        .serve_with_shutdown(address, shutdown)
        .await?;
    Ok(())
}
