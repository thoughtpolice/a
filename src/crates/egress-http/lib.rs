// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! HTTP/1.1 requests to hosts named by untrusted input.
//!
//! Each request gets its own connection from [`egress::connect`], which
//! refuses internal addresses, wrapped in TLS for `https`. Callers keep their
//! own protocol and redirect rules; this crate owns the transport they share:
//! where a request goes ([`Target`]), sending it ([`send`]), and reading a
//! body without letting the server choose how much memory that takes
//! ([`collect_capped`]).

use std::fmt;
use std::future::Future;
use std::pin::Pin;

use bytes::{Bytes, BytesMut};
use http_body_util::BodyExt as _;
use hyper::body::{Body, Incoming};
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use openssl::ssl::{SslConnector, SslMethod};
use tokio_openssl::SslStream;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// A connection's driver, which must run for its request to make progress.
pub type Connection = Pin<Box<dyn Future<Output = ()> + Send>>;

/// Why a request did not produce a response or its body.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid URL {url}: {reason}")]
    InvalidUrl { url: String, reason: String },
    /// A redirect that cannot or must not be followed.
    #[error("{0}")]
    BadRedirect(String),
    #[error(transparent)]
    Connect(#[from] egress::ConnectError),
    #[error("TLS handshake with {host}: {source}")]
    Tls {
        host: String,
        #[source]
        source: BoxError,
    },
    #[error("HTTP handshake: {0}")]
    Handshake(#[source] hyper::Error),
    #[error("send request: {0}")]
    Send(#[source] hyper::Error),
    #[error("read body: {0}")]
    Body(#[source] BoxError),
    /// The body is larger than the caller's limit. The size is the declared
    /// `Content-Length`, or how much had arrived when it passed the limit.
    #[error("response too large: {size} bytes exceeds {limit} byte limit")]
    TooLarge { size: usize, limit: usize },
}

/// Where a request goes: an `http` or `https` URL taken apart.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub scheme: &'static str,
    /// As `http::Uri::host` gives it: IPv6 literals keep their brackets.
    pub host: String,
    pub port: u16,
    pub path_and_query: String,
}

impl Target {
    /// Parse an `http` or `https` URL, filling in the scheme's default port.
    pub fn parse(url: &str) -> Result<Self, Error> {
        let invalid = |reason: &str| Error::InvalidUrl {
            url: url.to_string(),
            reason: reason.to_string(),
        };
        let parsed: hyper::Uri = url.parse().map_err(|e| invalid(&format!("{e}")))?;
        let scheme = match parsed.scheme_str() {
            Some("https") => "https",
            Some("http") => "http",
            Some(other) => return Err(invalid(&format!("unsupported scheme {other}"))),
            None => return Err(invalid("missing scheme")),
        };
        let host = parsed.host().ok_or_else(|| invalid("missing host"))?;
        Ok(Self {
            scheme,
            host: host.to_string(),
            port: parsed
                .port_u16()
                .unwrap_or(if scheme == "https" { 443 } else { 80 }),
            path_and_query: parsed
                .path_and_query()
                .map_or_else(|| "/".to_string(), |pq| pq.as_str().to_string()),
        })
    }

    /// The `Host` header for requests to this target.
    pub fn host_header(&self) -> String {
        egress::host_header(self.scheme, &self.host, self.port)
    }

    /// Where a redirect from this target with `location` leads.
    ///
    /// Absolute and root-relative locations are followed; anything else is
    /// refused, as is a redirect from `https` to `http`.
    pub fn redirect(&self, location: &str) -> Result<Self, Error> {
        let next = if location.starts_with("http://") || location.starts_with("https://") {
            Self::parse(location)?
        } else if location.starts_with('/') {
            Self {
                path_and_query: location.to_string(),
                ..self.clone()
            }
        } else {
            return Err(Error::BadRedirect(format!(
                "unsupported relative redirect: {location}"
            )));
        };
        if self.scheme == "https" && next.scheme != "https" {
            return Err(Error::BadRedirect(
                "redirect would downgrade from HTTPS to HTTP".to_string(),
            ));
        }
        Ok(next)
    }
}

impl fmt::Display for Target {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}://{}:{}{}",
            self.scheme, self.host, self.port, self.path_and_query
        )
    }
}

/// A TLS connector trusting the system roots.
pub fn ssl_connector() -> SslConnector {
    SslConnector::builder(SslMethod::tls())
        .expect("failed to create SSL connector builder")
        .build()
}

