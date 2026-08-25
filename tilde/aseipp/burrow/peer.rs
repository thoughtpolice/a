// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Parsing a legacy endpoint ID or a self-contained Burrow address.

use std::fmt;
use std::net::SocketAddr;
use std::str::FromStr;

use burrow_core::BurrowAddr;
use iroh::{EndpointAddr, EndpointId, RelayUrl, TransportAddr};

#[derive(Clone, Debug)]
pub(crate) enum Peer {
    Id(EndpointId),
    Address(BurrowAddr),
}

impl Peer {
    pub(crate) fn id(&self) -> EndpointId {
        match self {
            Self::Id(id) => *id,
            Self::Address(addr) => addr.id(),
        }
    }

    pub(crate) fn endpoint_addr(
        &self,
        fallback_relay: RelayUrl,
        extra_addrs: impl IntoIterator<Item = SocketAddr>,
    ) -> EndpointAddr {
        match self {
            Self::Id(id) => EndpointAddr::new(*id)
                .with_relay_url(fallback_relay)
                .with_addrs(extra_addrs.into_iter().map(TransportAddr::Ip)),
            Self::Address(addr) => {
                let mut endpoint = addr.endpoint_addr();
                for direct in extra_addrs {
                    endpoint = endpoint.with_addrs([TransportAddr::Ip(direct)]);
                }
                endpoint
            }
        }
    }
}

impl FromStr for Peer {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        if text.starts_with(burrow_core::address::ADDRESS_PREFIX) {
            return text
                .parse()
                .map(Self::Address)
                .map_err(|err| err.to_string());
        }
        text.parse()
            .map(Self::Id)
            .map_err(|err| format!("invalid endpoint ID or Burrow address: {err}"))
    }
}

impl fmt::Display for Peer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Id(id) => id.fmt(f),
            Self::Address(addr) => addr.fmt(f),
        }
    }
}

#[cfg(test)]
#[path = "tests/peer.rs"]
mod tests;
