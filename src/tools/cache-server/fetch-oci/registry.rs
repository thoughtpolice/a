// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Thin HTTP client for OCI registry v2 GET requests, built on `fetch-http`'s
//! SSRF-guarded connection primitives.
//!
//! Unlike `fetch_http::fetch_http_blob`, this client:
//!
//! - sets custom `Accept` and optional `Authorization` headers per request,
//! - lets callers inspect the raw status + headers (for 401 challenges),
//! - enforces its own body-size cap, and
//! - **strips `Authorization` on cross-host redirects** (the Docker-client
//!   convention for blob URLs that 307 to an S3/CloudFront backend).

use std::pin::Pin;

use bytes::Bytes;
use dial9::Dial9TokioHandle;
use fetch_http::{HttpFetchError, resolve_and_validate, send_request};
use http_body_util::{BodyExt as _, Empty, LengthLimitError, Limited};
use hyper::header::HeaderValue;
use hyper::{HeaderMap, Request, StatusCode};
use hyper_util::rt::TokioIo;
use openssl::ssl::SslConnector;
use tokio_openssl::SslStream;

use crate::OciFetchError;

const MAX_REDIRECTS: u32 = 10;
const USER_AGENT: &str = "cache-server/fetch-oci";

/// HTTP client for an OCI registry session. Holds the SSL configuration, a
/// telemetry handle, optional bearer token, and the per-response size cap.
pub struct RegistryClient<'a> {
    ssl_connector: &'a SslConnector,
    handle: &'a Dial9TokioHandle,
    token: Option<String>,
    blob_size_limit: usize,
}

impl<'a> RegistryClient<'a> {
    pub fn new(
        ssl_connector: &'a SslConnector,
        handle: &'a Dial9TokioHandle,
        blob_size_limit: usize,
    ) -> Self {
        Self {
            ssl_connector,
            handle,
            token: None,
            blob_size_limit,
        }
    }

    pub fn has_token(&self) -> bool {
        self.token.is_some()
    }

    pub fn set_token(&mut self, token: String) {
        self.token = Some(token);
    }
}

/// A fully-received HTTP response.
pub struct RegistryResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl RegistryClient<'_> {
    /// Perform a GET, following redirects (stripping `Authorization` on
    /// cross-host hops), capping the body at `self.blob_size_limit`.
    ///
    /// The current `self.token`, if any, is sent as `Authorization: Bearer …`
    /// on the initial request and every same-host redirect.
    pub async fn get(&self, url: &str, accept: &str) -> Result<RegistryResponse, OciFetchError> {
        self.get_with_auth(url, accept, self.token.as_deref()).await
    }

    /// Like `get`, but lets the caller override the `Authorization` header.
    /// Used by the auth flow to send unauthenticated requests.
    pub async fn get_with_auth(
        &self,
        url: &str,
        accept: &str,
        auth: Option<&str>,
    ) -> Result<RegistryResponse, OciFetchError> {
        let mut current_url = url.to_string();
        let original_parts = parse_url(&current_url)?;
        let original_host = original_parts.host.clone();
        let mut current_auth = auth.map(String::from);
        let mut current_parts = original_parts;

        for _ in 0..MAX_REDIRECTS {
            let resp = self
                .single_get(&current_parts, accept, current_auth.as_deref())
                .await?;

            if resp.status.is_redirection() {
                let location = resp
                    .headers
                    .get(hyper::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| {
                        OciFetchError::Http(HttpFetchError::RequestFailed(format!(
                            "HTTP {}: redirect without Location header",
                            resp.status.as_u16(),
                        )))
                    })?;
                let next_url = resolve_redirect(&current_parts, location)?;
                if current_parts.scheme == "https" && !next_url.starts_with("https://") {
                    return Err(OciFetchError::Http(HttpFetchError::RequestFailed(
                        "redirect would downgrade from HTTPS to HTTP".to_string(),
                    )));
                }
                let next_parts = parse_url(&next_url)?;
                let cross_host = next_parts.host != original_host;
                if cross_host && current_auth.is_some() {
                    current_auth = None;
                }
                tracing::debug!(
                    from = %current_url,
                    to = %next_url,
                    cross_host,
                    "following OCI redirect"
                );
                current_url = next_url;
                current_parts = next_parts;
                continue;
            }

            return Ok(resp);
        }

        Err(OciFetchError::Http(HttpFetchError::RequestFailed(format!(
            "too many redirects (max {MAX_REDIRECTS})"
        ))))
    }

    async fn single_get(
        &self,
        parts: &UrlParts,
        accept: &str,
        auth: Option<&str>,
    ) -> Result<RegistryResponse, OciFetchError> {
        let tcp = resolve_and_validate(&parts.host, parts.port)
            .await
            .map_err(OciFetchError::Http)?;
        tcp.set_nodelay(true).map_err(|e| {
            OciFetchError::Http(HttpFetchError::RequestFailed(format!("set nodelay: {e}")))
        })?;

        let mut builder = Request::get(parts.path_and_query.as_str())
            .header(hyper::header::HOST, &parts.host)
            .header(hyper::header::USER_AGENT, USER_AGENT)
            .header(hyper::header::ACCEPT, accept);
        if let Some(tok) = auth {
            builder = builder.header(
                hyper::header::AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {tok}")).map_err(|e| {
                    OciFetchError::Http(HttpFetchError::RequestFailed(format!(
                        "invalid bearer token: {e}"
                    )))
                })?,
            );
        }
        let req = builder.body(Empty::<Bytes>::new()).map_err(|e| {
            OciFetchError::Http(HttpFetchError::RequestFailed(format!("build request: {e}")))
        })?;

        let resp = if parts.scheme == "https" {
            let ssl_config = self
                .ssl_connector
                .configure()
                .map_err(|e| {
                    OciFetchError::Http(HttpFetchError::RequestFailed(format!(
                        "SSL configure: {e}"
                    )))
                })?
                .into_ssl(&parts.host)
                .map_err(|e| {
                    OciFetchError::Http(HttpFetchError::RequestFailed(format!("SSL init: {e}")))
                })?;
            let mut tls_stream = SslStream::new(ssl_config, tcp).map_err(|e| {
                OciFetchError::Http(HttpFetchError::RequestFailed(format!("SSL stream: {e}")))
            })?;
            Pin::new(&mut tls_stream).connect().await.map_err(|e| {
                OciFetchError::Http(HttpFetchError::RequestFailed(format!(
                    "TLS handshake with {}: {e}",
                    parts.host
                )))
            })?;
            let io = TokioIo::new(tls_stream);
            send_request(io, req, self.handle)
                .await
                .map_err(OciFetchError::Http)?
        } else {
            let io = TokioIo::new(tcp);
            send_request(io, req, self.handle)
                .await
                .map_err(OciFetchError::Http)?
        };

        let status = resp.status();
        let headers = resp.headers().clone();

        // Content-Length pre-check mirrors fetch-http; returns the OCI-sized
        // TooLarge so the caller sees a consistent error shape.
        if let Some(cl) = headers.get(hyper::header::CONTENT_LENGTH) {
            if let Ok(s) = cl.to_str() {
                if let Ok(len) = s.parse::<usize>() {
                    if len > self.blob_size_limit {
                        return Err(OciFetchError::Http(HttpFetchError::TooLarge(len)));
                    }
                }
            }
        }

        let body = Limited::new(resp.into_body(), self.blob_size_limit)
            .collect()
            .await
            .map_err(|e| {
                if e.downcast_ref::<LengthLimitError>().is_some() {
                    OciFetchError::Http(HttpFetchError::TooLarge(self.blob_size_limit))
                } else {
                    OciFetchError::Http(HttpFetchError::RequestFailed(format!("read body: {e}")))
                }
            })?
            .to_bytes();

        Ok(RegistryResponse {
            status,
            headers,
            body,
        })
    }
}

