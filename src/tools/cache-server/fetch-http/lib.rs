// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! HTTP asset fetching with SRI (Subresource Integrity) checksum validation.

use std::fmt;

use base64::Engine as _;
use bytes::Bytes;
use dial9::Dial9TokioHandle;
use openssl::ssl::SslConnector;
use sha2::{Digest as _, Sha256, Sha384, Sha512};

// ---------------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------------

/// Maximum size for HTTP-fetched content (256 MiB).
pub const MAX_HTTP_FETCH_SIZE: usize = 256 * 1024 * 1024;

/// Maximum number of HTTP redirects to follow.
const MAX_REDIRECTS: u32 = 10;

// ---------------------------------------------------------------------------------------------------------------------
// SRI types and parsing
// ---------------------------------------------------------------------------------------------------------------------

/// Supported SRI hash algorithms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SriAlgorithm {
    Sha256,
    Sha384,
    Sha512,
}

/// A parsed SRI checksum entry.
#[derive(Debug, Clone)]
pub struct SriChecksum {
    algorithm: SriAlgorithm,
    digest_bytes: Vec<u8>,
}

/// Parse a `checksum.sri` qualifier value into a list of checksums.
///
/// The SRI format is space-separated entries of `algorithm-base64digest`.
/// Example: `sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=`
pub fn parse_sri(value: &str) -> Result<Vec<SriChecksum>, String> {
    let mut checksums = Vec::new();
    for entry in value.split_whitespace() {
        let (algo_str, b64) = entry
            .split_once('-')
            .ok_or_else(|| format!("invalid SRI entry (missing '-'): {entry}"))?;

        let algorithm = match algo_str {
            "sha256" => SriAlgorithm::Sha256,
            "sha384" => SriAlgorithm::Sha384,
            "sha512" => SriAlgorithm::Sha512,
            _ => return Err(format!("unsupported SRI algorithm: {algo_str}")),
        };

        let digest_bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("invalid base64 in SRI entry '{entry}': {e}"))?;

        let expected_len = match algorithm {
            SriAlgorithm::Sha256 => 32,
            SriAlgorithm::Sha384 => 48,
            SriAlgorithm::Sha512 => 64,
        };
        if digest_bytes.len() != expected_len {
            return Err(format!(
                "SRI digest length mismatch for {algo_str}: expected {expected_len} bytes, got {}",
                digest_bytes.len()
            ));
        }

        checksums.push(SriChecksum {
            algorithm,
            digest_bytes,
        });
    }

    if checksums.is_empty() {
        return Err("empty checksum.sri value".to_string());
    }
    Ok(checksums)
}

/// Checks a body against SRI checksums as it streams past, hashing it once
/// per algorithm the checksums use.
pub struct SriVerifier<'a> {
    checksums: &'a [SriChecksum],
    sha256: Option<Sha256>,
    sha384: Option<Sha384>,
    sha512: Option<Sha512>,
}

impl<'a> SriVerifier<'a> {
    pub fn new(checksums: &'a [SriChecksum]) -> Self {
        let uses = |algorithm| checksums.iter().any(|c| c.algorithm == algorithm);
        Self {
            checksums,
            sha256: uses(SriAlgorithm::Sha256).then(Sha256::new),
            sha384: uses(SriAlgorithm::Sha384).then(Sha384::new),
            sha512: uses(SriAlgorithm::Sha512).then(Sha512::new),
        }
    }

    pub fn update(&mut self, data: &[u8]) {
        if let Some(h) = &mut self.sha256 {
            h.update(data);
        }
        if let Some(h) = &mut self.sha384 {
            h.update(data);
        }
        if let Some(h) = &mut self.sha512 {
            h.update(data);
        }
    }

    /// `Ok(())` if there are no checksums or at least one matches.
    pub fn finish(self) -> Result<(), String> {
        if self.checksums.is_empty() {
            return Ok(());
        }
        let sha256 = self.sha256.map(|h| h.finalize().to_vec());
        let sha384 = self.sha384.map(|h| h.finalize().to_vec());
        let sha512 = self.sha512.map(|h| h.finalize().to_vec());
        let matched = self.checksums.iter().any(|c| {
            let digest = match c.algorithm {
                SriAlgorithm::Sha256 => &sha256,
                SriAlgorithm::Sha384 => &sha384,
                SriAlgorithm::Sha512 => &sha512,
            };
            digest.as_deref() == Some(c.digest_bytes.as_slice())
        });
        if matched {
            Ok(())
        } else {
            Err("SRI integrity check failed: no checksum matched".to_string())
        }
    }
}

