// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Finding iroh endpoints by topic on the BitTorrent mainline DHT.
//!
//! `iroh-dial` reaches an endpoint whose ID you already have. This crate is
//! for the step before that: endpoints that agree on a topic name, and
//! nothing else, find each other's IDs. A typical use is bootstrapping a
//! gossip swarm, whose members then tell each other about everyone else,
//! which [`Rendezvous::join_gossip`] does in one call:
//!
//! ```ignore
//! let endpoint = iroh_boring::builder()
//!     .preset(iroh_dial::Global::default())
//!     .bind()
//!     .await?;
//! let gossip = Gossip::builder().spawn(endpoint.clone());
//! let _router = Router::builder(endpoint.clone())
//!     .accept(iroh_gossip::ALPN, gossip.clone())
//!     .spawn();
//!
//! let rendezvous = Rendezvous::new(endpoint.secret_key().clone())?;
//! let mut swarm = rendezvous.join_gossip(&gossip, Topic::new("my-app/lobby")).await?;
//! swarm.joined().await?;
//! swarm.sender().broadcast("hello".into()).await?;
//! ```
//!
//! [`Rendezvous::announce`] and [`Rendezvous::find`] are there for anything
//! other than gossip.
//!
//! # How it works
//!
//! Mainline stores small signed values (BEP 44) under an ed25519 key and a
//! salt. Every member of a topic derives the same signing key from the
//! topic name and the current [`BUCKET`] of time, so all of them can write
//! under it and nobody else can. Each bucket has [`SLOTS`] salts, and each
//! slot holds up to [`PER_SLOT`] entries: an endpoint ID, when it was
//! written, and that endpoint's own signature over the topic and bucket.
//! Announcing reads a slot, adds this endpoint, drops the oldest entries
//! past the limit and writes it back with a compare-and-swap. Finding reads
//! every slot of this bucket and the last.
//!
//! The rotating key means nothing ever has to be deleted: last bucket's
//! records simply stop being read, and DHT nodes forget them within hours.
//!
//! # What it promises
//!
//! - A DHT node sees an ed25519 key unrelated to the topic name, so it
//!   cannot tell what the topic is. It does see the endpoint IDs stored
//!   under it, which DNS and DHT address lookup publish anyway.
//! - Only someone who knows the topic name can write, and an entry only
//!   verifies if the endpoint it names signed it, so a member cannot make
//!   up other members.
//! - A member *can* overwrite slots and push others out. Anyone who knows
//!   the name is a member, so pick a name with as much secrecy as the topic
//!   needs, such as one with a random suffix.
//! - At most `2 * SLOTS * PER_SLOT` endpoints are visible at once. That is
//!   plenty to join a swarm, which is the point; it is not a member list.

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::io;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::stream::{self, Stream, StreamExt};
use iroh::{EndpointId, SecretKey, Signature};
use n0_mainline::errors::{PutMutableError, PutQueryError};
use n0_mainline::{ActorShutdown, Dht, MutableItem, SigningKey};

pub use gossip::{Swarm, Upkeep};
pub use n0_mainline;

mod gossip;

/// How long one signing key, and so one set of records, stays current.
/// Finding reads this bucket and the previous one, so an announcement is
/// visible for between one and two buckets.
pub const BUCKET: Duration = Duration::from_secs(5 * 60);

/// How often [`Rendezvous::spawn_announcer`] announces. Well under a
/// [`BUCKET`], so every bucket gets an entry soon after it starts.
pub const ANNOUNCE_INTERVAL: Duration = Duration::from_secs(2 * 60);

/// How soon a failed announcement is retried.
const RETRY_INTERVAL: Duration = Duration::from_secs(15);

/// Salts per bucket. Spreading writers out keeps compare-and-swap conflicts
/// rare; every one costs a lookup when finding.
pub const SLOTS: u8 = 8;

/// Entries per slot. Mainline caps a value at 1000 bytes.
pub const PER_SLOT: usize = 8;

/// How many times announcing rereads a slot after losing a write race.
const RETRIES: usize = 4;

