// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Digests, as the worker computes and checks them.

use std::fmt;
use std::io::Read;
use std::path::Path;

use protos::build::bazel::remote::execution::v2::Digest;

/// The digest functions the worker can compute, so the ones it can verify
/// inputs with and name outputs by.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DigestFunction {
    Sha256,
    Blake3,
}

impl DigestFunction {
    /// From a `DigestFunction.Value`, where 0 (unknown) means SHA-256, as
    /// it did before clients named one.
    pub fn from_proto(value: i32) -> Option<Self> {
        match value {
            0 | 1 => Some(Self::Sha256),
            9 => Some(Self::Blake3),
            _ => None,
        }
    }

    pub fn to_proto(self) -> i32 {
        match self {
            Self::Sha256 => 1,
            Self::Blake3 => 9,
        }
    }

    /// What ByteStream resource names call it, if not the default.
    pub fn resource_name(self) -> Option<&'static str> {
        match self {
            Self::Sha256 => None,
            Self::Blake3 => Some("blake3"),
        }
    }

    pub fn hasher(self) -> Hasher {
        match self {
            Self::Sha256 => Hasher::Sha256(<sha2::Sha256 as sha2::Digest>::new(), 0),
            Self::Blake3 => Hasher::Blake3(Box::new(blake3::Hasher::new()), 0),
        }
    }

    pub fn of(self, data: &[u8]) -> Digest {
        let mut hasher = self.hasher();
        hasher.update(data);
        hasher.finish()
    }

    /// The digest of the file at `path`.
    pub fn of_file(self, path: &Path) -> std::io::Result<Digest> {
        let mut file = std::fs::File::open(path)?;
        let mut hasher = self.hasher();
        let mut buffer = vec![0; 256 * 1024];
        loop {
            match file.read(&mut buffer)? {
                0 => return Ok(hasher.finish()),
                n => hasher.update(&buffer[..n]),
            }
        }
    }
}

impl fmt::Display for DigestFunction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Sha256 => "sha256",
            Self::Blake3 => "blake3",
        })
    }
}

/// A digest being computed, with the length so far.
pub enum Hasher {
    Sha256(sha2::Sha256, u64),
    Blake3(Box<blake3::Hasher>, u64),
}

impl Hasher {
    pub fn update(&mut self, data: &[u8]) {
        match self {
            Self::Sha256(h, n) => {
                sha2::Digest::update(h, data);
                *n += data.len() as u64;
            }
            Self::Blake3(h, n) => {
                h.update(data);
                *n += data.len() as u64;
            }
        }
    }

    pub fn finish(self) -> Digest {
        let (hash, size) = match self {
            Self::Sha256(h, n) => (hex::encode(sha2::Digest::finalize(h)), n),
            Self::Blake3(h, n) => (h.finalize().to_hex().to_string(), n),
        };
        Digest {
            hash,
            size_bytes: size as i64,
        }
    }
}

/// A digest as a map key; the generated `Digest` is not `Hash`.
pub type Key = (String, i64);

pub fn key(digest: &Digest) -> Key {
    (digest.hash.clone(), digest.size_bytes)
}

/// `hash/size`, as REAPI resource names and error messages write a digest.
pub fn show(digest: &Digest) -> String {
    format!("{}/{}", digest.hash, digest.size_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_digests() {
        assert_eq!(
            DigestFunction::Sha256.of(b"").hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        let hello = DigestFunction::Blake3.of(b"hello");
        assert_eq!(
            hello.hash,
            "ea8f163db38682925e4491c5e58d4bb3506ef8c14eb78a86e908c5624a67200f"
        );
        assert_eq!(hello.size_bytes, 5);
        assert_eq!(DigestFunction::from_proto(0), Some(DigestFunction::Sha256));
        assert_eq!(DigestFunction::from_proto(3), None);
    }
}
