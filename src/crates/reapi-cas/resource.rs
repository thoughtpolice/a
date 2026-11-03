// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! ByteStream resource names: the paths REAPI blobs are read and written
//! under.
//!
//! ```text
//! {instance}/blobs/{digest_function}/{hash}/{size}
//! {instance}/compressed-blobs/{compressor}/{digest_function}/{hash}/{size}
//! {instance}/uploads/{uuid}/blobs/{digest_function}/{hash}/{size}
//! {instance}/uploads/{uuid}/compressed-blobs/{compressor}/{digest_function}/{hash}/{size}
//! ```
//!
//! The instance name is optional, and so is the digest function segment:
//! without one, the digest is SHA-256. REAPI has the segment written only
//! for digest functions newer than SHA-256 (BLAKE3, SHA256TREE), so the
//! builders here leave it out for SHA-256.

use crate::compression::Compression;
use crate::digest::{Digest, DigestFn, InvalidDigest};

/// Why a string is not a resource name of the kind asked for. The message
/// names the string.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ResourceNameError(pub String);

type Result<T> = std::result::Result<T, ResourceNameError>;

fn invalid(message: impl Into<String>) -> ResourceNameError {
    ResourceNameError(message.into())
}

/// The `{hash}/{size}` or `{digest_fn}/{hash}/{size}` suffix common to read
/// and write resource names.
struct DigestTail {
    hash: String,
    size: i64,
    digest_fn: DigestFn,
}

fn parse_size(size: &str, name: &str) -> Result<i64> {
    let size = size
        .parse::<i64>()
        .map_err(|_| invalid(format!("invalid size in resource name: {name}")))?;
    if size < 0 {
        return Err(invalid("size must be non-negative"));
    }
    Ok(size)
}

fn parse_digest_tail(parts: &[&str], name: &str) -> Result<DigestTail> {
    match parts {
        [hash, size] => Ok(DigestTail {
            hash: hash.to_string(),
            size: parse_size(size, name)?,
            digest_fn: DigestFn::Sha256,
        }),
        [function, hash, size] => {
            let digest_fn = DigestFn::from_str_name(function).ok_or_else(|| {
                invalid(format!(
                    "unsupported digest function '{function}' in resource name: {name}"
                ))
            })?;
            Ok(DigestTail {
                hash: hash.to_string(),
                size: parse_size(size, name)?,
                digest_fn,
            })
        }
        _ => Err(invalid(format!("invalid resource name format: {name}"))),
    }
}

fn parse_compressor(compressor: &str, name: &str) -> Result<Compression> {
    Compression::from_str_name(compressor).ok_or_else(|| {
        invalid(format!(
            "unsupported compressor '{compressor}' in resource name: {name}"
        ))
    })
}

/// A ByteStream read resource name, parsed. The hash is as written: the
/// caller checks it against the digest function.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadResourceName {
    pub hash: String,
    pub size: i64,
    pub digest_fn: DigestFn,
    pub compressor: Compression,
}

impl ReadResourceName {
    /// The digest the name gives, if its hash and size are valid.
    pub fn digest(&self) -> std::result::Result<Digest, InvalidDigest> {
        Digest::parse(&self.hash, self.size)
    }
}

/// Parse a ByteStream read resource name, with or without an instance
/// name, compressor, or digest function (see the module documentation).
pub fn parse_read(name: &str) -> Result<ReadResourceName> {
    let parts: Vec<&str> = name.split('/').collect();
    let (blob_idx, compressor) =
        if let Some(idx) = parts.iter().position(|&s| s == "compressed-blobs") {
            let compressor = parts.get(idx + 1).ok_or_else(|| {
                invalid(format!(
                    "missing compressor after 'compressed-blobs' in resource name: {name}"
                ))
            })?;
            (idx + 2, parse_compressor(compressor, name)?)
        } else if let Some(idx) = parts.iter().position(|&s| s == "blobs") {
            (idx + 1, Compression::Identity)
        } else {
            return Err(invalid(format!(
                "missing 'blobs' or 'compressed-blobs' in resource name: {name}"
            )));
        };
    let tail = parse_digest_tail(&parts[blob_idx..], name)?;
    Ok(ReadResourceName {
        hash: tail.hash,
        size: tail.size,
        digest_fn: tail.digest_fn,
        compressor,
    })
}

