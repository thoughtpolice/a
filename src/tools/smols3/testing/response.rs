// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Response assertion helpers.

use bytes::Bytes;
use http::Response;
use http_body_util::BodyExt;

/// Collect a response body into bytes.
pub async fn collect_body(resp: Response<s3s::Body>) -> Bytes {
    let (_, body) = resp.into_parts();
    body.collect()
        .await
        .expect("body collection should not fail")
        .to_bytes()
}

/// Builder for response expectations.
///
/// Provides a fluent API for specifying expected response properties.
#[derive(Debug, Default)]
pub struct Expect {
    status: Option<u16>,
    headers: Vec<(String, Option<String>)>,
    body: Option<Bytes>,
    body_contains: Option<Vec<u8>>,
}

impl Expect {
    /// Create a new expectation with the given status code.
    pub fn status(code: u16) -> Self {
        Self {
            status: Some(code),
            ..Default::default()
        }
    }

    /// Expect a specific header value.
    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers
            .push((name.to_lowercase(), Some(value.to_string())));
        self
    }

    /// Expect a header to be present (any value).
    pub fn with_header_present(mut self, name: &str) -> Self {
        self.headers.push((name.to_lowercase(), None));
        self
    }

    /// Expect an exact body.
    pub fn with_body(mut self, body: impl Into<Bytes>) -> Self {
        self.body = Some(body.into());
        self
    }

    /// Expect body to contain the given bytes.
    pub fn with_body_contains(mut self, pattern: impl Into<Vec<u8>>) -> Self {
        self.body_contains = Some(pattern.into());
        self
    }

    /// Check if a response matches this expectation.
    pub fn matches(&self, resp: &Response<()>, body: &Bytes) -> Result<(), String> {
        // Check status
        if let Some(expected_status) = self.status {
            let actual_status = resp.status().as_u16();
            if actual_status != expected_status {
                return Err(format!(
                    "status mismatch: expected {expected_status}, got {actual_status}"
                ));
            }
        }

        // Check headers
        for (name, expected_value) in &self.headers {
            match resp.headers().get(name) {
                Some(actual_value) => {
                    if let Some(expected) = expected_value {
                        let actual = actual_value.to_str().unwrap_or("<non-utf8>");
                        if actual != expected {
                            return Err(format!(
                                "header '{name}' mismatch: expected '{expected}', got '{actual}'"
                            ));
                        }
                    }
                }
                None => {
                    return Err(format!("header '{name}' not present"));
                }
            }
        }

        // Check body
        if let Some(expected_body) = &self.body {
            if body != expected_body {
                return Err(format!(
                    "body mismatch: expected {} bytes, got {} bytes",
                    expected_body.len(),
                    body.len()
                ));
            }
        }

        // Check body contains
        if let Some(pattern) = &self.body_contains {
            if !contains_subsequence(body, pattern) {
                return Err(format!(
                    "body does not contain expected pattern ({} bytes)",
                    pattern.len()
                ));
            }
        }

        Ok(())
    }
}

/// Check if haystack contains needle as a subsequence.
fn contains_subsequence(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() {
        return true;
    }
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}