/// Parsed URL components used by the single-GET path.
#[derive(Debug)]
struct UrlParts {
    scheme: &'static str,
    host: String,
    port: u16,
    path_and_query: String,
}

fn parse_url(url: &str) -> Result<UrlParts, OciFetchError> {
    let parsed: hyper::Uri = url
        .parse()
        .map_err(|e| OciFetchError::InvalidUri(format!("parse {url}: {e}")))?;
    let scheme: &'static str = match parsed.scheme_str() {
        Some("https") => "https",
        Some("http") => "http",
        Some(other) => {
            return Err(OciFetchError::InvalidUri(format!(
                "unsupported scheme {other}: {url}"
            )));
        }
        None => return Err(OciFetchError::InvalidUri(format!("missing scheme: {url}"))),
    };
    let host = parsed
        .host()
        .ok_or_else(|| OciFetchError::InvalidUri(format!("missing host: {url}")))?
        .to_string();
    let port = parsed.port_u16().unwrap_or(match scheme {
        "https" => 443,
        _ => 80,
    });
    let path_and_query = parsed
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    Ok(UrlParts {
        scheme,
        host,
        port,
        path_and_query,
    })
}

fn resolve_redirect(base: &UrlParts, location: &str) -> Result<String, OciFetchError> {
    if location.starts_with("http://") || location.starts_with("https://") {
        Ok(location.to_string())
    } else if let Some(path) = location.strip_prefix('/') {
        Ok(format!(
            "{}://{}:{}/{}",
            base.scheme, base.host, base.port, path
        ))
    } else {
        Err(OciFetchError::Http(HttpFetchError::RequestFailed(format!(
            "unsupported relative redirect: {location}"
        ))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_url_https_defaults_port() {
        let p = parse_url("https://ghcr.io/v2/foo/manifests/sha256:abc").unwrap();
        assert_eq!(p.scheme, "https");
        assert_eq!(p.host, "ghcr.io");
        assert_eq!(p.port, 443);
        assert_eq!(p.path_and_query, "/v2/foo/manifests/sha256:abc");
    }

    #[test]
    fn parse_url_http_explicit_port() {
        let p = parse_url("http://127.0.0.1:5000/v2/foo/manifests/sha256:abc").unwrap();
        assert_eq!(p.scheme, "http");
        assert_eq!(p.host, "127.0.0.1");
        assert_eq!(p.port, 5000);
        assert_eq!(p.path_and_query, "/v2/foo/manifests/sha256:abc");
    }

    #[test]
    fn parse_url_unsupported_scheme() {
        let err = parse_url("ftp://example.com/x").unwrap_err();
        assert!(matches!(err, OciFetchError::InvalidUri(_)));
    }

    #[test]
    fn resolve_absolute_redirect() {
        let base = parse_url("https://ghcr.io/v2/foo").unwrap();
        assert_eq!(
            resolve_redirect(&base, "https://cdn.example/blob?x=1").unwrap(),
            "https://cdn.example/blob?x=1"
        );
    }

    #[test]
    fn resolve_root_relative_redirect() {
        let base = parse_url("https://ghcr.io/v2/foo").unwrap();
        assert_eq!(
            resolve_redirect(&base, "/other/path").unwrap(),
            "https://ghcr.io:443/other/path"
        );
    }

    #[test]
    fn resolve_relative_rejected() {
        let base = parse_url("https://ghcr.io/v2/foo").unwrap();
        assert!(resolve_redirect(&base, "other").is_err());
    }
}
