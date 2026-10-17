// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! How gonzo daemons and their workers reach each other over iroh.
//!
//! A worker dials the daemon on [`ALPN`] and proves, on the connection's
//! first stream, that it knows a join key ([`join`]); the daemon proves it
//! back. Every later stream of the connection then carries one HTTP/2
//! connection, so the daemon's gRPC services serve over iroh as they do
//! over TCP ([`serve`], [`channel`]). See `src/gonzo/notes/execution.md`.
//!
//! A worker finds the daemon by a ticket, which carries the daemon's ID,
//! its addresses and its join key, or by the daemon's six-word
//! [`JoinCode`], which names a [`Cluster`] on the mainline DHT.

mod cluster;
mod code;
mod grpc;
mod join;
mod keys;
mod ticket;
mod words;

pub use cluster::Cluster;
pub use code::{JoinCode, ParseCodeError};
pub use grpc::{Stream, bind, channel, serve};
pub use iroh_rendezvous::{Announcer, Rendezvous, n0_mainline::Dht};
pub use join::{CLOSE_REFUSED, HANDSHAKE_TIMEOUT, JoinError, admit, join};
pub use keys::{JoinKey, load_or_create_identity};
pub use ticket::{JoinTicket, ParseTicketError};

pub use iroh::{Endpoint, EndpointAddr, EndpointId, SecretKey};

/// What workers and daemons speak.
pub const ALPN: &[u8] = b"gonzo/worker/1";

#[cfg(test)]
mod tests;
