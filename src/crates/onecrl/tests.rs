// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::path::PathBuf;

use x509_parser::pem::Pem;

use crate::{OneCrl, Revocation};

/// testdata/emudhra: the chains from https://emudhra.we-have-a-problem.com/
/// (chains.zip, and the Let's Encrypt chain the page itself is served
/// with), and the OneCRL records that name the compromised intermediates.
fn emudhra() -> PathBuf {
    let testdata = std::env::var("ONECRL_TESTDATA").expect("ONECRL_TESTDATA names the test data");
    PathBuf::from(testdata).join("testdata/emudhra")
}

fn chain(path: &std::path::Path) -> Vec<Vec<u8>> {
    let pem = std::fs::read(path).unwrap();
    Pem::iter_from_buffer(&pem)
        .map(|block| block.unwrap().contents)
        .collect()
}

#[test]
fn emudhra_chains_are_revoked() {
    let onecrl = OneCrl::load(&emudhra().join("onecrl.json")).unwrap();
    assert_eq!(onecrl.len(), 12);

    let mut chains: Vec<_> = std::fs::read_dir(emudhra().join("revoked"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    chains.sort();
    assert_eq!(chains.len(), 16);
    for path in chains {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let found = onecrl.check_chain(&chain(&path)).unwrap();
        // The intermediate under the emSign root is revoked itself; its
        // cross-sign by AAA Certificate Services only by its key. Each
        // rollover chain puts the rollover certificate before it.
        let index = if name.contains("rollover") { 2 } else { 1 };
        let why = if name.contains("-aaa-") {
            Revocation::SubjectAndKey
        } else {
            Revocation::IssuerAndSerial
        };
        assert_eq!(found, Some((index, why)), "{name}");
    }
}

#[test]
fn an_unrelated_chain_is_not_revoked() {
    let onecrl = OneCrl::load(&emudhra().join("onecrl.json")).unwrap();
    let good = chain(&emudhra().join("good/emudhra.we-have-a-problem.com.pem"));
    assert_eq!(good.len(), 3);
    assert_eq!(onecrl.check_chain(&good).unwrap(), None);
}

/// One of the real records, with `enabled` set as given.
fn record(enabled: bool) -> String {
    let path = emudhra().join("onecrl.json");
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let mut record = json["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r.get("serialNumber").is_some())
        .unwrap()
        .clone();
    record["enabled"] = enabled.into();
    record.to_string()
}

#[test]
fn disabled_records_are_enforced() {
    // As Firefox does: it never reads `enabled`.
    let json = format!(r#"{{"data": [{}]}}"#, record(false));
    assert_eq!(OneCrl::from_json(json.as_bytes()).unwrap().len(), 1);
}

#[test]
fn records_without_a_pair_are_skipped() {
    let json = format!(
        r#"{{"data": [{}, {{"issuerName": "AAAA"}}, {{"pubKeyHash": "AAAA"}}, {{}}]}}"#,
        record(true)
    );
    assert_eq!(OneCrl::from_json(json.as_bytes()).unwrap().len(), 1);
}

#[test]
fn malformed_input_is_an_error() {
    assert!(OneCrl::from_json(b"not json").is_err());
    assert!(OneCrl::from_json(br#"{"records": []}"#).is_err());
    assert!(
        OneCrl::from_json(br#"{"data": [{"issuerName": "!", "serialNumber": "AAAA"}]}"#).is_err()
    );
    assert!(OneCrl::default().revocation(b"not a certificate").is_err());
    assert!(
        OneCrl::default()
            .check_chain(&[b"not a certificate"])
            .is_err()
    );
}

#[test]
fn an_empty_list_revokes_nothing() {
    let onecrl = OneCrl::default();
    assert!(onecrl.is_empty());
    let good = chain(&emudhra().join("good/emudhra.we-have-a-problem.com.pem"));
    assert_eq!(onecrl.check_chain(&good).unwrap(), None);
    assert_eq!(onecrl.check_chain::<Vec<u8>>(&[]).unwrap(), None);
}
