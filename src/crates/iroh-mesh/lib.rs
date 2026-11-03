// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A host and the members that join it over iroh, from anywhere, and the
//! gRPC services the host serves them.
//!
//! A member dials the host on its [`Protocol`]'s ALPN and proves, on the
//! connection's first stream, that it knows a join key
//! ([`Protocol::join`]); the host proves it back ([`Protocol::admit`]).
//! Every later stream of the connection then carries one HTTP/2
//! connection, so the host's gRPC services serve over iroh as they do over
//! TCP ([`Protocol::serve`], [`channel`]).
//!
//! A member finds the host by a [`JoinTicket`], which carries the host's
//! ID, its addresses and its join key, or by the host's six-word
//! [`JoinCode`], which names a [`Cluster`] on the mainline DHT.
//!
//! Join keys and codes are credentials: whoever holds one can join.

mod cluster;
mod code;
mod grpc;
mod join;
mod keys;
mod ticket;
mod words;

pub use cluster::Cluster;
pub use code::{JoinCode, ParseCodeError};
pub use grpc::{Stream, Transport, channel};
pub use iroh_rendezvous::{Announcer, Rendezvous, n0_mainline::Dht};
pub use join::{CLOSE_REFUSED, HANDSHAKE_TIMEOUT, JoinError};
pub use keys::{JoinKey, load_or_create_identity};
pub use ticket::{JoinTicket, ParseTicketError};

pub use iroh::{Endpoint, EndpointAddr, EndpointId, SecretKey};

/// What an application's hosts and members speak, and the names that keep
/// its credentials from meaning anything to another application.
///
/// Everything here is part of the wire format: the ALPN names the
/// connection, the name domain-separates join proofs and the clusters join
/// codes derive, and the role labels are in every proof. Changing any of
/// them strands every member and every code in use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Protocol {
    /// The ALPN hosts accept members on.
    pub alpn: &'static [u8],
    /// The application, for domain separation.
    pub name: &'static str,
    /// What the application calls a host, as proofs name it.
    pub host: &'static str,
    /// What the application calls a member, as proofs name it.
    pub member: &'static str,
}

impl Protocol {
    /// The Argon2 salt join codes derive their clusters with.
    pub(crate) fn code_salt(&self) -> String {
        format!("{} join code v1", self.name)
    }
}

#[cfg(test)]
mod tests;
