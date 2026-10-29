// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! OneCRL, Firefox's list of revoked certificates, which it checks every
//! certificate of a chain against.
//!
//! CRLite (see the `crlite` crate) only knows what CAs revoke on their CRLs
//! for the end-entity certificates of enrolled intermediates. Revoking an
//! intermediate, say one whose key is compromised so that anyone can mint
//! leaves under it that no CRL will ever list, is what OneCRL is for. A TLS
//! client wanting Firefox's revocation checks wants both:
//!
//! ```ignore
//! let onecrl = onecrl::update(&path, onecrl::Instance::Prod)?;
//! if let Some((index, why)) = onecrl.check_chain(&verified_chain)? {
//!     // reject: certificate `index` of the chain is revoked
//! }
//! ```

use std::collections::HashSet;
use std::fmt;
use std::path::Path;

use base64::Engine;
use base64::prelude::BASE64_STANDARD;
use log::debug;
use serde::Deserialize;
use x509_parser::prelude::*;

/// A Remote Settings instance to download OneCRL from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Instance {
    Prod,
    Stage,
}

impl Instance {
    /// The collection's records, in the bucket Firefox reads them from.
    pub fn url(self) -> &'static str {
        match self {
            Instance::Prod => {
                "https://firefox.settings.services.mozilla.com/v1/buckets/security-state/collections/onecrl/records"
            }
            Instance::Stage => {
                "https://firefox.settings.services.allizom.org/v1/buckets/security-state/collections/onecrl/records"
            }
        }
    }
}

/// An error loading or downloading OneCRL, or parsing a certificate.
#[derive(Debug)]
pub struct Error(String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

/// Why OneCRL revokes a certificate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Revocation {
    /// The certificate itself, by its issuer's name and its serial.
    IssuerAndSerial,
    /// Every certificate for a key, cross-signs included, by the subject's
    /// name and the hash of its public key.
    SubjectAndKey,
}

/// A OneCRL record names a certificate by one of the two pairs.
#[derive(Deserialize)]
struct Record {
    #[serde(rename = "issuerName")]
    issuer_name: Option<String>,
    #[serde(rename = "serialNumber")]
    serial_number: Option<String>,
    subject: Option<String>,
    #[serde(rename = "pubKeyHash")]
    pub_key_hash: Option<String>,
}

#[derive(Deserialize)]
struct Collection {
    data: Vec<Record>,
}

/// The revocations in a OneCRL collection.
#[derive(Default)]
pub struct OneCrl {
    /// The DER issuer name, and the DER serial (the INTEGER's contents).
    issuer_serials: HashSet<(Vec<u8>, Vec<u8>)>,
    /// The DER subject name, and the SHA-256 of the DER SubjectPublicKeyInfo.
    subject_keys: HashSet<(Vec<u8>, Vec<u8>)>,
}

impl OneCrl {
    /// Parse the collection's records, as Remote Settings serves them.
    ///
    /// Every record is enforced, as in Firefox: records carry an `enabled`
    /// field, but Firefox's import (RemoteSecuritySettings.sys.mjs) never
    /// reads it.
    pub fn from_json(json: &[u8]) -> Result<Self> {
        let collection: Collection = serde_json::from_slice(json)
            .map_err(|e| Error(format!("could not parse OneCRL records: {e}")))?;
        let decode = |field: &str, value: &str| {
            BASE64_STANDARD
                .decode(value)
                .map_err(|_| Error(format!("bad base64 in OneCRL {field}: {value}")))
        };
        let mut onecrl = OneCrl::default();
        for record in collection.data {
            match record {
                Record {
                    issuer_name: Some(issuer),
                    serial_number: Some(serial),
                    ..
                } => {
                    onecrl.issuer_serials.insert((
                        decode("issuerName", &issuer)?,
                        decode("serialNumber", &serial)?,
                    ));
                }
                Record {
                    subject: Some(subject),
                    pub_key_hash: Some(hash),
                    ..
                } => {
                    onecrl
                        .subject_keys
                        .insert((decode("subject", &subject)?, decode("pubKeyHash", &hash)?));
                }
                // Firefox skips a record with neither pair, too.
                _ => {}
            }
        }
        Ok(onecrl)
    }

    /// Load a file written by [`update`].
    pub fn load(path: &Path) -> Result<Self> {
        let json = std::fs::read(path)
            .map_err(|e| Error(format!("could not read {}: {e}", path.display())))?;
        Self::from_json(&json)
    }

    /// The number of revocations.
    pub fn len(&self) -> usize {
        self.issuer_serials.len() + self.subject_keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Whether, and why, a DER-encoded certificate is revoked.
    pub fn revocation(&self, cert_der: &[u8]) -> Result<Option<Revocation>> {
        let (_, cert) = X509Certificate::from_der(cert_der)
            .map_err(|_| Error("could not parse certificate".into()))?;
        let issuer_serial = (cert.issuer().as_raw().to_vec(), cert.raw_serial().to_vec());
        if self.issuer_serials.contains(&issuer_serial) {
            return Ok(Some(Revocation::IssuerAndSerial));
        }
        let subject_key = (
            cert.subject().as_raw().to_vec(),
            openssl::sha::sha256(cert.public_key().raw).to_vec(),
        );
        Ok(self
            .subject_keys
            .contains(&subject_key)
            .then_some(Revocation::SubjectAndKey))
    }

    /// The first certificate of a chain that is revoked, by its index, and
    /// why. The chain should be the one the caller verified: a certificate
    /// left out of it isn't checked.
    pub fn check_chain<C: AsRef<[u8]>>(&self, chain: &[C]) -> Result<Option<(usize, Revocation)>> {
        for (index, cert) in chain.iter().enumerate() {
            if let Some(revocation) = self.revocation(cert.as_ref())? {
                return Ok(Some((index, revocation)));
            }
        }
        Ok(None)
    }
}

/// Download OneCRL from `instance` and write it to `path`, returning it.
/// The download is parsed before it replaces what `path` holds.
pub fn update(path: &Path, instance: Instance) -> Result<OneCrl> {
    debug!("Fetching OneCRL from {}", instance.url());
    let json = reqwest::blocking::get(instance.url())
        .and_then(|response| response.error_for_status())
        .and_then(|response| response.bytes())
        .map_err(|e| Error(format!("could not fetch OneCRL: {e}")))?;
    let onecrl = OneCrl::from_json(&json)?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &json)
        .and_then(|()| std::fs::rename(&tmp, path))
        .map_err(|e| Error(format!("could not write {}: {e}", path.display())))?;
    Ok(onecrl)
}
