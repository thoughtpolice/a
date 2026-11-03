// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Hosts and members on this machine, with no relays and no lookup:
//! members dial the host's own addresses.

use iroh::endpoint::Connection;

use super::*;

/// The protocol the tests speak.
pub(crate) const PROTOCOL: Protocol = Protocol {
    alpn: b"iroh-mesh/test/1",
    name: "iroh-mesh test",
    host: "host",
    member: "member",
};

/// An endpoint on loopback, accepting members if `host`.
async fn endpoint(host: bool) -> Endpoint {
    let (key, preset, transport) = (
        SecretKey::generate(),
        iroh_dial::Global::none(),
        Transport::default(),
    );
    if host {
        PROTOCOL.bind_host(key, preset, &transport).await
    } else {
        PROTOCOL.bind_member(key, preset, &transport).await
    }
    .expect("bind")
}

fn channel(conn: Connection) -> tonic::transport::Channel {
    crate::channel(conn, &Transport::default())
}

async fn join(conn: &Connection, me: EndpointId, key: &JoinKey) -> Result<(), JoinError> {
    PROTOCOL.join(conn, me, key).await
}

async fn admit(conn: &Connection, me: EndpointId, keys: &[JoinKey]) -> Result<(), JoinError> {
    PROTOCOL.admit(conn, me, keys).await
}

/// A member's connection to `host`, and the host's to the member.
async fn connect(host: &Endpoint, member: &Endpoint) -> (Connection, Connection) {
    let accepting = {
        let host = host.clone();
        tokio::spawn(async move { host.accept().await.expect("open").await.expect("accept") })
    };
    let ours = member
        .connect(iroh_utils::dialable_addr(host), PROTOCOL.alpn)
        .await
        .expect("connect");
    (ours, accepting.await.expect("accepted"))
}

#[tokio::test]
async fn a_member_with_the_key_is_admitted_and_admits_the_host() {
    let (host, member) = (endpoint(true).await, endpoint(false).await);
    let key = JoinKey::generate();
    let (to_host, to_member) = connect(&host, &member).await;
    let keys = [JoinKey::generate(), key.clone()];
    let (joined, admitted) = tokio::join!(
        join(&to_host, member.id(), &key),
        admit(&to_member, host.id(), &keys),
    );
    joined.expect("joined");
    admitted.expect("admitted");
}

#[tokio::test]
async fn a_member_without_the_key_is_sent_away() {
    let (host, member) = (endpoint(true).await, endpoint(false).await);
    let (to_host, to_member) = connect(&host, &member).await;
    let (theirs, ours) = (JoinKey::generate(), [JoinKey::generate()]);
    let (joined, admitted) = tokio::join!(
        join(&to_host, member.id(), &theirs),
        admit(&to_member, host.id(), &ours),
    );
    assert!(
        matches!(admitted, Err(JoinError::UnknownMember)),
        "{admitted:?}"
    );
    assert!(
        matches!(joined, Err(JoinError::UnknownMember)),
        "{joined:?}"
    );
}

#[tokio::test]
async fn a_host_that_cannot_prove_the_key_is_not_trusted() {
    let (host, member) = (endpoint(true).await, endpoint(false).await);
    let (to_host, to_member) = connect(&host, &member).await;
    // An impostor answers anything at all.
    let impostor = tokio::spawn(async move {
        let (mut send, mut recv) = to_member.accept_bi().await.expect("a stream");
        let _ = recv.read_to_end(64).await;
        send.write_all(&[7; 32]).await.expect("write");
        send.finish().expect("finish");
        to_member.closed().await;
    });
    let joined = join(&to_host, member.id(), &JoinKey::generate()).await;
    assert!(matches!(joined, Err(JoinError::UnknownHost)), "{joined:?}");
    impostor.abort();
}

#[tokio::test]
async fn a_refusal_whose_stream_ends_before_the_close_reads_as_one() {
    let (host, member) = (endpoint(true).await, endpoint(false).await);
    let (to_host, to_member) = connect(&host, &member).await;
    // As `admit` does when refusing, but with the stream's end and the
    // close in separate packets, as a busy host may send them.
    let refusing = tokio::spawn(async move {
        let (send, mut recv) = to_member.accept_bi().await.expect("a stream");
        let _ = recv.read_to_end(64).await;
        drop(send);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        to_member.close(CLOSE_REFUSED, b"not admitted");
    });
    let joined = join(&to_host, member.id(), &JoinKey::generate()).await;
    assert!(
        matches!(joined, Err(JoinError::UnknownMember)),
        "{joined:?}"
    );
    refusing.await.expect("refused");
}

#[tokio::test]
async fn a_proof_is_good_only_between_the_two_it_names() {
    let (host, member, other) = (
        endpoint(true).await,
        endpoint(false).await,
        endpoint(false).await,
    );
    let key = JoinKey::generate();
    // A member that relays another's proof: the host checks it against
    // the IDs of its own connection, not the ones the proof was made for.
    let (to_host, to_member) = connect(&host, &other).await;
    let keys = [key.clone()];
    let (joined, admitted) = tokio::join!(
        join(&to_host, member.id(), &key),
        admit(&to_member, host.id(), &keys),
    );
    assert!(admitted.is_err() && joined.is_err());
}

