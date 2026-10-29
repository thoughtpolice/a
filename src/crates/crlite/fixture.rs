// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A CRLite database for tests, built from scratch: a CA, certificates it
//! issued with embedded SCTs, and a clubcard filter that covers them, in
//! which one is revoked. [`ca`] and [`leaf`] mint more, for tests that need
//! other hierarchies.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use clubcard::builder::{ApproximateRibbon, ClubcardBuilder, ExactRibbon};
use clubcard_crlite::builder::CRLiteBuilderItem;
use clubcard_crlite::{CRLiteClubcard, CRLiteCoverage, CRLiteQuery, Encoding, IssuerSpkiHash};
use openssl::asn1::{Asn1Object, Asn1OctetString, Asn1Time};
use openssl::bn::BigNum;
use openssl::ec::{EcGroup, EcKey};
use openssl::hash::MessageDigest;
use openssl::nid::Nid;
use openssl::pkey::{PKey, Private};
use openssl::x509::extension::{BasicConstraints, SubjectAlternativeName};
use openssl::x509::{X509, X509Extension, X509Name};

/// The CT log the filter covers. Certificates logged elsewhere are not
/// covered.
pub const LOG_ID: [u8; 32] = [7; 32];

/// The DNS name of every leaf.
pub const LEAF_NAME: &str = "leaf.test";

const DAY: u64 = 24 * 60 * 60;

pub struct Cert {
    pub der: Vec<u8>,
    pub key: PKey<Private>,
}

pub struct Fixture {
    /// The enrolled CA the filter has data for.
    pub ca: Cert,
    /// An enrolled CA the filter has no data for.
    pub other_ca: Cert,
    /// Issued by `ca`, logged to `LOG_ID`, and revoked. Its serial has the
    /// high bit set, so its DER encoding has a leading zero, which is part
    /// of the serial CRLite keys on.
    pub revoked: Cert,
    /// Issued by `ca`, logged to `LOG_ID`, and not revoked.
    pub good: Cert,
    /// Issued by `ca` and logged, but to another log.
    pub not_covered: Cert,
    /// Issued by `ca` and revoked, but expired.
    pub expired: Cert,
    /// Issued by `other_ca`.
    pub other: Cert,
    /// Issued by a CA that is not enrolled.
    pub unenrolled: Cert,
}

impl Fixture {
    pub fn new() -> Self {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let valid = (now - DAY, now + 30 * DAY);
        let logged = Some((LOG_ID, (now - DAY) * 1000));

        let ca = self::ca("Test CA", &[1], None, None);
        let other_ca = self::ca("Other CA", &[2], None, None);
        let unenrolled_ca = self::ca("Unenrolled CA", &[3], None, None);
        let leaf = |issuer: &Cert, serial: &[u8], validity, sct| {
            issue(LEAF_NAME, serial, Some(issuer), false, validity, sct, None)
        };
        Fixture {
            revoked: leaf(&ca, &[0x80, 1], valid, logged),
            good: leaf(&ca, &[0x11], valid, logged),
            not_covered: leaf(&ca, &[0x12], valid, Some(([9; 32], (now - DAY) * 1000))),
            expired: leaf(&ca, &[0x13], (now - 60 * DAY, now - 30 * DAY), logged),
            other: leaf(&other_ca, &[0x21], valid, logged),
            unenrolled: leaf(&unenrolled_ca, &[0x31], valid, logged),
            ca,
            other_ca,
        }
    }

    /// The DER certificates of the enrolled intermediates.
    pub fn enrolled(&self) -> Vec<Vec<u8>> {
        vec![self.ca.der.clone(), self.other_ca.der.clone()]
    }

