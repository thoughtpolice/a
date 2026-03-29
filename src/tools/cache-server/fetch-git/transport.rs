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
//! Uses hyper for HTTP/1.1, openssl for TLS, and tokio for async I/O. Each
//! request opens a fresh TCP connection (no connection pooling). The pattern
//! mirrors the cache-server's `http_fetch` module.
//!
//! POST requests set `Content-Type: application/x-git-upload-pack-request`
//! as required by the smart HTTP protocol.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::{Buf as _, Bytes, BytesMut};
use dial9::Dial9TokioHandle;
use http_body_util::BodyExt as _;
use hyper_util::rt::TokioIo;
use openssl::ssl::{SslConnector, SslMethod};
use tokio::io::{AsyncRead, ReadBuf};
use tokio::net::TcpStream;
use tokio_openssl::SslStream;

use crate::{GitFetchError, MAX_CLONE_SIZE};

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
pub fn build_ssl_connector() -> SslConnector {
    SslConnector::builder(SslMethod::tls())
        .expect("failed to create SSL connector builder")
        .build()
}

// ---------------------------------------------------------------------------------------------------------------
// Content-Type validation
// ---------------------------------------------------------------------------------------------------------------

/// Content-Type of a smart HTTP ref advertisement response.
pub const UPLOAD_PACK_ADVERTISEMENT_TYPE: &str = "application/x-git-upload-pack-advertisement";

/// Content-Type of a smart HTTP upload-pack (fetch) response.
pub const UPLOAD_PACK_RESULT_TYPE: &str = "application/x-git-upload-pack-result";

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
    let full_path = format!("{}{}", uri.base_path, REFS_SUFFIX);

    let req = hyper::Request::get(&full_path)
        .header(hyper::header::HOST, &uri.host)
        .header(hyper::header::USER_AGENT, "cache-server/git-fetch")
        .header(hyper::header::ACCEPT, "*/*")
        .body(http_body_util::Empty::<Bytes>::new())
        .map_err(|e| GitFetchError::RequestFailed(format!("build GET request: {e}")))?;

    send_request_raw(ssl_connector, uri, req, handle).await
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
/// Polls the body for data frames and serves bytes to readers from an internal
/// buffer. Tracks total bytes read for [`MAX_CLONE_SIZE`] enforcement.
pub(crate) struct BodyReader<B> {
    body: B,
    buf: BytesMut,
    bytes_read: usize,
    max_bytes: usize,
    done: bool,
}

