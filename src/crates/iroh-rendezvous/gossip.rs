// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Joining an iroh-gossip swarm whose first members come from the DHT.
//!
//! Gossip needs a few endpoint IDs to start from, after which members
//! introduce each other. [`Rendezvous::join_gossip`] supplies them: it
//! announces this endpoint in the topic, subscribes with whoever is
//! already there, and keeps looking in the background so that two
//! endpoints that started at the same moment, each finding nobody, still
//! meet.

use std::collections::HashSet;
use std::time::Duration;

use iroh::EndpointId;
use iroh_gossip::api::{ApiError, GossipReceiver, GossipSender};
use iroh_gossip::{Gossip, TopicId};

use crate::{ANNOUNCE_INTERVAL, Announcer, RETRY_INTERVAL, Rendezvous, Topic};

/// How soon the background search first looks again. It doubles from
/// here up to [`ANNOUNCE_INTERVAL`].
const FIRST_REFIND: Duration = Duration::from_secs(5);

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
    /// Returns as soon as the subscription exists; await
    /// [`Swarm::joined`] to wait for a first neighbor. The first member of
    /// a topic has nobody to join, so that wait lasts until someone else
    /// arrives.
    pub async fn join_gossip(&self, gossip: &Gossip, topic: Topic) -> Result<Swarm, ApiError> {
        // Announce before anything else, so a member who arrives next can
        // find this one. A failure is not fatal, but the announcer has to
        // retry soon: until it lands, nobody can find this member.
        let next = match self.announce(&topic).await {
            Ok(()) => ANNOUNCE_INTERVAL,
            Err(err) => {
                tracing::warn!(?topic, "announcing: {err}");
                RETRY_INTERVAL
            }
        };
        let announcer = self.spawn_announcer_after(topic.clone(), next);

        let first = self.find(&topic).await.unwrap_or_default();
        let (sender, receiver) = gossip
            .subscribe(topic.gossip_id(), first.clone())
            .await?
            .split();

        let finder = tokio::spawn(keep_finding(
            self.clone(),
            topic,
            sender.clone(),
            first.into_iter().collect(),
        ));
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

/// Asks gossip to join every member the DHT turns up that it has not
/// already been told about. Gossip's own membership protocol does the
/// rest, so this only matters until the swarm is connected, but it stays
/// on at a low rate to heal a split.
async fn keep_finding(
    rendezvous: Rendezvous,
    topic: Topic,
    sender: GossipSender,
    mut asked: HashSet<EndpointId>,
) {
    let mut wait = FIRST_REFIND;
    loop {
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(ANNOUNCE_INTERVAL);

        let Ok(found) = rendezvous.find(&topic).await else {
            return;
        };
        let new: Vec<_> = found.into_iter().filter(|id| asked.insert(*id)).collect();
        if !new.is_empty() && sender.join_peers(new).await.is_err() {
            return;
        }
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
