// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Small things every iroh program ends up writing.
//!
//! Nothing here picks a crypto provider, a relay or a discovery service.
//! These are the helpers left over once a program has made those choices:
//! how to wait for a relay, how to dial an endpoint on this machine, and
//! how to tell an ordinary end of a connection from a real failure.
//!
//! For endpoints on the in-tree BoringSSL provider, see `iroh-boring`.

use std::io;
use std::net::SocketAddr;
use std::time::Duration;

use iroh::endpoint::{ConnectionError, ReadError, VarInt, WriteError};
use iroh::{Endpoint, EndpointAddr, RelayUrl, TransportAddr, Watcher};

/// How long to wait for a relay before deciding an endpoint is only
/// reachable by direct address. Relays answer in well under a second when
/// they answer at all, so this is a patience limit, not an expectation.
pub const RELAY_TIMEOUT: Duration = Duration::from_secs(15);

/// The code a QUIC peer closes with when it simply finished. noq also
/// sends it when a connection handle is dropped, so it means "no error"
/// rather than anything a program chose to say.
pub const CLOSE_DONE: VarInt = VarInt::from_u32(0);

/// Waits for the endpoint to reach a relay and returns which one answered,
/// or `None` if the endpoint closed first.
///
/// An endpoint with no relay configured never comes online, so bound this
/// with [`RELAY_TIMEOUT`] and read a timeout as "no relay yet" rather than
/// as an error. Direct addresses still work either way.
pub async fn home_relay(endpoint: &Endpoint) -> Option<RelayUrl> {
    tokio::select! {
        biased;
        _ = endpoint.closed() => return None,
        _ = endpoint.online() => {}
    }
    endpoint
        .home_relay_status()
        .get()
        .iter()
        .find(|status| status.is_connected())
        .map(|status| status.url().clone())
}

/// The endpoint's bound sockets, with any unspecified address rewritten to
/// loopback so the result can be dialed.
///
/// An endpoint bound to `0.0.0.0:0` reports exactly that, and no peer can
/// connect to it. Rewriting is what lets a program on this machine dial
/// another with no relay and no address lookup in the way, which is how
/// most tests and single-host demos work.
pub fn dialable_addrs(endpoint: &Endpoint) -> Vec<SocketAddr> {
    endpoint
        .bound_sockets()
        .into_iter()
        .map(|mut addr| {
            if addr.ip().is_unspecified() {
                match addr {
                    SocketAddr::V4(_) => addr.set_ip(std::net::Ipv4Addr::LOCALHOST.into()),
                    SocketAddr::V6(_) => addr.set_ip(std::net::Ipv6Addr::LOCALHOST.into()),
                }
            }
            addr
        })
        .collect()
}

/// The endpoint's ID together with its [`dialable_addrs`], ready to hand
/// to `Endpoint::connect`.
pub fn dialable_addr(endpoint: &Endpoint) -> EndpointAddr {
    EndpointAddr::from_parts(
        endpoint.id(),
        dialable_addrs(endpoint).into_iter().map(TransportAddr::Ip),
    )
}

/// The code the peer reset or stopped a stream with, if that is what ended
/// it.
///
/// A program that resets streams with codes of its own gets them back
/// here, which is the only way to tell the peer's reason from a local one:
/// `tokio::io::copy` and friends hand back an `io::Error`, and the typed
/// error survives as its source.
pub fn peer_code(err: &io::Error) -> Option<VarInt> {
    let source = err.get_ref()?;
    if let Some(ReadError::Reset(code)) = source.downcast_ref::<ReadError>() {
        return Some(*code);
    }
    if let Some(WriteError::Stopped(code)) = source.downcast_ref::<WriteError>() {
        return Some(*code);
    }
    None
}

/// Whether a stream error is only its connection ending the way a finished
/// session ends.
///
/// Worth asking before logging. A copy that is still running when either
/// side closes reports the close as a failure, and on a busy server that
/// turns every clean disconnect into a warning.
pub fn is_normal_close(err: &io::Error) -> bool {
    let Some(source) = err.get_ref() else {
        return false;
    };
    let lost = if let Some(ReadError::ConnectionLost(lost)) = source.downcast_ref::<ReadError>() {
        lost
    } else if let Some(WriteError::ConnectionLost(lost)) = source.downcast_ref::<WriteError>() {
        lost
    } else {
        return false;
    };
    match lost {
        ConnectionError::LocallyClosed => true,
        ConnectionError::ApplicationClosed(close) => close.error_code == CLOSE_DONE,
        _ => false,
    }
}

#[cfg(test)]
mod tests;
