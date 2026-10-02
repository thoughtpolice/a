// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use std::{net::SocketAddr, sync::Arc, time::Duration};

use accept::Accept;
use dial9::Dial9TokioHandle;
use rustls_transport::TlsAccept;
use tower::Layer;

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
    tls: Option<Arc<rustls::ServerConfig>>,
    shutdown: impl Future<Output = ()> + Send + 'static,
    store: Arc<CacheStore>,
    request_timeout: Option<Duration>,
    max_concurrent_requests: Option<usize>,
    fetch_config: crate::service::FetchConfig,
    handle: Dial9TokioHandle,
    pressure_monitor: Option<runtime::psi::PressureMonitor>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use crate::service;

    let (health_reporter, health_service) = tonic_health::server::health_reporter();
    set_services_status(&health_reporter, tonic_health::ServingStatus::Serving).await;

    // Report every service NOT_SERVING as soon as shutdown begins, so load
    // balancers watching health stop routing here while connections drain.
    let shutdown = {
        let health = health_reporter.clone();
        async move {
            shutdown.await;
            set_not_serving(&health).await;
        }
    };

    let timeouts = crate::request_timeout::RequestTimeouts {
        default: request_timeout,
        fetch: fetch_config
            .max_fetch_time
            .map(|max| max + service::FETCH_TIMEOUT_MARGIN),
    };

    let cas_service = service::ContentAddressableStorageService::new(store.clone(), handle.clone());
    let action_cache_service = service::ActionCacheService::new(store.clone());
    let bytestream_service = service::ByteStreamService::new(store.clone(), handle.clone());
    let execution_service = service::ExecutionService::default();
    let capabilities_service = service::CapabilitiesService::default();
    let operations_service = service::OperationsService::default();
    let fetch_service = service::FetchService::new(store.clone(), handle.clone(), fetch_config);
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

    match tls {
        Some(config) => {
            serve_stack(
                TlsAccept::new(listener, config),
                routes,
                timeouts,
                effective_limit,
                pressure_monitor,
                handle,
                shutdown,
            )
            .await
        }
        None => {
            serve_stack(
                listener,
                routes,
                timeouts,
                effective_limit,
                pressure_monitor,
                handle,
                shutdown,
            )
            .await
        }
    }
}

/// Mark the server and each of its services NOT_SERVING.
async fn set_not_serving(health: &tonic_health::server::HealthReporter) {
    let status = tonic_health::ServingStatus::NotServing;
    health.set_service_status("", status).await;
    set_services_status(health, status).await;
}

/// Report each of the server's services `status`.
async fn set_services_status(
    health: &tonic_health::server::HealthReporter,
    status: tonic_health::ServingStatus,
) {
    use crate::service;
    use tonic::server::NamedService;

    for name in [
        <CapabilitiesServer<service::CapabilitiesService> as NamedService>::NAME,
        <ContentAddressableStorageServer<service::ContentAddressableStorageService> as NamedService>::NAME,
        <ActionCacheServer<service::ActionCacheService> as NamedService>::NAME,
        <ExecutionServer<service::ExecutionService> as NamedService>::NAME,
        <ByteStreamServer<service::ByteStreamService> as NamedService>::NAME,
        <FetchServer<service::FetchService> as NamedService>::NAME,
        <PushServer<service::PushService> as NamedService>::NAME,
        <LogStreamServiceServer<service::LogStreamSvc> as NamedService>::NAME,
    ] {
        health.set_service_status(name, status).await;
    }
}

/// Serve the prepared routes over any transport: plain TCP, TLS, or later
/// an iroh acceptor.
///
/// Applies the per-route request timeouts, then the global concurrency
/// limit. When a pressure monitor is available, wraps the outermost layer
/// with a gate that rejects requests under severe memory pressure
/// (UNAVAILABLE).
async fn serve_stack<A: Accept>(
    acceptor: A,
    routes: tonic::service::Routes,
    timeouts: crate::request_timeout::RequestTimeouts,
    effective_limit: usize,
    pressure_monitor: Option<runtime::psi::PressureMonitor>,
    handle: Dial9TokioHandle,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let svc = tower::limit::ConcurrencyLimit::new(
        crate::request_timeout::RequestTimeout::new(routes, timeouts),
        effective_limit,
    );
    match pressure_monitor {
        Some(monitor) => {
            let svc = crate::pressure_gate::PressureGateLayer::new(
                monitor,
                runtime::psi::PressureLevel::High,
            )
            .layer(svc);
            dial9_tonic::serve_traced(acceptor, svc, handle, shutdown).await
        }
        None => dial9_tonic::serve_traced(acceptor, svc, handle, shutdown).await,
    }
}
