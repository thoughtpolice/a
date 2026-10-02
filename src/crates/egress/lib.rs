// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Outbound connections to hosts named by untrusted input.
//!
//! A server that fetches URLs on a client's behalf must not become a way into
//! the network it runs on. [`connect`] resolves the host, refuses the whole
//! answer if any address is internal (loopback, private, link-local including
//! cloud metadata endpoints, CGNAT, unique-local, and similar), and then
//! connects only to the addresses it checked, so a second DNS answer cannot
//! substitute an internal one (DNS rebinding).
//!
//! Every hop needs the check, redirects included: each one names a new host.

use std::io;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::net::TcpStream;

/// Test-only switch that lets [`connect`] reach loopback addresses.
///
/// Tests that fetch from a fake server bound to `127.0.0.1` set this. Only
/// loopback is let through; every other blocked range stays blocked. Never
/// set it in production code.
#[doc(hidden)]
pub static ALLOW_LOOPBACK_FOR_TESTS: AtomicBool = AtomicBool::new(false);

/// Why [`connect`] did not produce a connection.
#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error("DNS lookup for {host}: {source}")]
    Resolve {
        host: String,
        #[source]
        source: io::Error,
    },
    #[error("DNS lookup for {host} returned no addresses")]
    NoAddresses { host: String },
    /// The host resolved to an address in a blocked range.
    #[error("{host} resolved to blocked address {addr}")]
    Blocked { host: String, addr: IpAddr },
    #[error("TCP connect to {host}:{port}: {source}")]
    Connect {
        host: String,
        port: u16,
        #[source]
        source: io::Error,
    },
}

/// Returns `true` if `ip` is in a range that outbound fetches must not reach.
pub fn is_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()         // 127.0.0.0/8
            || v4.is_private()       // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
            || v4.is_link_local()    // 169.254.0.0/16 (includes cloud metadata endpoint)
            || v4.is_broadcast()     // 255.255.255.255
            || v4.is_unspecified()   // 0.0.0.0
            || v4.is_documentation() // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24
            || v4.octets()[0] == 100 && (v4.octets()[1] & 0xC0) == 64 // 100.64.0.0/10 (CGNAT)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()       // ::1
            || v6.is_unspecified() // ::
            // IPv4-mapped IPv6: ::ffff:x.x.x.x -- extract the inner v4 and re-check
            || v6.to_ipv4_mapped().is_some_and(|v4| is_blocked(IpAddr::V4(v4)))
            // Link-local unicast: fe80::/10
            || (v6.segments()[0] & 0xffc0) == 0xfe80
            // Unique local addresses (ULA): fc00::/7
            || (v6.segments()[0] & 0xfe00) == 0xfc00
        }
    }
}

/// Resolve `host`, check every address it resolves to, then connect to one.
///
/// If even one resolved address is blocked the whole answer is rejected, so
/// a hostile name server cannot mix an internal address in with public ones.
/// `host` may be an IPv6 literal in URI brackets, as `http::Uri::host`
/// returns it.
pub async fn connect(host: &str, port: u16) -> Result<TcpStream, ConnectError> {
    let name = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((name, port))
        .await
        .map_err(|source| ConnectError::Resolve {
            host: host.to_string(),
            source,
        })?
        .collect();
    if addrs.is_empty() {
        return Err(ConnectError::NoAddresses {
            host: host.to_string(),
        });
    }

    let allow_loopback = ALLOW_LOOPBACK_FOR_TESTS.load(Ordering::Relaxed);
    if let Some(addr) = addrs
        .iter()
        .map(|addr| addr.ip())
        .find(|ip| is_blocked(*ip) && !(allow_loopback && ip.is_loopback()))
    {
        return Err(ConnectError::Blocked {
            host: host.to_string(),
            addr,
        });
    }

    TcpStream::connect(addrs.as_slice())
        .await
        .map_err(|source| ConnectError::Connect {
            host: host.to_string(),
            port,
            source,
        })
}

