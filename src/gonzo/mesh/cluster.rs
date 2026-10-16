// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Clusters: daemons and workers that find each other by a name they
//! share, on the BitTorrent mainline DHT, rather than by ticket.
//!
//! A daemon announces itself under the cluster's topic; a worker reads who
//! has, dials them, and joins with the key the name derives. Anyone who
//! knows the name can join, so pick one with as much secrecy as the
//! daemon's results deserve, such as one with a random suffix.

use iroh::{Endpoint, EndpointId};
use iroh_rendezvous::{Announcer, Rendezvous, Topic, n0_mainline::Dht};

use crate::keys::JoinKey;

/// A cluster, by name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cluster(String);

impl Cluster {
    pub fn new(name: impl Into<String>) -> Self {
        Self(name.into())
    }

    pub fn name(&self) -> &str {
        &self.0
    }

    /// The key members join with.
    pub fn key(&self) -> JoinKey {
        JoinKey::for_cluster(&self.0)
    }

    fn topic(&self) -> Topic {
        Topic::new(format!("gonzo cluster {}", self.0))
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
        rendezvous.spawn_announcer(self.topic())
    }

    /// The daemons announced in the cluster lately, most recent first.
    pub async fn daemons(&self, rendezvous: &Rendezvous) -> std::io::Result<Vec<EndpointId>> {
        rendezvous
            .find(&self.topic())
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))
    }
}
