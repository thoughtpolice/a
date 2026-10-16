// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Builder-style configuration for [`S3Store`](crate::S3Store).

use std::time::Duration;

use s3_client::ClientBuilder;

use crate::{S3Store, map_error};

type Result<T, E = object_store::Error> = std::result::Result<T, E>;

/// Configure and construct an [`S3Store`].
///
/// ```no_run
/// # use s3_store::S3StoreBuilder;
/// let store = S3StoreBuilder::from_env()
///     .with_bucket("my-bucket")
///     .with_region("us-east-1")
///     .build()
///     .unwrap();
/// ```
#[derive(Debug, Clone, Default)]
pub struct S3StoreBuilder {
    client: ClientBuilder,
}

impl S3StoreBuilder {
    /// An empty builder. The bucket is the only mandatory field, but without
    /// credentials only [`with_skip_signature`](Self::with_skip_signature)
    /// requests are possible.
    pub fn new() -> Self {
        Self::default()
    }

    /// A builder filled in from the standard `AWS_*` environment variables,
    /// as [`ClientBuilder::from_env`] reads them.
    pub fn from_env() -> Self {
        Self {
            client: ClientBuilder::from_env(),
        }
    }

    fn map(self, f: impl FnOnce(ClientBuilder) -> ClientBuilder) -> Self {
        Self {
            client: f(self.client),
        }
    }

    /// Set the bucket name (required).
    pub fn with_bucket(self, bucket: impl Into<String>) -> Self {
        self.map(|c| c.with_bucket(bucket))
    }

    /// Set the signing region. Defaults to `us-east-1`.
    pub fn with_region(self, region: impl Into<String>) -> Self {
        self.map(|c| c.with_region(region))
    }

    /// Set the endpoint base URL, e.g. `http://127.0.0.1:9000`. Defaults to
    /// the regional AWS endpoint `https://s3.{region}.amazonaws.com`.
    pub fn with_endpoint(self, endpoint: impl Into<String>) -> Self {
        self.map(|c| c.with_endpoint(endpoint))
    }

    /// Set static credentials.
    pub fn with_credentials(
        self,
        access_key_id: impl Into<String>,
        secret_access_key: impl Into<String>,
    ) -> Self {
        self.map(|c| c.with_credentials(access_key_id, secret_access_key))
    }

    /// Set an STS session token to accompany the static credentials.
    pub fn with_session_token(self, token: impl Into<String>) -> Self {
        self.map(|c| c.with_session_token(token))
    }

    /// Address the bucket as `{bucket}.{endpoint-host}` instead of
    /// `{endpoint}/{bucket}`. Defaults to path style, which every
    /// S3-compatible service supports.
    pub fn with_virtual_hosted_style_request(self, enabled: bool) -> Self {
        self.map(|c| c.with_virtual_hosted_style_request(enabled))
    }

    /// Permit plain-HTTP endpoints. Defaults to off, so TLS is required
    /// unless this is set.
    pub fn with_allow_http(self, allow: bool) -> Self {
        self.map(|c| c.with_allow_http(allow))
    }

    /// Whether request signatures cover the body's SHA-256. See
    /// [`ClientBuilder::with_payload_signing`].
    pub fn with_payload_signing(self, sign: bool) -> Self {
        self.map(|c| c.with_payload_signing(sign))
    }

    /// Send unsigned (anonymous) requests instead of requiring credentials.
    pub fn with_skip_signature(self, skip: bool) -> Self {
        self.map(|c| c.with_skip_signature(skip))
    }

    /// Total per-request timeout, covering the response body. `None`
    /// disables the timeout. Defaults to 300 seconds.
    pub fn with_timeout(self, timeout: Option<Duration>) -> Self {
        self.map(|c| c.with_timeout(timeout))
    }

    /// TCP connect timeout. Defaults to 5 seconds.
    pub fn with_connect_timeout(self, timeout: Duration) -> Self {
        self.map(|c| c.with_connect_timeout(timeout))
    }

    /// Maximum request attempts (first try plus retries) for transient
    /// failures. Defaults to 3.
    pub fn with_max_attempts(self, attempts: usize) -> Self {
        self.map(|c| c.with_max_attempts(attempts))
    }

    /// Validate the configuration and construct the store.
    pub fn build(self) -> Result<S3Store> {
        let client = self
            .client
            .with_user_agent("depot-s3-store")
            .build()
            .map_err(|e| map_error("", e))?;
        Ok(S3Store::from_client(client))
    }
}
