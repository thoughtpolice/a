// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Builder-style configuration for [`S3Store`](crate::S3Store).

use std::time::Duration;

use crate::S3Store;
use crate::client::{S3Client, S3Config, STORE};
use crate::sigv4::Credentials;

type Result<T, E = object_store::Error> = std::result::Result<T, E>;

fn config_error(message: impl Into<String>) -> object_store::Error {
    object_store::Error::Generic {
        store: STORE,
        source: message.into().into(),
    }
}

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
    bucket: Option<String>,
    region: Option<String>,
    endpoint: Option<String>,
    access_key_id: Option<String>,
    secret_access_key: Option<String>,
    session_token: Option<String>,
    virtual_hosted_style: bool,
    allow_http: bool,
    skip_signature: bool,
    timeout: Option<Duration>,
    connect_timeout: Option<Duration>,
    max_attempts: Option<usize>,
}

impl S3StoreBuilder {
    /// An empty builder. The bucket is the only mandatory field, but without
    /// credentials only [`with_skip_signature`](Self::with_skip_signature)
    /// requests are possible.
    pub fn new() -> Self {
        Self::default()
    }

    /// A builder pre-populated from the standard `AWS_*` environment
    /// variables:
    ///
    /// | Variable | Field |
    /// |----------|-------|
    /// | `AWS_ACCESS_KEY_ID` | access key ID |
    /// | `AWS_SECRET_ACCESS_KEY` | secret access key |
    /// | `AWS_SESSION_TOKEN` | session token |
    /// | `AWS_REGION` / `AWS_DEFAULT_REGION` | region |
    /// | `AWS_ENDPOINT_URL_S3` / `AWS_ENDPOINT_URL` / `AWS_ENDPOINT` | endpoint |
    /// | `AWS_ALLOW_HTTP` | allow `http://` endpoints |
    /// | `AWS_VIRTUAL_HOSTED_STYLE_REQUEST` | virtual-hosted addressing |
    pub fn from_env() -> Self {
        let env = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
        let env_bool = |name: &str| {
            env(name).is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true"))
        };
        Self {
            access_key_id: env("AWS_ACCESS_KEY_ID"),
            secret_access_key: env("AWS_SECRET_ACCESS_KEY"),
            session_token: env("AWS_SESSION_TOKEN"),
            region: env("AWS_REGION").or_else(|| env("AWS_DEFAULT_REGION")),
            endpoint: env("AWS_ENDPOINT_URL_S3")
                .or_else(|| env("AWS_ENDPOINT_URL"))
                .or_else(|| env("AWS_ENDPOINT")),
            allow_http: env_bool("AWS_ALLOW_HTTP"),
            virtual_hosted_style: env_bool("AWS_VIRTUAL_HOSTED_STYLE_REQUEST"),
            ..Self::default()
        }
    }

    /// Set the bucket name (required).
    pub fn with_bucket(mut self, bucket: impl Into<String>) -> Self {
        self.bucket = Some(bucket.into());
        self
    }

    /// Set the signing region. Defaults to `us-east-1`.
    pub fn with_region(mut self, region: impl Into<String>) -> Self {
        self.region = Some(region.into());
        self
    }