/// Send `request` to `target` on a new connection and return the response,
/// its body still streaming.
///
/// The connection comes from [`egress::connect`], so a host resolving to an
/// internal address is refused, and is wrapped in TLS for `https`. The
/// request's URI and `Host` header are set from `target`. `spawn` runs the
/// connection's driver, which must keep running until the body is read.
pub async fn send<B>(
    ssl: &SslConnector,
    target: &Target,
    mut request: Request<B>,
    spawn: impl FnOnce(Connection),
) -> Result<Response<Incoming>, Error>
where
    B: Body<Data = Bytes, Error: Into<BoxError>> + Send + 'static,
{
    *request.uri_mut() =
        target
            .path_and_query
            .parse()
            .map_err(|e: hyper::http::uri::InvalidUri| Error::InvalidUrl {
                url: target.to_string(),
                reason: e.to_string(),
            })?;
    let host = hyper::header::HeaderValue::from_str(&target.host_header())
        .expect("a parsed URI authority is a valid header value");
    request.headers_mut().insert(hyper::header::HOST, host);

    let tcp = egress::connect(&target.host, target.port).await?;
    // Requests are small and latency-bound; Nagle only delays them.
    let _ = tcp.set_nodelay(true);
    if target.scheme != "https" {
        return exchange(TokioIo::new(tcp), request, spawn).await;
    }

    let tls_error = |source: BoxError| Error::Tls {
        host: target.host.clone(),
        source,
    };
    let ssl = ssl
        .configure()
        .and_then(|config| config.into_ssl(&target.host))
        .map_err(|e| tls_error(e.into()))?;
    let mut tls = SslStream::new(ssl, tcp).map_err(|e| tls_error(e.into()))?;
    Pin::new(&mut tls)
        .connect()
        .await
        .map_err(|e| tls_error(e.into()))?;
    exchange(TokioIo::new(tls), request, spawn).await
}

async fn exchange<I, B>(
    io: I,
    request: Request<B>,
    spawn: impl FnOnce(Connection),
) -> Result<Response<Incoming>, Error>
where
    I: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
    B: Body<Data = Bytes, Error: Into<BoxError>> + Send + 'static,
{
    let (mut sender, connection) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(Error::Handshake)?;
    spawn(Box::pin(async move {
        // The response, or a body read, reports any error that matters.
        let _ = connection.await;
    }));
    sender.send_request(request).await.map_err(Error::Send)
}

/// The body of `response`, refusing more than `limit` bytes.
///
/// A declared `Content-Length` over the limit fails before anything is
/// read; a chunked body fails as soon as it passes the limit, never holding
/// more than that. The body is gathered into one buffer sized from the
/// declared length when there is one.
pub async fn collect_capped<B>(response: Response<B>, limit: usize) -> Result<Bytes, Error>
where
    B: Body<Data = Bytes, Error: Into<BoxError>> + Unpin,
{
    collect_capped_observing(response, limit, |_| {}).await
}

