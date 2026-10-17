// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Clusters: daemons and workers that find each other on the BitTorrent
//! mainline DHT, by a [`JoinCode`](crate::JoinCode) they share, rather
//! than by ticket.
//!
//! A daemon announces itself under the cluster's topic; a worker reads who
//! has, dials them, and joins with the cluster's key. Both come from the
//! code (see [`JoinCode::cluster`](crate::JoinCode::cluster)).

use iroh::{Endpoint, EndpointId};
use iroh_rendezvous::{Announcer, Rendezvous, Topic, n0_mainline::Dht};

use crate::keys::JoinKey;

/// A cluster: where its daemons announce themselves, and the key members
/// join with.
#[derive(Clone)]
pub struct Cluster {
    topic: Topic,
    key: JoinKey,
    hint: String,
}

impl Cluster {
    pub(crate) fn new(topic: Topic, key: JoinKey, hint: String) -> Self {
        Self { topic, key, hint }
    }

    /// Which cluster it is, for logs: the hint of its code.
    pub fn hint(&self) -> &str {
        &self.hint
    }

    /// The key members join with.
    pub fn key(&self) -> JoinKey {
        self.key.clone()
    }

    /// `endpoint`'s view of the DHT: the public mainline DHT, or `dht`
    /// (one bootstrapped from a private testnet, say).
    pub fn rendezvous(endpoint: &Endpoint, dht: Option<Dht>) -> std::io::Result<Rendezvous> {
        let key = endpoint.secret_key().clone();
        match dht {
            Some(dht) => Ok(Rendezvous::with_dht(dht, key)),
            None => Rendezvous::new(key),
        }
    }

    /// Announce the daemon `rendezvous` speaks for, every few minutes,
    /// until the result is dropped.
    pub fn announce(&self, rendezvous: &Rendezvous) -> Announcer {
        rendezvous.spawn_announcer(self.topic.clone())
    }

    /// The daemons announced in the cluster lately, most recent first.
    pub async fn daemons(&self, rendezvous: &Rendezvous) -> std::io::Result<Vec<EndpointId>> {
        rendezvous
            .find(&self.topic)
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))
    }
}
