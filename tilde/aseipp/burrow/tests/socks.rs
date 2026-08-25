// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::collections::BTreeSet;

use burrow_core::ServerConfig;

use crate::endpoint::{Role, bind};
use crate::policy::{PortSet, RoutePolicy};
use crate::tunnel::serve_configured;

impl SocksRouter {
    fn dynamic_len(&self) -> usize {
        self.0
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .dynamic
            .len()
    }
}

const PATIENCE: Duration = Duration::from_secs(10);

fn address() -> BurrowAddr {
    BurrowAddr::new(
        iroh::SecretKey::generate().public(),
        "https://relay.example.com./".parse().unwrap(),
    )
    .unwrap()
}

fn address_route(address: BurrowAddr, port: u16) -> SocksRoute {
    SocksRoute::Address {
        address,
        target: Target::LocalPort(port),
    }
}

async fn run_handshake(
    input: &[u8],
    reply_len: usize,
) -> (io::Result<Option<SocksRoute>>, Vec<u8>) {
    let capacity = input.len().max(reply_len).max(1);
    let (mut peer, mut server) = tokio::io::duplex(capacity);
    peer.write_all(input).await.expect("write SOCKS request");
    let result = handshake(&mut server).await;
    let mut reply = vec![0; reply_len];
    peer.read_exact(&mut reply).await.expect("read SOCKS reply");
    (result, reply)
}

fn name_request(command: u8, name: &[u8], port: u16) -> Vec<u8> {
    let mut request = vec![SOCKS_VERSION, 1, METHOD_NO_AUTH];
    request.extend_from_slice(&[SOCKS_VERSION, command, 0, ADDRESS_NAME, name.len() as u8]);
    request.extend_from_slice(name);
    request.extend_from_slice(&port.to_be_bytes());
    request
}

fn address_request(address_type: u8, address: &[u8], port: u16) -> Vec<u8> {
    let mut request = vec![SOCKS_VERSION, 1, METHOD_NO_AUTH];
    request.extend_from_slice(&[SOCKS_VERSION, COMMAND_CONNECT, 0, address_type]);
    request.extend_from_slice(address);
    request.extend_from_slice(&port.to_be_bytes());
    request
}

#[tokio::test]
async fn domains_are_left_for_the_burrow_server_to_resolve() {
    let input = name_request(COMMAND_CONNECT, b"www.example.com", 443);
    let (target, reply) = run_handshake(&input, 2).await;
    assert_eq!(reply, [SOCKS_VERSION, METHOD_NO_AUTH]);
    assert_eq!(
        target.expect("valid handshake"),
        Some(SocksRoute::Fixed(Target::Tcp {
            host: Host::Name(HostName::new("www.example.com").unwrap()),
            port: 443,
        }))
    );
}

#[tokio::test]
async fn the_magic_server_name_selects_a_loopback_port() {
    let input = name_request(COMMAND_CONNECT, b"SERVER.BURROW", 22);
    let (target, _) = run_handshake(&input, 2).await;
    assert_eq!(
        target.expect("valid handshake"),
        Some(SocksRoute::Fixed(Target::LocalPort(22)))
    );
}

#[tokio::test]
async fn a_burrow_address_hostname_selects_that_servers_local_port() {
    let address = address();
    assert!(address.as_str().len() <= MAX_SOCKS_NAME_BYTES);
    let input = name_request(COMMAND_CONNECT, address.as_str().as_bytes(), 8080);
    let (route, reply) = run_handshake(&input, 2).await;
    assert_eq!(reply, [SOCKS_VERSION, METHOD_NO_AUTH]);
    assert_eq!(
        route.expect("valid handshake"),
        Some(address_route(address, 8080))
    );
}

