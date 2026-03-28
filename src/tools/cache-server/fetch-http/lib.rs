// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! HTTP asset fetching with SRI (Subresource Integrity) checksum validation.

use std::fmt;
use std::net::IpAddr;
use std::pin::Pin;
use std::time::Duration;

use base64::Engine as _;
use bytes::Bytes;
use dial9::Dial9TokioHandle;
use http_body_util::{BodyExt as _, LengthLimitError, Limited};
use hyper_util::rt::TokioIo;
use openssl::ssl::{SslConnector, SslMethod};
use sha2::{Digest as _, Sha256, Sha384, Sha512};
use tokio::net::TcpStream;
use tokio_openssl::SslStream;

use storage::DigestFn;

// ---------------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------------

/// Maximum size for HTTP-fetched content (256 MiB).
pub const MAX_HTTP_FETCH_SIZE: usize = 256 * 1024 * 1024;

/// Default timeout for HTTP fetch requests.
const DEFAULT_HTTP_TIMEOUT: Duration = Duration::from_secs(60);

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
fn parse_sri_value(value: &str) -> Result<Vec<SriChecksum>, String> {
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

/// Validate data against SRI checksums. Returns `Ok(())` if at least one matches.
fn validate_sri(data: &[u8], checksums: &[SriChecksum]) -> Result<(), String> {
    for cs in checksums {
        let matches = match cs.algorithm {
            SriAlgorithm::Sha256 => Sha256::digest(data).as_slice() == cs.digest_bytes.as_slice(),
            SriAlgorithm::Sha384 => Sha384::digest(data).as_slice() == cs.digest_bytes.as_slice(),
            SriAlgorithm::Sha512 => Sha512::digest(data).as_slice() == cs.digest_bytes.as_slice(),
        };
        if matches {
            return Ok(());
        }
    }
    Err("SRI integrity check failed: no checksum matched".to_string())
}

/// Extract the `checksum.sri` qualifier value from a qualifier list.
pub fn find_sri_qualifier<'a>(qualifiers: &'a [(String, String)]) -> Option<&'a str> {
    qualifiers
        .iter()
        .find(|(name, _)| name == "checksum.sri")
        .map(|(_, value)| value.as_str())
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
    /// Response body exceeds size limit.
    TooLarge(usize),
    /// SRI integrity check failed.
    IntegrityMismatch(String),
    /// Request timed out.
    Timeout,
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
            Self::TooLarge(size) => write!(
                f,
                "response too large: {size} bytes exceeds {MAX_HTTP_FETCH_SIZE} byte limit"
            ),
            Self::IntegrityMismatch(msg) => write!(f, "integrity check failed: {msg}"),
            Self::Timeout => write!(f, "HTTP request timed out"),
            Self::InvalidUri(msg) => write!(f, "invalid URI: {msg}"),
            Self::BlockedAddress(msg) => write!(f, "blocked address: {msg}"),
        }
    }
}

