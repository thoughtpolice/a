// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! AWS SigV4 request signing for testing.
//!
//! Implements a minimal AWS Signature Version 4 signing algorithm for use
//! in authorization tests. This allows creating properly signed requests
//! that pass authentication and can be tested against Cedar policies.

use bytes::Bytes;
use http::{Method, Request, Uri};
use sha2::{Digest, Sha256};

/// Credentials for signing requests.
#[derive(Clone)]
pub struct TestCredentials {
    pub access_key: String,
    pub secret_key: String,
}

impl TestCredentials {
    pub fn new(access_key: impl Into<String>, secret_key: impl Into<String>) -> Self {
        Self {
            access_key: access_key.into(),
            secret_key: secret_key.into(),
        }
    }
}

/// Builder for signed S3 HTTP requests.
pub struct SignedRequest {
    method: Method,
    uri: String,
    body: Option<Bytes>,
    headers: Vec<(String, String)>,
    credentials: TestCredentials,
}

impl SignedRequest {
    fn new(method: Method, uri: String, credentials: TestCredentials) -> Self {
        Self {
            method,
            uri,
            body: None,
            headers: vec![],
            credentials,
        }
    }

    // =========================================================================
    // Bucket operations
    // =========================================================================

    pub fn create_bucket(bucket: &str, credentials: TestCredentials) -> Self {
        Self::new(Method::PUT, format!("/{bucket}"), credentials)
    }

    pub fn delete_bucket(bucket: &str, credentials: TestCredentials) -> Self {
        Self::new(Method::DELETE, format!("/{bucket}"), credentials)
    }

    pub fn head_bucket(bucket: &str, credentials: TestCredentials) -> Self {
        Self::new(Method::HEAD, format!("/{bucket}"), credentials)
    }

    pub fn list_buckets(credentials: TestCredentials) -> Self {
        Self::new(Method::GET, "/".to_string(), credentials)
    }

    // =========================================================================
    // Object operations
    // =========================================================================

    pub fn put_object(bucket: &str, key: &str, credentials: TestCredentials) -> Self {
        Self::new(Method::PUT, format!("/{bucket}/{key}"), credentials)
    }

    pub fn get_object(bucket: &str, key: &str, credentials: TestCredentials) -> Self {
        Self::new(Method::GET, format!("/{bucket}/{key}"), credentials)
    }

    pub fn head_object(bucket: &str, key: &str, credentials: TestCredentials) -> Self {
        Self::new(Method::HEAD, format!("/{bucket}/{key}"), credentials)
    }

    pub fn delete_object(bucket: &str, key: &str, credentials: TestCredentials) -> Self {
        Self::new(Method::DELETE, format!("/{bucket}/{key}"), credentials)
    }

    pub fn list_objects_v2(bucket: &str, credentials: TestCredentials) -> Self {
        Self::new(Method::GET, format!("/{bucket}?list-type=2"), credentials)
    }

    // =========================================================================
    // Builder methods
    // =========================================================================