#[tokio::test]
async fn malformed_or_case_changed_address_hostnames_are_not_sent_to_dns() {
    let address = address();
    let changed_case = format!("BR1{}", &address.as_str()[3..]);
    for name in ["br1not-an-address", &changed_case] {
        let input = name_request(COMMAND_CONNECT, name.as_bytes(), 80);
        let (route, reply) = run_handshake(&input, 12).await;
        assert_eq!(route.expect("well-formed rejection"), None);
        assert_eq!(reply[3], REPLY_ADDRESS_NOT_SUPPORTED);
    }

    // A dotted DNS name is ordinary exit-node traffic even when its first
    // label happens to begin with the address prefix.
    let input = name_request(COMMAND_CONNECT, b"br1.example", 80);
    let (route, _) = run_handshake(&input, 2).await;
    assert_eq!(
        route.expect("valid DNS request"),
        Some(SocksRoute::Fixed(Target::Tcp {
            host: Host::Name(HostName::new("br1.example").unwrap()),
            port: 80,
        }))
    );
}

#[tokio::test]
async fn ip_literals_remain_arbitrary_tcp_targets() {
    let cases = [
        (
            address_request(ADDRESS_IPV4, &[192, 0, 2, 10], 80),
            "192.0.2.10".parse().unwrap(),
            80,
        ),
        (
            address_request(ADDRESS_IPV6, &Ipv6Addr::LOCALHOST.octets(), 443),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            443,
        ),
    ];
    for (input, ip, port) in cases {
        let (target, _) = run_handshake(&input, 2).await;
        assert_eq!(
            target.expect("valid handshake"),
            Some(SocksRoute::Fixed(Target::Tcp {
                host: Host::Ip(ip),
                port,
            }))
        );
    }
}

#[tokio::test]
async fn bind_and_udp_associate_are_explicitly_unsupported() {
    for command in [COMMAND_BIND, COMMAND_UDP_ASSOCIATE] {
        let input = name_request(command, b"example.com", 80);
        let (target, reply) = run_handshake(&input, 12).await;
        assert_eq!(target.expect("well-formed rejection"), None);
        assert_eq!(&reply[..2], &[SOCKS_VERSION, METHOD_NO_AUTH]);
        assert_eq!(reply[3], REPLY_COMMAND_NOT_SUPPORTED);
    }
}

#[tokio::test]
async fn non_token_names_over_the_dns_bound_are_rejected() {
    let input = name_request(COMMAND_CONNECT, &[b'x'; 254], 443);
    let (target, reply) = run_handshake(&input, 12).await;
    assert_eq!(target.expect("well-formed rejection"), None);
    assert_eq!(reply[3], REPLY_ADDRESS_NOT_SUPPORTED);
}

#[tokio::test]
async fn zero_ports_and_control_characters_are_rejected() {
    for input in [
        name_request(COMMAND_CONNECT, b"example.com", 0),
        name_request(COMMAND_CONNECT, b"line\nbreak", 80),
    ] {
        let (target, reply) = run_handshake(&input, 12).await;
        assert_eq!(target.expect("well-formed rejection"), None);
        assert_eq!(reply[3], REPLY_ADDRESS_NOT_SUPPORTED);
    }
}

#[tokio::test]
async fn authentication_methods_other_than_no_auth_are_rejected() {
    let input = [SOCKS_VERSION, 2, 1, 2];
    let (target, reply) = run_handshake(&input, 2).await;
    assert_eq!(target.expect("well-formed rejection"), None);
    assert_eq!(reply, [SOCKS_VERSION, METHOD_NONE_ACCEPTABLE]);
}

#[tokio::test]
async fn dynamic_client_cache_reuses_bounds_and_evicts_only_idle_entries() {
    let endpoint = iroh_boring::builder()
        .relay_mode(iroh::RelayMode::Disabled)
        .bind()
        .await
        .expect("binding a shared client endpoint");
    let router = SocksRouter::with_limit(endpoint.clone(), None, 1).unwrap();
    let first_address = address();
    let second_address = address();

    let (first, target) = router
        .resolve(address_route(first_address.clone(), 80))
        .await
        .expect("creating the first dynamic client");
    assert_eq!(target, Target::LocalPort(80));
    let (reused, _) = router
        .resolve(address_route(first_address, 443))
        .await
        .expect("reusing the first dynamic client");
    assert!(Arc::ptr_eq(&first, &reused));
    assert_eq!(router.dynamic_len(), 1);
    drop(reused);

    let full = match router
        .resolve(address_route(second_address.clone(), 80))
        .await
    {
        Ok(_) => panic!("an active cache entry was evicted"),
        Err(err) => err,
    };
    assert_eq!(full.kind(), io::ErrorKind::WouldBlock);

    drop(first);
    let (second, _) = router
        .resolve(address_route(second_address.clone(), 80))
        .await
        .expect("evicting the now-idle entry");
    assert_eq!(router.dynamic_len(), 1);

    router.close_all(false).await;
    let closed = match router.resolve(address_route(second_address, 80)).await {
        Ok(_) => panic!("a closed router created another client"),
        Err(err) => err,
    };
    assert_eq!(closed.kind(), io::ErrorKind::BrokenPipe);
    drop(second);
    endpoint.close().await;
}

