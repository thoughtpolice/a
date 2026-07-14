// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! AWS Signature Version 4 request signing.
//!
//! Implements header-based [SigV4] signing for S3-compatible services on top
//! of the RustCrypto `hmac`/`sha2` stack, so no ring or aws-lc-rs enters the
//! build graph (TLS itself comes from reqwest's native-tls backend, which the
//! toolchain satisfies with BoringSSL).
//!
//! The algorithm follows the canonical-request construction rules exactly:
//! the S3 service uses the URL path verbatim (single URI encoding), while
//! every other service double-encodes it; query parameters are sorted and
//! re-encoded with the unreserved-character set; signed headers exclude
//! `authorization`, `content-length`, and `user-agent`; and header values
//! have runs of whitespace collapsed.
//!
//! [SigV4]: https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html

use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac as _};
use percent_encoding::utf8_percent_encode;
use reqwest::header::{AUTHORIZATION, HOST, HeaderMap, HeaderName, HeaderValue};
use sha2::{Digest as _, Sha256};
use std::collections::BTreeMap;
use std::fmt::Write as _;

/// SHA-256 of the empty string, the payload hash for bodyless requests.
pub(crate) const EMPTY_SHA256: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// Sentinel payload hash for requests whose body is deliberately unsigned.
#[allow(dead_code)] // exposed for completeness and exercised by tests
pub(crate) const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";

const ALGORITHM: &str = "AWS4-HMAC-SHA256";

/// Characters percent-encoded in canonical query strings: everything except
/// the RFC 3986 unreserved set (`A-Z a-z 0-9 - . _ ~`).
pub(crate) const STRICT_ENCODE_SET: percent_encoding::AsciiSet = percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// [`STRICT_ENCODE_SET`] with `/` preserved, for encoding object keys into
/// URL paths.
pub(crate) const STRICT_PATH_ENCODE_SET: percent_encoding::AsciiSet =
    STRICT_ENCODE_SET.remove(b'/');

static DATE_HEADER: HeaderName = HeaderName::from_static("x-amz-date");
static HASH_HEADER: HeaderName = HeaderName::from_static("x-amz-content-sha256");
static TOKEN_HEADER: HeaderName = HeaderName::from_static("x-amz-security-token");

/// A set of static AWS credentials.
#[derive(Clone, PartialEq, Eq)]
pub struct Credentials {
    /// The access key ID (`AWS_ACCESS_KEY_ID`).
    pub access_key_id: String,
    /// The secret access key (`AWS_SECRET_ACCESS_KEY`).
    pub secret_access_key: String,
    /// Optional STS session token (`AWS_SESSION_TOKEN`).
    pub session_token: Option<String>,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("access_key_id", &self.access_key_id)
            .field("secret_access_key", &"******")
            .field(
                "session_token",
                &self.session_token.as_ref().map(|_| "******"),
            )
            .finish()
    }
}

/// Hex-encoded SHA-256 digest of `data`.
pub(crate) fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(key).expect("HMAC-SHA256 accepts keys of any length");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

/// Sign `request` in place for S3 using the current time.
///
/// `payload_sha256` must be the lowercase hex SHA-256 of the request body
/// ([`EMPTY_SHA256`] for bodyless requests), or [`UNSIGNED_PAYLOAD`].
pub(crate) fn sign_request(
    request: &mut reqwest::Request,
    credentials: &Credentials,
    region: &str,
    payload_sha256: &str,
) {
    sign_request_at(
        request,
        credentials,
        "s3",
        region,
        payload_sha256,
        Utc::now(),
    )
}

