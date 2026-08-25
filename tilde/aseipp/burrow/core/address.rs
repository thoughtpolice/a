// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Self-contained, shareable address encoding for a Burrow server.
//!
//! An iroh endpoint ID authenticates a peer, but it does not say how to reach
//! it.  [`BurrowAddr`] carries the endpoint ID together with its rendezvous
//! relay and any direct address hints.  Its text form is safe to paste into a
//! command line: `br1` followed by URL-safe, unpadded base64 containing compact
//! JSON.

use std::error::Error;
use std::fmt;
use std::net::SocketAddr;
use std::str::FromStr;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use iroh::{EndpointAddr, EndpointId, RelayUrl, TransportAddr};
use serde::{Deserialize, Serialize};

/// Prefix of the current Burrow address text format.
pub const ADDRESS_PREFIX: &str = "br1";

/// Largest decoded JSON representation accepted from an address string.
///
/// Normal addresses are only a few hundred bytes.  The generous limit leaves
/// room for many direct hints while preventing an attacker-controlled command
/// line or DNS record from causing an unbounded allocation.
pub const MAX_ADDRESS_BYTES: usize = 16 * 1024;

/// Maximum number of direct socket-address hints in one shareable address.
///
/// A handful is normally enough to cover every interface.  The deliberately
/// generous cap also bounds local construction from arbitrary iterators before
/// any collection or serialization allocation occurs.
pub const MAX_DIRECT_ADDRS: usize = 64;

const ADDRESS_VERSION: u8 = 1;
const MAX_ENCODED_BYTES: usize = MAX_ADDRESS_BYTES.div_ceil(3) * 4;

/// A versioned address containing everything needed to dial a Burrow server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BurrowAddr {
    id: EndpointId,
    relay: RelayUrl,
    direct_addrs: Vec<SocketAddr>,
    text: String,
}

impl BurrowAddr {
    /// The version written inside the encoded address.
    pub const VERSION: u8 = ADDRESS_VERSION;

    /// Creates an address with no direct address hints.
    pub fn new(id: EndpointId, relay: RelayUrl) -> Result<Self, EncodeBurrowAddrError> {
        Self::from_parts(id, relay, Vec::new())
    }

    /// Replaces the direct address hints.
    pub fn with_direct_addrs(
        self,
        addrs: impl IntoIterator<Item = SocketAddr>,
    ) -> Result<Self, EncodeBurrowAddrError> {
        let mut direct_addrs = Vec::new();
        for addr in addrs {
            if direct_addrs.len() == MAX_DIRECT_ADDRS {
                return Err(EncodeBurrowAddrError::TooManyDirectAddrs);
            }
            direct_addrs.push(addr);
        }
        Self::from_parts(self.id, self.relay, direct_addrs)
    }

    /// Returns the cryptographic identity of the server.
    pub fn id(&self) -> EndpointId {
        self.id
    }

    /// Returns the rendezvous and fallback relay.
    pub fn relay(&self) -> &RelayUrl {
        &self.relay
    }

    /// Returns the direct socket address hints.
    pub fn direct_addrs(&self) -> &[SocketAddr] {
        &self.direct_addrs
    }

    /// Returns the canonical, bounded text representation.
    pub fn as_str(&self) -> &str {
        &self.text
    }

    /// Converts this shareable address to the form accepted by iroh.
    pub fn endpoint_addr(&self) -> EndpointAddr {
        EndpointAddr::new(self.id)
            .with_relay_url(self.relay.clone())
            .with_addrs(self.direct_addrs.iter().copied().map(TransportAddr::Ip))
    }

    fn from_parts(
        id: EndpointId,
        relay: RelayUrl,
        mut direct_addrs: Vec<SocketAddr>,
    ) -> Result<Self, EncodeBurrowAddrError> {
        if direct_addrs.len() > MAX_DIRECT_ADDRS {
            return Err(EncodeBurrowAddrError::TooManyDirectAddrs);
        }
        direct_addrs.sort_unstable();
        direct_addrs.dedup();
        let wire = WireAddr {
            v: ADDRESS_VERSION,
            i: id,
            r: relay.clone(),
            a: direct_addrs.clone(),
        };
        let json = serde_json::to_vec(&wire).map_err(EncodeBurrowAddrError::Json)?;
        if json.len() > MAX_ADDRESS_BYTES {
            return Err(EncodeBurrowAddrError::TooLong);
        }
        let text = format!("{ADDRESS_PREFIX}{}", URL_SAFE_NO_PAD.encode(json));
        Ok(Self {
            id,
            relay,
            direct_addrs,
            text,
        })
    }
}