    pub fn with_body(mut self, body: impl AsRef<[u8]>) -> Self {
        self.body = Some(Bytes::copy_from_slice(body.as_ref()));
        self
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    pub fn with_query(mut self, key: &str, value: &str) -> Self {
        if self.uri.contains('?') {
            self.uri.push('&');
        } else {
            self.uri.push('?');
        }
        self.uri.push_str(key);
        self.uri.push('=');
        self.uri.push_str(value);
        self
    }

    /// Build a presigned URL with the signature in query parameters.
    ///
    /// Unlike header-based auth, presigned URLs embed the signature in the URL
    /// itself, allowing unauthenticated clients to access the resource for a
    /// limited time.
    ///
    /// # Arguments
    /// * `base_url` - The base URL of the S3 service (e.g., "http://localhost:8080")
    /// * `expires_in` - How long the URL is valid, in seconds
    pub fn build_presigned_url(&self, base_url: &str, expires_in: u64) -> String {
        let uri: Uri = self.uri.parse().expect("invalid URI");

        // Use current time for presigned URLs (they expire based on real time)
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time went backwards");
        let secs = now.as_secs();
        // Convert to date/time components
        let days_since_epoch = secs / 86400;
        let secs_in_day = secs % 86400;
        let hours = secs_in_day / 3600;
        let minutes = (secs_in_day % 3600) / 60;
        let seconds = secs_in_day % 60;
        // Simple date calculation (not accounting for leap years precisely, but close enough for tests)
        let (year, month, day) = days_to_ymd(days_since_epoch);
        let amz_date = format!("{:04}{:02}{:02}T{:02}{:02}{:02}Z", year, month, day, hours, minutes, seconds);
        let date_stamp = format!("{:04}{:02}{:02}", year, month, day);

        let region = "us-east-1";
        let service = "s3";

        // For presigned URLs, payload is always UNSIGNED-PAYLOAD
        let payload_hash = "UNSIGNED-PAYLOAD";

        // Build credential scope
        let credential_scope = format!("{date_stamp}/{region}/{service}/aws4_request");
        let credential = format!("{}/{}", self.credentials.access_key, credential_scope);

        // For presigned URLs, only host is signed
        let signed_headers = "host";
        let host = "localhost";

        // Build query string with auth parameters (sorted alphabetically)
        let canonical_uri = uri.path();
        let existing_query = uri.query().unwrap_or("");

        // Build the presign query parameters
        let mut query_params: Vec<(String, String)> = vec![
            ("X-Amz-Algorithm".to_string(), "AWS4-HMAC-SHA256".to_string()),
            ("X-Amz-Credential".to_string(), credential.clone()),
            ("X-Amz-Date".to_string(), amz_date.to_string()),
            ("X-Amz-Expires".to_string(), expires_in.to_string()),
            ("X-Amz-SignedHeaders".to_string(), signed_headers.to_string()),
        ];

        // Parse and add existing query parameters
        if !existing_query.is_empty() {
            for pair in existing_query.split('&') {
                if let Some((k, v)) = pair.split_once('=') {
                    query_params.push((k.to_string(), v.to_string()));
                }
            }
        }

        // Sort query parameters alphabetically by key
        query_params.sort_by(|a, b| a.0.cmp(&b.0));

        // Build canonical query string (URL-encoded)
        let canonical_query: String = query_params
            .iter()
            .map(|(k, v)| format!("{}={}", url_encode(k), url_encode(v)))
            .collect::<Vec<_>>()
            .join("&");

        // Canonical headers (just host for presigned URLs)
        let canonical_headers = format!("host:{}\n", host);

        // Build canonical request
        let canonical_request = format!(
            "{}\n{}\n{}\n{}\n{}\n{}",
            self.method, canonical_uri, canonical_query, canonical_headers, signed_headers, payload_hash
        );

        // Create string to sign
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{}\n{}\n{}",
            amz_date,
            credential_scope,
            hex_sha256(canonical_request.as_bytes())
        );

        // Calculate signature
        let k_date = hmac_sha256(format!("AWS4{}", self.credentials.secret_key).as_bytes(), date_stamp.as_bytes());
        let k_region = hmac_sha256(&k_date, region.as_bytes());
        let k_service = hmac_sha256(&k_region, service.as_bytes());
        let k_signing = hmac_sha256(&k_service, b"aws4_request");
        let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));

        // Build the final URL with signature
        let base_url = base_url.trim_end_matches('/');
        format!(
            "{}{}?{}&X-Amz-Signature={}",
            base_url, canonical_uri, canonical_query, signature
        )
    }

    /// Build a signed HTTP request.
    pub fn build(self) -> Request<s3s::Body> {
        let uri: Uri = self.uri.parse().expect("invalid URI");

        let body_bytes = self.body.clone().unwrap_or_default();
        let body = if body_bytes.is_empty() {
            s3s::Body::empty()
        } else {
            s3s::Body::from(body_bytes.clone())
        };

        // Use a fixed timestamp for deterministic tests
        let amz_date = "20260128T000000Z";
        let date_stamp = "20260128";
        let region = "us-east-1";
        let service = "s3";

        // Calculate payload hash
        let payload_hash = hex_sha256(&body_bytes);

        // Build canonical request
        let canonical_uri = uri.path();
        let canonical_query = uri.query().unwrap_or("");

        // Collect headers for signing
        let host = "localhost";
        let mut headers_to_sign: Vec<(&str, String)> = vec![
            ("host", host.to_string()),
            ("x-amz-content-sha256", payload_hash.clone()),
            ("x-amz-date", amz_date.to_string()),
        ];

        // Add custom headers
        for (name, value) in &self.headers {
            headers_to_sign.push((name.as_str(), value.clone()));
        }

        // Sort headers by name
        headers_to_sign.sort_by(|a, b| a.0.cmp(b.0));

        let signed_headers: String = headers_to_sign
            .iter()
            .map(|(n, _)| n.to_lowercase())
            .collect::<Vec<_>>()
            .join(";");

        let canonical_headers: String = headers_to_sign
            .iter()
            .map(|(n, v)| format!("{}:{}\n", n.to_lowercase(), v.trim()))
            .collect();

        let canonical_request = format!(
            "{}\n{}\n{}\n{}\n{}\n{}",
            self.method, canonical_uri, canonical_query, canonical_headers, signed_headers, payload_hash
        );

        // Create string to sign
        let credential_scope = format!("{date_stamp}/{region}/{service}/aws4_request");
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{}\n{}\n{}",
            amz_date,
            credential_scope,
            hex_sha256(canonical_request.as_bytes())
        );

        // Calculate signature
        let k_date = hmac_sha256(format!("AWS4{}", self.credentials.secret_key).as_bytes(), date_stamp.as_bytes());
        let k_region = hmac_sha256(&k_date, region.as_bytes());
        let k_service = hmac_sha256(&k_region, service.as_bytes());
        let k_signing = hmac_sha256(&k_service, b"aws4_request");
        let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));

        // Build authorization header
        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
            self.credentials.access_key, credential_scope, signed_headers, signature
        );

        // Build the request
        let mut builder = Request::builder()
            .method(self.method)
            .uri(uri)
            .header("host", host)
            .header("x-amz-content-sha256", &payload_hash)
            .header("x-amz-date", amz_date)
            .header("authorization", authorization);

        for (name, value) in &self.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }

        builder.body(body).expect("failed to build request")
    }
}

