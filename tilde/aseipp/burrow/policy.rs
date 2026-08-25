// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Server-side routing policy for client-selected destinations.

use std::collections::BTreeSet;
use std::fmt;
use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;
use std::str::FromStr;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use burrow_core::{
    Destination, DestinationPolicy, Host, PolicyFuture, Response, ResponseStatus, Target,
};
use futures::FutureExt;
use iroh::EndpointId;
use tokio::net::TcpStream;

const TARGET_TIMEOUT: Duration = Duration::from_secs(10);

/// A normalized set parsed from forms such as `22,80,8000-8999`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct PortSet(Arc<BTreeSet<u16>>);

impl PortSet {
    pub(crate) fn contains(&self, port: u16) -> bool {
        self.0.contains(&port)
    }
}

impl FromStr for PortSet {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        if text.trim() == "all" {
            return Ok(Self(Arc::new((1..=u16::MAX).collect())));
        }
        let mut ports = BTreeSet::new();
        for item in text.split(',') {
            let item = item.trim();
            if item.is_empty() {
                return Err("port list contains an empty item".into());
            }
            if let Some((start, end)) = item.split_once('-') {
                let start = parse_port(start)?;
                let end = parse_port(end)?;
                if start > end {
                    return Err(format!("port range {item:?} runs backwards"));
                }
                ports.extend(start..=end);
            } else {
                ports.insert(parse_port(item)?);
            }
        }
        Ok(Self(Arc::new(ports)))
    }
}

fn parse_port(text: &str) -> Result<u16, String> {
    match text.parse::<u16>() {
        Ok(0) => Err("port 0 is not a routable destination".into()),
        Ok(port) => Ok(port),
        Err(_) => Err(format!("invalid TCP port {text:?}")),
    }
}

#[derive(Clone, Debug)]
pub(crate) struct RoutePolicy {
    default: SocketAddr,
    local_ports: PortSet,
    exit_node: bool,
}

impl RoutePolicy {
    pub(crate) fn new(default: SocketAddr, local_ports: PortSet, exit_node: bool) -> Self {
        Self {
            default,
            local_ports,
            exit_node,
        }
    }

    /// Applies policy before connecting. DNS names intentionally stay names
    /// until this side of the tunnel, which gives SOCKS its `socks5h` behavior.
    async fn connect_target(&self, target: Target) -> Result<Destination, Response> {
        let display = target.to_string();
        let connect: Pin<Box<dyn Future<Output = io::Result<TcpStream>> + Send>> = match target {
            Target::Default => Box::pin(TcpStream::connect(self.default)),
            Target::LocalPort(port) if self.local_ports.contains(port) => {
                // A service may bind either loopback family.  Pass both
                // literal addresses to Tokio so an unavailable family falls
                // through without relying on the host's DNS configuration.
                let loopback = [
                    SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port),
                    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
                ];
                Box::pin(async move { TcpStream::connect(&loopback[..]).await })
            }
            Target::LocalPort(port) => {
                return Err(Response::new(ResponseStatus::Denied)
                    .with_message(format!("local port {port} is not allowed")));
            }
            Target::Tcp { .. } if !self.exit_node => {
                return Err(Response::new(ResponseStatus::Denied)
                    .with_message("arbitrary TCP routing is disabled on this server"));
            }
            Target::Tcp {
                host: Host::Ip(ip),
                port,
            } => Box::pin(TcpStream::connect(SocketAddr::new(ip, port))),
            Target::Tcp {
                host: Host::Name(name),
                port,
            } => Box::pin(async move { TcpStream::connect((name.as_str(), port)).await }),
        };

        match tokio::time::timeout(TARGET_TIMEOUT, connect).await {
            Ok(Ok(stream)) => {
                let _ = stream.set_nodelay(true);
                Ok(Destination::tcp(stream))
            }
            Ok(Err(err)) => Err(Response::new(ResponseStatus::Unreachable)
                .with_message(format!("connecting to {display}: {err}"))),
            Err(_) => Err(
                Response::new(ResponseStatus::Unreachable).with_message(format!(
                    "connecting to {display} timed out after {TARGET_TIMEOUT:?}"
                )),
            ),
        }
    }
}

impl DestinationPolicy for RoutePolicy {
    fn connect(&self, _remote: EndpointId, target: Target) -> PolicyFuture {
        let policy = self.clone();
        async move { policy.connect_target(target).await }.boxed()
    }
}

/// Atomically lends one process-output sink to one default request.
///
/// Clones share the same slot. A reservation which disappears before the
/// positive response is written returns the destination to that slot, so a
/// cancelled request cannot consume the one-shot pipe.
#[derive(Clone)]
pub(crate) struct PipePolicy {
    destination: Arc<Mutex<Option<Destination>>>,
}

impl PipePolicy {
    pub(crate) fn stdio() -> Self {
        Self::sink(tokio::io::stdout())
    }

    pub(crate) fn sink<W>(write: W) -> Self
    where
        W: tokio::io::AsyncWrite + Send + Unpin + 'static,
    {
        Self {
            destination: Arc::new(Mutex::new(Some(Destination::sink(write)))),
        }
    }

    fn reserve(&self) -> Option<Destination> {
        let destination = self
            .destination
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()?;
        let slot: Weak<Mutex<Option<Destination>>> = Arc::downgrade(&self.destination);
        Some(destination.reclaim_on_abort(move |destination| {
            let Some(slot) = slot.upgrade() else {
                return;
            };
            let mut slot = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            // Only this reservation can refill an empty slot. Avoid panicking
            // in Destination::drop if future code ever violates that invariant.
            if slot.is_none() {
                *slot = Some(destination);
            }
        }))
    }
}

impl DestinationPolicy for PipePolicy {
    fn connect(&self, _remote: EndpointId, target: Target) -> PolicyFuture {
        let result = if target != Target::Default {
            Err(Response::new(ResponseStatus::Denied)
                .with_message("the one-shot pipe accepts only the default target"))
        } else {
            self.reserve().ok_or_else(|| {
                Response::new(ResponseStatus::Denied)
                    .with_message("the one-shot pipe has already been claimed")
            })
        };
        async move { result }.boxed()
    }
}

impl fmt::Display for PortSet {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut ports = self.0.iter().copied().peekable();
        let mut first = true;
        while let Some(start) = ports.next() {
            let mut end = start;
            while ports
                .peek()
                .is_some_and(|next| *next == end.saturating_add(1))
            {
                end = ports.next().expect("peeked at the next port");
            }
            if !first {
                f.write_str(",")?;
            }
            first = false;
            start.fmt(f)?;
            if end != start {
                write!(f, "-{end}")?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "tests/policy.rs"]
mod tests;