#[tokio::test]
async fn ordinary_targets_require_a_fixed_server() {
    let endpoint = iroh_boring::builder()
        .relay_mode(iroh::RelayMode::Disabled)
        .bind()
        .await
        .expect("binding a shared client endpoint");
    let router = SocksRouter::new(endpoint.clone(), None);
    let error = match router
        .resolve(SocksRoute::Fixed(Target::LocalPort(22)))
        .await
    {
        Ok(_) => panic!("an ordinary target worked without a fixed server"),
        Err(err) => err,
    };
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(error.to_string().contains("fixed SERVER"));
    router.close_all(false).await;
    endpoint.close().await;
}

#[tokio::test]
async fn dynamic_only_router_drains_unsolicited_incoming_while_idle() {
    let endpoint = iroh_boring::builder()
        .relay_mode(iroh::RelayMode::Disabled)
        .bind()
        .await
        .expect("binding the idle dynamic endpoint");
    let router = SocksRouter::new(endpoint.clone(), None);
    let peer = iroh_boring::builder()
        .relay_mode(iroh::RelayMode::Disabled)
        .bind()
        .await
        .expect("binding an unsolicited peer");

    tokio::time::timeout(
        PATIENCE,
        peer.connect(
            iroh_utils::dialable_addr(&endpoint),
            burrow_core::protocol::ALPN,
        ),
    )
    .await
    .expect("the idle router did not drain the incoming Initial")
    .expect_err("the client-only endpoint accepted an incoming connection");

    let refused = router.close_all(false).await;
    // QUIC may retry an Initial, but at least one must have reached and
    // been refused by the router-owned drain.
    assert!(refused >= 1);
    peer.close().await;
    endpoint.close().await;
}

#[tokio::test]
async fn address_hostname_reaches_its_server_without_a_fixed_peer() {
    let echo = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("binding TCP echo");
    let echo_addr = echo.local_addr().unwrap();
    let echo_task = tokio::spawn(async move {
        let (mut stream, _) = echo.accept().await.expect("accepting TCP echo");
        let (mut read, mut write) = stream.split();
        tokio::io::copy(&mut read, &mut write)
            .await
            .expect("serving TCP echo");
    });

    let client_endpoint = bind(
        iroh::SecretKey::generate(),
        iroh::RelayMode::Disabled,
        Role::Client,
    )
    .await
    .expect("binding the Burrow client");
    let allowed: BTreeSet<_> = [client_endpoint.id()].into_iter().collect();
    let server_endpoint = bind(
        iroh::SecretKey::generate(),
        iroh::RelayMode::Disabled,
        Role::Server(allowed.clone()),
    )
    .await
    .expect("binding the Burrow server");
    let ports: PortSet = echo_addr.port().to_string().parse().unwrap();
    let policy = RoutePolicy::new(echo_addr, ports, false);
    let (stop, stopped) = oneshot::channel();
    let serving_endpoint = server_endpoint.clone();
    let server_task = tokio::spawn(async move {
        serve_configured(
            serving_endpoint,
            ServerConfig::new(allowed),
            policy,
            async move {
                let _ = stopped.await;
            },
        )
        .await
    });

    let address = BurrowAddr::new(
        server_endpoint.id(),
        "https://127.0.0.1:9/".parse().unwrap(),
    )
    .unwrap()
    .with_direct_addrs(iroh_utils::dialable_addrs(&server_endpoint))
    .unwrap();
    assert!(
        address.as_str().len() <= MAX_SOCKS_NAME_BYTES,
        "the test address cannot fit in a SOCKS hostname"
    );
    let router = SocksRouter::new(client_endpoint.clone(), None);
    let socks_listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("binding the SOCKS proxy");
    let mut proxy = spawn_accept_loop(socks_listener, router.clone(), 4).unwrap();
    let mut peer = TcpStream::connect(proxy.local_addr())
        .await
        .expect("connecting to the SOCKS proxy");
    peer.write_all(&name_request(
        COMMAND_CONNECT,
        address.as_str().as_bytes(),
        echo_addr.port(),
    ))
    .await
    .expect("requesting the address-host route");
    let mut replies = [0; 12];
    tokio::time::timeout(PATIENCE, peer.read_exact(&mut replies))
        .await
        .expect("the SOCKS handshake timed out")
        .expect("reading SOCKS replies");
    assert_eq!(&replies[..2], &[SOCKS_VERSION, METHOD_NO_AUTH]);
    assert_eq!(replies[3], REPLY_OK);

    peer.write_all(b"through a br1 hostname")
        .await
        .expect("writing through SOCKS");
    peer.shutdown().await.expect("half-closing the SOCKS peer");
    let mut echoed = Vec::new();
    tokio::time::timeout(PATIENCE, peer.read_to_end(&mut echoed))
        .await
        .expect("the SOCKS echo timed out")
        .expect("reading through SOCKS");
    assert_eq!(echoed, b"through a br1 hostname");

    proxy.shutdown().await.expect("stopping the SOCKS proxy");
    router.close_all(false).await;
    let _ = stop.send(());
    tokio::time::timeout(PATIENCE, server_task)
        .await
        .expect("the Burrow server did not stop")
        .expect("the Burrow server panicked")
        .expect("the Burrow server failed");
    echo_task.await.expect("the echo task panicked");
    client_endpoint.close().await;
    server_endpoint.close().await;
}

