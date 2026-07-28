// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Optimistic reads from a remote REAPI cache.
//!
//! A manifest entry's `digest` and `size` describe the downloaded artifact
//! exactly, so they *are* a CAS digest — the cache can be probed with no
//! preliminary lookup, and a hit is verifiable against the manifest that
//! asked for it.
//!
//! This tier only ever makes a launch faster. Anything short of a verified
//! hit — no endpoint configured, connection refused, a miss, a truncated
//! stream — degrades to `Ok(None)` and the caller falls through to the origin
//! providers, exactly as it did before this tier existed. The one exception is
//! content that is present but does not match its digest: a content-addressed
//! store returning the wrong bytes is an integrity failure, and quietly
//! re-downloading from the origin would hide it forever.
//!
//! Nothing here writes to stdout or stderr. `SHABANG2_LOG` is `off` unless the
//! user sets it, so the launcher stays transparent.

use anyhow::{Result, bail};
use dotslash_manifest::{HashAlgorithm, PlatformEntry};
use reapi_client::{ConnectOptions, Digest, DigestFunction, Error, ReapiClient};

/// gRPC endpoint of the cache, e.g. `http://cache.internal:8080`. Unset means
/// the remote tier does not exist.
const ENDPOINT_ENV: &str = "SHABANG2_REMOTE_CACHE";

/// REAPI instance name; empty addresses the server's default instance.
const INSTANCE_ENV: &str = "SHABANG2_REMOTE_INSTANCE";

/// A configured remote cache.
#[derive(Debug, Clone)]
pub struct Remote {
    url: String,
    instance: String,
}

impl Remote {
    pub fn new(url: impl Into<String>, instance: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            instance: instance.into(),
        }
    }

    /// Read the configuration from the environment.
    ///
    /// The environment is the only channel available here: in shebang mode the
    /// kernel invokes `env shabang2 <script> <args...>`, and everything after
    /// the manifest belongs to the tool being launched, so the launcher can
    /// never be given a flag.
    ///
    /// There is deliberately no default. A default of `localhost:8080` would
    /// make every cold miss on every machine attempt a connection nobody asked
    /// for.
    pub fn from_env() -> Option<Self> {
        let url = std::env::var(ENDPOINT_ENV).ok().filter(|s| !s.is_empty())?;
        let instance = std::env::var(INSTANCE_ENV).unwrap_or_default();
        Some(Self::new(url, instance))
    }

    /// Try to satisfy `entry` from the remote cache.
    ///
    /// `Ok(None)` means "carry on to the origin". `Err` means the launch must
    /// not proceed.
    pub async fn try_read(&self, entry: &PlatformEntry) -> Result<Option<Vec<u8>>> {
        let Ok(size) = i64::try_from(entry.size) else {
            tracing::warn!(size = entry.size, "manifest size is not representable");
            return Ok(None);
        };
        let function = digest_function(entry.hash);
        let digest = Digest::new(entry.digest.clone(), size);

        let options = ConnectOptions::new(&self.url).instance_name(&self.instance);
        let mut client = match ReapiClient::connect(options).await {
            Ok(client) => client,
            Err(err) => {
                tracing::warn!(url = %self.url, %err, "remote cache unreachable");
                return Ok(None);
            }
        };

        match client.read_blob(function, &digest).await {
            Ok(Some(data)) => {
                tracing::info!(digest = %entry.digest, size, "remote cache hit");
                Ok(Some(data.to_vec()))
            }
            Ok(None) => {
                tracing::debug!(digest = %entry.digest, "remote cache miss");
                Ok(None)
            }
            Err(err @ (Error::DigestMismatch { .. } | Error::SizeMismatch { .. })) => {
                bail!(
                    "remote cache corruption for '{}': {err}\n  \
                     the cache at {} returned content that does not match the digest \
                     it was asked for; refusing to run it",
                    entry.path,
                    self.url,
                );
            }
            Err(err) => {
                tracing::warn!(url = %self.url, %err, "remote cache read failed");
                Ok(None)
            }
        }
    }
}

/// Manifest hash algorithms map one-to-one onto REAPI digest functions, which
/// is why a manifest digest can be used as a CAS digest unchanged.
fn digest_function(hash: HashAlgorithm) -> DigestFunction {
    match hash {
        HashAlgorithm::Sha256 => DigestFunction::Sha256,
        HashAlgorithm::Blake3 => DigestFunction::Blake3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dotslash_manifest::ArchiveFormat;

    fn entry(hash: HashAlgorithm, digest: &str, size: u64) -> PlatformEntry {
        PlatformEntry {
            size,
            hash,
            digest: digest.to_string(),
            format: ArchiveFormat::Plain,
            path: "tool".to_string(),
            providers: vec![],
        }
    }

    #[test]
    fn hash_algorithms_map_onto_digest_functions() {
        assert_eq!(
            digest_function(HashAlgorithm::Sha256),
            DigestFunction::Sha256
        );
        assert_eq!(
            digest_function(HashAlgorithm::Blake3),
            DigestFunction::Blake3
        );
    }

    /// An unreachable cache must never break a launch: it degrades to a miss
    /// so the caller falls through to the origin providers.
    #[tokio::test]
    async fn unreachable_cache_degrades_to_a_miss() {
        // Port 1 on loopback: refused immediately, no timeout to wait out.
        let remote = Remote::new("http://127.0.0.1:1", "");
        let entry = entry(HashAlgorithm::Sha256, &"a".repeat(64), 10);

        assert_eq!(remote.try_read(&entry).await.unwrap(), None);
    }

    /// A malformed endpoint is a configuration mistake, not a reason to stop
    /// the tool from running.
    #[tokio::test]
    async fn unusable_endpoint_degrades_to_a_miss() {
        let remote = Remote::new("not a url", "");
        let entry = entry(HashAlgorithm::Blake3, &"b".repeat(64), 10);

        assert_eq!(remote.try_read(&entry).await.unwrap(), None);
    }
}
