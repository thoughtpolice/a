// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! HTTP transport for the Git smart protocol.
//!
//! Provides low-level HTTP GET and POST helpers for the two Git smart HTTP
//! endpoints:
//!
//! - **GET** `<repo>/info/refs?service=git-upload-pack` -- ref discovery
//! - **POST** `<repo>/git-upload-pack` -- pack negotiation and download
//!
//! # Implementation
//!
//! Each request opens a fresh connection (no pooling) through
//! [`egress_http::send`], which refuses hosts that resolve to internal
//! addresses: repository URIs come from clients, and so do the redirects
//! their servers send.
//!
//! POST requests set `Content-Type: application/x-git-upload-pack-request`
//! as required by the smart HTTP protocol.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::{Buf as _, Bytes};
use dial9::Dial9TokioHandle;
use openssl::ssl::SslConnector;
use tokio::io::{AsyncRead, ReadBuf};

use crate::{GitFetchError, MAX_REF_ADVERTISEMENT_SIZE};

/// Asks a server for protocol v2. Servers without it ignore the header and
/// answer in v0.
const GIT_PROTOCOL_V2: (&str, &str) = ("git-protocol", "version=2");

// ---------------------------------------------------------------------------------------------------------------
// URI parsing
// ---------------------------------------------------------------------------------------------------------------

/// Parsed components of a Git HTTP URI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedUri {
    pub scheme: String,
    pub host: String,
    pub port: u16,
    /// Base path, e.g. `/user/repo.git`
    pub base_path: String,
}

impl ParsedUri {
    /// Where a request for `suffix` below the repository base goes.
    fn target(&self, suffix: &str) -> egress_http::Target {
        egress_http::Target {
            scheme: if self.scheme == "https" {
                "https"
            } else {
                "http"
            },
            host: self.host.clone(),
            port: self.port,
            path_and_query: format!("{}{suffix}", self.base_path),
        }
    }
}

/// Parse a Git repository URI into components.
pub(crate) fn parse_git_uri(uri: &str) -> Result<ParsedUri, GitFetchError> {
    let parsed: hyper::Uri = uri
        .parse()
        .map_err(|e| GitFetchError::InvalidUri(format!("{e}")))?;

    let scheme = parsed
        .scheme_str()
        .ok_or_else(|| GitFetchError::InvalidUri("missing scheme".into()))?
        .to_string();

    if scheme != "http" && scheme != "https" {
        return Err(GitFetchError::InvalidUri(format!(
            "unsupported scheme: {scheme}"
        )));
    }

    let host = parsed
        .host()
        .ok_or_else(|| GitFetchError::InvalidUri("missing host".into()))?
        .to_string();

    let port = parsed.port_u16().unwrap_or(match scheme.as_str() {
        "https" => 443,
        _ => 80,
    });

    let base_path = parsed.path().to_string();

    Ok(ParsedUri {
        scheme,
        host,
        port,
        base_path,
    })
}

// ---------------------------------------------------------------------------------------------------------------
// SSL
// ---------------------------------------------------------------------------------------------------------------

/// Build a default `SslConnector` using OpenSSL with system root certificates.
pub use egress_http::ssl_connector as build_ssl_connector;

// ---------------------------------------------------------------------------------------------------------------
// Content-Type validation
// ---------------------------------------------------------------------------------------------------------------

/// Content-Type of a smart HTTP ref advertisement response.
pub const UPLOAD_PACK_ADVERTISEMENT_TYPE: &str = "application/x-git-upload-pack-advertisement";

/// Content-Type of a smart HTTP upload-pack (fetch) response.
pub const UPLOAD_PACK_RESULT_TYPE: &str = "application/x-git-upload-pack-result";

/// Content-Type of a smart HTTP upload-pack request.
const UPLOAD_PACK_REQUEST_TYPE: &str = "application/x-git-upload-pack-request";

/// Path below the repository base of the upload-pack endpoint.
const UPLOAD_PACK_SUFFIX: &str = "/git-upload-pack";