/// Domain separation for everything derived or signed here.
const DOMAIN: &str = "depot iroh-rendezvous v1";

const ENTRY_LEN: usize = 32 + 8 + Signature::LENGTH;

const _: () = assert!(ENTRY_LEN * PER_SLOT <= 1000);

/// A topic name, hashed. Everyone who builds the same name gets the same
/// topic.
#[derive(Clone, PartialEq, Eq)]
pub struct Topic([u8; 32]);

impl Topic {
    /// The topic called `name`. Any bytes do, but whoever knows them can
    /// read and write the topic.
    pub fn new(name: impl AsRef<[u8]>) -> Self {
        Self(blake3::derive_key(
            &format!("{DOMAIN} topic"),
            name.as_ref(),
        ))
    }

    /// A 32-byte ID for the topic that does not give away its name or its
    /// signing keys, for naming the same topic elsewhere. It converts
    /// directly into an iroh-gossip `TopicId`.
    pub fn public_id(&self) -> [u8; 32] {
        *blake3::keyed_hash(&self.0, b"public id").as_bytes()
    }

    /// The key every member of the topic signs a bucket's records with.
    fn signer(&self, bucket: u64) -> SigningKey {
        let mut hasher = blake3::Hasher::new_keyed(&self.0);
        hasher.update(b"signer").update(&bucket.to_be_bytes());
        SigningKey::from_bytes(hasher.finalize().as_bytes())
    }

    /// The slot `id` writes to in `bucket`. Fixed for the bucket, so an
    /// endpoint replaces its own entry rather than spreading copies, and
    /// different per bucket, so two endpoints that collide once do not
    /// keep colliding.
    fn slot(&self, id: &EndpointId, bucket: u64) -> u8 {
        let mut hasher = blake3::Hasher::new_keyed(&self.0);
        hasher
            .update(b"slot")
            .update(id.as_bytes())
            .update(&bucket.to_be_bytes());
        hasher.finalize().as_bytes()[0] % SLOTS
    }
}

impl fmt::Debug for Topic {
    /// Only the public ID: the hash itself is what lets one write.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Topic({})", hex::encode(&self.public_id()[..8]))
    }
}

/// One endpoint's claim to be in a topic during a bucket.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry {
    id: EndpointId,
    /// Unix seconds when the entry was written. Only orders entries; the
    /// signature over the bucket is what stops an old one being replayed.
    at: u64,
    sig: Signature,
}

fn signable(topic: &Topic, bucket: u64, id: &EndpointId, at: u64) -> Vec<u8> {
    [
        DOMAIN.as_bytes(),
        &topic.0,
        &bucket.to_be_bytes(),
        id.as_bytes(),
        &at.to_be_bytes(),
    ]
    .concat()
}

impl Entry {
    fn new(secret_key: &SecretKey, topic: &Topic, bucket: u64, at: u64) -> Self {
        let id = secret_key.public();
        let sig = secret_key.sign(&signable(topic, bucket, &id, at));
        Self { id, at, sig }
    }

    fn verifies(&self, topic: &Topic, bucket: u64) -> bool {
        self.id
            .verify(&signable(topic, bucket, &self.id, self.at), &self.sig)
            .is_ok()
    }

    fn encode(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(self.id.as_bytes());
        out.extend_from_slice(&self.at.to_be_bytes());
        out.extend_from_slice(&self.sig.to_bytes());
    }

    fn decode(bytes: &[u8; ENTRY_LEN]) -> Option<Self> {
        let (id, rest) = bytes.split_first_chunk::<32>()?;
        let (at, sig) = rest.split_first_chunk::<8>()?;
        Some(Self {
            id: EndpointId::from_bytes(id).ok()?,
            at: u64::from_be_bytes(*at),
            sig: Signature::from_bytes(sig.try_into().ok()?),
        })
    }
}

/// The entries in a slot's value that verify for this topic and bucket.
/// Anything malformed or forged is skipped rather than failing the slot,
/// since one bad writer should not hide everyone else.
fn decode_slot(value: &[u8], topic: &Topic, bucket: u64) -> Vec<Entry> {
    value
        .as_chunks::<ENTRY_LEN>()
        .0
        .iter()
        .filter_map(Entry::decode)
        .filter(|entry| entry.verifies(topic, bucket))
        .collect()
}

