// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::collections::BTreeSet;

use iroh::SecretKey;

fn example() -> BurrowAddr {
    BurrowAddr::new(
        SecretKey::generate().public(),
        "https://relay.example.com./".parse().unwrap(),
    )
    .unwrap()
    .with_direct_addrs([
        "192.0.2.1:443".parse().unwrap(),
        "[2001:db8::1]:8443".parse().unwrap(),
    ])
    .unwrap()
}

fn encoded_wire(wire: &WireAddr) -> String {
    format!(
        "{ADDRESS_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(wire).unwrap())
    )
}

#[test]
fn text_round_trip_is_self_contained() {
    let original = example();
    let text = original.to_string();
    assert!(text.starts_with(ADDRESS_PREFIX));
    assert!(!text.contains('='), "address must use unpadded base64");
    assert_eq!(text.parse::<BurrowAddr>().unwrap(), original);
}

#[test]
fn endpoint_addr_contains_every_route() {
    let original = example();
    let endpoint = original.endpoint_addr();
    assert_eq!(endpoint.id, original.id());
    assert_eq!(
        endpoint.relay_urls().collect::<Vec<_>>(),
        vec![original.relay()]
    );
    assert_eq!(
        endpoint.ip_addrs().copied().collect::<BTreeSet<_>>(),
        original.direct_addrs().iter().copied().collect()
    );
}

#[test]
fn direct_addresses_are_optional() {
    let original = BurrowAddr::new(
        SecretKey::generate().public(),
        "https://relay.example.com./".parse().unwrap(),
    )
    .unwrap();
    let parsed: BurrowAddr = original.to_string().parse().unwrap();
    assert!(parsed.direct_addrs().is_empty());
    assert_eq!(parsed, original);
}

#[test]
fn rejects_wrong_prefix_and_malformed_payloads() {
    assert!(matches!(
        "tc1anything".parse::<BurrowAddr>(),
        Err(ParseBurrowAddrError::InvalidPrefix)
    ));
    assert!(matches!(
        "br1!".parse::<BurrowAddr>(),
        Err(ParseBurrowAddrError::Base64(_))
    ));
    let invalid_json = format!("br1{}", URL_SAFE_NO_PAD.encode(b"not json"));
    assert!(matches!(
        invalid_json.parse::<BurrowAddr>(),
        Err(ParseBurrowAddrError::Json(_))
    ));
}

#[test]
fn rejects_unknown_version() {
    let addr = example();
    let text = encoded_wire(&WireAddr {
        v: ADDRESS_VERSION + 1,
        i: addr.id,
        r: addr.relay,
        a: addr.direct_addrs,
    });
    assert!(matches!(
        text.parse::<BurrowAddr>(),
        Err(ParseBurrowAddrError::UnsupportedVersion(2))
    ));
}

#[test]
fn rejects_unknown_fields() {
    let addr = example();
    let json = format!(
        r#"{{"v":1,"i":"{}","r":"{}","unknown":true}}"#,
        addr.id(),
        addr.relay()
    );
    let text = format!("br1{}", URL_SAFE_NO_PAD.encode(json));
    assert!(matches!(
        text.parse::<BurrowAddr>(),
        Err(ParseBurrowAddrError::Json(_))
    ));
}

#[test]
fn rejects_oversized_input_before_decoding() {
    let text = format!("{ADDRESS_PREFIX}{}", "A".repeat(MAX_ENCODED_BYTES + 1));
    assert!(matches!(
        text.parse::<BurrowAddr>(),
        Err(ParseBurrowAddrError::TooLong)
    ));
}

#[test]
fn direct_addresses_are_capped_before_collection() {
    let address = BurrowAddr::new(
        SecretKey::generate().public(),
        "https://relay.example.com./".parse().unwrap(),
    )
    .unwrap();
    let mut yielded = 0;
    let addrs = (0..MAX_DIRECT_ADDRS + 10).map(|port| {
        yielded += 1;
        SocketAddr::from(([192, 0, 2, 1], port as u16))
    });
    assert!(matches!(
        address.with_direct_addrs(addrs),
        Err(EncodeBurrowAddrError::TooManyDirectAddrs)
    ));
    assert_eq!(yielded, MAX_DIRECT_ADDRS + 1);
}

#[test]
fn direct_addresses_are_normalized_for_canonical_tokens() {
    let id = SecretKey::generate().public();
    let relay: RelayUrl = "https://relay.example.com./".parse().unwrap();
    let first: SocketAddr = "192.0.2.2:443".parse().unwrap();
    let second: SocketAddr = "192.0.2.1:443".parse().unwrap();
    let left = BurrowAddr::new(id, relay.clone())
        .unwrap()
        .with_direct_addrs([first, second, first])
        .unwrap();
    let right = BurrowAddr::new(id, relay)
        .unwrap()
        .with_direct_addrs([second, first])
        .unwrap();

    assert_eq!(left, right);
    assert_eq!(left.as_str(), right.as_str());
    assert_eq!(left.direct_addrs(), &[second, first]);
}

#[test]
fn parsed_addresses_enforce_the_direct_hint_cap() {
    let addr = example();
    let text = encoded_wire(&WireAddr {
        v: ADDRESS_VERSION,
        i: addr.id,
        r: addr.relay,
        a: (0..MAX_DIRECT_ADDRS + 1)
            .map(|port| SocketAddr::from(([192, 0, 2, 1], port as u16)))
            .collect(),
    });
    assert!(matches!(
        text.parse::<BurrowAddr>(),
        Err(ParseBurrowAddrError::TooManyDirectAddrs)
    ));
}