/// Sign `request` in place with an explicit service and timestamp.
///
/// Inserts the `host`, `x-amz-date`, `x-amz-content-sha256`, (optionally)
/// `x-amz-security-token`, and `authorization` headers. All headers present
/// on the request participate in the signature except `authorization`,
/// `content-length`, and `user-agent`, so callers must not add headers after
/// signing.
pub(crate) fn sign_request_at(
    request: &mut reqwest::Request,
    credentials: &Credentials,
    service: &str,
    region: &str,
    payload_sha256: &str,
    date: DateTime<Utc>,
) {
    if let Some(token) = &credentials.session_token {
        let value = HeaderValue::from_str(token).expect("session token is a valid header value");
        request.headers_mut().insert(TOKEN_HEADER.clone(), value);
    }

    // hyper would fill in `host` at transmission time; insert it explicitly
    // so the signed header set matches what goes over the wire
    let host = host_header_value(request.url());
    let host_value = HeaderValue::from_str(&host).expect("URL authority is a valid header value");
    request.headers_mut().insert(HOST, host_value);

    let date_str = date.format("%Y%m%dT%H%M%SZ").to_string();
    let date_value = HeaderValue::from_str(&date_str).expect("formatted date is ASCII");
    request
        .headers_mut()
        .insert(DATE_HEADER.clone(), date_value);

    let hash_value = HeaderValue::from_str(payload_sha256).expect("payload hash is ASCII");
    request
        .headers_mut()
        .insert(HASH_HEADER.clone(), hash_value);

    let (signed_headers, canonical_headers) = canonicalize_headers(request.headers());

    // S3 uses the (already percent-encoded) URL path verbatim; every other
    // service percent-encodes it a second time
    let canonical_uri = match service {
        "s3" => request.url().path().to_string(),
        _ => utf8_percent_encode(request.url().path(), &STRICT_PATH_ENCODE_SET).to_string(),
    };

    let canonical_query = canonicalize_query(request.url());

    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        request.method().as_str(),
        canonical_uri,
        canonical_query,
        canonical_headers,
        signed_headers,
        payload_sha256,
    );

    let scope = format!("{}/{region}/{service}/aws4_request", date.format("%Y%m%d"));
    let string_to_sign = format!(
        "{ALGORITHM}\n{date_str}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes()),
    );

    // derive the signing key with the HMAC chain over date, region, service
    let secret = format!("AWS4{}", credentials.secret_access_key);
    let key = hmac_sha256(
        secret.as_bytes(),
        date.format("%Y%m%d").to_string().as_bytes(),
    );
    let key = hmac_sha256(&key, region.as_bytes());
    let key = hmac_sha256(&key, service.as_bytes());
    let key = hmac_sha256(&key, b"aws4_request");
    let signature = hex::encode(hmac_sha256(&key, string_to_sign.as_bytes()));

    let authorization = format!(
        "{ALGORITHM} Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        credentials.access_key_id,
    );
    let auth_value = HeaderValue::from_str(&authorization).expect("authorization header is ASCII");
    request.headers_mut().insert(AUTHORIZATION, auth_value);
}

/// The `host` header value for a URL: the host, plus the port when it is not
/// the scheme default.
fn host_header_value(url: &reqwest::Url) -> String {
    let host = url.host_str().unwrap_or_default();
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    }
}

/// Canonicalize headers into the `(SignedHeaders, CanonicalHeaders)` pair.
///
/// Header names arrive lowercased from [`HeaderMap`]; they are sorted, values
/// of repeated headers are comma-joined, and runs of whitespace inside values
/// collapse to a single space.
fn canonicalize_headers(headers: &HeaderMap) -> (String, String) {
    let mut ordered = BTreeMap::<&str, Vec<&str>>::new();
    for (name, value) in headers {
        let name = name.as_str();
        if matches!(name, "authorization" | "content-length" | "user-agent") {
            continue;
        }
        let value = std::str::from_utf8(value.as_bytes())
            .expect("header values produced by this crate are UTF-8");
        ordered.entry(name).or_default().push(value);
    }

    let mut signed_headers = String::new();
    let mut canonical_headers = String::new();
    for (header_idx, (name, values)) in ordered.into_iter().enumerate() {
        if header_idx != 0 {
            signed_headers.push(';');
        }
        signed_headers.push_str(name);

        canonical_headers.push_str(name);
        canonical_headers.push(':');
        for (value_idx, value) in values.into_iter().enumerate() {
            if value_idx != 0 {
                canonical_headers.push(',');
            }
            let mut words = value.split_whitespace();
            if let Some(first) = words.next() {
                canonical_headers.push_str(first);
                for word in words {
                    canonical_headers.push(' ');
                    canonical_headers.push_str(word);
                }
            }
        }
        canonical_headers.push('\n');
    }

    (signed_headers, canonical_headers)
}

/// Canonicalize the query string: decode pairs, sort by key then value, and
/// re-encode with [`STRICT_ENCODE_SET`].
fn canonicalize_query(url: &reqwest::Url) -> String {
    match url.query() {
        Some(query) if !query.is_empty() => {}
        _ => return String::new(),
    }

    let mut pairs = url.query_pairs().collect::<Vec<_>>();
    pairs.sort_unstable();

    let mut encoded = String::new();
    for (idx, (key, value)) in pairs.iter().enumerate() {
        if idx != 0 {
            encoded.push('&');
        }
        let _ = write!(
            encoded,
            "{}={}",
            utf8_percent_encode(key.as_ref(), &STRICT_ENCODE_SET),
            utf8_percent_encode(value.as_ref(), &STRICT_ENCODE_SET),
        );
    }
    encoded
}