/// Compact, explicitly versioned JSON representation inside the base64 text.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireAddr {
    v: u8,
    i: EndpointId,
    r: RelayUrl,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    a: Vec<SocketAddr>,
}

impl fmt::Display for BurrowAddr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text)
    }
}

/// Error returned when constructing a bounded Burrow address fails.
#[derive(Debug)]
pub enum EncodeBurrowAddrError {
    /// More than [`MAX_DIRECT_ADDRS`] direct hints were supplied.
    TooManyDirectAddrs,
    /// The decoded JSON representation would exceed [`MAX_ADDRESS_BYTES`].
    TooLong,
    /// The address fields could not be serialized.
    Json(serde_json::Error),
}

impl fmt::Display for EncodeBurrowAddrError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooManyDirectAddrs => write!(
                f,
                "Burrow address has more than {MAX_DIRECT_ADDRS} direct address hints"
            ),
            Self::TooLong => write!(
                f,
                "Burrow address exceeds the {MAX_ADDRESS_BYTES}-byte decoded limit"
            ),
            Self::Json(err) => write!(f, "encoding Burrow address JSON: {err}"),
        }
    }
}

impl Error for EncodeBurrowAddrError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Json(err) => Some(err),
            Self::TooManyDirectAddrs | Self::TooLong => None,
        }
    }
}

/// Error returned when a string is not a valid current-format Burrow address.
#[derive(Debug)]
pub enum ParseBurrowAddrError {
    /// The address does not start with the current `br1` prefix.
    InvalidPrefix,
    /// The encoded or decoded representation exceeds [`MAX_ADDRESS_BYTES`].
    TooLong,
    /// The address contains more than [`MAX_DIRECT_ADDRS`] direct hints.
    TooManyDirectAddrs,
    /// The payload is not URL-safe, unpadded base64.
    Base64(base64::DecodeError),
    /// The decoded payload is not the expected compact JSON structure.
    Json(serde_json::Error),
    /// The JSON structure names a format version this build does not know.
    UnsupportedVersion(u8),
}

impl fmt::Display for ParseBurrowAddrError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPrefix => write!(f, "Burrow address must start with {ADDRESS_PREFIX:?}"),
            Self::TooLong => write!(
                f,
                "Burrow address exceeds the {MAX_ADDRESS_BYTES}-byte decoded limit"
            ),
            Self::TooManyDirectAddrs => write!(
                f,
                "Burrow address has more than {MAX_DIRECT_ADDRS} direct address hints"
            ),
            Self::Base64(err) => write!(f, "invalid Burrow address base64: {err}"),
            Self::Json(err) => write!(f, "invalid Burrow address JSON: {err}"),
            Self::UnsupportedVersion(version) => {
                write!(f, "unsupported Burrow address version {version}")
            }
        }
    }
}

impl Error for ParseBurrowAddrError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Base64(err) => Some(err),
            Self::Json(err) => Some(err),
            _ => None,
        }
    }
}

impl FromStr for BurrowAddr {
    type Err = ParseBurrowAddrError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let payload = text
            .strip_prefix(ADDRESS_PREFIX)
            .ok_or(ParseBurrowAddrError::InvalidPrefix)?;
        if payload.len() > MAX_ENCODED_BYTES {
            return Err(ParseBurrowAddrError::TooLong);
        }
        let json = URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(ParseBurrowAddrError::Base64)?;
        if json.len() > MAX_ADDRESS_BYTES {
            return Err(ParseBurrowAddrError::TooLong);
        }
        let wire: WireAddr = serde_json::from_slice(&json).map_err(ParseBurrowAddrError::Json)?;
        if wire.v != ADDRESS_VERSION {
            return Err(ParseBurrowAddrError::UnsupportedVersion(wire.v));
        }
        Self::from_parts(wire.i, wire.r, wire.a).map_err(|err| match err {
            EncodeBurrowAddrError::TooManyDirectAddrs => ParseBurrowAddrError::TooManyDirectAddrs,
            EncodeBurrowAddrError::TooLong => ParseBurrowAddrError::TooLong,
            EncodeBurrowAddrError::Json(err) => ParseBurrowAddrError::Json(err),
        })
    }
}

#[cfg(test)]
#[path = "../tests/core/address.rs"]
mod tests;