    /// Write a filter for `ca`'s certificates to `dir`, as a full filter
    /// named the way Remote Settings names them.
    pub fn write_filter(&self, dir: &Path, encoding: Encoding) {
        let issuer = IssuerSpkiHash(openssl::sha::sha256(&spki(&self.ca.der)));
        let item = |cert: &Cert, revoked| {
            let serial = serial(&cert.der);
            if revoked {
                CRLiteBuilderItem::revoked(issuer, serial)
            } else {
                CRLiteBuilderItem::not_revoked(issuer, serial)
            }
        };
        let universe = [
            (&self.revoked, true),
            (&self.good, false),
            (&self.not_covered, false),
            (&self.expired, true),
        ];

        let mut builder = ClubcardBuilder::new();
        let mut approx = builder.new_approx_builder(&issuer.0);
        approx.set_universe_size(universe.len());
        for (cert, revoked) in universe {
            if revoked {
                approx.insert(item(cert, true));
            }
        }
        builder.collect_approx_ribbons(vec![ApproximateRibbon::from(approx)]);
        let mut exact = builder.new_exact_builder(&issuer.0);
        for (cert, revoked) in universe {
            exact.insert(item(cert, revoked));
        }
        builder.collect_exact_ribbons(vec![ExactRibbon::from(exact)]);

        // Coverage is only constructible from the pipeline's ct-logs.json.
        let ct_logs = format!(
            r#"[{{"LogID": "{}", "MinTimestamp": 0, "MaxTimestamp": {}, "MMD": 86400, "MinEntry": 0}}]"#,
            base64::prelude::BASE64_STANDARD.encode(LOG_ID),
            u64::MAX / 2,
        );
        let coverage = CRLiteCoverage::from_mozilla_ct_logs_json(ct_logs.as_bytes());
        let clubcard = CRLiteClubcard::from(builder.build::<CRLiteQuery>(coverage, ()));
        std::fs::write(
            dir.join("20261029-0-default.filter"),
            clubcard.to_bytes(encoding).unwrap(),
        )
        .unwrap();
    }
}

impl Default for Fixture {
    fn default() -> Self {
        Self::new()
    }
}

/// A certificate's DER SubjectPublicKeyInfo.
pub fn spki(der: &[u8]) -> Vec<u8> {
    let (_, cert) = x509_parser::parse_x509_certificate(der).unwrap();
    cert.public_key().raw.to_vec()
}

/// A OneCRL record, as JSON, revoking `der` by its issuer's name and its
/// serial.
pub fn onecrl_by_issuer_and_serial(der: &[u8]) -> String {
    let (_, cert) = x509_parser::parse_x509_certificate(der).unwrap();
    format!(
        r#"{{"issuerName": "{}", "serialNumber": "{}"}}"#,
        base64::prelude::BASE64_STANDARD.encode(cert.issuer().as_raw()),
        base64::prelude::BASE64_STANDARD.encode(cert.raw_serial()),
    )
}

/// A OneCRL record, as JSON, revoking every certificate for `der`'s subject
/// and key.
pub fn onecrl_by_subject_and_key(der: &[u8]) -> String {
    let (_, cert) = x509_parser::parse_x509_certificate(der).unwrap();
    format!(
        r#"{{"subject": "{}", "pubKeyHash": "{}"}}"#,
        base64::prelude::BASE64_STANDARD.encode(cert.subject().as_raw()),
        base64::prelude::BASE64_STANDARD.encode(openssl::sha::sha256(cert.public_key().raw)),
    )
}

/// A certificate's serial, as the bytes of its DER encoding.
fn serial(der: &[u8]) -> Vec<u8> {
    let (_, cert) = x509_parser::parse_x509_certificate(der).unwrap();
    cert.raw_serial().to_vec()
}

/// Not before and not after, in seconds since the epoch.
type Validity = (u64, u64);

/// An embedded SCT's log ID and timestamp, in milliseconds.
type Sct = ([u8; 32], u64);

/// The validity of a current certificate, and an SCT from [`LOG_ID`].
fn now() -> (Validity, Option<Sct>) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    (
        (now - DAY, now + 30 * DAY),
        Some((LOG_ID, (now - DAY) * 1000)),
    )
}