#[tokio::test]
async fn cooperative_shutdown_drains_a_handler_at_the_connection_limit() {
    let endpoint = iroh_boring::builder()
        .relay_mode(iroh::RelayMode::Disabled)
        .bind()
        .await
        .expect("binding a client endpoint");
    // The handler is deliberately left in request parsing, so this peer
    // never needs to exist or be dialled.
    let remote = iroh::EndpointAddr::new(iroh::SecretKey::generate().public());
    let client = Client::new(endpoint.clone(), remote);
    let router = SocksRouter::new(endpoint.clone(), Some(client));
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("binding a SOCKS listener");
    let mut proxy = spawn_accept_loop(listener, router.clone(), 1).unwrap();
    let mut peer = TcpStream::connect(proxy.local_addr())
        .await
        .expect("connecting to SOCKS");

    peer.write_all(&[SOCKS_VERSION, 1, METHOD_NO_AUTH])
        .await
        .expect("offering no-auth");
    let mut method = [0; 2];
    peer.read_exact(&mut method).await.expect("method response");
    assert_eq!(method, [SOCKS_VERSION, METHOD_NO_AUTH]);
    // One byte of the four-byte request header leaves the sole handler
    // blocked and the accept loop in its at-capacity branch.
    peer.write_all(&[SOCKS_VERSION])
        .await
        .expect("writing a partial request");

    let cancelled = tokio::time::timeout(Duration::from_secs(1), proxy.shutdown())
        .await
        .expect("proxy shutdown hung at the connection limit")
        .expect("proxy shutdown failed");
    assert_eq!(cancelled, 1);

    let mut byte = [0];
    match tokio::time::timeout(Duration::from_secs(1), peer.read(&mut byte)).await {
        Ok(Ok(0) | Err(_)) => {}
        other => panic!("SOCKS peer stayed open after handler drain: {other:?}"),
    }
    router.close_all(false).await;
    endpoint.close().await;
}

#[tokio::test]
async fn completed_handlers_are_not_reported_as_cancelled_on_shutdown() {
    let mut tasks = JoinSet::new();
    let completed = tasks.spawn(async {});
    tokio::time::timeout(Duration::from_secs(1), async {
        while !completed.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the completed handler never finished");
    assert_eq!(tasks.len(), 1, "the completed task must remain unjoined");
    assert_eq!(abort_and_join(&mut tasks).await, 0);
}