impl HttpFetchError {
    /// Map this error to a `google.rpc.Status` proto.
    pub fn to_rpc_status(&self) -> protos::google::rpc::Status {
        let (code, message) = match self {
            Self::RequestFailed(msg) => (tonic::Code::Unavailable as i32, msg.clone()),
            Self::HttpStatus(status, msg) => {
                let code = match *status {
                    404 => tonic::Code::NotFound,
                    401 | 403 => tonic::Code::PermissionDenied,
                    _ => tonic::Code::Unavailable,
                };
                (code as i32, format!("HTTP {status}: {msg}"))
            }
            Self::TooLarge(size) => (
                tonic::Code::ResourceExhausted as i32,
                format!(
                    "response too large: {size} bytes exceeds {MAX_HTTP_FETCH_SIZE} byte limit"
                ),
            ),
            Self::IntegrityMismatch(msg) => (tonic::Code::Aborted as i32, msg.clone()),
            Self::Timeout => (
                tonic::Code::DeadlineExceeded as i32,
                "HTTP request timed out".to_string(),
            ),
            Self::InvalidUri(msg) => (tonic::Code::InvalidArgument as i32, msg.clone()),
            Self::BlockedAddress(msg) => (tonic::Code::PermissionDenied as i32, msg.clone()),
        };
        protos::google::rpc::Status {
            code,
            message,
            details: vec![],
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// HTTP fetch result
// ---------------------------------------------------------------------------------------------------------------------

/// Successful result from an HTTP fetch.
#[derive(Debug)]
pub struct HttpFetchResult {
    pub data: Bytes,
    pub digest_hash: [u8; 32],
    pub digest_size: i64,
}

// ---------------------------------------------------------------------------------------------------------------------
// HTTP fetch implementation
// ---------------------------------------------------------------------------------------------------------------------

/// Build a default `SslConnector` using BoringSSL with system root certificates.
pub fn build_ssl_connector() -> SslConnector {
    SslConnector::builder(SslMethod::tls())
        .expect("failed to create SSL connector builder")
        .build()
}

/// Fetch a blob from an HTTP or HTTPS URI, validate its SRI checksums, and
/// compute the CAS digest.
pub async fn fetch_http_blob(
    ssl_connector: &SslConnector,
    uri: &str,
    timeout: Option<Duration>,
    sri_checksums: &[SriChecksum],
    digest_fn: DigestFn,
    handle: &Dial9TokioHandle,
) -> Result<HttpFetchResult, HttpFetchError> {
    let timeout = timeout.unwrap_or(DEFAULT_HTTP_TIMEOUT);
    tokio::time::timeout(
        timeout,
        fetch_http_blob_inner(ssl_connector, uri, sri_checksums, digest_fn, handle),
    )
    .await
    .map_err(|_| HttpFetchError::Timeout)?
}

async fn fetch_http_blob_inner(
    ssl_connector: &SslConnector,
    uri: &str,
    sri_checksums: &[SriChecksum],
    digest_fn: DigestFn,
    handle: &Dial9TokioHandle,
) -> Result<HttpFetchResult, HttpFetchError> {
    let mut current_uri = uri.to_string();

    for _redirect in 0..MAX_REDIRECTS {
        match do_http_get(ssl_connector, &current_uri, handle).await? {
            HttpGetResult::Body(body) => {
                // Validate SRI (skipped when no checksums are provided)
                if !sri_checksums.is_empty() {
                    validate_sri(&body, sri_checksums)
                        .map_err(HttpFetchError::IntegrityMismatch)?;
                }

                let digest_hash = digest_fn.hash_data(&body);
                let digest_size = body.len() as i64;

                return Ok(HttpFetchResult {
                    data: body,
                    digest_hash,
                    digest_size,
                });
            }
            HttpGetResult::Redirect(location) => {
                if current_uri.starts_with("https://") && !location.starts_with("https://") {
                    return Err(HttpFetchError::RequestFailed(
                        "redirect would downgrade from HTTPS to HTTP".to_string(),
                    ));
                }
                tracing::debug!(from = %current_uri, to = %location, "following HTTP redirect");
                current_uri = location;
            }
        }
    }

    Err(HttpFetchError::RequestFailed(format!(
        "too many redirects (max {MAX_REDIRECTS})"
    )))
}

/// Result of a single HTTP GET: either a collected body or a redirect location.
enum HttpGetResult {
    Body(Bytes),
    Redirect(String),
}

/// Returns `true` if the given IP address is in a range that should not be
/// accessed by server-side HTTP fetches (SSRF protection).
fn is_ip_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()         // 127.0.0.0/8
            || v4.is_private()       // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
            || v4.is_link_local()    // 169.254.0.0/16 (includes cloud metadata endpoint)
            || v4.is_broadcast()     // 255.255.255.255
            || v4.is_unspecified()   // 0.0.0.0
            || v4.is_documentation() // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24
            || v4.octets()[0] == 100 && (v4.octets()[1] & 0xC0) == 64 // 100.64.0.0/10 (CGNAT)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()       // ::1
            || v6.is_unspecified() // ::
            // IPv4-mapped IPv6: ::ffff:x.x.x.x -- extract the inner v4 and re-check
            || v6.to_ipv4_mapped().is_some_and(|v4| is_ip_blocked(IpAddr::V4(v4)))
            // Link-local unicast: fe80::/10
            || (v6.segments()[0] & 0xffc0) == 0xfe80
            // Unique local addresses (ULA): fc00::/7
            || (v6.segments()[0] & 0xfe00) == 0xfc00
        }
    }
}