/// Validate a response `Content-Type` against the expected smart-HTTP media
/// type.
///
/// Anything else (an HTML error page, a dumb-HTTP server ignoring the
/// `?service=` parameter) means the endpoint is not speaking the smart
/// protocol; failing here gives a clear error instead of a baffling
/// pkt-line parse failure downstream.
fn check_content_type(headers: &hyper::HeaderMap, expected: &str) -> Result<(), GitFetchError> {
    let got = headers
        .get(hyper::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let media_type = got.split(';').next().unwrap_or("").trim();
    if media_type.eq_ignore_ascii_case(expected) {
        return Ok(());
    }
    let shown = if got.is_empty() { "<missing>" } else { got };
    Err(GitFetchError::RequestFailed(format!(
        "expected content-type {expected}, got {shown} \
         (server does not appear to support the git smart HTTP protocol)"
    )))
}

// ---------------------------------------------------------------------------------------------------------------
// Ref discovery GET (with single-hop redirect handling)
// ---------------------------------------------------------------------------------------------------------------

/// Path + query appended to the repository base path for ref discovery.
const REFS_SUFFIX: &str = "/info/refs?service=git-upload-pack";

fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

/// Rebase a repository URL from a ref-discovery redirect `Location`.
///
/// The location must end with the `/info/refs` path we requested (mirroring
/// git's own check), so stripping it recovers the redirected repository base
/// — e.g. GitHub redirecting `/user/repo/info/refs?…` to
/// `/user/repo.git/info/refs?…` yields the `/user/repo.git` base.
pub(crate) fn rewrite_redirect_base(
    original: &ParsedUri,
    location: &str,
    path_suffix: &str,
) -> Result<ParsedUri, GitFetchError> {
    // The suffix we append includes the query string; matching happens on
    // the path alone since servers may or may not echo the query back.
    let suffix_path = path_suffix.split('?').next().unwrap_or(path_suffix);

    let mut target = if location.starts_with('/') {
        // Path-only redirect on the same scheme/host/port.
        ParsedUri {
            base_path: location.split('?').next().unwrap_or(location).to_string(),
            ..original.clone()
        }
    } else {
        parse_git_uri(location).map_err(|e| {
            GitFetchError::RequestFailed(format!("bad redirect location {location:?}: {e}"))
        })?
    };

    match target.base_path.strip_suffix(suffix_path) {
        Some(base) => {
            target.base_path = base.to_string();
            Ok(target)
        }
        None => Err(GitFetchError::RequestFailed(format!(
            "redirect location {location:?} does not end with {suffix_path:?}"
        ))),
    }
}

async fn send_refs_request(
    ssl_connector: &SslConnector,
    uri: &ParsedUri,
    handle: &Dial9TokioHandle,
) -> Result<hyper::Response<hyper::body::Incoming>, GitFetchError> {
    let req = hyper::Request::builder()
        .header(hyper::header::USER_AGENT, "cache-server/git-fetch")
        .header(hyper::header::ACCEPT, "*/*")
        .header(GIT_PROTOCOL_V2.0, GIT_PROTOCOL_V2.1)
        .body(http_body_util::Empty::<Bytes>::new())
        .map_err(|e| GitFetchError::RequestFailed(format!("build GET request: {e}")))?;

    send(ssl_connector, &uri.target(REFS_SUFFIX), req, handle).await
}

/// Fetch the ref advertisement for a repository, following at most one
/// redirect (git's `http.followRedirects=initial` behavior).
///
/// Returns the advertisement bytes plus the rebased repository URL when a
/// redirect was followed — the caller must aim the subsequent
/// `git-upload-pack` POST at that URL.
pub(crate) async fn discover_refs(
    ssl_connector: &SslConnector,
    uri: &ParsedUri,
    handle: &Dial9TokioHandle,
) -> Result<(Bytes, Option<ParsedUri>), GitFetchError> {
    let resp = send_refs_request(ssl_connector, uri, handle).await?;

    let status = resp.status().as_u16();
    if !is_redirect(status) {
        let resp = ensure_success(resp)?;
        check_content_type(resp.headers(), UPLOAD_PACK_ADVERTISEMENT_TYPE)?;
        return Ok((collect_response_body(resp).await?, None));
    }

    let location = resp
        .headers()
        .get(hyper::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            GitFetchError::HttpStatus(status, "redirect without Location header".into())
        })?;
    let new_uri = rewrite_redirect_base(uri, location, REFS_SUFFIX)?;
    tracing::info!(
        from = %format!("{}://{}{}", uri.scheme, uri.host, uri.base_path),
        to = %format!("{}://{}{}", new_uri.scheme, new_uri.host, new_uri.base_path),
        "following git ref discovery redirect",
    );

    let resp = send_refs_request(ssl_connector, &new_uri, handle).await?;
    let status = resp.status().as_u16();
    if is_redirect(status) {
        return Err(GitFetchError::HttpStatus(
            status,
            format!("redirected more than once (first to {location}); use the canonical URL"),
        ));
    }
    let resp = ensure_success(resp)?;
    check_content_type(resp.headers(), UPLOAD_PACK_ADVERTISEMENT_TYPE)?;
    Ok((collect_response_body(resp).await?, Some(new_uri)))
}

