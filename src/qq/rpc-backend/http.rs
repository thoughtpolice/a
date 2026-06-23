// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Shared HTTP transport for the RPC backend, built on hyper.
//!
//! We use plain hyper (HTTP/1, no TLS) deliberately: it keeps the rustls/ring
//! crypto stack out of qq-cli's link graph entirely. The backend only ever talks
//! to a local `http://` server, so no TLS is needed.
//!
//! jj drives backend futures with `pollster`, which has no I/O reactor, so each
//! request is `spawn`ed onto a process-wide tokio runtime and the resulting
//! [`tokio::task::JoinHandle`] is awaited: pollster can drive the `JoinHandle`
//! to completion because tokio wakes it from one of the runtime's worker threads.

use std::sync::OnceLock;

use http::Method;
use http::Request;
use http::StatusCode;
use http_body_util::BodyExt as _;
use http_body_util::Full;
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use thiserror::Error;
use tokio::net::TcpStream;
use tokio::runtime::Runtime;

/// Environment variable naming the RPC server base URL (e.g. `http://localhost:1234`).
pub(crate) const BACKEND_URL_ENV: &str = "QQ_RPC_BACKEND_URL";

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Errors raised by the RPC transport layer.
#[derive(Debug, Error)]
pub(crate) enum RpcError {
    #[error("environment variable {BACKEND_URL_ENV} is not set (e.g. http://localhost:1234)")]
    MissingUrl,
    #[error("invalid backend URL {url:?}: {message}")]
    InvalidUrl { url: String, message: String },
    #[error("HTTP request to {url} failed")]
    Request { url: String, source: BoxError },
    #[error("the RPC request task for {url} failed to complete")]
    Join {
        url: String,
        source: tokio::task::JoinError,
    },
    #[error("RPC server returned status {status} for {url}")]
    Status { url: String, status: StatusCode },
}

/// Process-wide tokio runtime shared by all RPC stores.
fn runtime() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to build tokio runtime for the RPC backend")
    })
}

/// A handle to the RPC server: the parsed authority and base path. Cheap to clone.
#[derive(Clone, Debug)]
pub(crate) struct RpcClient {
    authority: String,
    host: String,
    port: u16,
    base_path: String,
}

impl RpcClient {
    /// Reads and parses the base URL from [`BACKEND_URL_ENV`].
    pub(crate) fn from_env() -> Result<Self, RpcError> {
        let url = std::env::var(BACKEND_URL_ENV).map_err(|_| RpcError::MissingUrl)?;
        Self::parse(&url)
    }

    fn parse(url: &str) -> Result<Self, RpcError> {
        let invalid = |message: &str| RpcError::InvalidUrl {
            url: url.to_owned(),
            message: message.to_owned(),
        };
        let rest = url
            .strip_prefix("http://")
            .ok_or_else(|| invalid("only http:// URLs are supported"))?;
        let rest = rest.trim_end_matches('/');
        let (authority, base_path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, ""),
        };
        let (host, port) = match authority.rsplit_once(':') {
            Some((h, p)) => (
                h.to_owned(),
                p.parse::<u16>().map_err(|_| invalid("invalid port"))?,
            ),
            None => (authority.to_owned(), 80),
        };
        if host.is_empty() {
            return Err(invalid("missing host"));
        }
        Ok(Self {
            authority: authority.to_owned(),
            host,
            port,
            base_path: base_path.to_owned(),
        })
    }

    fn full_url(&self, path: &str) -> String {
        format!("http://{}{}/{}", self.authority, self.base_path, path)
    }

    /// Runs an HTTP request on the shared runtime, returning the response status
    /// and body. Only transport/task failures are surfaced as `Err`; any HTTP
    /// status code is returned for the caller to interpret.
    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
    ) -> Result<(StatusCode, Vec<u8>), RpcError> {
        let url = self.full_url(path);
        let uri_path = format!("{}/{}", self.base_path, path);
        let host = self.host.clone();
        let port = self.port;
        let authority = self.authority.clone();
        let join = runtime().spawn(async move {
            let stream = TcpStream::connect((host.as_str(), port)).await?;
            stream.set_nodelay(true).ok();
            let io = TokioIo::new(stream);
            let (mut sender, conn) =
                hyper::client::conn::http1::handshake::<_, Full<Bytes>>(io).await?;
            // Drive the connection in the background; it ends when `sender` drops.
            tokio::spawn(async move {
                let _ = conn.await;
            });
            let body = Full::new(Bytes::from(body.unwrap_or_default()));
            let req = Request::builder()
                .method(method)
                .uri(&uri_path)
                .header(http::header::HOST, &authority)
                .body(body)?;
            let resp = sender.send_request(req).await?;
            let status = resp.status();
            let bytes = resp.into_body().collect().await?.to_bytes();
            Ok::<(StatusCode, Vec<u8>), BoxError>((status, bytes.to_vec()))
        });
        join.await
            .map_err(|source| RpcError::Join {
                url: url.clone(),
                source,
            })?
            .map_err(|source| RpcError::Request { url, source })
    }

    /// `GET path`: `Some(body)` on 2xx, `None` on 404, error on any other status.
    pub(crate) async fn get(&self, path: &str) -> Result<Option<Vec<u8>>, RpcError> {
        let (status, body) = self.request(Method::GET, path, None).await?;
        if status.is_success() {
            Ok(Some(body))
        } else if status == StatusCode::NOT_FOUND {
            Ok(None)
        } else {
            Err(RpcError::Status {
                url: self.full_url(path),
                status,
            })
        }
    }

    /// `GET path` returning the raw status and body, for callers that need to
    /// distinguish more than found/not-found (e.g. prefix resolution).
    pub(crate) async fn get_raw(&self, path: &str) -> Result<(StatusCode, Vec<u8>), RpcError> {
        self.request(Method::GET, path, None).await
    }

    /// `POST path` with `body`: returns the response body on 2xx, error otherwise.
    pub(crate) async fn post(&self, path: &str, body: Vec<u8>) -> Result<Vec<u8>, RpcError> {
        let (status, resp) = self.request(Method::POST, path, Some(body)).await?;
        if status.is_success() {
            Ok(resp)
        } else {
            Err(RpcError::Status {
                url: self.full_url(path),
                status,
            })
        }
    }
}
