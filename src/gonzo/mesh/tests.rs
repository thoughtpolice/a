// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Daemons and workers on this machine, with no relays and no lookup:
//! workers dial the daemon's own addresses.

use iroh::endpoint::Connection;

use super::*;

/// An endpoint on loopback, accepting workers if `daemon`.
async fn endpoint(daemon: bool) -> Endpoint {
    bind(SecretKey::generate(), daemon, iroh_dial::Global::none())
        .await
        .expect("bind")
}

/// A worker's connection to `daemon`, and the daemon's to the worker.
async fn connect(daemon: &Endpoint, worker: &Endpoint) -> (Connection, Connection) {
    let accepting = {
        let daemon = daemon.clone();
        tokio::spawn(async move { daemon.accept().await.expect("open").await.expect("accept") })
    };
    let ours = worker
        .connect(iroh_utils::dialable_addr(daemon), ALPN)
        .await
        .expect("connect");
    (ours, accepting.await.expect("accepted"))
}

#[tokio::test]
async fn a_worker_with_the_key_is_admitted_and_admits_the_daemon() {
    let (daemon, worker) = (endpoint(true).await, endpoint(false).await);
    let key = JoinKey::generate();
    let (to_daemon, to_worker) = connect(&daemon, &worker).await;
    let keys = [JoinKey::generate(), key.clone()];
    let (joined, admitted) = tokio::join!(
        join(&to_daemon, worker.id(), &key),
        admit(&to_worker, daemon.id(), &keys),
    );
    joined.expect("joined");
    admitted.expect("admitted");
}

#[tokio::test]
async fn a_worker_without_the_key_is_sent_away() {
    let (daemon, worker) = (endpoint(true).await, endpoint(false).await);
    let (to_daemon, to_worker) = connect(&daemon, &worker).await;
    let (theirs, ours) = (JoinKey::generate(), [JoinKey::generate()]);
    let (joined, admitted) = tokio::join!(
        join(&to_daemon, worker.id(), &theirs),
        admit(&to_worker, daemon.id(), &ours),
    );
    assert!(
        matches!(admitted, Err(JoinError::UnknownWorker)),
        "{admitted:?}"
    );
    assert!(
        matches!(joined, Err(JoinError::UnknownWorker)),
        "{joined:?}"
    );
}

#[tokio::test]
async fn a_daemon_that_cannot_prove_the_key_is_not_trusted() {
    let (daemon, worker) = (endpoint(true).await, endpoint(false).await);
    let (to_daemon, to_worker) = connect(&daemon, &worker).await;
    // An impostor answers anything at all.
    let impostor = tokio::spawn(async move {
        let (mut send, mut recv) = to_worker.accept_bi().await.expect("a stream");
        let _ = recv.read_to_end(64).await;
        send.write_all(&[7; 32]).await.expect("write");
        send.finish().expect("finish");
        to_worker.closed().await;
    });
    let joined = join(&to_daemon, worker.id(), &JoinKey::generate()).await;
    assert!(
        matches!(joined, Err(JoinError::UnknownDaemon)),
        "{joined:?}"
    );
    impostor.abort();
}

#[tokio::test]
async fn a_refusal_whose_stream_ends_before_the_close_reads_as_one() {
    let (daemon, worker) = (endpoint(true).await, endpoint(false).await);
    let (to_daemon, to_worker) = connect(&daemon, &worker).await;
    // As `admit` does when refusing, but with the stream's end and the
    // close in separate packets, as a busy daemon may send them.
    let refusing = tokio::spawn(async move {
        let (send, mut recv) = to_worker.accept_bi().await.expect("a stream");
        let _ = recv.read_to_end(64).await;
        drop(send);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        to_worker.close(CLOSE_REFUSED, b"not admitted");
    });
    let joined = join(&to_daemon, worker.id(), &JoinKey::generate()).await;
    assert!(
        matches!(joined, Err(JoinError::UnknownWorker)),
        "{joined:?}"
    );
    refusing.await.expect("refused");
}

#[tokio::test]
async fn a_proof_is_good_only_between_the_two_it_names() {
    let (daemon, worker, other) = (
        endpoint(true).await,
        endpoint(false).await,
        endpoint(false).await,
    );
    let key = JoinKey::generate();
    // A worker that relays another's proof: the daemon checks it against
    // the IDs of its own connection, not the ones the proof was made for.
    let (to_daemon, to_worker) = connect(&daemon, &other).await;
    let keys = [key.clone()];
    let (joined, admitted) = tokio::join!(
        join(&to_daemon, worker.id(), &key),
        admit(&to_worker, daemon.id(), &keys),
    );
    assert!(admitted.is_err() && joined.is_err());
}