/// A slot's value with `own` added: any older entry from the same endpoint
/// is replaced, and the oldest entries go once the slot is full.
fn merge_slot(value: &[u8], topic: &Topic, bucket: u64, own: Entry) -> Vec<u8> {
    let mut entries = decode_slot(value, topic, bucket);
    entries.retain(|entry| entry.id != own.id);
    entries.push(own);
    entries.sort_by_key(|entry| Reverse(entry.at));
    entries.truncate(PER_SLOT);

    let mut out = Vec::with_capacity(entries.len() * ENTRY_LEN);
    for entry in &entries {
        entry.encode(&mut out);
    }
    out
}

fn unix_now() -> Duration {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
}

/// Why an announcement did not land.
#[derive(Debug)]
pub enum AnnounceError {
    /// The DHT could not store the record, most often because this node
    /// has not reached any other DHT nodes yet.
    Dht(PutQueryError),
    /// Other members kept writing the same slot first. Trying again later
    /// will almost always work.
    Contended,
}

impl fmt::Display for AnnounceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Dht(err) => write!(f, "storing on the DHT: {err}"),
            Self::Contended => write!(f, "lost {RETRIES} write races for the same slot"),
        }
    }
}

impl std::error::Error for AnnounceError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Dht(err) => Some(err),
            Self::Contended => None,
        }
    }
}

impl From<ActorShutdown> for AnnounceError {
    fn from(_: ActorShutdown) -> Self {
        Self::Dht(PutQueryError::Shutdown)
    }
}

/// An endpoint's view of the DHT, for announcing itself in topics and
/// finding the others there.
///
/// Cloning shares the same DHT node.
#[derive(Debug, Clone)]
pub struct Rendezvous {
    dht: Dht,
    secret_key: SecretKey,
}

impl Rendezvous {
    /// Joins the public mainline DHT as a client, signing entries as the
    /// endpoint `secret_key` belongs to. Must be called inside a Tokio
    /// runtime, which the DHT's socket registers with.
    pub fn new(secret_key: SecretKey) -> io::Result<Self> {
        Ok(Self::with_dht(Dht::client()?, secret_key))
    }

    /// Uses a DHT node the caller built, such as one bootstrapped from a
    /// private `n0_mainline::Testnet`.
    pub fn with_dht(dht: Dht, secret_key: SecretKey) -> Self {
        Self { dht, secret_key }
    }

    /// The endpoint this announces.
    pub fn id(&self) -> EndpointId {
        self.secret_key.public()
    }

    /// Records this endpoint in `topic` for the current bucket.
    pub async fn announce(&self, topic: &Topic) -> Result<(), AnnounceError> {
        self.announce_at(topic, unix_now()).await
    }

    async fn announce_at(&self, topic: &Topic, now: Duration) -> Result<(), AnnounceError> {
        let bucket = now.as_secs() / BUCKET.as_secs();
        let signer = topic.signer(bucket);
        let key = signer.verifying_key().to_bytes();
        let salt = [topic.slot(&self.id(), bucket)];
        let own = Entry::new(&self.secret_key, topic, bucket, now.as_secs());

        for _ in 0..RETRIES {
            let current = self.dht.get_mutable_most_recent(&key, Some(&salt)).await?;
            let (value, cas) = match &current {
                Some(item) => (item.value(), Some(item.seq())),
                None => (&[][..], None),
            };
            // Sequence numbers only have to grow. Time keeps them readable
            // and lets an endpoint that just restarted win over its past.
            let seq = (now.as_micros() as i64).max(cas.map_or(0, |seq| seq + 1));
            let merged = merge_slot(value, topic, bucket, own.clone());
            let item = MutableItem::new(&signer, &merged, seq, Some(&salt));

            match self.dht.put_mutable(item, cas).await {
                Ok(_) => return Ok(()),
                Err(PutMutableError::Concurrency(_)) => continue,
                Err(PutMutableError::Query(err)) => return Err(AnnounceError::Dht(err)),
            }
        }
        Err(AnnounceError::Contended)
    }