/// A ByteStream write resource name, parsed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WriteResourceName {
    pub hash: String,
    pub size: i64,
    pub uuid: Option<String>,
    pub digest_fn: DigestFn,
    pub compressor: Compression,
}

impl WriteResourceName {
    /// The digest the name gives, if its hash and size are valid.
    pub fn digest(&self) -> std::result::Result<Digest, InvalidDigest> {
        Digest::parse(&self.hash, self.size)
    }
}

/// Parse a ByteStream write resource name, with or without an instance
/// name, compressor, or digest function (see the module documentation).
pub fn parse_write(name: &str) -> Result<WriteResourceName> {
    let parts: Vec<&str> = name.split('/').collect();
    let uploads_idx = parts
        .iter()
        .position(|&s| s == "uploads")
        .ok_or_else(|| invalid(format!("missing 'uploads' in resource name: {name}")))?;
    let after_uploads = &parts[uploads_idx + 1..];
    let malformed = || invalid(format!("invalid write resource name format: {name}"));
    if after_uploads.len() < 4 {
        return Err(malformed());
    }
    let uuid = after_uploads[0].to_string();
    let (blob_parts, compressor) = match after_uploads[1] {
        "compressed-blobs" => {
            if after_uploads.len() < 5 {
                return Err(malformed());
            }
            (
                &after_uploads[3..],
                parse_compressor(after_uploads[2], name)?,
            )
        }
        "blobs" => (&after_uploads[2..], Compression::Identity),
        _ => {
            return Err(invalid(format!(
                "expected 'blobs' or 'compressed-blobs' segment in resource name: {name}"
            )));
        }
    };
    let tail = parse_digest_tail(blob_parts, name)?;
    Ok(WriteResourceName {
        hash: tail.hash,
        size: tail.size,
        uuid: Some(uuid),
        digest_fn: tail.digest_fn,
        compressor,
    })
}

/// `{instance}/` or nothing, then `blobs/` or `compressed-blobs/{compressor}/`,
/// then the digest.
fn push_blob(name: &mut String, digest_fn: DigestFn, compressor: Compression, digest: &Digest) {
    use std::fmt::Write as _;
    match compressor {
        Compression::Identity => name.push_str("blobs/"),
        other => {
            let _ = write!(name, "compressed-blobs/{}/", other.as_str());
        }
    }
    if digest_fn != DigestFn::Sha256 {
        let _ = write!(name, "{}/", digest_fn.as_str());
    }
    let _ = write!(name, "{digest}");
}

fn with_instance(instance: &str) -> String {
    if instance.is_empty() {
        String::new()
    } else {
        format!("{instance}/")
    }
}

/// The resource name to read the blob `digest` under, sent
/// `compressor`-compressed.
pub fn read_name(
    instance: &str,
    digest_fn: DigestFn,
    compressor: Compression,
    digest: &Digest,
) -> String {
    let mut name = with_instance(instance);
    push_blob(&mut name, digest_fn, compressor, digest);
    name
}

/// The resource name to upload the blob `digest` under, as the upload
/// `uuid`, sent `compressor`-compressed.
pub fn write_name(
    instance: &str,
    uuid: &str,
    digest_fn: DigestFn,
    compressor: Compression,
    digest: &Digest,
) -> String {
    let mut name = with_instance(instance);
    name.push_str("uploads/");
    name.push_str(uuid);
    name.push('/');
    push_blob(&mut name, digest_fn, compressor, digest);
    name
}
