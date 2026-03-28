// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use std::{net::SocketAddr, sync::Arc, time::Duration};

use dial9_tokio_telemetry::telemetry::TelemetryHandle;

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
    request_timeout: Option<Duration>,
    max_concurrent_requests: Option<usize>,
    handle: TelemetryHandle,
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

    let cas_service = service::ContentAddressableStorageService::new(store.clone(), handle.clone());
    let action_cache_service = service::ActionCacheService::new(store.clone());
    let bytestream_service = service::ByteStreamService::new(store.clone(), handle.clone());
    let execution_service = service::ExecutionService::default();
    let capabilities_service = service::CapabilitiesService::default();
    let operations_service = service::OperationsService::default();
    let fetch_service = service::FetchService::new(store.clone());
    let push_service = service::PushService::new(store.clone());
    let logstream_service = service::LogStreamSvc::default();
    let reflection_service = tonic_reflection::server::Builder::configure()
        .register_encoded_file_descriptor_set(protos::FILE_DESCRIPTOR_SET)
        .register_encoded_file_descriptor_set(tonic_health::pb::FILE_DESCRIPTOR_SET)
        .build_v1()
        .unwrap();

    // Build routes using tonic::service::Routes directly — we bypass tonic's
    // transport layer so we can run our own traced accept loop.
    let routes = tonic::service::Routes::new(CapabilitiesServer::new(capabilities_service))
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
        .prepare();

    let effective_limit = max_concurrent_requests.unwrap_or(8192);

    let listener = tokio::net::TcpListener::bind(address).await?;

    // Apply global concurrency limit, then optionally a per-request timeout.
    // The two branches avoid complex type-erasure; serve_traced is generic.
    if let Some(timeout) = request_timeout {
        let svc = tower::limit::ConcurrencyLimit::new(
            tower::timeout::Timeout::new(routes, timeout),
            effective_limit,
        );
        dial9_tonic::serve_traced(listener, svc, handle, shutdown).await
    } else {
        let svc = tower::limit::ConcurrencyLimit::new(routes, effective_limit);
        dial9_tonic::serve_traced(listener, svc, handle, shutdown).await
    }
}
