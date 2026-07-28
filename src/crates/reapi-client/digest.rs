// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Content digests and the digest functions that produce them.
//!
//! These are owned types rather than re-exported protobuf messages, so that
//! consumers of this crate need not depend on `prost`, `tonic`, or the
//! generated proto crate.

use std::fmt;

use crate::error::{Error, Result};

/// A hash function identifier, mapping to REAPI's `DigestFunction.Value`.
///
/// Only the functions this crate can independently *verify* are represented.
/// REAPI also defines MD5, SHA-1, VSO, SHA-384/512 and the chunked
/// `SHA256TREE`; none are implemented here, and a server that requires one is
/// not usable through this client.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DigestFunction {
    Sha256,
    Blake3,
}

impl DigestFunction {
    /// The `DigestFunction.Value` enum number for this function.
    ///
    /// Note that SHA-256 is `1`, not `0`: zero is `UNKNOWN`. Servers commonly
    /// tolerate `0` as a legacy alias for SHA-256, but this client always
    /// sends the explicit value.
    pub fn to_proto(self) -> i32 {
        match self {
            DigestFunction::Sha256 => 1,
            DigestFunction::Blake3 => 9,
        }
    }

    /// The lowercase name used in ByteStream resource names.
    pub fn as_str(self) -> &'static str {
        match self {
            DigestFunction::Sha256 => "sha256",
            DigestFunction::Blake3 => "blake3",
        }
    }

    /// Hash `data`, returning a lowercase hex digest.
    pub fn hash(self, data: &[u8]) -> String {
        match self {
            DigestFunction::Sha256 => {
                use sha2::Digest as _;
                hex::encode(sha2::Sha256::digest(data))
            }
            DigestFunction::Blake3 => blake3::hash(data).to_hex().to_string(),
        }
    }
}

impl fmt::Display for DigestFunction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A content digest: a hex-encoded hash plus the exact byte length of the
/// content it names.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Digest {
    /// Lowercase hex encoding of the hash.
    pub hash: String,
    /// Length of the content in bytes.
    pub size: i64,
}

impl Digest {
    pub fn new(hash: impl Into<String>, size: i64) -> Self {
        Self {
            hash: hash.into(),
            size: size as _,
        }
    }

    /// Compute the digest of `data` under `function`.
    pub fn of(function: DigestFunction, data: &[u8]) -> Self {
        Self {
            hash: function.hash(data),
            size: data.len() as i64,
        }
    }

    /// Reject digests that cannot be valid before they reach the wire: a
    /// negative size, or a hash that is not 64 lowercase hex characters.
    pub(crate) fn validate(&self) -> Result<()> {
        if self.size < 0 {
            return Err(Error::InvalidDigest(format!(
                "size must be non-negative, got {}",
                self.size
            )));
        }
        if self.hash.len() != 64 {
            return Err(Error::InvalidDigest(format!(
                "hash must be 64 hex characters, got {}",
                self.hash.len()
            )));
        }
        if !self
            .hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::InvalidDigest(format!(
                "hash must be lowercase hex, got {:?}",
                self.hash
            )));
        }
        Ok(())
    }

    /// Render this digest as a Subresource Integrity value, suitable for the
    /// Remote Asset API's `checksum.sri` qualifier.
    ///
    /// Returns `None` for BLAKE3: SRI has no registered prefix for it, and
    /// servers parse only `sha256`/`sha384`/`sha512`.
    pub fn to_sri(&self, function: DigestFunction) -> Option<String> {
        match function {
            DigestFunction::Blake3 => None,
            DigestFunction::Sha256 => {
                use base64::Engine as _;
                let raw = hex_decode(&self.hash)?;
                Some(format!(
                    "sha256-{}",
                    base64::engine::general_purpose::STANDARD.encode(raw)
                ))
            }
        }
    }
}

impl fmt::Display for Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.hash, self.size)
    }
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    hex::decode(s).ok()
}