    /// The endpoints announced in `topic` during this bucket or the last,
    /// most recent first, leaving out this one.
    ///
    /// This waits for every DHT node asked to answer, which can take tens
    /// of seconds on the public network. [`Self::find_stream`] hands over
    /// each endpoint as soon as the first node mentions it.
    pub async fn find(&self, topic: &Topic) -> Result<Vec<EndpointId>, ActorShutdown> {
        self.find_at(topic, unix_now()).await
    }

    async fn find_at(
        &self,
        topic: &Topic,
        now: Duration,
    ) -> Result<Vec<EndpointId>, ActorShutdown> {
        let mut latest = HashMap::new();
        let mut entries = self.entries_at(topic, now).await?;
        while let Some(entry) = entries.next().await {
            let at = latest.entry(entry.id).or_insert(entry.at);
            *at = (*at).max(entry.at);
        }
        latest.remove(&self.id());

        let mut found: Vec<_> = latest.into_iter().collect();
        found.sort_by_key(|&(id, at)| (Reverse(at), id));
        Ok(found.into_iter().map(|(id, _)| id).collect())
    }

    /// The endpoints announced in `topic` during this bucket or the last,
    /// each one once and as soon as any DHT node mentions it, leaving out
    /// this one. The stream ends once every node asked has answered.
    pub async fn find_stream(
        &self,
        topic: &Topic,
    ) -> Result<impl Stream<Item = EndpointId> + use<>, ActorShutdown> {
        self.find_stream_at(topic, unix_now()).await
    }

    async fn find_stream_at(
        &self,
        topic: &Topic,
        now: Duration,
    ) -> Result<impl Stream<Item = EndpointId> + use<>, ActorShutdown> {
        let mut seen = HashSet::from([self.id()]);
        let entries = self.entries_at(topic, now).await?;
        Ok(entries
            .filter_map(move |entry| std::future::ready(seen.insert(entry.id).then_some(entry.id))))
    }

    /// Every entry that verifies in every slot of this bucket and the last,
    /// as DHT nodes answer.
    ///
    /// Nodes may hold different versions of a slot. All of them count:
    /// each entry was signed for this topic and bucket by the endpoint it
    /// names, so an older version is no less true, only less complete.
    async fn entries_at(
        &self,
        topic: &Topic,
        now: Duration,
    ) -> Result<impl Stream<Item = Entry> + use<>, ActorShutdown> {
        let current = now.as_secs() / BUCKET.as_secs();
        let mut buckets = vec![current, current.saturating_sub(1)];
        buckets.dedup();

        let mut reads = Vec::new();
        for bucket in buckets {
            let key = topic.signer(bucket).verifying_key().to_bytes();
            for slot in 0..SLOTS {
                let topic = topic.clone();
                let answers = self.dht.get_mutable(&key, Some(&[slot]), None).await?;
                reads.push(
                    answers.flat_map(move |item| {
                        stream::iter(decode_slot(item.value(), &topic, bucket))
                    }),
                );
            }
        }
        Ok(stream::select_all(reads))
    }

    /// Announces in `topic` every [`ANNOUNCE_INTERVAL`], until the returned
    /// handle is dropped. Failures are retried sooner and logged, since the
    /// DHT is expected to be unreachable now and then.
    pub fn spawn_announcer(&self, topic: Topic) -> Announcer {
        let this = self.clone();
        Announcer(tokio::spawn(async move {
            loop {
                let wait = match this.announce(&topic).await {
                    Ok(()) => ANNOUNCE_INTERVAL,
                    Err(err) => {
                        tracing::warn!(?topic, "announcing: {err}");
                        RETRY_INTERVAL
                    }
                };
                tokio::time::sleep(wait).await;
            }
        }))
    }
}

/// Keeps announcing in a topic for as long as it is held.
#[derive(Debug)]
pub struct Announcer(tokio::task::JoinHandle<()>);

impl Drop for Announcer {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(test)]
mod tests;
