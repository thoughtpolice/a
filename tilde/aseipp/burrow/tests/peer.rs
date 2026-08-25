// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use super::*;

use iroh::SecretKey;

#[test]
fn accepts_legacy_ids_and_self_contained_addresses() {
    let id = SecretKey::generate().public();
    let legacy: Peer = id.to_string().parse().unwrap();
    assert_eq!(legacy.id(), id);

    let address = BurrowAddr::new(id, "https://relay.example.com./".parse().unwrap())
        .unwrap()
        .with_direct_addrs(["192.0.2.1:443".parse().unwrap()])
        .unwrap();
    let parsed: Peer = address.to_string().parse().unwrap();
    assert_eq!(parsed.id(), id);
    assert!(matches!(parsed, Peer::Address(_)));
}
