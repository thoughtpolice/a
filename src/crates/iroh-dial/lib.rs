// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Dialing iroh endpoints by ID alone.
//!
//! An endpoint from `iroh-boring` has no relay and no address lookup, so it
//! can only reach peers whose addresses it was handed. [`Global`] adds the
//! rest, as an iroh [`Preset`]:
//!
//! ```ignore
//! let endpoint = iroh_boring::builder().preset(iroh_dial::Global::default()).bind().await?;
//! let conn = iroh_dial::dial(&endpoint, "<endpoint id or ticket>".parse()?, ALPN).await?;
//! ```
//!
//! With every source on, an endpoint publishes itself and resolves others
//! three ways, and the first answer wins:
//!
//! - **n0 DNS**: signed records on n0's pkarr relay, read back over DNS.
//!   Fast, but n0 has to be up.
//! - **The mainline DHT**: the same signed records stored on BitTorrent's
//!   DHT. Slower, with no server at all.
//! - **mDNS**: peers on the local network, with no internet.
//!
//! The preset picks no crypto provider, so it fits any builder. iroh's own
//! `presets::N0` does much the same, but only exists with ring or aws-lc-rs
//! compiled in.

use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use futures::StreamExt;
use iroh::address_lookup::{AddrFilter, DnsAddressLookup, PkarrPublisher, PkarrResolver};
use iroh::endpoint::{Builder, ConnectError, Connection, default_relay_mode, presets::Preset};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMode};
use iroh_mainline_address_lookup::DhtAddressLookup;
use iroh_mdns_address_lookup::MdnsAddressLookup;
use iroh_tickets::endpoint::EndpointTicket;

pub use n0_mainline::DhtBuilder;

/// How long [`dial`] waits for a connection, address lookup included. A
/// DHT lookup alone can take several seconds when the records are cold.
pub const DIAL_TIMEOUT: Duration = Duration::from_secs(30);

/// How long [`resolve`] collects answers. DNS answers in milliseconds and
/// mDNS within a few seconds; the DHT can need most of this.
pub const RESOLVE_TIMEOUT: Duration = Duration::from_secs(15);

/// Relays and address lookup for reaching endpoints anywhere, by ID.
///
/// Every source is on by default. What an endpoint publishes about itself
/// follows the relays: with relays on, it publishes only its relay, so the
/// public DNS and DHT records never carry its IP addresses; with relays
/// off, a relay-only record would be empty, so it publishes its direct
/// addresses instead. [`Global::publish`] overrides that choice. mDNS
/// always shares direct addresses, since it never leaves the local network.
#[derive(Debug)]
pub struct Global {
    relays: bool,
    dns: bool,
    dht: Option<DhtBuilder>,
    mdns: bool,
    publish: Option<AddrFilter>,
}

impl Default for Global {
    fn default() -> Self {
        Self {
            relays: true,
            dns: true,
            dht: Some(DhtBuilder::default()),
            mdns: true,
            publish: None,
        }
    }
}

impl Global {
    /// Nothing at all: no relays and no lookup. Useful as a base for
    /// turning on exactly one source, such as a DHT in a test.
    pub fn none() -> Self {
        Self {
            relays: false,
            dns: false,
            dht: None,
            mdns: false,
            publish: None,
        }
    }

    /// Skips n0's relays. Peers behind NATs that cannot hole-punch will
    /// then be unreachable.
    pub fn no_relays(mut self) -> Self {
        self.relays = false;
        self
    }

    /// Skips n0's DNS and pkarr servers.
    pub fn no_dns(mut self) -> Self {
        self.dns = false;
        self
    }

    /// Skips the mainline DHT.
    pub fn no_dht(mut self) -> Self {
        self.dht = None;
        self
    }

    /// Uses the mainline DHT with this configuration, for instance one
    /// bootstrapped from a private `n0_mainline::Testnet`.
    pub fn dht(mut self, dht: DhtBuilder) -> Self {
        self.dht = Some(dht);
        self
    }

    /// Skips mDNS.
    pub fn no_mdns(mut self) -> Self {
        self.mdns = false;
        self
    }

    /// Chooses which addresses go into the public DNS and DHT records,
    /// instead of following the relays. [`AddrFilter::unfiltered`] lets
    /// peers skip the relay entirely when this endpoint has a public IP.
    pub fn publish(mut self, filter: AddrFilter) -> Self {
        self.publish = Some(filter);
        self
    }
}

impl Preset for Global {
    fn apply(self, mut builder: Builder) -> Builder {
        let publish = self.publish.unwrap_or_else(|| {
            if self.relays {
                AddrFilter::relay_only()
            } else {
                AddrFilter::unfiltered()
            }
        });

        builder = builder.relay_mode(if self.relays {
            default_relay_mode()
        } else {
            RelayMode::Disabled
        });
        if self.dns {
            builder = builder
                .address_lookup(PkarrPublisher::n0_dns().addr_filter(publish.clone()))
                .address_lookup(PkarrResolver::n0_dns())
                .address_lookup(DnsAddressLookup::n0_dns());
        }
        if let Some(dht) = self.dht {
            builder = builder.address_lookup(
                DhtAddressLookup::builder()
                    .dht_builder(dht)
                    .addr_filter(publish),
            );
        }
        if self.mdns {
            builder = builder.address_lookup(MdnsAddressLookup::builder());
        }
        builder
    }
}