/// A daemon serving the gRPC health service to joined workers.
fn serve_health(daemon: &Endpoint, keys: Vec<JoinKey>) -> tokio::sync::oneshot::Sender<()> {
    let (_reporter, health) = tonic_health::server::health_reporter();
    let routes = tonic::service::Routes::new(health).prepare();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(dial9_tonic::serve_traced(
        serve(daemon.clone(), keys),
        routes,
        dial9::Dial9TokioHandle::disabled(),
        async move {
            let _ = stopped.await;
        },
    ));
    stop
}

async fn check(channel: tonic::transport::Channel) -> Result<i32, tonic::Status> {
    use tonic_health::pb::{HealthCheckRequest, health_client::HealthClient};
    let response = HealthClient::new(channel)
        .check(HealthCheckRequest {
            service: String::new(),
        })
        .await?;
    Ok(response.into_inner().status)
}

#[tokio::test]
async fn joined_workers_reach_the_daemons_grpc_services() {
    let (daemon, worker) = (endpoint(true).await, endpoint(false).await);
    let key = JoinKey::generate();
    let _stop = serve_health(&daemon, vec![key.clone()]);
    let conn = worker
        .connect(iroh_utils::dialable_addr(&daemon), ALPN)
        .await
        .expect("connect");
    join(&conn, worker.id(), &key).await.expect("join");
    let channel = channel(conn);
    // Twice over one channel, and over a second channel on the same
    // connection, which is a second stream.
    for _ in 0..2 {
        assert_eq!(check(channel.clone()).await.expect("check"), 1);
    }
    assert_eq!(
        check(super::channel(connect_again(&worker, &daemon, &key).await))
            .await
            .expect("check"),
        1
    );
}

async fn connect_again(worker: &Endpoint, daemon: &Endpoint, key: &JoinKey) -> Connection {
    let conn = worker
        .connect(iroh_utils::dialable_addr(daemon), ALPN)
        .await
        .expect("connect");
    join(&conn, worker.id(), key).await.expect("join");
    conn
}

#[tokio::test]
async fn a_worker_that_has_not_joined_gets_nothing() {
    let (daemon, worker) = (endpoint(true).await, endpoint(false).await);
    let _stop = serve_health(&daemon, vec![JoinKey::generate()]);
    let conn = worker
        .connect(iroh_utils::dialable_addr(&daemon), ALPN)
        .await
        .expect("connect");
    // Straight to gRPC: the daemon takes the stream for a handshake, which
    // fails, and closes the connection.
    let checked = tokio::time::timeout(std::time::Duration::from_secs(20), check(channel(conn)))
        .await
        .expect("an answer in time");
    assert!(checked.is_err(), "{checked:?}");
}

/// A worker that knows only the daemon's join code finds the daemon on the
/// DHT and joins it. The DHT is a private testnet on loopback, so this
/// never touches the real mainline network.
#[tokio::test(flavor = "multi_thread")]
async fn a_worker_finds_and_joins_a_daemon_by_its_code() {
    let testnet = iroh_rendezvous::n0_mainline::Testnet::new(5)
        .await
        .expect("a DHT testnet");
    let dht = || {
        Dht::builder()
            .bootstrap(&testnet.bootstrap)
            .build()
            .expect("joining the testnet")
    };
    let cluster = JoinCode::generate().cluster();
    let (daemon, worker) = (endpoint(true).await, endpoint(false).await);
    let _stop = serve_health(&daemon, vec![JoinKey::generate(), cluster.key()]);
    let announcing = Cluster::rendezvous(&daemon, Some(dht())).expect("rendezvous");
    let _announcer = cluster.announce(&announcing);

    let finding = Cluster::rendezvous(&worker, Some(dht())).expect("rendezvous");
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    let found = loop {
        let found = cluster.daemons(&finding).await.expect("finding");
        if !found.is_empty() {
            break found;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no daemon announced"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    };
    assert_eq!(found, [daemon.id()]);
    assert!(
        JoinCode::generate()
            .cluster()
            .daemons(&finding)
            .await
            .expect("finding")
            .is_empty(),
        "another cluster's daemons stay hidden"
    );

    // No address lookup here, so dial the address directly.
    let conn = worker
        .connect(iroh_utils::dialable_addr(&daemon), ALPN)
        .await
        .expect("connect");
    join(&conn, worker.id(), &cluster.key())
        .await
        .expect("join");
    assert_eq!(check(channel(conn)).await.expect("check"), 1);
}
