// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use super::*;

use n0_mainline::Testnet;

const NOW: Duration = Duration::from_secs(1_800_000_000);

fn bucket(now: Duration) -> u64 {
    now.as_secs() / BUCKET.as_secs()
}

#[test]
fn an_entry_verifies_only_where_it_was_signed() {
    let key = SecretKey::generate();
    let topic = Topic::new("lobby");
    let entry = Entry::new(&key, &topic, 7, 100);

    assert!(entry.verifies(&topic, 7));
    assert!(
        !entry.verifies(&Topic::new("elsewhere"), 7),
        "replayed into another topic"
    );
    assert!(!entry.verifies(&topic, 8), "replayed into another bucket");
    assert!(
        !Entry {
            at: 101,
            ..entry.clone()
        }
        .verifies(&topic, 7),
        "timestamp bumped by someone else",
    );
    let impostor = SecretKey::generate().public();
    assert!(
        !Entry {
            id: impostor,
            ..entry
        }
        .verifies(&topic, 7),
        "a member claiming to be another endpoint",
    );
}

#[test]
fn a_slot_drops_forgeries_and_keeps_the_newest() {
    let topic = Topic::new("lobby");
    let keys: Vec<_> = (0..PER_SLOT + 2).map(|_| SecretKey::generate()).collect();

    let mut value = Vec::new();
    for (at, key) in keys.iter().enumerate() {
        value = merge_slot(&value, &topic, 1, Entry::new(key, &topic, 1, at as u64));
    }
    // Garbage and an entry signed for the wrong bucket, as a careless or
    // hostile member might leave behind.
    value.extend_from_slice(&[0xff; ENTRY_LEN]);
    Entry::new(&SecretKey::generate(), &topic, 2, 999).encode(&mut value);
    value.extend_from_slice(b"trailing");

    let kept = decode_slot(&value, &topic, 1);
    assert_eq!(kept.len(), PER_SLOT);
    let newest: Vec<_> = keys
        .iter()
        .rev()
        .take(PER_SLOT)
        .map(SecretKey::public)
        .collect();
    assert_eq!(kept.iter().map(|e| e.id).collect::<Vec<_>>(), newest);

    let full = merge_slot(&value, &topic, 1, Entry::new(&keys[0], &topic, 1, 1_000));
    assert!(
        full.len() <= 1000,
        "{} bytes is over mainline's limit",
        full.len()
    );
    let kept = decode_slot(&full, &topic, 1);
    assert_eq!(
        kept[0].id,
        keys[0].public(),
        "re-announcing moves to the front"
    );
    assert_eq!(kept.iter().filter(|e| e.id == keys[0].public()).count(), 1);
}

#[test]
fn a_topic_does_not_print_its_secret() {
    let topic = Topic::new("lobby");
    assert!(!format!("{topic:?}").contains(&hex::encode(topic.0)));
    assert_ne!(topic.public_id(), topic.0);
    assert_eq!(Topic::new("lobby"), topic);
}

async fn member(testnet: &Testnet) -> Rendezvous {
    let dht = Dht::builder()
        .bootstrap(&testnet.bootstrap)
        .build()
        .expect("joining the testnet");
    Rendezvous::with_dht(dht, SecretKey::generate())
}

/// Several endpoints announce in a topic over a private DHT on loopback,
/// and each finds the others and nobody from a different topic.
#[tokio::test(flavor = "multi_thread")]
async fn members_find_each_other_and_only_each_other() {
    let testnet = Testnet::new(5).await.expect("starting a DHT testnet");
    let lobby = Topic::new("lobby");
    let members = [
        member(&testnet).await,
        member(&testnet).await,
        member(&testnet).await,
    ];
    let outsider = member(&testnet).await;

    for member in &members {
        member.announce_at(&lobby, NOW).await.expect("announcing");
    }
    outsider
        .announce_at(&Topic::new("elsewhere"), NOW)
        .await
        .expect("announcing elsewhere");

    for me in &members {
        let mut found = me.find_at(&lobby, NOW).await.expect("finding");
        found.sort();
        let mut others: Vec<_> = members
            .iter()
            .map(Rendezvous::id)
            .filter(|&id| id != me.id())
            .collect();
        others.sort();
        assert_eq!(found, others);
    }
    // Finding needs only the name, not an announcement of one's own.
    assert_eq!(
        outsider.find_at(&lobby, NOW).await.expect("finding").len(),
        members.len()
    );
}

/// An announcement stays visible through the next bucket, then ages out
/// without anyone deleting it.
#[tokio::test(flavor = "multi_thread")]
async fn announcements_age_out_after_a_bucket() {
    let testnet = Testnet::new(5).await.expect("starting a DHT testnet");
    let topic = Topic::new("lobby");
    let (announcer, finder) = (member(&testnet).await, member(&testnet).await);

    announcer
        .announce_at(&topic, NOW)
        .await
        .expect("announcing");
    let found = |later: Duration| finder.find_at(&topic, NOW + later);

    assert_eq!(found(Duration::ZERO).await.unwrap(), vec![announcer.id()]);
    assert_eq!(found(BUCKET).await.unwrap(), vec![announcer.id()]);
    assert_eq!(found(BUCKET * 2).await.unwrap(), vec![]);
    assert_eq!(bucket(NOW + BUCKET * 2), bucket(NOW) + 2);
}

