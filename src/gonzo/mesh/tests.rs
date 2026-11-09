// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! gRPC between a daemon and its workers over the mesh, on this machine,
//! with no relays and no lookup: workers dial the daemon's own addresses.

use iroh::endpoint::Connection;

use super::*;

/// An endpoint on loopback, accepting workers if `daemon`.
async fn endpoint(daemon: bool) -> Endpoint {
    let (key, preset, transport) = (
        SecretKey::generate(),
        iroh_dial::Global::none(),
        Transport::default(),
    );
    if daemon {
        PROTOCOL.bind_host(key, preset, &transport).await
    } else {
        PROTOCOL.bind_member(key, preset, &transport).await
    }
    .expect("bind")
}

/// A daemon serving the gRPC health service to joined workers.
fn serve_health(daemon: &Endpoint, keys: Vec<JoinKey>) -> tokio::sync::oneshot::Sender<()> {
    let (_reporter, health) = tonic_health::server::health_reporter();
    let routes = tonic::service::Routes::new(health).prepare();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(dial9_tonic::serve_traced(
        PROTOCOL.serve(daemon.clone(), keys),
        routes,
        dial9::Dial9TokioHandle::disabled(),
        async move {
            let _ = stopped.await;
        },
    ));
    stop
}

async fn check(conn: Connection) -> Result<i32, tonic::Status> {
    use tonic_health::pb::{HealthCheckRequest, health_client::HealthClient};
    let response = HealthClient::new(channel(conn, &Transport::default()))
        .check(HealthCheckRequest {
            service: String::new(),
        })
        .await?;
    Ok(response.into_inner().status)
}

async fn connect(worker: &Endpoint, daemon: &Endpoint) -> Connection {
    worker
        .connect(iroh_utils::dialable_addr(daemon), PROTOCOL.alpn)
        .await
        .expect("connect")
}

#[tokio::test]
async fn joined_workers_reach_the_daemons_grpc_services() {
    let (daemon, worker) = (endpoint(true).await, endpoint(false).await);
    let key = JoinKey::generate();
    let _stop = serve_health(&daemon, vec![key.clone()]);
    let conn = connect(&worker, &daemon).await;
    PROTOCOL.join(&conn, worker.id(), &key).await.expect("join");
    // Twice over one connection (each channel's connection is a stream of
    // it), and over a second connection.
    for _ in 0..2 {
        assert_eq!(check(conn.clone()).await.expect("check"), 1);
    }
    let again = connect(&worker, &daemon).await;
    PROTOCOL
        .join(&again, worker.id(), &key)
        .await
        .expect("join");
    assert_eq!(check(again).await.expect("check"), 1);
}

#[tokio::test]
async fn a_worker_that_has_not_joined_gets_no_services() {
    let (daemon, worker) = (endpoint(true).await, endpoint(false).await);
    let _stop = serve_health(&daemon, vec![JoinKey::generate()]);
    let conn = connect(&worker, &daemon).await;
    // Straight to gRPC: the daemon takes the stream for a handshake, which
    // fails, and closes the connection.
    let checked = tokio::time::timeout(std::time::Duration::from_secs(20), check(conn))
        .await
        .expect("an answer in time");
    assert!(checked.is_err(), "{checked:?}");
}
