// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Reusable protocol and transport machinery within the Burrow package.
//!
//! This crate deliberately starts with an already-built [`iroh::Endpoint`].
//! Applications remain responsible for identity storage, crypto-provider and
//! relay selection, logging, and user-facing destination policy.

pub mod address;
pub mod protocol;
pub mod splice;
pub mod transport;

pub use address::{BurrowAddr, EncodeBurrowAddrError, MAX_DIRECT_ADDRS, ParseBurrowAddrError};
pub use protocol::{
    ALPN, Host, HostName, ParseHostNameError, ParseTargetError, Request, Response, ResponseStatus,
    Target,
};
pub use splice::{LocalEof, RESET_ABORTED, splice, splice_tcp};
pub use transport::{
    CLOSE_BUSY, CLOSE_NOT_ALLOWED, CLOSE_RETIRED, CLOSE_SHUTDOWN, Client, ClientConfig,
    ClientError, Destination, DestinationPolicy, OpenedStream, Ping, PolicyFuture, RESET_BUSY,
    Server, ServerConfig,
};