/// Something to dial: an endpoint ID, which address lookup has to turn
/// into addresses, or a ticket, which already carries some.
///
/// Parses from an endpoint ID in hex or z-base-32 (the form in DNS and DHT
/// records) or from an `endpoint…` ticket, which is what a user is most
/// likely to paste.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target(EndpointAddr);

impl Target {
    /// The endpoint this target names.
    pub fn id(&self) -> EndpointId {
        self.0.id
    }
}

impl From<EndpointId> for Target {
    fn from(id: EndpointId) -> Self {
        Self(EndpointAddr::new(id))
    }
}

impl From<EndpointAddr> for Target {
    fn from(addr: EndpointAddr) -> Self {
        Self(addr)
    }
}

impl From<EndpointTicket> for Target {
    fn from(ticket: EndpointTicket) -> Self {
        Self(ticket.into())
    }
}

impl From<Target> for EndpointAddr {
    fn from(target: Target) -> Self {
        target.0
    }
}

impl fmt::Display for Target {
    /// A ticket when there are addresses to carry, otherwise the bare ID.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.0.is_empty() {
            write!(f, "{}", self.0.id)
        } else {
            write!(f, "{}", EndpointTicket::new(self.0.clone()))
        }
    }
}

/// A string that is neither an endpoint ID nor an endpoint ticket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseTargetError(String);

impl fmt::Display for ParseTargetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "not an endpoint ID or ticket: {:?}", self.0)
    }
}

impl std::error::Error for ParseTargetError {}

impl FromStr for Target {
    type Err = ParseTargetError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let s = s.trim();
        if let Ok(id) = EndpointId::from_str(s) {
            return Ok(id.into());
        }
        if let Ok(id) = EndpointId::from_z32(s) {
            return Ok(id.into());
        }
        EndpointTicket::from_str(s)
            .map(Into::into)
            .map_err(|_| ParseTargetError(s.to_owned()))
    }
}

/// Every address the endpoint's lookup services know for `id`, merged, or
/// `None` if none answered within `timeout`.
///
/// `Endpoint::connect` does this on its own, so a program only needs it to
/// ask whether a peer is findable at all, or to show where it is.
pub async fn resolve(
    endpoint: &Endpoint,
    id: EndpointId,
    timeout: Duration,
) -> Option<EndpointAddr> {
    let stream = endpoint.address_lookup().ok()?.resolve(id);
    let mut found = EndpointAddr::new(id);
    let collect = stream.for_each(|item| {
        if let Ok(Ok(item)) = item {
            found.addrs.extend(item.into_endpoint_addr().addrs);
        }
        std::future::ready(())
    });
    // A timeout only cuts short the slow sources; what the fast ones found
    // still counts.
    let _ = tokio::time::timeout(timeout, collect).await;
    (!found.is_empty()).then_some(found)
}

/// Why [`dial`] failed.
#[derive(Debug)]
pub enum DialError {
    /// No connection within [`DIAL_TIMEOUT`]. For an ID with no addresses
    /// this usually means no lookup service had a record for it.
    TimedOut(EndpointId),
    /// iroh gave up, with its reason.
    Connect(ConnectError),
}

impl fmt::Display for DialError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TimedOut(id) => write!(f, "no connection to {id} within {DIAL_TIMEOUT:?}"),
            Self::Connect(err) => write!(f, "connecting: {err}"),
        }
    }
}

impl std::error::Error for DialError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::TimedOut(_) => None,
            Self::Connect(err) => Some(err),
        }
    }
}

/// Connects to `target` over `alpn`, looking up its addresses as needed,
/// and gives up after [`DIAL_TIMEOUT`].
///
/// Addresses a ticket carries are tried alongside whatever lookup finds,
/// so a stale ticket still works as long as the ID is findable.
pub async fn dial(
    endpoint: &Endpoint,
    target: Target,
    alpn: &[u8],
) -> Result<Connection, DialError> {
    let id = target.id();
    match tokio::time::timeout(DIAL_TIMEOUT, endpoint.connect(target, alpn)).await {
        Ok(conn) => conn.map_err(DialError::Connect),
        Err(_) => Err(DialError::TimedOut(id)),
    }
}

/// A ticket for this endpoint with whatever addresses it currently has, to
/// hand to someone who will [`dial`] it.
///
/// With address lookup on, the bare [`Endpoint::id`] is enough, and unlike
/// a ticket it never goes stale. A ticket still helps a peer that shares
/// none of this endpoint's lookup services.
pub fn ticket(endpoint: &Endpoint) -> EndpointTicket {
    EndpointTicket::new(endpoint.addr())
}

#[cfg(test)]
mod tests;