/// The `Host` header for a request to `host` on `port` over `scheme`.
///
/// HTTP requires the header to match the target URI's authority, so a port
/// other than the scheme's default must be included: virtual hosts and
/// proxies route on it and build redirects from it.
pub fn host_header(scheme: &str, host: &str, port: u16) -> String {
    let default_port = if scheme == "https" { 443 } else { 80 };
    if port == default_port {
        host.to_string()
    } else {
        format!("{host}:{port}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocked(ip: &str) -> bool {
        is_blocked(ip.parse().unwrap())
    }

    #[test]
    fn blocked_ipv4_loopback() {
        assert!(blocked("127.0.0.1"));
        assert!(blocked("127.255.255.255"));
    }

    #[test]
    fn blocked_ipv4_private_rfc1918() {
        assert!(blocked("10.0.0.1"));
        assert!(blocked("10.255.255.255"));
        assert!(blocked("172.16.0.1"));
        assert!(blocked("172.31.255.255"));
        assert!(blocked("192.168.0.1"));
        assert!(blocked("192.168.255.255"));
    }

    #[test]
    fn blocked_ipv4_link_local() {
        assert!(blocked("169.254.169.254"));
        assert!(blocked("169.254.0.1"));
    }

    #[test]
    fn blocked_ipv4_special() {
        assert!(blocked("0.0.0.0"));
        assert!(blocked("255.255.255.255"));
        assert!(blocked("100.64.0.1"));
        assert!(blocked("100.127.255.255"));
        assert!(blocked("192.0.2.1"));
    }

    #[test]
    fn allowed_ipv4_public() {
        assert!(!blocked("8.8.8.8"));
        assert!(!blocked("1.1.1.1"));
        assert!(!blocked("100.128.0.1"));
        assert!(!blocked("172.32.0.1"));
    }

    #[test]
    fn blocked_ipv6() {
        assert!(blocked("::1"));
        assert!(blocked("::"));
        assert!(blocked("fe80::1"));
        assert!(blocked("fd00::1"));
        assert!(blocked("fc00::1"));
        assert!(blocked("::ffff:127.0.0.1"));
        assert!(blocked("::ffff:10.0.0.1"));
        assert!(blocked("::ffff:169.254.169.254"));
    }

    #[test]
    fn allowed_ipv6_public() {
        assert!(!blocked("2607:f8b0:4004:800::200e"));
        assert!(!blocked("::ffff:8.8.8.8"));
    }

    #[test]
    fn host_header_includes_only_non_default_ports() {
        assert_eq!(host_header("https", "example.com", 443), "example.com");
        assert_eq!(host_header("http", "example.com", 80), "example.com");
        assert_eq!(
            host_header("https", "example.com", 8443),
            "example.com:8443"
        );
        assert_eq!(host_header("http", "example.com", 443), "example.com:443");
        assert_eq!(host_header("http", "[::1]", 8080), "[::1]:8080");
    }

    #[tokio::test]
    async fn connect_refuses_loopback() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        for host in ["127.0.0.1", "localhost"] {
            let err = connect(host, port).await.unwrap_err();
            assert!(matches!(err, ConnectError::Blocked { .. }), "{host}: {err}");
        }
    }

    #[tokio::test]
    async fn connect_refuses_private_and_metadata_addresses_without_dialing() {
        // Nothing listens on these; a refusal that names the address shows the
        // check ran before any connection attempt.
        for host in ["10.0.0.5", "169.254.169.254", "[fd00::1]"] {
            let err = connect(host, 6379).await.unwrap_err();
            assert!(matches!(err, ConnectError::Blocked { .. }), "{host}: {err}");
        }
    }

    #[tokio::test]
    async fn loopback_switch_admits_only_loopback() {
        ALLOW_LOOPBACK_FOR_TESTS.store(true, Ordering::Relaxed);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        connect("127.0.0.1", port).await.unwrap();
        let err = connect("10.0.0.5", port).await.unwrap_err();
        assert!(matches!(err, ConnectError::Blocked { .. }), "{err}");
    }
}