/// Build a ByteStream `Read` resource name.
///
/// The digest-function segment is omitted for SHA-256, which REAPI defines as
/// the implied default; including it is legal but not universally accepted, so
/// the narrower form is used where it is unambiguous.
pub(crate) fn read_resource_name(
    instance_name: &str,
    function: DigestFunction,
    digest: &Digest,
) -> String {
    let mut out = String::new();
    if !instance_name.is_empty() {
        out.push_str(instance_name);
        out.push('/');
    }
    out.push_str("blobs/");
    if function != DigestFunction::Sha256 {
        out.push_str(function.as_str());
        out.push('/');
    }
    out.push_str(&digest.hash);
    out.push('/');
    out.push_str(&digest.size.to_string());
    out
}

/// Build a ByteStream `Write` resource name. `uuid` scopes the upload so that
/// concurrent writers of the same blob do not collide.
pub(crate) fn write_resource_name(
    instance_name: &str,
    uuid: &str,
    function: DigestFunction,
    digest: &Digest,
) -> String {
    let mut out = String::new();
    if !instance_name.is_empty() {
        out.push_str(instance_name);
        out.push('/');
    }
    out.push_str("uploads/");
    out.push_str(uuid);
    out.push_str("/blobs/");
    if function != DigestFunction::Sha256 {
        out.push_str(function.as_str());
        out.push('/');
    }
    out.push_str(&digest.hash);
    out.push('/');
    out.push_str(&digest.size.to_string());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";

    /// SHA-256 is 1 and BLAKE3 is 9; 0 is UNKNOWN and must never be sent.
    #[test]
    fn proto_values_are_explicit() {
        assert_eq!(DigestFunction::Sha256.to_proto(), 1);
        assert_eq!(DigestFunction::Blake3.to_proto(), 9);
    }

    #[test]
    fn read_resource_name_omits_sha256_segment() {
        let d = Digest::new(ZERO, 42);
        assert_eq!(
            read_resource_name("", DigestFunction::Sha256, &d),
            format!("blobs/{ZERO}/42")
        );
    }

    #[test]
    fn read_resource_name_includes_blake3_segment() {
        let d = Digest::new(ZERO, 42);
        assert_eq!(
            read_resource_name("", DigestFunction::Blake3, &d),
            format!("blobs/blake3/{ZERO}/42")
        );
    }

    #[test]
    fn read_resource_name_with_instance() {
        let d = Digest::new(ZERO, 7);
        assert_eq!(
            read_resource_name("inst", DigestFunction::Blake3, &d),
            format!("inst/blobs/blake3/{ZERO}/7")
        );
    }

    #[test]
    fn write_resource_name_shapes() {
        let d = Digest::new(ZERO, 5);
        assert_eq!(
            write_resource_name("", "u", DigestFunction::Sha256, &d),
            format!("uploads/u/blobs/{ZERO}/5")
        );
        assert_eq!(
            write_resource_name("inst", "u", DigestFunction::Blake3, &d),
            format!("inst/uploads/u/blobs/blake3/{ZERO}/5")
        );
    }

    #[test]
    fn digest_of_empty_sha256() {
        let d = Digest::of(DigestFunction::Sha256, b"");
        assert_eq!(
            d.hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(d.size, 0);
    }

    #[test]
    fn digest_of_blake3_matches_reference() {
        let d = Digest::of(DigestFunction::Blake3, b"hello world");
        assert_eq!(d.hash, blake3::hash(b"hello world").to_hex().to_string());
    }

    /// The SRI form must be exactly what the server's parser expects:
    /// `sha256-` followed by standard base64 of the *raw* 32 bytes.
    #[test]
    fn sri_of_empty_sha256() {
        let d = Digest::of(DigestFunction::Sha256, b"");
        assert_eq!(
            d.to_sri(DigestFunction::Sha256).as_deref(),
            Some("sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=")
        );
    }

    #[test]
    fn sri_is_unavailable_for_blake3() {
        let d = Digest::of(DigestFunction::Blake3, b"hello world");
        assert_eq!(d.to_sri(DigestFunction::Blake3), None);
    }

    #[test]
    fn validate_rejects_bad_digests() {
        let lower = "a".repeat(64);
        assert!(Digest::new(ZERO, 0).validate().is_ok());
        assert!(Digest::new(&lower, 0).validate().is_ok());
        assert!(Digest::new(ZERO, -1).validate().is_err());
        assert!(Digest::new("abc", 0).validate().is_err());
        assert!(Digest::new(lower.to_uppercase(), 0).validate().is_err());
        assert!(Digest::new("g".repeat(64), 0).validate().is_err());
    }
}