/// A current CA certificate, self-signed if there's no `issuer`, with a new
/// key unless given one: a CA cross-signed by another is the same name and
/// key under a second issuer.
pub fn ca(cn: &str, serial: &[u8], issuer: Option<&Cert>, key: Option<&PKey<Private>>) -> Cert {
    issue(cn, serial, issuer, true, now().0, None, key.cloned())
}

/// A current leaf for [`LEAF_NAME`], logged to [`LOG_ID`].
pub fn leaf(issuer: &Cert, serial: &[u8]) -> Cert {
    let (validity, sct) = now();
    issue(LEAF_NAME, serial, Some(issuer), false, validity, sct, None)
}

fn issue(
    cn: &str,
    serial: &[u8],
    issuer: Option<&Cert>,
    ca: bool,
    (not_before, not_after): Validity,
    sct: Option<Sct>,
    key: Option<PKey<Private>>,
) -> Cert {
    let key = key.unwrap_or_else(|| {
        let group = EcGroup::from_curve_name(Nid::X9_62_PRIME256V1).unwrap();
        PKey::from_ec_key(EcKey::generate(&group).unwrap()).unwrap()
    });
    let mut name = X509Name::builder().unwrap();
    name.append_entry_by_nid(Nid::COMMONNAME, cn).unwrap();
    let name = name.build();

    let mut builder = X509::builder().unwrap();
    builder.set_version(2).unwrap();
    let serial = BigNum::from_slice(serial)
        .unwrap()
        .to_asn1_integer()
        .unwrap();
    builder.set_serial_number(&serial).unwrap();
    builder.set_subject_name(&name).unwrap();
    builder.set_pubkey(&key).unwrap();
    let not_before = Asn1Time::from_unix(not_before as i64).unwrap();
    let not_after = Asn1Time::from_unix(not_after as i64).unwrap();
    builder.set_not_before(&not_before).unwrap();
    builder.set_not_after(&not_after).unwrap();
    if ca {
        let constraints = BasicConstraints::new().critical().ca().build().unwrap();
        builder.append_extension(constraints).unwrap();
    } else {
        let names = SubjectAlternativeName::new()
            .dns(cn)
            .build(&builder.x509v3_context(None, None))
            .unwrap();
        builder.append_extension(names).unwrap();
    }
    if let Some((log_id, timestamp)) = sct {
        builder
            .append_extension(sct_extension(log_id, timestamp))
            .unwrap();
    }
    let signer = match issuer {
        Some(issuer) => {
            let issuer_cert = X509::from_der(&issuer.der).unwrap();
            builder.set_issuer_name(issuer_cert.subject_name()).unwrap();
            &issuer.key
        }
        None => {
            builder.set_issuer_name(&name).unwrap();
            &key
        }
    };
    builder.sign(signer, MessageDigest::sha256()).unwrap();
    Cert {
        der: builder.build().to_der().unwrap(),
        key,
    }
}

/// An embedded SCT list (RFC 6962, section 3.3) with one SCT. Its signature
/// is a placeholder: CRLite reads only the log ID and timestamp.
fn sct_extension(log_id: [u8; 32], timestamp: u64) -> X509Extension {
    let mut sct = vec![0]; // v1
    sct.extend_from_slice(&log_id);
    sct.extend_from_slice(&timestamp.to_be_bytes());
    sct.extend_from_slice(&[0, 0]); // no extensions
    sct.extend_from_slice(&[4, 3, 0, 2, 0, 0]); // SHA-256, ECDSA, 2 bytes
    let mut list = ((sct.len() + 2) as u16).to_be_bytes().to_vec();
    list.extend_from_slice(&(sct.len() as u16).to_be_bytes());
    list.extend_from_slice(&sct);

    // The extension's value is itself a DER OCTET STRING of the list.
    let mut value = vec![0x04, list.len() as u8];
    value.extend_from_slice(&list);
    let oid = Asn1Object::from_str("1.3.6.1.4.1.11129.2.4.2").unwrap();
    let value = Asn1OctetString::new_from_bytes(&value).unwrap();
    X509Extension::new_from_der(&oid, false, &value).unwrap()
}
