// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MPL-2.0
//
// Adapted from rust-query-crlite in https://github.com/mozilla/crlite, by the
// Mozilla Foundation and contributors, under the same license.

//! Certificate revocation checks against Firefox's CRLite filters.
//!
//! CRLite compresses the revocation status of every certificate in the
//! WebPKI that was logged to Certificate Transparency into a set of
//! filters, published through Firefox's Remote Settings. A [`Database`] is a
//! directory of those filters, plus the enrolled intermediates used to find
//! a certificate's issuer, and answers queries locally:
//!
//! ```ignore
//! crlite::update(dir, crlite::Instance::Prod, crlite::Channel::Default)?;
//! let db = crlite::Database::load(dir)?;
//! match db.query(&leaf_der)? {
//!     crlite::Status::Revoked => { /* reject */ }
//!     _ => { /* not known to be revoked */ }
//! }
//! ```
//!
//! A TLS client that has already verified the peer's chain knows the issuer,
//! and can skip the intermediates lookup with [`Database::query_chain`] or
//! [`Database::query_with_issuer`].
//!
//! CRLite only covers end-entity certificates. Firefox catches revoked
//! intermediates with OneCRL, in the `onecrl` crate; check the chain against
//! both.
//!
//! Adapted from upstream's `rust-query-crlite`
//! (<https://github.com/mozilla/crlite>). The difference is the crypto:
//! signatures are verified and digests computed with BoringSSL, by way of
//! the `openssl` crate, rather than ring.

use std::collections::HashMap;
use std::fmt;
use std::path::Path;
use std::time::SystemTime;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE;
use clubcard_crlite::{CRLiteClubcard, CRLiteKey, CRLiteStatus, IssuerSpkiHash, LogId, Timestamp};
use log::{debug, error, info, trace};
use serde::Deserialize;
use x509_parser::der_parser::Oid;
use x509_parser::der_parser::oid;
use x509_parser::prelude::*;

mod update;

pub use update::{Channel, Instance, update, update_intermediates};

/// The file in a database directory that holds the enrolled intermediates.
/// Firefox keeps the filters in a profile's `security_state` directory, but
/// not this file.
pub const INTERMEDIATES_FILE: &str = "crlite.intermediates";

const OID_SCT_EXTENSION: Oid<'static> = oid!(1.3.6.1.4.1.11129.2.4.2);

/// The revocation status of a certificate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// The certificate has expired, so the filters may not cover it.
    Expired,
    /// The filters cover the certificate, and it is not revoked.
    Good,
    /// None of the filters cover the certificate's CT log timestamps.
    NotCovered,
    /// The certificate's issuer is not enrolled in CRLite.
    NotEnrolled,
    /// The certificate is revoked.
    Revoked,
}

/// An error loading, updating or querying a database.
#[derive(Debug)]
pub struct Error {
    message: String,
}