/// Test-only switch that allows the SSRF guard to accept loopback addresses.
///
/// Exposed (but `#[doc(hidden)]`) so that integration tests in sibling crates
/// — for example, `fetch-oci` — can exercise the SSRF-protected code paths
/// against a fake server bound to `127.0.0.1`. Setting this to `true` only
/// allows loopback IPs through; all other blocked ranges (private, link-local,
/// CGNAT, unique-local, …) remain rejected. Do not flip this in production code.
#[doc(hidden)]
pub static ALLOW_LOOPBACK_FOR_TESTS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Resolve a hostname to IP addresses, validate all of them against the SSRF
/// blocklist, then connect to one of the allowed addresses.
///
/// All resolved addresses must pass validation. If even one address in the DNS
/// response is blocked, the entire resolution is rejected to prevent DNS
/// rebinding attacks.
pub async fn resolve_and_validate(host: &str, port: u16) -> Result<TcpStream, HttpFetchError> {
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| HttpFetchError::RequestFailed(format!("DNS lookup for {host}: {e}")))?
        .collect();

    if addrs.is_empty() {
        return Err(HttpFetchError::RequestFailed(format!(
            "DNS lookup for {host} returned no addresses"
        )));
    }

    for addr in &addrs {
        let blocked = is_ip_blocked(addr.ip())
            && !(ALLOW_LOOPBACK_FOR_TESTS.load(std::sync::atomic::Ordering::Relaxed)
                && addr.ip().is_loopback());
        if blocked {
            return Err(HttpFetchError::BlockedAddress(format!(
                "{host} resolved to blocked address {}",
                addr.ip()
            )));
        }
    }

    TcpStream::connect(addrs.as_slice())
        .await
        .map_err(|e| HttpFetchError::RequestFailed(format!("TCP connect to {host}:{port}: {e}")))
}

/// Perform a single HTTP GET request, returning either the body or a redirect.
async fn do_http_get(
    ssl_connector: &SslConnector,
    uri: &str,
    handle: &Dial9TokioHandle,
) -> Result<HttpGetResult, HttpFetchError> {
    let parsed: hyper::Uri = uri
        .parse()
        .map_err(|e| HttpFetchError::InvalidUri(format!("{e}")))?;

    let scheme = parsed
        .scheme_str()
        .ok_or_else(|| HttpFetchError::InvalidUri("missing scheme".to_string()))?;
    let host = parsed
        .host()
        .ok_or_else(|| HttpFetchError::InvalidUri("missing host".to_string()))?
        .to_string();
    let port = parsed.port_u16().unwrap_or(match scheme {
        "https" => 443,
        _ => 80,
    });
    let path_and_query = parsed.path_and_query().map(|pq| pq.as_str()).unwrap_or("/");

    // DNS resolve + SSRF validation + TCP connect
    let tcp = resolve_and_validate(&host, port).await?;
    tcp.set_nodelay(true)
        .map_err(|e| HttpFetchError::RequestFailed(format!("set nodelay: {e}")))?;

    // Build HTTP request
    let req = hyper::Request::get(path_and_query)
        .header(hyper::header::HOST, &host)
        .header(hyper::header::USER_AGENT, "cache-server")
        .body(http_body_util::Empty::<Bytes>::new())
        .map_err(|e| HttpFetchError::RequestFailed(format!("build request: {e}")))?;

    let resp = if scheme == "https" {
        let ssl_config = ssl_connector
            .configure()
            .map_err(|e| HttpFetchError::RequestFailed(format!("SSL configure: {e}")))?
            .into_ssl(&host)
            .map_err(|e| HttpFetchError::RequestFailed(format!("SSL init: {e}")))?;
        let mut tls_stream = SslStream::new(ssl_config, tcp)
            .map_err(|e| HttpFetchError::RequestFailed(format!("SSL stream: {e}")))?;
        Pin::new(&mut tls_stream).connect().await.map_err(|e| {
            HttpFetchError::RequestFailed(format!("TLS handshake with {host}: {e}"))
        })?;
        let io = TokioIo::new(tls_stream);
        send_request(io, req, handle).await?
    } else {
        let io = TokioIo::new(tcp);
        send_request(io, req, handle).await?
    };

    let status = resp.status();

    // Handle redirects
    if status.is_redirection() {
        let location = resp
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

        // Resolve relative URLs against the current URI
        let resolved = if location.starts_with("http://") || location.starts_with("https://") {
            location.to_string()
        } else if location.starts_with('/') {
            format!("{scheme}://{host}:{port}{location}")
        } else {
            return Err(HttpFetchError::RequestFailed(format!(
                "unsupported relative redirect: {location}"
            )));
        };

        return Ok(HttpGetResult::Redirect(resolved));
    }

    if !status.is_success() {
        let reason = status.canonical_reason().unwrap_or("unknown").to_string();
        return Err(HttpFetchError::HttpStatus(status.as_u16(), reason));
    }

    // Check Content-Length before downloading
    if let Some(cl) = resp.headers().get(hyper::header::CONTENT_LENGTH) {
        if let Ok(len_str) = cl.to_str() {
            if let Ok(len) = len_str.parse::<usize>() {
                if len > MAX_HTTP_FETCH_SIZE {
                    return Err(HttpFetchError::TooLarge(len));
                }
            }
        }
    }

    let body = Limited::new(resp.into_body(), MAX_HTTP_FETCH_SIZE)
        .collect()
        .await
        .map_err(|e| {
            if e.downcast_ref::<LengthLimitError>().is_some() {
                HttpFetchError::TooLarge(MAX_HTTP_FETCH_SIZE)
            } else {
                HttpFetchError::RequestFailed(format!("read body: {e}"))
            }
        })?
        .to_bytes();

    Ok(HttpGetResult::Body(body))
}