    /// Set the endpoint base URL, e.g. `http://127.0.0.1:9000`. Defaults to
    /// the regional AWS endpoint `https://s3.{region}.amazonaws.com`.
    pub fn with_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.endpoint = Some(endpoint.into());
        self
    }

    /// Set static credentials.
    pub fn with_credentials(
        mut self,
        access_key_id: impl Into<String>,
        secret_access_key: impl Into<String>,
    ) -> Self {
        self.access_key_id = Some(access_key_id.into());
        self.secret_access_key = Some(secret_access_key.into());
        self
    }

    /// Set an STS session token to accompany the static credentials.
    pub fn with_session_token(mut self, token: impl Into<String>) -> Self {
        self.session_token = Some(token.into());
        self
    }

    /// Address the bucket as `{bucket}.{endpoint-host}` instead of
    /// `{endpoint}/{bucket}`. Defaults to path-style, which every
    /// S3-compatible service supports.
    pub fn with_virtual_hosted_style_request(mut self, enabled: bool) -> Self {
        self.virtual_hosted_style = enabled;
        self
    }

    /// Permit plain-HTTP endpoints. Defaults to off; TLS is required unless
    /// this is set.
    pub fn with_allow_http(mut self, allow: bool) -> Self {
        self.allow_http = allow;
        self
    }

    /// Send unsigned (anonymous) requests instead of requiring credentials.
    pub fn with_skip_signature(mut self, skip: bool) -> Self {
        self.skip_signature = skip;
        self
    }

    /// Total per-request timeout, covering the response body. `None`
    /// disables the timeout. Defaults to 300 seconds.
    pub fn with_timeout(mut self, timeout: Option<Duration>) -> Self {
        self.timeout = timeout;
        self
    }

    /// TCP connect timeout. Defaults to 5 seconds.
    pub fn with_connect_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = Some(timeout);
        self
    }

    /// Maximum request attempts (first try plus retries) for transient
    /// failures. Defaults to 3.
    pub fn with_max_attempts(mut self, attempts: usize) -> Self {
        self.max_attempts = Some(attempts.max(1));
        self
    }

    /// Validate the configuration and construct the store.
    pub fn build(self) -> Result<S3Store> {
        let bucket = self
            .bucket
            .filter(|b| !b.is_empty())
            .ok_or_else(|| config_error("no bucket name configured"))?;
        if bucket.contains('/') {
            return Err(config_error(format!("invalid bucket name {bucket:?}")));
        }

        let region = self.region.unwrap_or_else(|| "us-east-1".to_string());
        let endpoint = self
            .endpoint
            .unwrap_or_else(|| format!("https://s3.{region}.amazonaws.com"));
        let endpoint = endpoint.trim_end_matches('/').to_string();

        let parsed = reqwest::Url::parse(&endpoint)
            .map_err(|e| config_error(format!("invalid endpoint {endpoint:?}: {e}")))?;
        match parsed.scheme() {
            "https" => {}
            "http" if self.allow_http => {}
            "http" => {
                return Err(config_error(format!(
                    "endpoint {endpoint:?} uses HTTP but allow_http is not enabled",
                )));
            }
            other => {
                return Err(config_error(format!(
                    "endpoint {endpoint:?} has unsupported scheme {other:?}",
                )));
            }
        }

        let bucket_endpoint = if self.virtual_hosted_style {
            let host = parsed
                .host_str()
                .ok_or_else(|| config_error(format!("endpoint {endpoint:?} has no host")))?;
            match parsed.port() {
                Some(port) => format!("{}://{bucket}.{host}:{port}", parsed.scheme()),
                None => format!("{}://{bucket}.{host}", parsed.scheme()),
            }
        } else {
            format!("{endpoint}/{bucket}")
        };

        let credentials = if self.skip_signature {
            None
        } else {
            match (self.access_key_id, self.secret_access_key) {
                (Some(access_key_id), Some(secret_access_key)) => Some(Credentials {
                    access_key_id,
                    secret_access_key,
                    session_token: self.session_token,
                }),
                _ => {
                    return Err(config_error(
                        "no credentials configured: set AWS_ACCESS_KEY_ID and \
                         AWS_SECRET_ACCESS_KEY (or enable skip_signature)",
                    ));
                }
            }
        };

        // HTTP/1.1 only: S3 endpoints do not negotiate h2, and a stable
        // `host` header keeps SigV4 signing deterministic. Redirects are
        // disabled because a replayed request needs re-signing; surfacing
        // the 3xx is more debuggable than a mangled signature.
        let mut http = reqwest::Client::builder()
            .http1_only()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(self.connect_timeout.unwrap_or(Duration::from_secs(5)))
            .user_agent("depot-s3-store");
        if let Some(timeout) = self.timeout.or(Some(Duration::from_secs(300))) {
            http = http.timeout(timeout);
        }
        let http = http
            .build()
            .map_err(|e| config_error(format!("failed to build HTTP client: {e}")))?;

        let config = S3Config {
            bucket,
            region,
            bucket_endpoint,
            credentials,
            max_attempts: self.max_attempts.unwrap_or(3),
            retry_backoff: Duration::from_millis(100),
        };
        Ok(S3Store::from_client(S3Client::new(config, http)))
    }
}