/// A host serving the gRPC health service to joined members.
fn serve_health(host: &Endpoint, keys: Vec<JoinKey>) -> tokio::sync::oneshot::Sender<()> {
    let (_reporter, health) = tonic_health::server::health_reporter();
    let routes = tonic::service::Routes::new(health).prepare();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(dial9_tonic::serve_traced(
        PROTOCOL.serve(host.clone(), keys),
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
async fn joined_members_reach_the_hosts_grpc_services() {
    let (host, member) = (endpoint(true).await, endpoint(false).await);
    let key = JoinKey::generate();
    let _stop = serve_health(&host, vec![key.clone()]);
    let conn = member
        .connect(iroh_utils::dialable_addr(&host), PROTOCOL.alpn)
        .await
        .expect("connect");
    join(&conn, member.id(), &key).await.expect("join");
    let joined = channel(conn);
    // Twice over one channel, and over a second channel on the same
    // connection, which is a second stream.
    for _ in 0..2 {
        assert_eq!(check(joined.clone()).await.expect("check"), 1);
    }
    assert_eq!(
        check(channel(connect_again(&member, &host, &key).await))
            .await
            .expect("check"),
        1
    );
}

async fn connect_again(member: &Endpoint, host: &Endpoint, key: &JoinKey) -> Connection {
    let conn = member
        .connect(iroh_utils::dialable_addr(host), PROTOCOL.alpn)
        .await
        .expect("connect");
    join(&conn, member.id(), key).await.expect("join");
    conn
}

#[tokio::test]
async fn a_member_that_has_not_joined_gets_nothing() {
    let (host, member) = (endpoint(true).await, endpoint(false).await);
    let _stop = serve_health(&host, vec![JoinKey::generate()]);
    let conn = member
        .connect(iroh_utils::dialable_addr(&host), PROTOCOL.alpn)
        .await
        .expect("connect");
    // Straight to gRPC: the host takes the stream for a handshake, which
    // fails, and closes the connection.
    let checked = tokio::time::timeout(std::time::Duration::from_secs(20), check(channel(conn)))
        .await
        .expect("an answer in time");
    assert!(checked.is_err(), "{checked:?}");
}

/// A member that knows only the host's join code finds the host on the
/// DHT and joins it. The DHT is a private testnet on loopback, so this
/// never touches the real mainline network.
#[tokio::test(flavor = "multi_thread")]
async fn a_member_finds_and_joins_a_host_by_its_code() {
    let testnet = iroh_rendezvous::n0_mainline::Testnet::new(5)
        .await
        .expect("a DHT testnet");
    let dht = || {
        Dht::builder()
            .bootstrap(&testnet.bootstrap)
            .build()
            .expect("joining the testnet")
    };
    let cluster = JoinCode::generate().cluster(&PROTOCOL);
    let (host, member) = (endpoint(true).await, endpoint(false).await);
    let _stop = serve_health(&host, vec![JoinKey::generate(), cluster.key()]);
    let announcing = Cluster::rendezvous(&host, Some(dht())).expect("rendezvous");
    let _announcer = cluster.announce(&announcing);

    let finding = Cluster::rendezvous(&member, Some(dht())).expect("rendezvous");
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    let found = loop {
        let found = cluster.hosts(&finding).await.expect("finding");
        if !found.is_empty() {
            break found;
        }
        assert!(tokio::time::Instant::now() < deadline, "no host announced");
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    };
    assert_eq!(found, [host.id()]);
    assert!(
        JoinCode::generate()
            .cluster(&PROTOCOL)
            .hosts(&finding)
            .await
            .expect("finding")
            .is_empty(),
        "another cluster's hosts stay hidden"
    );

    // No address lookup here, so dial the address directly.
    let conn = member
        .connect(iroh_utils::dialable_addr(&host), PROTOCOL.alpn)
        .await
        .expect("connect");
    join(&conn, member.id(), &cluster.key())
        .await
        .expect("join");
    assert_eq!(check(channel(conn)).await.expect("check"), 1);
}

/// gonzo's daemons and workers predate this crate, and its protocol must
/// keep producing the proofs and clusters they compute: the bytes here are
/// the ones gonzo hashed before.
#[test]
fn proofs_and_code_salts_keep_their_wire_format() {
    let gonzo = Protocol {
        alpn: b"gonzo/worker/1",
        name: "gonzo",
        host: "daemon",
        member: "worker",
    };
    assert_eq!(gonzo.code_salt(), "gonzo join code v1");
    let key = JoinKey::generate();
    let (host, member) = (
        SecretKey::generate().public(),
        SecretKey::generate().public(),
    );
    for role in ["worker", "daemon"] {
        let mut hasher = blake3::Hasher::new_keyed(&key.0);
        hasher.update(b"gonzo join v1 ");
        hasher.update(role.as_bytes());
        hasher.update(host.as_bytes());
        hasher.update(member.as_bytes());
        assert_eq!(
            crate::join::proof(&gonzo, &key, role, host, member),
            hasher.finalize(),
            "{role}"
        );
    }
    assert_ne!(
        crate::join::proof(&gonzo, &key, "worker", host, member),
        crate::join::proof(&PROTOCOL, &key, "worker", host, member),
        "another protocol's proofs differ"
    );
}