/// [`collect_capped`], also handing each chunk to `observe` as it arrives,
/// so a caller can hash the body in the same pass that receives it.
pub async fn collect_capped_observing<B>(
    response: Response<B>,
    limit: usize,
    mut observe: impl FnMut(&[u8]),
) -> Result<Bytes, Error>
where
    B: Body<Data = Bytes, Error: Into<BoxError>> + Unpin,
{
    let declared = response
        .headers()
        .get(hyper::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok());
    if let Some(size) = declared
        && size > limit
    {
        return Err(Error::TooLarge { size, limit });
    }

    let mut body = response.into_body();
    let mut buf = BytesMut::with_capacity(declared.unwrap_or(0));
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| Error::Body(e.into()))?;
        if let Ok(data) = frame.into_data() {
            if buf.len() + data.len() > limit {
                return Err(Error::TooLarge {
                    size: buf.len() + data.len(),
                    limit,
                });
            }
            observe(&data);
            buf.extend_from_slice(&data);
        }
        // Non-data frames (trailers) are ignored.
    }
    Ok(buf.freeze())
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::task::{Context, Poll};

    use http_body_util::Full;

    use super::*;

    #[test]
    fn parse_fills_in_default_ports() {
        let t = Target::parse("https://example.com/a/b?c=d").unwrap();
        assert_eq!(
            t,
            Target {
                scheme: "https",
                host: "example.com".into(),
                port: 443,
                path_and_query: "/a/b?c=d".into(),
            }
        );
        let t = Target::parse("http://example.com:8080").unwrap();
        assert_eq!((t.port, t.path_and_query.as_str()), (8080, "/"));
        assert_eq!(t.host_header(), "example.com:8080");
        assert!(Target::parse("ftp://example.com/").is_err());
        assert!(Target::parse("example.com/x").is_err());
    }

    #[test]
    fn redirects_keep_the_origin_for_root_relative_locations() {
        let base = Target::parse("https://a.example/x").unwrap();
        let next = base.redirect("/y?z").unwrap();
        assert_eq!(
            (next.host.as_str(), next.path_and_query.as_str()),
            ("a.example", "/y?z")
        );
        let next = base.redirect("https://b.example:444/w").unwrap();
        assert_eq!((next.host.as_str(), next.port), ("b.example", 444));
    }

    #[test]
    fn redirects_refuse_downgrades_and_relative_paths() {
        let base = Target::parse("https://a.example/x").unwrap();
        assert!(matches!(
            base.redirect("http://a.example/"),
            Err(Error::BadRedirect(_))
        ));
        assert!(matches!(base.redirect("y"), Err(Error::BadRedirect(_))));
        let plain = Target::parse("http://a.example/x").unwrap();
        plain.redirect("https://a.example/").unwrap();
    }

    /// A body that yields each queued chunk as its own data frame, with no
    /// declared length.
    struct Chunks(VecDeque<Bytes>);

    impl Body for Chunks {
        type Data = Bytes;
        type Error = std::convert::Infallible;

        fn poll_frame(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Option<Result<hyper::body::Frame<Bytes>, Self::Error>>> {
            Poll::Ready(self.0.pop_front().map(|b| Ok(hyper::body::Frame::data(b))))
        }
    }

    fn chunked(chunks: &[&'static [u8]]) -> Response<Chunks> {
        Response::new(Chunks(
            chunks.iter().map(|c| Bytes::from_static(c)).collect(),
        ))
    }

    #[tokio::test]
    async fn collect_capped_accepts_up_to_the_limit() {
        let body = collect_capped(chunked(&[b"hello ", b"world"]), 11)
            .await
            .unwrap();
        assert_eq!(&body[..], b"hello world");
        let body = collect_capped(chunked(&[]), 0).await.unwrap();
        assert!(body.is_empty());
    }

    #[tokio::test]
    async fn collect_capped_stops_a_chunked_body_at_the_limit() {
        let err = collect_capped(chunked(&[b"12345", b"6"]), 5)
            .await
            .unwrap_err();
        assert!(
            matches!(err, Error::TooLarge { size: 6, limit: 5 }),
            "{err}"
        );
    }

    #[tokio::test]
    async fn collect_capped_refuses_a_declared_length_before_reading() {
        let response = Response::builder()
            .header(hyper::header::CONTENT_LENGTH, "1000")
            .body(Full::new(Bytes::from_static(b"short")))
            .unwrap();
        let err = collect_capped(response, 100).await.unwrap_err();
        assert!(
            matches!(
                err,
                Error::TooLarge {
                    size: 1000,
                    limit: 100
                }
            ),
            "{err}"
        );
    }

    #[tokio::test]
    async fn send_refuses_internal_addresses() {
        let target = Target::parse("http://169.254.169.254/latest").unwrap();
        let request = Request::new(http_body_util::Empty::<Bytes>::new());
        let err = send(&ssl_connector(), &target, request, |c| {
            tokio::spawn(c);
        })
        .await
        .unwrap_err();
        assert!(
            matches!(err, Error::Connect(egress::ConnectError::Blocked { .. })),
            "{err}"
        );
    }

    #[tokio::test]
    async fn send_sets_the_path_and_a_host_header_with_the_port() {
        egress::ALLOW_LOOPBACK_FOR_TESTS.store(true, std::sync::atomic::Ordering::Relaxed);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let service = hyper::service::service_fn(|req: Request<Incoming>| async move {
                let seen = format!(
                    "{} {}",
                    req.headers()[hyper::header::HOST].to_str().unwrap(),
                    req.uri()
                );
                Ok::<_, std::convert::Infallible>(Response::new(Full::new(Bytes::from(seen))))
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });

        let target = Target::parse(&format!("http://127.0.0.1:{port}/a/b?c")).unwrap();
        let request = Request::new(http_body_util::Empty::<Bytes>::new());
        let response = send(&ssl_connector(), &target, request, |c| {
            tokio::spawn(c);
        })
        .await
        .unwrap();
        let body = collect_capped(response, 1024).await.unwrap();
        assert_eq!(body, format!("127.0.0.1:{port} /a/b?c").as_bytes());
    }
}
