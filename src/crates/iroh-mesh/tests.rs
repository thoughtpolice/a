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

/// A host that echoes, on every stream its joined members open, what they
/// send, until it is stopped.
fn serve_echo(host: &Endpoint, keys: Vec<JoinKey>) -> tokio::sync::oneshot::Sender<()> {
    use accept::Accept as _;
    let mut streams = PROTOCOL.serve(host.clone(), keys);
    let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                stream = streams.accept() => match stream {
                    Ok(Some(stream)) => {
                        tokio::spawn(async move {
                            let (mut recv, mut send) = tokio::io::split(stream);
                            let _ = tokio::io::copy(&mut recv, &mut send).await;
                            let _ = tokio::io::AsyncWriteExt::shutdown(&mut send).await;
                        });
                    }
                    _ => return,
                },
                _ = &mut stopped => return,
            }
        }
    });
    stop
}

/// Send `message` on a new stream of `conn`, and read what comes back.
async fn echo(conn: &Connection, message: &[u8]) -> Result<Vec<u8>, String> {
    let (mut send, mut recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
    send.write_all(message).await.map_err(|e| e.to_string())?;
    send.finish().map_err(|e| e.to_string())?;
    recv.read_to_end(1024).await.map_err(|e| e.to_string())
}

#[tokio::test]
async fn joined_members_reach_the_hosts_streams() {
    let (host, member) = (endpoint(true).await, endpoint(false).await);
    let key = JoinKey::generate();
    let _stop = serve_echo(&host, vec![key.clone()]);
    let conn = member
        .connect(iroh_utils::dialable_addr(&host), PROTOCOL.alpn)
        .await
        .expect("connect");
    join(&conn, member.id(), &key).await.expect("join");
    // Two streams on one connection, and one on a second connection.
    for message in [&b"one"[..], b"two"] {
        assert_eq!(echo(&conn, message).await.expect("echo"), message);
    }
    let again = connect_again(&member, &host, &key).await;
    assert_eq!(echo(&again, b"three").await.expect("echo"), b"three");
}

/// The host reaches a member's connection through the streams it opens:
/// datagrams go both ways on it, beside the streams.
#[tokio::test]
async fn a_stream_carries_its_members_connection_for_datagrams() {
    use accept::Accept as _;
    let (host, member) = (endpoint(true).await, endpoint(false).await);
    let key = JoinKey::generate();
    let mut streams = PROTOCOL.serve(host.clone(), vec![key.clone()]);
    let conn = connect_again(&member, &host, &key).await;
    // A stream reaches the host once something is sent on it.
    let (mut send, _recv) = conn.open_bi().await.expect("open");
    send.write_all(b"hello").await.expect("write");
    let stream = streams.accept().await.expect("accept").expect("a stream");
    assert_eq!(stream.connection().remote_id(), member.id());
    conn.send_datagram(b"up"[..].into()).expect("send up");
    let up = stream.connection().read_datagram().await.expect("read up");
    assert_eq!(&up[..], b"up");
    stream
        .connection()
        .send_datagram(b"down"[..].into())
        .expect("send down");
    assert_eq!(&conn.read_datagram().await.expect("read down")[..], b"down");
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
    let _stop = serve_echo(&host, vec![JoinKey::generate()]);
    let conn = member
        .connect(iroh_utils::dialable_addr(&host), PROTOCOL.alpn)
        .await
        .expect("connect");
    // Straight to a stream of its own: the host takes it for a handshake,
    // which fails, and closes the connection.
    let echoed = tokio::time::timeout(std::time::Duration::from_secs(20), echo(&conn, &[0; 32]))
        .await
        .expect("an answer in time");
    assert!(echoed.is_err(), "{echoed:?}");
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
    let _stop = serve_echo(&host, vec![JoinKey::generate(), cluster.key()]);
    let announcing = Cluster::rendezvous(&host, Some(dht())).expect("rendezvous");
    cluster
        .announce_once(&announcing)
        .await
        .expect("announcing once");
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
    {
        use futures::StreamExt as _;
        let mut stream = cluster.host_stream(&finding).await.expect("finding");
        assert_eq!(
            stream.next().await,
            Some(host.id()),
            "the host, as it is found"
        );
    }
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
    assert_eq!(echo(&conn, b"hello").await.expect("echo"), b"hello");
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