// ---------------------------------------------------------------------------------------------------------------
// Body → AsyncRead adapter
// ---------------------------------------------------------------------------------------------------------------

/// Adapts a [`hyper::body::Body`] into [`AsyncRead`].
///
/// Serves each data frame straight from hyper's buffer, and refuses a body
/// longer than `max_bytes` with [`GitFetchError::TooLarge`] (carried in the
/// [`io::Error`]).
pub(crate) struct BodyReader<B> {
    body: B,
    buf: Bytes,
    bytes_read: usize,
    max_bytes: usize,
    done: bool,
}

impl<B> BodyReader<B> {
    pub fn new(body: B, max_bytes: usize) -> Self {
        Self {
            body,
            buf: Bytes::new(),
            bytes_read: 0,
            max_bytes,
            done: false,
        }
    }
}

impl<B> AsyncRead for BodyReader<B>
where
    B: hyper::body::Body<Data = Bytes> + Unpin,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();

        loop {
            // Drain buffered data first.
            if !this.buf.is_empty() {
                let n = this.buf.len().min(buf.remaining());
                buf.put_slice(&this.buf[..n]);
                this.buf.advance(n);
                return Poll::Ready(Ok(()));
            }

            if this.done {
                return Poll::Ready(Ok(()));
            }

            // Poll the body for the next frame.
            match Pin::new(&mut this.body).poll_frame(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(None) => {
                    this.done = true;
                    return Poll::Ready(Ok(()));
                }
                Poll::Ready(Some(Err(e))) => {
                    this.done = true;
                    return Poll::Ready(Err(io::Error::other(format!(
                        "read HTTP body: {}",
                        e.into()
                    ))));
                }
                Poll::Ready(Some(Ok(frame))) => {
                    if let Ok(data) = frame.into_data() {
                        this.bytes_read += data.len();
                        if this.bytes_read > this.max_bytes {
                            this.done = true;
                            return Poll::Ready(Err(io::Error::other(GitFetchError::TooLarge {
                                what: "response size",
                                size: this.bytes_read,
                                limit: this.max_bytes,
                            })));
                        }
                        this.buf = data;
                    }
                    // Non-data frames (trailers) are ignored; loop to try again.
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Shared connection + request helpers
// ---------------------------------------------------------------------------------------------------------------

impl From<egress_http::Error> for GitFetchError {
    fn from(e: egress_http::Error) -> Self {
        match e {
            egress_http::Error::Connect(egress::ConnectError::Blocked { .. }) => {
                Self::BlockedAddress(e.to_string())
            }
            egress_http::Error::TooLarge { size, limit } => Self::TooLarge {
                what: "response size",
                size,
                limit,
            },
            _ => Self::RequestFailed(e.to_string()),
        }
    }
}

/// Send `req` to `target`, returning the response with its body streaming.
async fn send<B>(
    ssl_connector: &SslConnector,
    target: &egress_http::Target,
    req: hyper::Request<B>,
    handle: &Dial9TokioHandle,
) -> Result<hyper::Response<hyper::body::Incoming>, GitFetchError>
where
    B: hyper::body::Body<Data = Bytes, Error: Into<Box<dyn std::error::Error + Send + Sync>>>
        + Send
        + 'static,
{
    Ok(egress_http::send(ssl_connector, target, req, |connection| {
        handle.spawn(connection);
    })
    .await?)
}

/// Reject non-2xx responses. Redirect statuses name their target, since
/// only the initial ref-discovery GET ever follows one.
fn ensure_success(
    resp: hyper::Response<hyper::body::Incoming>,
) -> Result<hyper::Response<hyper::body::Incoming>, GitFetchError> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let mut reason = status.canonical_reason().unwrap_or("unknown").to_string();
    if let Some(loc) = resp
        .headers()
        .get(hyper::header::LOCATION)
        .and_then(|v| v.to_str().ok())
    {
        reason = format!("{reason} (redirects to {loc})");
    }
    Err(GitFetchError::HttpStatus(status.as_u16(), reason))
}

/// Collect a ref advertisement or `ls-refs` response, refusing more than
/// [`MAX_REF_ADVERTISEMENT_SIZE`] bytes.
async fn collect_response_body(
    resp: hyper::Response<hyper::body::Incoming>,
) -> Result<Bytes, GitFetchError> {
    Ok(egress_http::collect_capped(resp, MAX_REF_ADVERTISEMENT_SIZE).await?)
}

// ---------------------------------------------------------------------------------------------------------------
// Streaming POST
// ---------------------------------------------------------------------------------------------------------------

/// Perform a streaming upload-pack POST against a Git endpoint.
///
/// Returns a [`BodyReader`] wrapping the response body for incremental
/// reading, so the pack download path never buffers the entire response in
/// memory. `max_response_bytes` bounds the total body size delivered through
/// the reader. The response `Content-Type` must be
/// [`UPLOAD_PACK_RESULT_TYPE`].
pub(crate) async fn git_post_streaming(
    ssl_connector: &SslConnector,
    uri: &ParsedUri,
    body: Vec<u8>,
    protocol_v2: bool,
    max_response_bytes: usize,
    handle: &Dial9TokioHandle,
) -> Result<BodyReader<hyper::body::Incoming>, GitFetchError> {
    let resp = post_upload_pack(ssl_connector, uri, body, protocol_v2, handle).await?;
    Ok(BodyReader::new(resp.into_body(), max_response_bytes))
}

/// An upload-pack POST whose whole (small) response is wanted, such as a
/// protocol v2 `ls-refs`.
pub(crate) async fn git_post(
    ssl_connector: &SslConnector,
    uri: &ParsedUri,
    body: Vec<u8>,
    protocol_v2: bool,
    handle: &Dial9TokioHandle,
) -> Result<Bytes, GitFetchError> {
    let resp = post_upload_pack(ssl_connector, uri, body, protocol_v2, handle).await?;
    collect_response_body(resp).await
}

async fn post_upload_pack(
    ssl_connector: &SslConnector,
    uri: &ParsedUri,
    body: Vec<u8>,
    protocol_v2: bool,
    handle: &Dial9TokioHandle,
) -> Result<hyper::Response<hyper::body::Incoming>, GitFetchError> {
    let mut req = hyper::Request::builder()
        .method(hyper::Method::POST)
        .header(hyper::header::USER_AGENT, "cache-server/git-fetch")
        .header(hyper::header::CONTENT_TYPE, UPLOAD_PACK_REQUEST_TYPE)
        .header(hyper::header::ACCEPT, UPLOAD_PACK_RESULT_TYPE);
    if protocol_v2 {
        req = req.header(GIT_PROTOCOL_V2.0, GIT_PROTOCOL_V2.1);
    }
    let req = req
        .body(http_body_util::Full::new(Bytes::from(body)))
        .map_err(|e| GitFetchError::RequestFailed(format!("build POST request: {e}")))?;

    let resp = send(ssl_connector, &uri.target(UPLOAD_PACK_SUFFIX), req, handle).await?;
    let resp = ensure_success(resp)?;
    check_content_type(resp.headers(), UPLOAD_PACK_RESULT_TYPE)?;
    Ok(resp)
}

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use hyper_util::rt::TokioIo;

    use super::*;

    fn headers_with_ct(value: &str) -> hyper::HeaderMap {
        let mut h = hyper::HeaderMap::new();
        h.insert(hyper::header::CONTENT_TYPE, value.parse().unwrap());
        h
    }

    #[test]
    fn content_type_exact_match() {
        let h = headers_with_ct("application/x-git-upload-pack-advertisement");
        assert!(check_content_type(&h, UPLOAD_PACK_ADVERTISEMENT_TYPE).is_ok());
    }

    #[test]
    fn content_type_with_parameters() {
        let h = headers_with_ct("application/x-git-upload-pack-result; charset=utf-8");
        assert!(check_content_type(&h, UPLOAD_PACK_RESULT_TYPE).is_ok());
    }

    #[test]
    fn content_type_case_insensitive() {
        let h = headers_with_ct("Application/X-Git-Upload-Pack-Result");
        assert!(check_content_type(&h, UPLOAD_PACK_RESULT_TYPE).is_ok());
    }

    #[test]
    fn content_type_mismatch_errors() {
        // A dumb-HTTP server (or an HTML error page) must produce a clear
        // protocol error, not a pkt-line parse failure later.
        let h = headers_with_ct("text/html; charset=utf-8");
        let err = check_content_type(&h, UPLOAD_PACK_ADVERTISEMENT_TYPE).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("text/html"), "{msg}");
        assert!(msg.contains("smart HTTP"), "{msg}");
    }

    #[test]
    fn content_type_missing_errors() {
        let h = hyper::HeaderMap::new();
        let err = check_content_type(&h, UPLOAD_PACK_RESULT_TYPE).unwrap_err();
        assert!(format!("{err}").contains("<missing>"), "{err}");
    }

    // --- rewrite_redirect_base ---

    fn original_uri() -> ParsedUri {
        ParsedUri {
            scheme: "https".into(),
            host: "github.com".into(),
            port: 443,
            base_path: "/git/git".into(),
        }
    }

    #[test]
    fn redirect_absolute_url_with_query() {
        // The GitHub case: /user/repo redirected to /user/repo.git.
        let new = rewrite_redirect_base(
            &original_uri(),
            "https://github.com/git/git.git/info/refs?service=git-upload-pack",
            REFS_SUFFIX,
        )
        .unwrap();
        assert_eq!(new.scheme, "https");
        assert_eq!(new.host, "github.com");
        assert_eq!(new.port, 443);
        assert_eq!(new.base_path, "/git/git.git");
    }

    #[test]
    fn redirect_absolute_url_without_query() {
        let new = rewrite_redirect_base(
            &original_uri(),
            "https://github.com/git/git.git/info/refs",
            REFS_SUFFIX,
        )
        .unwrap();
        assert_eq!(new.base_path, "/git/git.git");
    }

    #[test]
    fn redirect_cross_host() {
        let new = rewrite_redirect_base(
            &original_uri(),
            "https://mirror.example.com:8443/git.git/info/refs?service=git-upload-pack",
            REFS_SUFFIX,
        )
        .unwrap();
        assert_eq!(new.host, "mirror.example.com");
        assert_eq!(new.port, 8443);
        assert_eq!(new.base_path, "/git.git");
    }

    #[test]
    fn redirect_path_only_keeps_host() {
        let orig = ParsedUri {
            scheme: "http".into(),
            host: "localhost".into(),
            port: 8080,
            base_path: "/repo".into(),
        };
        let new = rewrite_redirect_base(
            &orig,
            "/repo.git/info/refs?service=git-upload-pack",
            REFS_SUFFIX,
        )
        .unwrap();
        assert_eq!(new.scheme, "http");
        assert_eq!(new.host, "localhost");
        assert_eq!(new.port, 8080);
        assert_eq!(new.base_path, "/repo.git");
    }

    #[test]
    fn redirect_without_expected_suffix_errors() {
        // A redirect to an arbitrary page must not be used as a repo base.
        let err = rewrite_redirect_base(
            &original_uri(),
            "https://github.com/login?return_to=/git/git",
            REFS_SUFFIX,
        )
        .unwrap_err();
        assert!(format!("{err}").contains("does not end with"), "{err}");
    }

    #[test]
    fn redirect_non_http_scheme_errors() {
        let err = rewrite_redirect_base(
            &original_uri(),
            "ssh://git@github.com/git/git.git/info/refs",
            REFS_SUFFIX,
        )
        .unwrap_err();
        assert!(format!("{err}").contains("bad redirect location"), "{err}");
    }

    // --- parse_git_uri ---

    #[test]
    fn parse_uri_https_default_port() {
        let u = parse_git_uri("https://github.com/user/repo.git").unwrap();
        assert_eq!(u.scheme, "https");
        assert_eq!(u.host, "github.com");
        assert_eq!(u.port, 443);
        assert_eq!(u.base_path, "/user/repo.git");
    }

    #[test]
    fn parse_uri_http_explicit_port() {
        let u = parse_git_uri("http://localhost:8080/repo.git").unwrap();
        assert_eq!(u.scheme, "http");
        assert_eq!(u.port, 8080);
    }

    #[test]
    fn parse_uri_rejects_other_schemes() {
        assert!(parse_git_uri("ssh://git@github.com/user/repo.git").is_err());
        assert!(parse_git_uri("file:///tmp/repo").is_err());
        assert!(parse_git_uri("not a uri at all").is_err());
    }

    /// Serve every connection on a loopback port with `respond`, which sees
    /// the request's `Host` header.
    async fn serve_loopback(
        respond: fn(&str) -> hyper::Response<http_body_util::Full<Bytes>>,
    ) -> u16 {
        egress::ALLOW_LOOPBACK_FOR_TESTS.store(true, std::sync::atomic::Ordering::Relaxed);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let service = hyper::service::service_fn(move |req: hyper::Request<_>| {
                    let host = req
                        .headers()
                        .get(hyper::header::HOST)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("<missing>")
                        .to_string();
                    async move { Ok::<_, std::convert::Infallible>(respond(&host)) }
                });
                tokio::spawn(
                    hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service),
                );
            }
        });
        port
    }

    async fn discover(uri: &str) -> Result<(Bytes, Option<ParsedUri>), GitFetchError> {
        let uri = parse_git_uri(uri).unwrap();
        discover_refs(
            &build_ssl_connector(),
            &uri,
            &dial9::Dial9TokioHandle::disabled(),
        )
        .await
    }

    #[tokio::test]
    async fn internal_addresses_are_refused() {
        // Loopback is covered by egress itself; other tests here open it.
        for uri in [
            "http://169.254.169.254/latest.git",
            "http://10.0.0.5:6379/x.git",
        ] {
            let err = discover(uri).await.unwrap_err();
            assert!(
                matches!(err, GitFetchError::BlockedAddress(_)),
                "{uri}: {err}"
            );
        }
    }

    #[tokio::test]
    async fn redirects_to_internal_addresses_are_refused() {
        let port = serve_loopback(|_| {
            hyper::Response::builder()
                .status(302)
                .header(
                    hyper::header::LOCATION,
                    "http://10.0.0.5:6379/repo.git/info/refs?service=git-upload-pack",
                )
                .body(http_body_util::Full::new(Bytes::new()))
                .unwrap()
        })
        .await;
        let err = discover(&format!("http://127.0.0.1:{port}/repo.git"))
            .await
            .unwrap_err();
        assert!(matches!(err, GitFetchError::BlockedAddress(_)), "{err}");
    }

    #[tokio::test]
    async fn host_header_carries_a_non_default_port() {
        let port = serve_loopback(|host| {
            hyper::Response::builder()
                .header(hyper::header::CONTENT_TYPE, UPLOAD_PACK_ADVERTISEMENT_TYPE)
                .body(http_body_util::Full::new(Bytes::from(host.to_string())))
                .unwrap()
        })
        .await;
        let (body, _) = discover(&format!("http://127.0.0.1:{port}/repo.git"))
            .await
            .unwrap();
        assert_eq!(body, format!("127.0.0.1:{port}").as_bytes());
    }
}
