// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn port_sets_accept_lists_and_ranges() {
    let ports: PortSet = "22,80,8000-8002,80".parse().unwrap();
    for port in [22, 80, 8000, 8001, 8002] {
        assert!(ports.contains(port));
    }
    assert!(!ports.contains(81));

    let cloned = ports.clone();
    assert!(Arc::ptr_eq(&ports.0, &cloned.0));

    let all: PortSet = "all".parse().unwrap();
    assert!(all.contains(1));
    assert!(all.contains(u16::MAX));
    assert!(!all.contains(0));
}

#[test]
fn port_sets_reject_ambiguous_or_invalid_values() {
    for text in ["", "22,", "0", "80-22", "70000", "one"] {
        assert!(text.parse::<PortSet>().is_err(), "accepted {text:?}");
    }
}

#[tokio::test]
async fn local_ports_try_ipv6_loopback() {
    let listener = match tokio::net::TcpListener::bind("[::1]:0").await {
        Ok(listener) => listener,
        Err(err)
            if matches!(
                err.kind(),
                io::ErrorKind::AddrNotAvailable | io::ErrorKind::Unsupported
            ) =>
        {
            // Some test sandboxes disable IPv6 entirely.
            return;
        }
        Err(err) => panic!("binding IPv6 loopback: {err}"),
    };
    let port = listener.local_addr().unwrap().port();
    let ports: PortSet = port.to_string().parse().unwrap();
    let policy = RoutePolicy::new("127.0.0.1:1".parse().unwrap(), ports, false);

    let connecting = policy.connect_target(Target::LocalPort(port));
    let (destination, accepted) = tokio::join!(connecting, listener.accept());
    let _destination = destination.expect("connecting to an IPv6-only loopback listener");
    let (_, peer) = accepted.expect("accepting the IPv6 loopback connection");
    assert_eq!(peer.ip(), Ipv6Addr::LOCALHOST);
}

#[tokio::test]
async fn pipe_policy_rearms_pre_ack_reservations_without_consuming_on_denial() {
    let (write, _write_peer) = tokio::io::duplex(64);
    let policy = PipePolicy::sink(write);
    let remote = iroh::SecretKey::generate().public();

    let Err(wrong_target) = policy.connect(remote, Target::LocalPort(22)).await else {
        panic!("the pipe accepted a non-default target");
    };
    assert_eq!(wrong_target.status, ResponseStatus::Denied);

    // The first result is only a pre-ACK reservation. While retained it
    // excludes racing requests, and dropping it must atomically rearm the
    // pipe for a later request.
    let reserved = policy
        .connect(remote, Target::Default)
        .await
        .expect("reserving the pipe before an ACK");
    let Err(while_reserved) = policy.connect(remote, Target::Default).await else {
        panic!("the pipe was lent while another request reserved it");
    };
    assert_eq!(while_reserved.status, ResponseStatus::Denied);
    drop(reserved);

    let other = policy.clone();
    let (first, second) = tokio::join!(
        policy.connect(remote, Target::Default),
        other.connect(remote, Target::Default),
    );
    assert_eq!(
        usize::from(first.is_ok()) + usize::from(second.is_ok()),
        1,
        "exactly one racing request must claim the pipe",
    );
    for outcome in [first, second] {
        match outcome {
            Ok(destination) => drop(destination),
            Err(response) => assert_eq!(response.status, ResponseStatus::Denied),
        }
    }
}
