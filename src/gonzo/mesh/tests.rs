// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Daemons and workers on this machine, with no relays and no lookup:
//! workers dial the daemon's own addresses.

use iroh::endpoint::Connection;

use super::*;

/// An endpoint on loopback, accepting workers if `daemon`.
async fn endpoint(daemon: bool) -> Endpoint {
    let mut builder = iroh_boring::builder();
    if daemon {
        builder = builder.alpns(vec![ALPN.to_vec()]);
    }
    builder.bind().await.expect("bind")
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
    let keys = [JoinKey::for_cluster("other"), key.clone()];
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
