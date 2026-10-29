// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use clubcard_crlite::Encoding;

use crate::{Database, INTERMEDIATES_FILE, Intermediates, Status, certificates};
use crlite_fixture::{Fixture, spki};

fn database(fixture: &Fixture, encoding: Encoding) -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    fixture.write_filter(dir.path(), encoding);
    let intermediates = Intermediates::from_der_certs(fixture.enrolled());
    std::fs::write(
        dir.path().join(INTERMEDIATES_FILE),
        intermediates.encode().unwrap(),
    )
    .unwrap();
    let db = Database::load(dir.path()).unwrap();
    (dir, db)
}

#[test]
fn statuses() {
    let fixture = Fixture::new();
    // Remote Settings publishes the bincode encoding (V3); the pipeline
    // writes the newer one (V4) beside it.
    for encoding in [Encoding::V3, Encoding::V4] {
        let (_dir, db) = database(&fixture, encoding);
        assert_eq!(db.filter_count(), 1);
        for (cert, expected) in [
            (&fixture.revoked, Status::Revoked),
            (&fixture.good, Status::Good),
            (&fixture.not_covered, Status::NotCovered),
            (&fixture.expired, Status::Expired),
            // Enrolled, but the filter has nothing for its issuer.
            (&fixture.other, Status::NotEnrolled),
            // Its issuer isn't among the intermediates.
            (&fixture.unenrolled, Status::NotEnrolled),
        ] {
            assert_eq!(db.query(&cert.der).unwrap(), expected, "{:?}", encoding);
        }
    }
}

#[test]
fn query_with_issuer() {
    let fixture = Fixture::new();
    let (_dir, db) = database(&fixture, Encoding::V4);
    let ca = spki(&fixture.ca.der);
    assert_eq!(
        db.query_with_issuer(&fixture.revoked.der, &ca).unwrap(),
        Status::Revoked
    );
    assert_eq!(
        db.query_with_issuer(&fixture.good.der, &ca).unwrap(),
        Status::Good
    );
    // The filter keys on the issuer's key, so naming the wrong one finds
    // nothing.
    let other = spki(&fixture.other_ca.der);
    assert_eq!(
        db.query_with_issuer(&fixture.revoked.der, &other).unwrap(),
        Status::NotEnrolled
    );
}

#[test]
fn issuer_must_have_signed() {
    // An intermediate with the issuer's name but another key is not the
    // issuer.
    let fixture = Fixture::new();
    let dir = tempfile::tempdir().unwrap();
    fixture.write_filter(dir.path(), Encoding::V4);
    let impostor = Fixture::new().ca.der;
    let intermediates = Intermediates::from_der_certs([impostor]);
    std::fs::write(
        dir.path().join(INTERMEDIATES_FILE),
        intermediates.encode().unwrap(),
    )
    .unwrap();
    let db = Database::load(dir.path()).unwrap();
    assert_eq!(db.query(&fixture.revoked.der).unwrap(), Status::NotEnrolled);
}

#[test]
fn empty_database() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::load(dir.path()).unwrap();
    assert_eq!(db.filter_count(), 0);
    let fixture = Fixture::new();
    let ca = spki(&fixture.ca.der);
    assert_eq!(
        db.query_with_issuer(&fixture.revoked.der, &ca).unwrap(),
        Status::NotCovered
    );
    assert!(db.query(b"not a certificate").is_err());
}

#[test]
fn intermediates_roundtrip() {
    let fixture = Fixture::new();
    let intermediates = Intermediates::from_der_certs(fixture.enrolled());
    let decoded = Intermediates::decode(&intermediates.encode().unwrap()).unwrap();
    assert_eq!(decoded.0, intermediates.0);
    assert!(Intermediates::decode(b"garbage").is_err());
}

#[test]
fn query_chain() {
    let fixture = Fixture::new();
    // No intermediates file: the issuer comes from the chain.
    let dir = tempfile::tempdir().unwrap();
    fixture.write_filter(dir.path(), Encoding::V4);
    let db = Database::load(dir.path()).unwrap();
    let ca = &fixture.ca.der;
    assert_eq!(
        db.query_chain(&[&fixture.revoked.der, ca]).unwrap(),
        Status::Revoked
    );
    assert_eq!(
        db.query_chain(&[&fixture.good.der, ca]).unwrap(),
        Status::Good
    );
    // A next certificate that didn't sign the leaf isn't its issuer, and
    // without the intermediates nothing else is.
    let other = &fixture.other_ca.der;
    assert_eq!(
        db.query_chain(&[&fixture.revoked.der, other]).unwrap(),
        Status::NotEnrolled
    );
    assert_eq!(
        db.query_chain(&[&fixture.revoked.der]).unwrap(),
        Status::NotEnrolled
    );
    assert!(db.query_chain::<Vec<u8>>(&[]).is_err());
}

#[test]
fn query_chain_falls_back_to_the_intermediates() {
    let fixture = Fixture::new();
    let (_dir, db) = database(&fixture, Encoding::V4);
    let other = &fixture.other_ca.der;
    assert_eq!(
        db.query_chain(&[&fixture.revoked.der, other]).unwrap(),
        Status::Revoked
    );
    assert_eq!(db.query_chain(&[&fixture.good.der]).unwrap(), Status::Good);
}

#[test]
fn certificates_in_pem_or_der() {
    let fixture = Fixture::new();
    let pem = |der: &[u8]| {
        openssl::x509::X509::from_der(der)
            .unwrap()
            .to_pem()
            .unwrap()
    };
    let mut bundle = pem(&fixture.good.der);
    bundle.extend(pem(&fixture.ca.der));
    assert_eq!(
        certificates(&bundle),
        [fixture.good.der.clone(), fixture.ca.der.clone()]
    );
    assert_eq!(
        certificates(&pem(&fixture.good.der)),
        std::slice::from_ref(&fixture.good.der)
    );
    assert_eq!(
        certificates(&fixture.good.der),
        std::slice::from_ref(&fixture.good.der)
    );
}