impl Error {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Error {
            message: message.into(),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(err: std::io::Error) -> Self {
        Error::new(err.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

type IssuerDn = Vec<u8>;
type DerCert = Vec<u8>;

/// The enrolled intermediate certificates, by subject DN, from which a
/// certificate's issuer (and so the key its filter entries are under) is
/// found.
#[derive(Default)]
pub struct Intermediates(HashMap<IssuerDn, Vec<DerCert>>);

#[derive(Deserialize)]
pub(crate) struct EnrolledRecord {
    #[serde(rename = "uniqueID")]
    unique_id: String,
    pem: String,
}

impl Intermediates {
    /// Collect DER-encoded certificates, skipping any that do not parse.
    pub fn from_der_certs<I: IntoIterator<Item = DerCert>>(certs: I) -> Self {
        let mut intermediates = Intermediates::default();
        for der in certs {
            intermediates.insert(der);
        }
        intermediates
    }

    fn insert(&mut self, der: DerCert) -> bool {
        let Ok((_, cert)) = X509Certificate::from_der(&der) else {
            return false;
        };
        let name = cert.subject().as_raw().to_vec();
        self.0.entry(name).or_default().push(der);
        true
    }

    pub(crate) fn from_enrolled_json(records: &[EnrolledRecord]) -> Self {
        let mut intermediates = Intermediates::default();
        for record in records {
            let der = match x509_parser::pem::parse_x509_pem(record.pem.as_bytes()) {
                Ok((_, pem)) => pem.contents,
                Err(_) => {
                    trace!(
                        "Could not parse PEM in enrolled.json entry with uniqueID {}",
                        record.unique_id
                    );
                    continue;
                }
            };
            if !intermediates.insert(der) {
                trace!(
                    "Could not parse certificate in enrolled.json entry with uniqueID {}",
                    record.unique_id
                );
            }
        }
        intermediates
    }

    /// Decode the contents of an intermediates file.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        bincode::deserialize(bytes)
            .map(Intermediates)
            .map_err(|_| Error::new("could not deserialize bincoded intermediates"))
    }

    /// Encode the intermediates as upstream's tool does, so a database
    /// directory can be shared with it.
    pub fn encode(&self) -> Result<Vec<u8>> {
        bincode::serialize(&self.0).map_err(|_| Error::new("could not serialize intermediates"))
    }

    /// The SPKI, in DER, of an enrolled intermediate that signed `cert`.
    fn issuer_spki(&self, cert: &X509Certificate, cert_der: &[u8]) -> Option<Vec<u8>> {
        let candidates = self.0.get(cert.issuer().as_raw())?;
        candidates.iter().find_map(|der| {
            let (_, issuer) = X509Certificate::from_der(der).ok()?;
            let spki = issuer.public_key().raw;
            signed_by(cert_der, spki).then(|| spki.to_vec())
        })
    }
}

/// Whether the holder of `spki` signed a DER-encoded certificate.
fn signed_by(cert_der: &[u8], spki: &[u8]) -> bool {
    let Ok(cert) = openssl::x509::X509::from_der(cert_der) else {
        return false;
    };
    let Ok(key) = openssl::pkey::PKey::public_key_from_der(spki) else {
        return false;
    };
    cert.verify(&key).unwrap_or(false)
}

/// The CT log IDs and timestamps of a certificate's embedded SCTs, which
/// say whether a filter covers it.
fn sct_timestamps(cert: &X509Certificate) -> Vec<(LogId, Timestamp)> {
    let Ok(Some(extension)) = cert.get_extension_unique(&OID_SCT_EXTENSION) else {
        return vec![];
    };
    let ParsedExtension::SCT(scts) = extension.parsed_extension() else {
        return vec![];
    };
    scts.iter()
        .map(|sct| (LogId(*sct.id.key_id), Timestamp(sct.timestamp)))
        .collect()
}

/// A directory of CRLite filters and the enrolled intermediates.
pub struct Database {
    filters: Vec<(String, CRLiteClubcard)>,
    intermediates: Intermediates,
    newest_filter: Option<SystemTime>,
}

impl Database {
    /// Load the `.filter` and `.delta` files in `dir`, and its intermediates
    /// file if there is one. Without the intermediates, only
    /// [`Database::query_with_issuer`] can find a certificate's issuer.
    pub fn load(dir: &Path) -> Result<Self> {
        let mut filters = vec![];
        let mut newest_filter = None;
        for entry in std::fs::read_dir(dir)? {
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            let extension = path.extension().and_then(|x| x.to_str());
            if extension != Some("delta") && extension != Some("filter") {
                continue;
            }
            let clubcard = CRLiteClubcard::from_bytes(&std::fs::read(&path)?)
                .map_err(|_| Error::new(format!("could not load filter {}", path.display())))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            filters.push((name, clubcard));
            if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                newest_filter =
                    Some(newest_filter.map_or(modified, |t: SystemTime| t.max(modified)));
            }
        }

        // Sorted by name, so that (with trace output) the results of the
        // individual filters come in chronological order.
        filters.sort_by(|a, b| a.0.cmp(&b.0));

        if filters.is_empty() {
            error!(
                "No CRLite filters found. All results will indicate NotCovered. Use --update to download filters."
            );
        } else if let Some(age) =
            newest_filter.and_then(|t| SystemTime::now().duration_since(t).ok())
        {
            info!(
                "Loaded {} CRLite filter(s), most recent was downloaded: {} hours ago",
                filters.len(),
                age.as_secs() / 3600
            );
        }

        let intermediates_path = dir.join(INTERMEDIATES_FILE);
        let intermediates = if intermediates_path.exists() {
            Intermediates::decode(&std::fs::read(intermediates_path)?)?
        } else {
            Intermediates::default()
        };

        Ok(Database {
            filters,
            intermediates,
            newest_filter,
        })
    }

    /// The number of filters loaded.
    pub fn filter_count(&self) -> usize {
        self.filters.len()
    }

    /// When the most recent filter was written.
    pub fn newest_filter(&self) -> Option<SystemTime> {
        self.newest_filter
    }

    /// The status of a DER-encoded certificate, whose issuer is looked up
    /// among the enrolled intermediates.
    pub fn query(&self, cert_der: &[u8]) -> Result<Status> {
        let cert = parse(cert_der)?;
        let Some(issuer_spki) = self.intermediates.issuer_spki(&cert, cert_der) else {
            log_cert(&cert);
            return Ok(Status::NotEnrolled);
        };
        Ok(self.query_parsed(&cert, &issuer_spki))
    }

    /// The status of a DER-encoded certificate issued by the holder of
    /// `issuer_spki`, a DER SubjectPublicKeyInfo: say, from the issuer in a
    /// chain the caller has verified. The signature is not checked.
    pub fn query_with_issuer(&self, cert_der: &[u8], issuer_spki: &[u8]) -> Result<Status> {
        Ok(self.query_parsed(&parse(cert_der)?, issuer_spki))
    }

    /// The status of the leaf of a chain of DER-encoded certificates, leaf
    /// first. The leaf's issuer is the next certificate if that signed it,
    /// and is looked up among the enrolled intermediates otherwise. Only the
    /// leaf is checked: CRLite has nothing to say about the rest.
    pub fn query_chain<C: AsRef<[u8]>>(&self, chain: &[C]) -> Result<Status> {
        let Some(leaf_der) = chain.first().map(AsRef::as_ref) else {
            return Err(Error::new("empty certificate chain"));
        };
        if let Some(issuer_der) = chain.get(1).map(AsRef::as_ref) {
            let (_, issuer) = X509Certificate::from_der(issuer_der)
                .map_err(|_| Error::new("could not parse issuer certificate"))?;
            let spki = issuer.public_key().raw;
            if signed_by(leaf_der, spki) {
                return self.query_with_issuer(leaf_der, spki);
            }
            debug!("The second certificate of the chain did not sign the first");
        }
        self.query(leaf_der)
    }

    fn query_parsed(&self, cert: &X509Certificate, issuer_spki: &[u8]) -> Status {
        log_cert(cert);
        let issuer = IssuerSpkiHash(openssl::sha::sha256(issuer_spki));
        debug!("Issuer SPKI hash: {}", URL_SAFE.encode(issuer.0));

        // An expired certificate, even if enrolled and covered, might not be
        // in the filters.
        if !cert.validity().is_valid() {
            return Status::Expired;
        }

        let key = CRLiteKey::new(&issuer, cert.raw_serial());
        let timestamps = sct_timestamps(cert);
        let mut maybe_good = false;
        let mut covered = false;
        for (name, filter) in &self.filters {
            let status = filter.contains(&key, timestamps.iter().copied());
            trace!("{}: {:?}", name, status);
            match status {
                CRLiteStatus::Revoked => return Status::Revoked,
                CRLiteStatus::Good => maybe_good = true,
                CRLiteStatus::NotEnrolled => covered = true,
                CRLiteStatus::NotCovered => (),
            }
        }
        if maybe_good {
            Status::Good
        } else if covered {
            Status::NotEnrolled
        } else {
            Status::NotCovered
        }
    }
}

fn parse(cert_der: &[u8]) -> Result<X509Certificate<'_>> {
    X509Certificate::from_der(cert_der)
        .map(|(_, cert)| cert)
        .map_err(|_| Error::new("could not parse certificate"))
}

fn log_cert(cert: &X509Certificate) {
    debug!("Issuer DN: {}", cert.issuer());
    debug!("Subject DN: {}", cert.subject());
    debug!("Serial number: {}", hex::encode(cert.raw_serial()));
}

/// The DER certificates in PEM input, in order, or the input itself if it
/// isn't PEM and so might be a DER certificate.
pub fn certificates(input: &[u8]) -> Vec<Vec<u8>> {
    let pems: Vec<_> = x509_parser::pem::Pem::iter_from_buffer(input)
        .map_while(|block| block.ok())
        .filter(|pem| pem.label == "CERTIFICATE")
        .map(|pem| pem.contents)
        .collect();
    if pems.is_empty() {
        vec![input.to_vec()]
    } else {
        pems
    }
}

#[cfg(test)]
mod tests;