/// Send an HTTP/1.1 request over the given IO stream and return the response.
pub async fn send_request<I>(
    io: I,
    req: hyper::Request<http_body_util::Empty<Bytes>>,
    handle: &Dial9TokioHandle,
) -> Result<hyper::Response<hyper::body::Incoming>, HttpFetchError>
where
    I: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
{
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(|e| HttpFetchError::RequestFailed(format!("HTTP handshake: {e}")))?;

    handle.spawn(async move {
        if let Err(e) = conn.await {
            tracing::debug!("HTTP connection closed: {e}");
        }
    });

    sender
        .send_request(req)
        .await
        .map_err(|e| HttpFetchError::RequestFailed(format!("send request: {e}")))
}

/// Parse SRI qualifiers from a qualifier value string.
pub fn parse_sri(value: &str) -> Result<Vec<SriChecksum>, String> {
    parse_sri_value(value)
}

// ---------------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- parse_sri_value ---

    #[test]
    fn parse_sri_sha256_valid() {
        // SHA-256 of empty string
        let sri = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
        let result = parse_sri_value(sri).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].algorithm, SriAlgorithm::Sha256);
        assert_eq!(result[0].digest_bytes.len(), 32);
    }

    #[test]
    fn parse_sri_multiple_checksums() {
        let sri = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU= sha384-OLBgp1GsljhM2TJ+sbHjaiH9txEUvgdDTAzHv2P24donTt6/529l+9Ua0vFImLlb";
        let result = parse_sri_value(sri).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].algorithm, SriAlgorithm::Sha256);
        assert_eq!(result[1].algorithm, SriAlgorithm::Sha384);
        assert_eq!(result[1].digest_bytes.len(), 48);
    }

    #[test]
    fn parse_sri_sha512_valid() {
        let sri = "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==";
        let result = parse_sri_value(sri).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].algorithm, SriAlgorithm::Sha512);
        assert_eq!(result[0].digest_bytes.len(), 64);
    }

    #[test]
    fn parse_sri_unsupported_algorithm() {
        let err = parse_sri_value("md5-rL0Y20zC+Fzt72VPzMSk2A==").unwrap_err();
        assert!(err.contains("unsupported SRI algorithm"));
    }

    #[test]
    fn parse_sri_invalid_base64() {
        let err = parse_sri_value("sha256-!!!not-base64!!!").unwrap_err();
        assert!(err.contains("invalid base64"));
    }

    #[test]
    fn parse_sri_missing_dash() {
        let err = parse_sri_value("sha256AAAA").unwrap_err();
        assert!(err.contains("missing '-'"));
    }

    #[test]
    fn parse_sri_empty_value() {
        let err = parse_sri_value("").unwrap_err();
        assert!(err.contains("empty"));
    }

    #[test]
    fn parse_sri_wrong_digest_length() {
        // Too short for sha256 (only 16 bytes)
        let err = parse_sri_value("sha256-AAAAAAAAAAAAAAAAAAAAAA==").unwrap_err();
        assert!(err.contains("length mismatch"));
    }

    // --- validate_sri ---

    #[test]
    fn validate_sri_sha256_match() {
        let data = b"";
        let checksums =
            parse_sri_value("sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=").unwrap();
        assert!(validate_sri(data, &checksums).is_ok());
    }

    #[test]
    fn validate_sri_sha256_mismatch() {
        let data = b"hello world";
        // This is the hash of empty string, not "hello world"
        let checksums =
            parse_sri_value("sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=").unwrap();
        assert!(validate_sri(data, &checksums).is_err());
    }

    #[test]
    fn validate_sri_multiple_one_matches() {
        let data = b"";
        // First is wrong (sha256 of "x"), second is correct (sha256 of "")
        let sri = "sha256-LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ= sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
        let checksums = parse_sri_value(sri).unwrap();
        assert!(validate_sri(data, &checksums).is_ok());
    }

    #[test]
    fn validate_sri_sha384() {
        let data = b"";
        let checksums = parse_sri_value(
            "sha384-OLBgp1GsljhM2TJ+sbHjaiH9txEUvgdDTAzHv2P24donTt6/529l+9Ua0vFImLlb",
        )
        .unwrap();
        assert!(validate_sri(data, &checksums).is_ok());
    }

    #[test]
    fn validate_sri_sha512() {
        let data = b"";
        let checksums = parse_sri_value("sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==").unwrap();
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

    // --- find_sri_qualifier ---

    #[test]
    fn find_sri_qualifier_present() {
        let quals = vec![
            (
                "resource_type".to_string(),
                "application/x-gzip".to_string(),
            ),
            ("checksum.sri".to_string(), "sha256-abc123".to_string()),
        ];
        assert_eq!(find_sri_qualifier(&quals), Some("sha256-abc123"));
    }

    #[test]
    fn find_sri_qualifier_absent() {
        let quals = vec![(
            "resource_type".to_string(),
            "application/x-gzip".to_string(),
        )];
        assert_eq!(find_sri_qualifier(&quals), None);
    }

    #[test]
    fn find_sri_qualifier_empty() {
        let quals: Vec<(String, String)> = vec![];
        assert_eq!(find_sri_qualifier(&quals), None);
    }

    // --- is_ip_blocked ---

    #[test]
    fn blocked_ipv4_loopback() {
        assert!(is_ip_blocked("127.0.0.1".parse().unwrap()));
        assert!(is_ip_blocked("127.255.255.255".parse().unwrap()));
    }

    #[test]
    fn blocked_ipv4_private_rfc1918() {
        assert!(is_ip_blocked("10.0.0.1".parse().unwrap()));
        assert!(is_ip_blocked("10.255.255.255".parse().unwrap()));
        assert!(is_ip_blocked("172.16.0.1".parse().unwrap()));
        assert!(is_ip_blocked("172.31.255.255".parse().unwrap()));
        assert!(is_ip_blocked("192.168.0.1".parse().unwrap()));
        assert!(is_ip_blocked("192.168.255.255".parse().unwrap()));
    }

    #[test]
    fn blocked_ipv4_link_local() {
        assert!(is_ip_blocked("169.254.169.254".parse().unwrap()));
        assert!(is_ip_blocked("169.254.0.1".parse().unwrap()));
    }

    #[test]
    fn blocked_ipv4_special() {
        assert!(is_ip_blocked("0.0.0.0".parse().unwrap()));
        assert!(is_ip_blocked("255.255.255.255".parse().unwrap()));
        assert!(is_ip_blocked("192.0.2.1".parse().unwrap()));
        assert!(is_ip_blocked("100.64.0.1".parse().unwrap()));
    }

    #[test]
    fn allowed_ipv4_public() {
        assert!(!is_ip_blocked("8.8.8.8".parse().unwrap()));
        assert!(!is_ip_blocked("1.1.1.1".parse().unwrap()));
        assert!(!is_ip_blocked("93.184.216.34".parse().unwrap()));
    }

    #[test]
    fn blocked_ipv6_loopback_and_unspecified() {
        assert!(is_ip_blocked("::1".parse().unwrap()));
        assert!(is_ip_blocked("::".parse().unwrap()));
    }

    #[test]
    fn blocked_ipv6_link_local() {
        assert!(is_ip_blocked("fe80::1".parse().unwrap()));
    }

    #[test]
    fn blocked_ipv6_unique_local() {
        assert!(is_ip_blocked("fc00::1".parse().unwrap()));
        assert!(is_ip_blocked("fd00::1".parse().unwrap()));
    }

    #[test]
    fn blocked_ipv4_mapped_ipv6() {
        assert!(is_ip_blocked("::ffff:127.0.0.1".parse().unwrap()));
        assert!(is_ip_blocked("::ffff:169.254.169.254".parse().unwrap()));
        assert!(is_ip_blocked("::ffff:10.0.0.1".parse().unwrap()));
        assert!(is_ip_blocked("::ffff:192.168.1.1".parse().unwrap()));
    }

    #[test]
    fn allowed_ipv4_mapped_ipv6_public() {
        assert!(!is_ip_blocked("::ffff:8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn allowed_ipv6_public() {
        assert!(!is_ip_blocked("2607:f8b0:4004:800::200e".parse().unwrap()));
    }
}

#[cfg(test)]
mod test_integration;