impl<B> BodyReader<B> {
    pub fn new(body: B, max_bytes: usize) -> Self {
        Self {
            body,
            buf: BytesMut::with_capacity(65536),
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
                            return Poll::Ready(Err(io::Error::other(format!(
                                "response too large: {} bytes exceeds {} byte limit",
                                this.bytes_read, this.max_bytes
                            ))));
                        }
                        this.buf.extend_from_slice(&data);
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

/// Establish an HTTP/1.1 connection and send a request, returning the raw
/// response (status, headers, streaming body). Shared between the buffered
/// and streaming POST paths.
async fn send_request_raw<B>(
    ssl_connector: &SslConnector,
    uri: &ParsedUri,
    req: hyper::Request<B>,
    handle: &Dial9TokioHandle,
) -> Result<hyper::Response<hyper::body::Incoming>, GitFetchError>
where
    B: hyper::body::Body<Data = Bytes, Error: Into<Box<dyn std::error::Error + Send + Sync>>>
        + Send
        + 'static,
{
    // TCP connect
    let tcp = TcpStream::connect((&*uri.host, uri.port))
        .await
        .map_err(|e| {
            GitFetchError::RequestFailed(format!("TCP connect to {}:{}: {e}", uri.host, uri.port))
        })?;
    tcp.set_nodelay(true)
        .map_err(|e| GitFetchError::RequestFailed(format!("set nodelay: {e}")))?;

    if uri.scheme == "https" {
        let ssl_config = ssl_connector
            .configure()
            .map_err(|e| GitFetchError::RequestFailed(format!("SSL configure: {e}")))?
            .into_ssl(&uri.host)
            .map_err(|e| GitFetchError::RequestFailed(format!("SSL init: {e}")))?;
        let mut tls_stream = SslStream::new(ssl_config, tcp)
            .map_err(|e| GitFetchError::RequestFailed(format!("SSL stream: {e}")))?;
        Pin::new(&mut tls_stream).connect().await.map_err(|e| {
            GitFetchError::RequestFailed(format!("TLS handshake with {}: {e}", uri.host))
        })?;

        let io = TokioIo::new(tls_stream);
        do_send_request(io, req, handle).await
    } else {
        let io = TokioIo::new(tcp);
        do_send_request(io, req, handle).await
    }
}

async fn do_send_request<I, B>(
    io: I,
    req: hyper::Request<B>,
    handle: &Dial9TokioHandle,
) -> Result<hyper::Response<hyper::body::Incoming>, GitFetchError>
where
    I: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
    B: hyper::body::Body<Data = Bytes, Error: Into<Box<dyn std::error::Error + Send + Sync>>>
        + Send
        + 'static,
{
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(|e| GitFetchError::RequestFailed(format!("HTTP handshake: {e}")))?;

    handle.spawn(async move {
        if let Err(e) = conn.await {
            tracing::debug!("HTTP connection closed: {e}");
        }
    });

    sender
        .send_request(req)
        .await
        .map_err(|e| GitFetchError::RequestFailed(format!("send request: {e}")))
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

/// Collect a body into `Bytes`, enforcing `max_bytes` as frames arrive.
///
/// Chunked responses carry no Content-Length, so the cap cannot be checked
/// up front; checking only after collection would let a hostile server grow
/// the buffer without bound first.
async fn collect_body_capped<B>(mut body: B, max_bytes: usize) -> Result<Bytes, GitFetchError>
where
    B: hyper::body::Body<Data = Bytes> + Unpin,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let mut buf = BytesMut::new();
    while let Some(frame) = body.frame().await {
        let frame =
            frame.map_err(|e| GitFetchError::RequestFailed(format!("read body: {}", e.into())))?;
        if let Ok(data) = frame.into_data() {
            if buf.len() + data.len() > max_bytes {
                return Err(GitFetchError::TooLarge(buf.len() + data.len()));
            }
            buf.extend_from_slice(&data);
        }
        // Non-data frames (trailers) are ignored.
    }
    Ok(buf.freeze())
}

/// Collect a response body into `Bytes`, checking Content-Length and total size.
async fn collect_response_body(
    resp: hyper::Response<hyper::body::Incoming>,
) -> Result<Bytes, GitFetchError> {
    // Check Content-Length before downloading anything.
    if let Some(cl) = resp.headers().get(hyper::header::CONTENT_LENGTH) {
        if let Ok(len_str) = cl.to_str() {
            if let Ok(len) = len_str.parse::<usize>() {
                if len > MAX_CLONE_SIZE {
                    return Err(GitFetchError::TooLarge(len));
                }
            }
        }
    }

    collect_body_capped(resp.into_body(), MAX_CLONE_SIZE).await
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
    path_suffix: &str,
    content_type: &str,
    body: Vec<u8>,
    max_response_bytes: usize,
    handle: &Dial9TokioHandle,
) -> Result<BodyReader<hyper::body::Incoming>, GitFetchError> {
    let full_path = format!("{}{}", uri.base_path, path_suffix);

    let req = hyper::Request::post(&full_path)
        .header(hyper::header::HOST, &uri.host)
        .header(hyper::header::USER_AGENT, "cache-server/git-fetch")
        .header(hyper::header::CONTENT_TYPE, content_type)
        .header(hyper::header::ACCEPT, UPLOAD_PACK_RESULT_TYPE)
        .body(http_body_util::Full::new(Bytes::from(body)))
        .map_err(|e| GitFetchError::RequestFailed(format!("build POST request: {e}")))?;

    let resp = send_request_raw(ssl_connector, uri, req, handle).await?;
    let resp = ensure_success(resp)?;
    check_content_type(resp.headers(), UPLOAD_PACK_RESULT_TYPE)?;
    Ok(BodyReader::new(resp.into_body(), max_response_bytes))
}

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// A body that yields each queued chunk as its own data frame.
    struct FrameBody {
        frames: std::collections::VecDeque<Bytes>,
    }

    impl FrameBody {
        fn new(chunks: &[&[u8]]) -> Self {
            Self {
                frames: chunks.iter().map(|c| Bytes::copy_from_slice(c)).collect(),
            }
        }
    }

    impl hyper::body::Body for FrameBody {
        type Data = Bytes;
        type Error = std::convert::Infallible;

        fn poll_frame(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Option<Result<hyper::body::Frame<Bytes>, Self::Error>>> {
            Poll::Ready(
                self.frames
                    .pop_front()
                    .map(|b| Ok(hyper::body::Frame::data(b))),
            )
        }
    }

    #[tokio::test]
    async fn collect_capped_under_limit() {
        let body = FrameBody::new(&[b"hello ", b"world"]);
        let out = collect_body_capped(body, 100).await.unwrap();
        assert_eq!(&out[..], b"hello world");
    }

    #[tokio::test]
    async fn collect_capped_exact_limit() {
        let body = FrameBody::new(&[b"12345"]);
        let out = collect_body_capped(body, 5).await.unwrap();
        assert_eq!(&out[..], b"12345");
    }

    #[tokio::test]
    async fn collect_capped_rejects_single_oversized_frame() {
        let body = FrameBody::new(&[b"too large for the cap"]);
        let err = collect_body_capped(body, 5).await.unwrap_err();
        assert!(matches!(err, GitFetchError::TooLarge(_)), "{err}");
    }

    #[tokio::test]
    async fn collect_capped_rejects_accumulated_frames() {
        // No single frame exceeds the cap; the running total must be what
        // trips it (this is the chunked-response case with no
        // Content-Length).
        let body = FrameBody::new(&[b"aaaa", b"bbbb", b"cccc"]);
        let err = collect_body_capped(body, 10).await.unwrap_err();
        assert!(matches!(err, GitFetchError::TooLarge(_)), "{err}");
    }

    #[tokio::test]
    async fn collect_capped_empty_body() {
        let body = FrameBody::new(&[]);
        let out = collect_body_capped(body, 10).await.unwrap();
        assert!(out.is_empty());
    }

    // --- check_content_type ---

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
}