/// An endpoint that can reach others by ID through `dht`, with gossip
/// running on it.
struct Peer {
    rendezvous: Rendezvous,
    gossip: iroh_gossip::Gossip,
    router: iroh::protocol::Router,
}

async fn peer(preset: iroh_dial::Global, dht: Dht) -> Peer {
    let endpoint = iroh_boring::builder()
        .preset(preset)
        .bind()
        .await
        .expect("binding");
    let gossip = iroh_gossip::Gossip::builder().spawn(endpoint.clone());
    let router = iroh::protocol::Router::builder(endpoint.clone())
        .accept(iroh_gossip::ALPN, gossip.clone())
        .spawn();
    let rendezvous = Rendezvous::with_dht(dht, endpoint.secret_key().clone());
    Peer {
        rendezvous,
        gossip,
        router,
    }
}

async fn next_message(swarm: &mut Swarm) -> Vec<u8> {
    use futures::StreamExt;
    loop {
        match swarm.receiver().next().await {
            Some(Ok(iroh_gossip::api::Event::Received(msg))) => return msg.content.to_vec(),
            Some(Ok(_)) => continue,
            other => panic!("the swarm ended: {other:?}"),
        }
    }
}

/// Three endpoints that know only a topic name and a DHT end up in one
/// gossip swarm, and a message from the first reaches the others.
#[tokio::test(flavor = "multi_thread")]
async fn gossip_swarms_meet_through_the_dht() {
    let testnet = Testnet::new(5).await.expect("starting a DHT testnet");
    let builder = || {
        let mut dht = n0_mainline::DhtBuilder::default();
        dht.bootstrap(&testnet.bootstrap);
        dht
    };
    let topic = Topic::new("lobby");

    let mut peers = Vec::new();
    for _ in 0..3 {
        let preset = iroh_dial::Global::none().dht(builder());
        peers.push(peer(preset, builder().build().expect("joining the testnet")).await);
    }
    let mut swarms = Vec::new();
    for peer in &peers {
        let swarm = peer
            .rendezvous
            .join_gossip(&peer.gossip, topic.clone())
            .await;
        swarms.push(swarm.expect("joining"));
    }

    tokio::time::timeout(Duration::from_secs(30), async {
        for swarm in &mut swarms {
            swarm.joined().await.expect("waiting for a neighbor");
        }
        swarms[0]
            .sender()
            .broadcast(b"hello, lobby"[..].into())
            .await
            .expect("broadcasting");
        for swarm in &mut swarms[1..] {
            assert_eq!(next_message(swarm).await, b"hello, lobby");
        }
    })
    .await
    .expect("the swarm never formed");

    drop(swarms);
    for peer in peers {
        peer.router.shutdown().await.expect("shutting down");
    }
}

/// The same over the real internet: the public mainline DHT, n0's relays
/// and n0's DNS. Not run by default, since it publishes records for two
/// throwaway keys to public infrastructure. Run it by hand with
/// `--ignored` to check that the real network still behaves.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "uses the public mainline DHT and n0's relays"]
async fn live_gossip_over_the_public_dht() {
    let topic = Topic::new(format!(
        "depot/iroh-rendezvous/live/{}",
        hex::encode(rand_bytes())
    ));
    let mut peers = Vec::new();
    for _ in 0..2 {
        let preset = iroh_dial::Global::default().no_mdns();
        peers.push(peer(preset, Dht::client().expect("joining mainline")).await);
    }

    let started = std::time::Instant::now();
    let mut first = peers[0]
        .rendezvous
        .join_gossip(&peers[0].gossip, topic.clone())
        .await
        .expect("joining");
    eprintln!("first member announced after {:?}", started.elapsed());
    let mut second = peers[1]
        .rendezvous
        .join_gossip(&peers[1].gossip, topic.clone())
        .await
        .expect("joining");
    eprintln!("second member subscribed after {:?}", started.elapsed());

    tokio::time::timeout(Duration::from_secs(120), async {
        second.joined().await.expect("waiting for a neighbor");
        eprintln!("second member joined after {:?}", started.elapsed());
        first.joined().await.expect("waiting for a neighbor");
        second
            .sender()
            .broadcast(b"hello from the internet"[..].into())
            .await
            .expect("broadcasting");
        assert_eq!(next_message(&mut first).await, b"hello from the internet");
        eprintln!("message delivered after {:?}", started.elapsed());
    })
    .await
    .expect("the swarm never formed");

    drop((first, second));
    for peer in peers {
        peer.router.shutdown().await.expect("shutting down");
    }
}

fn rand_bytes() -> [u8; 8] {
    *blake3::hash(SecretKey::generate().public().as_bytes())
        .as_bytes()
        .first_chunk()
        .expect("32 bytes")
}
