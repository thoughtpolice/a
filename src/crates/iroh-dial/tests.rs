// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use super::*;

use iroh::SecretKey;
use n0_mainline::Testnet;

const ALPN: &[u8] = b"depot/iroh-dial/test";

#[test]
fn a_target_parses_from_every_form_of_an_id() {
    let id = SecretKey::generate().public();
    let bare = Target::from(id);

    assert_eq!(id.to_string().parse::<Target>(), Ok(bare.clone()));
    assert_eq!(id.to_z32().parse::<Target>(), Ok(bare.clone()));
    assert_eq!(format!("  {id}\n").parse::<Target>(), Ok(bare.clone()));
    assert_eq!(bare.to_string(), id.to_string());
}

#[test]
fn a_target_round_trips_through_a_ticket() {
    let id = SecretKey::generate().public();
    let addr = EndpointAddr::new(id).with_ip_addr("127.0.0.1:4433".parse().unwrap());
    let target = Target::from(addr.clone());

    let printed = target.to_string();
    assert!(printed.starts_with("endpoint"), "{printed}");
    assert_eq!(printed.parse::<Target>(), Ok(target));
    assert_eq!(EndpointAddr::from(printed.parse::<Target>().unwrap()), addr);
}

#[test]
fn garbage_is_not_a_target() {
    let err = "not-an-endpoint".parse::<Target>().unwrap_err();
    assert!(err.to_string().contains("not-an-endpoint"), "{err}");
}

/// Two endpoints that share nothing but a DHT find each other by ID alone:
/// no relay, no DNS, no ticket. The DHT is a private testnet on loopback,
/// so this never touches the real mainline network.
#[tokio::test(flavor = "multi_thread")]
async fn an_endpoint_is_dialable_by_id_over_the_dht() {
    let testnet = Testnet::new(5).await.expect("starting a DHT testnet");
    let preset = || {
        let mut dht = DhtBuilder::default();
        dht.bootstrap(&testnet.bootstrap);
        Global::none().dht(dht)
    };

    let server = iroh_boring::builder()
        .preset(preset())
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .expect("binding the server");
    let client = iroh_boring::builder()
        .preset(preset())
        .bind()
        .await
        .expect("binding the client");

    let accepting = {
        let server = server.clone();
        tokio::spawn(async move {
            let conn = server
                .accept()
                .await
                .expect("closed")
                .await
                .expect("accepting");
            let (mut send, mut recv) = conn.accept_bi().await.expect("accepting a stream");
            let payload = recv.read_to_end(64).await.expect("reading");
            send.write_all(&payload).await.expect("writing");
            send.finish().expect("finishing");
            conn.closed().await;
        })
    };

    // Publishing is fire and forget, so wait for the record to land before
    // dialing rather than racing it.
    let found = tokio::time::timeout(DIAL_TIMEOUT, async {
        loop {
            if let Some(addr) = resolve(&client, server.id(), Duration::from_secs(2)).await {
                return addr;
            }
        }
    })
    .await
    .expect("the server never appeared on the DHT");
    assert_eq!(found.id, server.id());
    assert!(
        found.ip_addrs().next().is_some(),
        "relays off, so the record carries IPs"
    );

    let conn = dial(&client, server.id().into(), ALPN)
        .await
        .expect("dialing by ID");
    let (mut send, mut recv) = conn.open_bi().await.expect("opening a stream");
    send.write_all(b"found you").await.expect("writing");
    send.finish().expect("finishing");
    assert_eq!(recv.read_to_end(64).await.expect("reading"), b"found you");

    conn.close(iroh_utils::CLOSE_DONE, b"done");
    accepting.await.expect("the accepting side panicked");
    client.close().await;
    server.close().await;
}

#[tokio::test]
async fn nothing_resolves_without_lookup() {
    let endpoint = iroh_boring::builder()
        .preset(Global::none())
        .bind()
        .await
        .expect("binding");
    let id = SecretKey::generate().public();
    assert_eq!(
        resolve(&endpoint, id, Duration::from_millis(200)).await,
        None
    );
    endpoint.close().await;
}

/// Dials a fresh endpoint by ID over the real internet with only `lookup`
/// to find it, and n0's relays to carry the traffic, and reports how long
/// each step took.
async fn live_dial(lookup: fn() -> Global) {
    let started = std::time::Instant::now();
    let server = iroh_boring::builder()
        .preset(lookup())
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .expect("binding the server");
    let client = iroh_boring::builder()
        .preset(lookup())
        .bind()
        .await
        .expect("binding the client");
    let relay = tokio::time::timeout(iroh_utils::RELAY_TIMEOUT, iroh_utils::home_relay(&server))
        .await
        .expect("no relay answered");
    eprintln!("server on relay {relay:?} after {:?}", started.elapsed());

    let accepting = {
        let server = server.clone();
        tokio::spawn(async move {
            let conn = server
                .accept()
                .await
                .expect("closed")
                .await
                .expect("accepting");
            let (mut send, mut recv) = conn.accept_bi().await.expect("accepting a stream");
            let payload = recv.read_to_end(64).await.expect("reading");
            send.write_all(&payload).await.expect("writing");
            send.finish().expect("finishing");
            conn.closed().await;
        })
    };

    let found = tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            if let Some(addr) = resolve(&client, server.id(), RESOLVE_TIMEOUT).await {
                return addr;
            }
        }
    })
    .await
    .expect("the server was never found");
    eprintln!("resolved {found:?} after {:?}", started.elapsed());

    let conn = dial(&client, server.id().into(), ALPN)
        .await
        .expect("dialing by ID");
    eprintln!("connected after {:?}", started.elapsed());
    let (mut send, mut recv) = conn.open_bi().await.expect("opening a stream");
    send.write_all(b"found you").await.expect("writing");
    send.finish().expect("finishing");
    assert_eq!(recv.read_to_end(64).await.expect("reading"), b"found you");

    conn.close(iroh_utils::CLOSE_DONE, b"done");
    accepting.await.expect("the accepting side panicked");
    client.close().await;
    server.close().await;
}

/// Not run by default, since it publishes records for throwaway keys to the
/// public mainline DHT. Run by hand with `--ignored`.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "uses the public mainline DHT and n0's relays"]
async fn live_dial_by_id_over_the_public_dht() {
    live_dial(|| Global::default().no_dns().no_mdns()).await;
}

/// Not run by default, since it publishes records for throwaway keys to
/// n0's DNS server. Run by hand with `--ignored`.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "uses n0's DNS server and relays"]
async fn live_dial_by_id_over_n0_dns() {
    live_dial(|| Global::default().no_dht().no_mdns()).await;
}