/// Returns `true` if the URI uses the `http://` or `https://` scheme.
pub fn is_http_uri(uri: &str) -> bool {
    let lower = uri.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

// ---------------------------------------------------------------------------------------------------------------------
// HTTP fetch error type
// ---------------------------------------------------------------------------------------------------------------------

/// Errors from HTTP asset fetching.
#[derive(Debug)]
pub enum HttpFetchError {
    /// HTTP request or connection failed.
    RequestFailed(String),
    /// Non-success HTTP status code.
    HttpStatus(u16, String),
    /// The response body is larger than `limit`: `size` is its declared
    /// length, or how much had arrived when it passed the limit.
    TooLarge { size: usize, limit: usize },
    /// SRI integrity check failed.
    IntegrityMismatch(String),
    /// URI is malformed or missing required components.
    InvalidUri(String),
    /// The target address is blocked (private, loopback, link-local, etc.).
    BlockedAddress(String),
}

impl fmt::Display for HttpFetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RequestFailed(msg) => write!(f, "HTTP request failed: {msg}"),
            Self::HttpStatus(code, msg) => write!(f, "HTTP {code}: {msg}"),
            Self::TooLarge { size, limit } => write!(
                f,
                "response too large: {size} bytes exceeds {limit} byte limit"
            ),
            Self::IntegrityMismatch(msg) => write!(f, "integrity check failed: {msg}"),
            Self::InvalidUri(msg) => write!(f, "invalid URI: {msg}"),
            Self::BlockedAddress(msg) => write!(f, "blocked address: {msg}"),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// HTTP fetch result
// ---------------------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------------------
// HTTP fetch implementation
// ---------------------------------------------------------------------------------------------------------------------

/// Build a default `SslConnector` using BoringSSL with system root certificates.
pub use egress_http::ssl_connector as build_ssl_connector;

/// Test-only switch that lets the SSRF guard reach loopback addresses, so
/// tests here and in sibling crates (`fetch-oci`) can fetch from a fake
/// server bound to `127.0.0.1`. See [`egress::ALLOW_LOOPBACK_FOR_TESTS`].
#[doc(hidden)]
pub use egress::ALLOW_LOOPBACK_FOR_TESTS;

impl From<egress_http::Error> for HttpFetchError {
    fn from(e: egress_http::Error) -> Self {
        match e {
            egress_http::Error::InvalidUrl { .. } => Self::InvalidUri(e.to_string()),
            egress_http::Error::Connect(egress::ConnectError::Blocked { .. }) => {
                Self::BlockedAddress(e.to_string())
            }
            egress_http::Error::TooLarge { size, limit } => Self::TooLarge { size, limit },
            _ => Self::RequestFailed(e.to_string()),
        }
    }
}

/// Fetch a blob from an HTTP or HTTPS URI and verify its SRI checksums,
/// handing every byte of the body to `observe` as it arrives.
///
/// Redirects are followed; the body is capped at [`MAX_HTTP_FETCH_SIZE`].
/// The caller bounds the time this takes. `observe` lets a caller hash the
/// body for its own purposes in the same pass that receives it.
pub async fn fetch_http_blob(
    ssl_connector: &SslConnector,
    uri: &str,
    sri_checksums: &[SriChecksum],
    observe: &mut (dyn FnMut(&[u8]) + Send),
    handle: &Dial9TokioHandle,
) -> Result<Bytes, HttpFetchError> {
    let target = egress_http::Target::parse(uri)?;
    let request = |_: &egress_http::Target| {
        hyper::Request::builder()
            .header(hyper::header::USER_AGENT, "cache-server")
            .body(http_body_util::Empty::<Bytes>::new())
            .map_err(|e| HttpFetchError::RequestFailed(format!("build request: {e}")))
    };
    let (response, _) = get_following_redirects(ssl_connector, target, request, handle).await?;

    let status = response.status();
    if !status.is_success() {
        let reason = status.canonical_reason().unwrap_or("unknown").to_string();
        return Err(HttpFetchError::HttpStatus(status.as_u16(), reason));
    }
    let mut sri = SriVerifier::new(sri_checksums);
    let body = egress_http::collect_capped_observing(response, MAX_HTTP_FETCH_SIZE, |chunk| {
        sri.update(chunk);
        observe(chunk);
    })
    .await?;
    sri.finish().map_err(HttpFetchError::IntegrityMismatch)?;
    Ok(body)
}

/// GET `target`, following up to [`MAX_REDIRECTS`] redirects, each request
/// the one `request` builds for its target. Returns the response that is
/// not a redirect, and the target that answered it.
pub async fn get_following_redirects(
    ssl_connector: &SslConnector,
    mut target: egress_http::Target,
    mut request: impl FnMut(
        &egress_http::Target,
    ) -> Result<hyper::Request<http_body_util::Empty<Bytes>>, HttpFetchError>,
    handle: &Dial9TokioHandle,
) -> Result<(hyper::Response<hyper::body::Incoming>, egress_http::Target), HttpFetchError> {
    for _redirect in 0..MAX_REDIRECTS {
        let response = egress_http::send(ssl_connector, &target, request(&target)?, |connection| {
            handle.spawn(connection);
        })
        .await?;

        let status = response.status();
        if !status.is_redirection() {
            return Ok((response, target));
        }
        let location = response
            .headers()
            .get(hyper::header::LOCATION)
            .ok_or_else(|| {
                HttpFetchError::RequestFailed(format!(
                    "HTTP {}: redirect without Location header",
                    status.as_u16(),
                ))
            })?
            .to_str()
            .map_err(|_| HttpFetchError::RequestFailed("invalid Location header".into()))?;
        let next = target.redirect(location)?;
        tracing::debug!(from = %target, to = %next, "following HTTP redirect");
        target = next;
    }

    Err(HttpFetchError::RequestFailed(format!(
        "too many redirects (max {MAX_REDIRECTS})"
    )))
}

// ---------------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- parse_sri ---

    #[test]
    fn parse_sri_sha256_valid() {
        // SHA-256 of empty string
        let sri = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
        let result = parse_sri(sri).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].algorithm, SriAlgorithm::Sha256);
        assert_eq!(result[0].digest_bytes.len(), 32);
    }

    #[test]
    fn parse_sri_multiple_checksums() {
        let sri = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU= sha384-OLBgp1GsljhM2TJ+sbHjaiH9txEUvgdDTAzHv2P24donTt6/529l+9Ua0vFImLlb";
        let result = parse_sri(sri).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].algorithm, SriAlgorithm::Sha256);
        assert_eq!(result[1].algorithm, SriAlgorithm::Sha384);
        assert_eq!(result[1].digest_bytes.len(), 48);
    }

    #[test]
    fn parse_sri_sha512_valid() {
        let sri = "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==";
        let result = parse_sri(sri).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].algorithm, SriAlgorithm::Sha512);
        assert_eq!(result[0].digest_bytes.len(), 64);
    }

    #[test]
    fn parse_sri_unsupported_algorithm() {
        let err = parse_sri("md5-rL0Y20zC+Fzt72VPzMSk2A==").unwrap_err();
        assert!(err.contains("unsupported SRI algorithm"));
    }

    #[test]
    fn parse_sri_invalid_base64() {
        let err = parse_sri("sha256-!!!not-base64!!!").unwrap_err();
        assert!(err.contains("invalid base64"));
    }

    #[test]
    fn parse_sri_missing_dash() {
        let err = parse_sri("sha256AAAA").unwrap_err();
        assert!(err.contains("missing '-'"));
    }

    #[test]
    fn parse_sri_empty_value() {
        let err = parse_sri("").unwrap_err();
        assert!(err.contains("empty"));
    }

    #[test]
    fn parse_sri_wrong_digest_length() {
        // Too short for sha256 (only 16 bytes)
        let err = parse_sri("sha256-AAAAAAAAAAAAAAAAAAAAAA==").unwrap_err();
        assert!(err.contains("length mismatch"));
    }

    // --- validate_sri ---

    /// Verify `data` in one piece, as the streaming verifier sees a body.
    fn validate_sri(data: &[u8], checksums: &[SriChecksum]) -> Result<(), String> {
        let mut verifier = SriVerifier::new(checksums);
        verifier.update(data);
        verifier.finish()
    }

    #[test]
    fn validate_sri_across_chunks() {
        let checksums = parse_sri(&format!("sha256-{}", {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD.encode(Sha256::digest(b"hello world"))
        }))
        .unwrap();
        let mut verifier = SriVerifier::new(&checksums);
        verifier.update(b"hello ");
        verifier.update(b"world");
        verifier.finish().unwrap();
        assert!(SriVerifier::new(&[]).finish().is_ok());
    }

    #[test]
    fn validate_sri_sha256_match() {
        let data = b"";
        let checksums = parse_sri("sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=").unwrap();
        assert!(validate_sri(data, &checksums).is_ok());
    }

    #[test]
    fn validate_sri_sha256_mismatch() {
        let data = b"hello world";
        // This is the hash of empty string, not "hello world"
        let checksums = parse_sri("sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=").unwrap();
        assert!(validate_sri(data, &checksums).is_err());
    }

    #[test]
    fn validate_sri_multiple_one_matches() {
        let data = b"";
        // First is wrong (sha256 of "x"), second is correct (sha256 of "")
        let sri = "sha256-LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ= sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
        let checksums = parse_sri(sri).unwrap();
        assert!(validate_sri(data, &checksums).is_ok());
    }

    #[test]
    fn validate_sri_sha384() {
        let data = b"";
        let checksums =
            parse_sri("sha384-OLBgp1GsljhM2TJ+sbHjaiH9txEUvgdDTAzHv2P24donTt6/529l+9Ua0vFImLlb")
                .unwrap();
        assert!(validate_sri(data, &checksums).is_ok());
    }

    #[test]
    fn validate_sri_sha512() {
        let data = b"";
        let checksums = parse_sri("sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==").unwrap();
        assert!(validate_sri(data, &checksums).is_ok());
    }

    // --- is_http_uri ---

    #[test]
    fn is_http_uri_variants() {
        assert!(is_http_uri("http://example.com/file.tar.gz"));
        assert!(is_http_uri("https://example.com/file.tar.gz"));
        assert!(is_http_uri("HTTP://EXAMPLE.COM/FILE"));
        assert!(is_http_uri("HTTPS://EXAMPLE.COM/FILE"));
        assert!(!is_http_uri("urn:example:resource"));
        assert!(!is_http_uri("ftp://example.com/file"));
        assert!(!is_http_uri(""));
        assert!(!is_http_uri("not-a-uri"));
    }
}

#[cfg(test)]
mod test_integration;
