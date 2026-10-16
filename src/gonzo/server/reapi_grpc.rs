// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The daemon's front end: which services each kind of peer reaches, and
//! the listeners they reach them on.
//!
//! Clients (Buck, over loopback TCP) get the whole of the REAPI, with
//! storage calls answered by the store and execution calls by the
//! scheduler. Workers get only what they need: the CAS and ByteStream for
//! inputs and outputs, and their sessions with the scheduler.

use std::{net::SocketAddr, sync::Arc, time::Duration};

use accept::Accept;
use dial9::Dial9TokioHandle;
use rustls_transport::TlsAccept;
use tower::Layer;

use crate::store::CacheStore;

use gonzo_protos::worker::v1::scheduler_server::SchedulerServer;
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

/// The daemon's services, and the route table each kind of peer gets.
#[derive(Clone)]
pub struct Frontend {
    pub store: Arc<CacheStore>,
    pub scheduler: scheduler::Scheduler,
    pub fetch_config: api::FetchConfig,
    pub handle: Dial9TokioHandle,
}

impl Frontend {
    /// Everything, for clients.
    fn client_routes(&self) -> tonic::service::Routes {
        let store = &self.store;
        let reflection_service = tonic_reflection::server::Builder::configure()
            .register_encoded_file_descriptor_set(protos::FILE_DESCRIPTOR_SET)
            .register_encoded_file_descriptor_set(tonic_health::pb::FILE_DESCRIPTOR_SET)
            .build_v1()
            .unwrap();
        tonic::service::Routes::new(CapabilitiesServer::new(api::CapabilitiesService::new(true)))
            .add_service(api::CasServer::new(
                api::ContentAddressableStorageService::new(store.clone(), self.handle.clone()),
            ))
            .add_service(ActionCacheServer::new(api::ActionCacheService::new(
                store.clone(),
            )))
            .add_service(ExecutionServer::new(scheduler::ExecutionService::new(
                self.scheduler.clone(),
                store.clone(),
            )))
            .add_service(ByteStreamServer::new(api::ByteStreamService::new(
                store.clone(),
                self.handle.clone(),
            )))
            .add_service(OperationsServer::new(scheduler::OperationsService::new(
                self.scheduler.clone(),
            )))
            .add_service(FetchServer::new(api::FetchService::new(
                store.clone(),
                self.handle.clone(),
                self.fetch_config.clone(),
            )))
            .add_service(PushServer::new(api::PushService::new(store.clone())))
            .add_service(LogStreamServiceServer::new(api::LogStreamSvc::default()))
            .add_service(reflection_service)
    }

    /// What a worker needs: its inputs, somewhere to put its outputs, and
    /// a session with the scheduler.
    fn worker_routes(&self) -> tonic::service::Routes {
        let store = &self.store;
        tonic::service::Routes::new(CapabilitiesServer::new(api::CapabilitiesService::new(true)))
            .add_service(api::CasServer::new(
                api::ContentAddressableStorageService::new(store.clone(), self.handle.clone()),
            ))
            .add_service(ByteStreamServer::new(api::ByteStreamService::new(
                store.clone(),
                self.handle.clone(),
            )))
            .add_service(SchedulerServer::new(scheduler::WorkerSessions::new(
                self.scheduler.clone(),
                store.clone(),
            )))
    }
}

pub async fn start_reapi_grpc(
    address: SocketAddr,
    tls: Option<Arc<rustls::ServerConfig>>,
    shutdown: impl Future<Output = ()> + Send + 'static,
    frontend: &Frontend,
    request_timeout: Option<Duration>,
    max_concurrent_requests: Option<usize>,
    max_connections: usize,
    pressure_monitor: Option<runtime::psi::PressureMonitor>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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
        fetch: frontend
            .fetch_config
            .max_fetch_time
            .map(|max| max + api::FETCH_TIMEOUT_MARGIN),
    };

    // Build routes using tonic::service::Routes directly — we bypass tonic's
    // transport layer so we can run our own traced accept loop.
    let routes = frontend
        .client_routes()
        .add_service(health_service)
        .prepare();

    let effective_limit = max_concurrent_requests.unwrap_or(8192);

    // Connections are capped below the open-files limit (TLS handshakes in
    // flight included), so the store always has descriptors left. At the
    // cap, the connection that has gone longest without a request makes
    // room for a newcomer.
    let listener = accept::Limited::new(
        tokio::net::TcpListener::bind(address).await?,
        max_connections,
    );
    let limits = dial9_tonic::ConnectionLimits {
        make_room: Some(listener.room_wanted()),
        ..Default::default()
    };
    let handle = frontend.handle.clone();

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
                limits,
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
                limits,
            )
            .await
        }
    }
}

/// Serve workers on `acceptor`: the daemon's own worker, through an
/// in-process pipe.
///
/// Worker traffic is never shed under memory pressure: refusing a worker
/// its inputs fails the action outright, where refusing a client only
/// sends it to build locally.
pub async fn serve_workers<A: Accept>(
    acceptor: A,
    frontend: &Frontend,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let timeouts = crate::request_timeout::RequestTimeouts {
        default: None,
        fetch: None,
    };
    serve_stack(
        acceptor,
        frontend.worker_routes().prepare(),
        timeouts,
        8192,
        None,
        frontend.handle.clone(),
        shutdown,
        dial9_tonic::ConnectionLimits::default(),
    )
    .await
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
    use tonic::server::NamedService;

    for name in [
        <CapabilitiesServer<api::CapabilitiesService> as NamedService>::NAME,
        <ContentAddressableStorageServer<api::ContentAddressableStorageService> as NamedService>::NAME,
        <ActionCacheServer<api::ActionCacheService> as NamedService>::NAME,
        <ExecutionServer<scheduler::ExecutionService> as NamedService>::NAME,
        <ByteStreamServer<api::ByteStreamService> as NamedService>::NAME,
        <FetchServer<api::FetchService> as NamedService>::NAME,
        <PushServer<api::PushService> as NamedService>::NAME,
        <LogStreamServiceServer<api::LogStreamSvc> as NamedService>::NAME,
    ] {
        health.set_service_status(name, status).await;
    }
}

/// Serve the prepared routes over any transport: plain TCP, TLS, an
/// in-process pipe, or later an iroh acceptor.
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
    limits: dial9_tonic::ConnectionLimits,
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
            dial9_tonic::serve_traced_with(acceptor, svc, handle, shutdown, limits).await
        }
        None => dial9_tonic::serve_traced_with(acceptor, svc, handle, shutdown, limits).await,
    }
}
