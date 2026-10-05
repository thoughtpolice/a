// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Joining an iroh-gossip swarm whose first members come from the DHT.
//!
//! Gossip needs a few endpoint IDs to start from, after which members
//! introduce each other. [`Rendezvous::join_gossip`] supplies them: it
//! announces this endpoint in the topic, subscribes, and joins each member
//! the DHT turns up the moment a DHT node mentions it. It keeps looking in
//! the background, so two endpoints that started at the same moment, each
//! finding nobody, still meet.

use std::collections::HashSet;
use std::pin::pin;
use std::time::Duration;

use futures::stream::{BoxStream, StreamExt};
use iroh::EndpointId;
use iroh_gossip::api::{ApiError, GossipReceiver, GossipSender, GossipTopic};
use iroh_gossip::{Gossip, TopicId};

use crate::{ANNOUNCE_INTERVAL, Announcer, Rendezvous, Topic};

/// How soon the background search looks again after its first pass. It
/// doubles from here up to [`ANNOUNCE_INTERVAL`].
const FIRST_REFIND: Duration = Duration::from_secs(2);

impl Topic {
    /// The gossip topic every member of this one subscribes to.
    pub fn gossip_id(&self) -> TopicId {
        self.public_id().into()
    }
}

impl Rendezvous {
    /// Joins `topic`'s gossip swarm on `gossip`, which must run on the
    /// endpoint this rendezvous announces and be able to reach other
    /// members by ID alone, as one with `iroh_dial::Global` can.
    ///
    /// Returns as soon as the subscription exists, before any DHT traffic
    /// has finished; await [`Swarm::joined`] to wait for a first neighbor.
    /// The first member of a topic has nobody to join, so that wait lasts
    /// until someone else arrives.
    pub async fn join_gossip(&self, gossip: &Gossip, topic: Topic) -> Result<Swarm, ApiError> {
        let announcer = self.spawn_announcer(topic.clone());
        let (sender, receiver) = gossip.subscribe(topic.gossip_id(), vec![]).await?.split();
        // The finder's own subscription, so it can watch neighbors come and
        // go without taking events from the caller's receiver.
        let watch = gossip.subscribe(topic.gossip_id(), vec![]).await?;
        let finder = tokio::spawn(keep_finding(self.clone(), topic, gossip.clone(), watch));
        Ok(Swarm {
            sender,
            receiver,
            upkeep: Upkeep {
                _announcer: announcer,
                finder,
            },
        })
    }
}

/// Asks gossip to join each member the DHT turns up, as soon as it turns
/// up. Gossip's own membership protocol does the rest, so this only
/// matters until the swarm is connected, but it stays on at a low rate to
/// heal a split.
///
/// A member is asked again only while this endpoint has no neighbors at
/// all. Two members usually find each other within moments of starting,
/// before either has published its addresses, so the first dial often
/// fails and has to be retried. Once connected, though, most members are
/// deliberately not neighbors (gossip keeps only a few), and asking them
/// all again on every pass would churn the swarm.
async fn keep_finding(rendezvous: Rendezvous, topic: Topic, gossip: Gossip, watch: GossipTopic) {
    let (mut sender, mut events) = watch.split();
    let mut asked = HashSet::new();
    let mut found: Option<BoxStream<'static, EndpointId>> = None;
    let mut wait = FIRST_REFIND;
    let next_pass = tokio::time::sleep(Duration::ZERO);
    let mut next_pass = pin!(next_pass);

    loop {
        tokio::select! {
            // Polling the receiver is what keeps its neighbor set current.
            event = events.next() => {
                if !matches!(event, Some(Ok(_))) {
                    // Lagged or closed: the neighbor set is unreliable, so
                    // start a fresh subscription, or stop with gossip.
                    let Ok(watch) = gossip.subscribe(topic.gossip_id(), vec![]).await else {
                        return;
                    };
                    (sender, events) = watch.split();
                }
            }
            id = next_found(&mut found) => match id {
                Some(id) => {
                    let isolated = events.neighbors().next().is_none();
                    let fresh = asked.insert(id);
                    if (fresh || isolated) && sender.join_peers(vec![id]).await.is_err() {
                        return;
                    }
                }
                None => {
                    found = None;
                    next_pass.as_mut().reset(tokio::time::Instant::now() + wait);
                    wait = (wait * 2).min(ANNOUNCE_INTERVAL);
                }
            },
            () = &mut next_pass, if found.is_none() => {
                let Ok(stream) = rendezvous.find_stream(&topic).await else {
                    return;
                };
                found = Some(stream.boxed());
            }
        }
    }
}

/// The next endpoint from the pass in progress, or never if none is.
async fn next_found(found: &mut Option<BoxStream<'static, EndpointId>>) -> Option<EndpointId> {
    match found {
        Some(found) => found.next().await,
        None => std::future::pending().await,
    }
}

/// A gossip subscription that stays announced and keeps finding members
/// for as long as it is held.
#[derive(Debug)]
pub struct Swarm {
    sender: GossipSender,
    receiver: GossipReceiver,
    upkeep: Upkeep,
}

impl Swarm {
    /// Sends messages to the swarm. Clone it to send from several tasks.
    pub fn sender(&self) -> &GossipSender {
        &self.sender
    }

    /// Events from the swarm: messages and neighbors coming and going.
    pub fn receiver(&mut self) -> &mut GossipReceiver {
        &mut self.receiver
    }

    /// Waits for a first neighbor.
    pub async fn joined(&mut self) -> Result<(), ApiError> {
        self.receiver.joined().await
    }

    /// The two halves, plus the [`Upkeep`] that has to stay alive with
    /// them for this endpoint to remain findable.
    pub fn split(self) -> (GossipSender, GossipReceiver, Upkeep) {
        (self.sender, self.receiver, self.upkeep)
    }
}

/// The announcing and searching behind a [`Swarm`], stopped when dropped.
#[derive(Debug)]
pub struct Upkeep {
    _announcer: Announcer,
    finder: tokio::task::JoinHandle<()>,
}

impl Drop for Upkeep {
    fn drop(&mut self) {
        self.finder.abort();
    }
}