fn hex_sha256(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

fn url_encode(input: &str) -> String {
    let mut encoded = String::new();
    for byte in input.bytes() {
        match byte {
            // Unreserved characters per RFC 3986
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    encoded
}

/// Convert days since Unix epoch to year, month (1-12), day (1-31).
fn days_to_ymd(days: u64) -> (u32, u32, u32) {
    // Algorithm from Howard Hinnant's date library
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as u32, m, d)
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    use sha2::Sha256;
    use hmac::{Hmac, Mac};

    type HmacSha256 = Hmac<Sha256>;

    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC can take key of any size");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_signing_produces_valid_request() {
        let creds = TestCredentials::new("AKIATEST", "secret");
        let req = SignedRequest::get_object("bucket", "key", creds).build();

        assert!(req.headers().contains_key("authorization"));
        assert!(req.headers().contains_key("x-amz-date"));
        assert!(req.headers().contains_key("x-amz-content-sha256"));

        let auth = req.headers().get("authorization").unwrap().to_str().unwrap();
        assert!(auth.starts_with("AWS4-HMAC-SHA256"));
        assert!(auth.contains("AKIATEST"));
    }

    #[test]
    fn test_presigned_url_format() {
        let creds = TestCredentials::new("AKIATEST", "secret");
        let req = SignedRequest::get_object("bucket", "key", creds);
        let url = req.build_presigned_url("http://localhost:8080", 3600);

        // Should contain the base URL and path
        assert!(url.starts_with("http://localhost:8080/bucket/key?"));

        // Should contain required query parameters
        assert!(url.contains("X-Amz-Algorithm=AWS4-HMAC-SHA256"));
        assert!(url.contains("X-Amz-Credential=AKIATEST"));
        assert!(url.contains("X-Amz-Date="));
        assert!(url.contains("X-Amz-Expires=3600"));
        assert!(url.contains("X-Amz-SignedHeaders=host"));
        assert!(url.contains("X-Amz-Signature="));

        // Signature should be a 64-character hex string
        let sig_start = url.find("X-Amz-Signature=").unwrap() + 16;
        let signature = &url[sig_start..];
        assert_eq!(signature.len(), 64);
        assert!(signature.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_presigned_url_with_query_params() {
        let creds = TestCredentials::new("AKIATEST", "secret");
        let req = SignedRequest::list_objects_v2("bucket", creds);
        let url = req.build_presigned_url("http://localhost:8080", 3600);

        // Should contain both the list-type query param and auth params
        assert!(url.contains("list-type=2"));
        assert!(url.contains("X-Amz-Algorithm=AWS4-HMAC-SHA256"));
    }
}
