// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Integration tests for the HTTP fetch code path.
//!
//! These tests spin up a real HTTP/1.1 server on localhost and exercise
//! `fetch_http_blob` end-to-end: TCP connect, HTTP request/response,
//! body collection, SRI validation, digest computation, redirects, and
//! error handling.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;

use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

use storage::DigestFn;

use crate::{
    ALLOW_LOOPBACK_FOR_TESTS, HttpFetchError, build_ssl_connector, fetch_http_blob, parse_sri,
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

fn enable_loopback() {
    ALLOW_LOOPBACK_FOR_TESTS.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// An inert handle: `spawn` falls through to `tokio::spawn` on whichever
/// runtime the test is running under, with no wake tracking.
fn test_handle() -> dial9::Dial9TokioHandle {
    dial9::Dial9TokioHandle::disabled()
}

fn sha256_sri(data: &[u8]) -> String {
    use base64::Engine as _;
    use sha2::{Digest as _, Sha256};
    let hash = Sha256::digest(data);
    let encoded = base64::engine::general_purpose::STANDARD.encode(hash);
    format!("sha256-{encoded}")
}

// ---------------------------------------------------------------------------
// Test HTTP server
// ---------------------------------------------------------------------------

struct TestServer {
    addr: SocketAddr,
    _task: tokio::task::JoinHandle<()>,
}

impl TestServer {
    async fn start<F>(handler: F) -> Self
    where
        F: Fn(Request<Incoming>) -> Response<Full<Bytes>> + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        Self::start_with_listener(listener, handler).await
    }

    async fn start_with_listener<F>(listener: TcpListener, handler: F) -> Self
    where
        F: Fn(Request<Incoming>) -> Response<Full<Bytes>> + Send + Sync + 'static,
    {
        let addr = listener.local_addr().unwrap();
        let handler = Arc::new(handler);

        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let handler = handler.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let svc = service_fn(move |req| {
                        let resp = (handler)(req);
                        async move { Ok::<_, Infallible>(resp) }
                    });
                    let _ = http1::Builder::new().serve_connection(io, svc).await;
                });
            }
        });

        TestServer { addr, _task: task }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.addr.port(), path)
    }
}

// ---------------------------------------------------------------------------
// Tests: basic fetch
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fetch_200_ok() {
    enable_loopback();
    let body = b"hello world";
    let server = TestServer::start(|_req| {
        Response::builder()
            .status(200)
            .body(Full::new(Bytes::from_static(b"hello world")))
            .unwrap()
    })
    .await;

    let result = fetch_http_blob(
        &build_ssl_connector(),
        &server.url("/file"),
        None,
        &[],
        DigestFn::Sha256,
        &test_handle(),
    )
    .await
    .unwrap();

    assert_eq!(result.data.as_ref(), body);
    assert_eq!(result.digest_size, body.len() as i64);
    assert_eq!(result.digest_hash, DigestFn::Sha256.hash_data(body));
}

// ---------------------------------------------------------------------------
// Tests: HTTP error statuses and connection errors
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fetch_http_404() {
    enable_loopback();
    let server = TestServer::start(|_req| {
        Response::builder()
            .status(404)
            .body(Full::new(Bytes::new()))
            .unwrap()
    })
    .await;

    let result = fetch_http_blob(
        &build_ssl_connector(),
        &server.url("/missing"),
        None,
        &[],
        DigestFn::Sha256,
        &test_handle(),
    )
    .await;

    match result {
        Err(HttpFetchError::HttpStatus(404, _)) => {}
        other => panic!("expected HttpStatus(404), got {other:?}"),
    }
}

#[tokio::test]
async fn fetch_http_500() {
    enable_loopback();
    let server = TestServer::start(|_req| {
        Response::builder()
            .status(500)
            .body(Full::new(Bytes::new()))
            .unwrap()
    })
    .await;

    let result = fetch_http_blob(
        &build_ssl_connector(),
        &server.url("/error"),
        None,
        &[],
        DigestFn::Sha256,
        &test_handle(),
    )
    .await;

    match result {
        Err(HttpFetchError::HttpStatus(500, _)) => {}
        other => panic!("expected HttpStatus(500), got {other:?}"),
    }
}

#[tokio::test]
async fn fetch_connection_refused() {
    enable_loopback();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let url = format!("http://127.0.0.1:{port}/");
    let result = fetch_http_blob(
        &build_ssl_connector(),
        &url,
        None,
        &[],
        DigestFn::Sha256,
        &test_handle(),
    )
    .await;

    match result {
        Err(HttpFetchError::RequestFailed(msg)) => {
            assert!(msg.contains("TCP connect"), "unexpected message: {msg}");
        }
        other => panic!("expected RequestFailed, got {other:?}"),
    }
}

#[tokio::test]
async fn fetch_invalid_uri() {
    enable_loopback();
    let result = fetch_http_blob(
        &build_ssl_connector(),
        "not a valid URI",
        None,
        &[],
        DigestFn::Sha256,
        &test_handle(),
    )
    .await;

    assert!(matches!(result, Err(HttpFetchError::InvalidUri(_))));
}

// ---------------------------------------------------------------------------
// Tests: SRI validation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fetch_sri_match_succeeds() {
    enable_loopback();
    let body = b"integrity-checked content";
    let sri = sha256_sri(body);
    let checksums = parse_sri(&sri).unwrap();

    let server = TestServer::start(|_req| {
        Response::builder()
            .status(200)
            .body(Full::new(Bytes::from_static(b"integrity-checked content")))
            .unwrap()
    })
    .await;

    let result = fetch_http_blob(
        &build_ssl_connector(),
        &server.url("/sri-ok"),
        None,
        &checksums,
        DigestFn::Sha256,
        &test_handle(),
    )
    .await
    .unwrap();

    assert_eq!(result.data.as_ref(), body);
}

#[tokio::test]
async fn fetch_sri_mismatch_fails() {
    enable_loopback();
    let wrong_sri = sha256_sri(b"different content");
    let checksums = parse_sri(&wrong_sri).unwrap();

    let server = TestServer::start(|_req| {
        Response::builder()
            .status(200)
            .body(Full::new(Bytes::from_static(b"actual content")))
            .unwrap()
    })
    .await;

    let result = fetch_http_blob(
        &build_ssl_connector(),
        &server.url("/sri-bad"),
        None,
        &checksums,
        DigestFn::Sha256,
        &test_handle(),
    )
    .await;

    assert!(matches!(result, Err(HttpFetchError::IntegrityMismatch(_))));
}

#[tokio::test]
async fn fetch_sri_multiple_one_matches() {
    enable_loopback();
    let body = b"multi-check";
    let wrong = sha256_sri(b"wrong content");
    let correct = sha256_sri(body);
    let combined = format!("{wrong} {correct}");
    let checksums = parse_sri(&combined).unwrap();

    let server = TestServer::start(|_req| {
        Response::builder()
            .status(200)
            .body(Full::new(Bytes::from_static(b"multi-check")))
            .unwrap()
    })
    .await;

    let result = fetch_http_blob(
        &build_ssl_connector(),
        &server.url("/sri-multi"),
        None,
        &checksums,
        DigestFn::Sha256,
        &test_handle(),
    )
    .await
    .unwrap();

    assert_eq!(result.data.as_ref(), body);
}

#[tokio::test]
async fn fetch_no_sri_skips_validation() {
    enable_loopback();
    let body = b"no checksums";

    let server = TestServer::start(|_req| {
        Response::builder()
            .status(200)
            .body(Full::new(Bytes::from_static(b"no checksums")))
            .unwrap()
    })
    .await;

    let result = fetch_http_blob(
        &build_ssl_connector(),
        &server.url("/no-sri"),
        None,
        &[],
        DigestFn::Sha256,
        &test_handle(),
    )
    .await
    .unwrap();

    assert_eq!(result.data.as_ref(), body);
}

// ---------------------------------------------------------------------------
// Tests: redirects
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fetch_follows_redirect() {
    enable_loopback();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let server = TestServer::start_with_listener(listener, move |req| {
        if req.uri().path() == "/target" {
            Response::builder()
                .status(200)
                .body(Full::new(Bytes::from_static(b"redirected")))
                .unwrap()
        } else {
            Response::builder()
                .status(302)
                .header("Location", format!("http://127.0.0.1:{port}/target"))
                .body(Full::new(Bytes::new()))
                .unwrap()
        }
    })
    .await;

    let result = fetch_http_blob(
        &build_ssl_connector(),
        &server.url("/start"),
        None,
        &[],
        DigestFn::Sha256,
        &test_handle(),
    )
    .await
    .unwrap();

    assert_eq!(result.data.as_ref(), b"redirected");
}

#[tokio::test]
async fn fetch_redirect_chain() {
    enable_loopback();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let server = TestServer::start_with_listener(listener, move |req| match req.uri().path() {
        "/a" => Response::builder()
            .status(301)
            .header("Location", format!("http://127.0.0.1:{port}/b"))
            .body(Full::new(Bytes::new()))
            .unwrap(),
        "/b" => Response::builder()
            .status(307)
            .header("Location", format!("http://127.0.0.1:{port}/c"))
            .body(Full::new(Bytes::new()))
            .unwrap(),
        "/c" => Response::builder()
            .status(200)
            .body(Full::new(Bytes::from_static(b"final")))
            .unwrap(),
        _ => Response::builder()
            .status(404)
            .body(Full::new(Bytes::new()))
            .unwrap(),
    })
    .await;

    let result = fetch_http_blob(
        &build_ssl_connector(),
        &server.url("/a"),
        None,
        &[],
        DigestFn::Sha256,
        &test_handle(),
    )
    .await
    .unwrap();

    assert_eq!(result.data.as_ref(), b"final");
}

#[tokio::test]
async fn fetch_root_relative_redirect() {
    enable_loopback();
    let server = TestServer::start(|req| {
        if req.uri().path() == "/dest" {
            Response::builder()
                .status(200)
                .body(Full::new(Bytes::from_static(b"got here")))
                .unwrap()
        } else {
            Response::builder()
                .status(302)
                .header("Location", "/dest")
                .body(Full::new(Bytes::new()))
                .unwrap()
        }
    })
    .await;

    let result = fetch_http_blob(
        &build_ssl_connector(),
        &server.url("/start"),
        None,
        &[],
        DigestFn::Sha256,
        &test_handle(),
    )
    .await
    .unwrap();

    assert_eq!(result.data.as_ref(), b"got here");
}

#[tokio::test]
async fn fetch_relative_redirect_rejected() {
    enable_loopback();
    let server = TestServer::start(|_req| {
        Response::builder()
            .status(302)
            .header("Location", "relative/path")
            .body(Full::new(Bytes::new()))
            .unwrap()
    })
    .await;

    let result = fetch_http_blob(
        &build_ssl_connector(),
        &server.url("/start"),
        None,
        &[],
        DigestFn::Sha256,
        &test_handle(),
    )
    .await;

    match result {
        Err(HttpFetchError::RequestFailed(msg)) => {
            assert!(
                msg.contains("unsupported relative redirect"),
                "unexpected message: {msg}"
            );
        }
        other => {
            panic!("expected RequestFailed with 'unsupported relative redirect', got {other:?}")
        }
    }
}

#[tokio::test]
async fn fetch_too_many_redirects() {
    enable_loopback();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let counter = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let counter_clone = counter.clone();

    let server = TestServer::start_with_listener(listener, move |_req| {
        let n = counter_clone.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Response::builder()
            .status(302)
            .header("Location", format!("http://127.0.0.1:{port}/hop{n}"))
            .body(Full::new(Bytes::new()))
            .unwrap()
    })
    .await;

    let result = fetch_http_blob(
        &build_ssl_connector(),
        &server.url("/start"),
        None,
        &[],
        DigestFn::Sha256,
        &test_handle(),
    )
    .await;

    match result {
        Err(HttpFetchError::RequestFailed(msg)) => {
            assert!(
                msg.contains("too many redirects"),
                "unexpected message: {msg}"
            );
        }
        other => panic!("expected RequestFailed with 'too many redirects', got {other:?}"),
    }

    assert_eq!(
        counter.load(std::sync::atomic::Ordering::Relaxed),
        10,
        "expected exactly MAX_REDIRECTS redirect hops"
    );
}

#[tokio::test]
async fn fetch_redirect_without_location_header() {
    enable_loopback();
    let server = TestServer::start(|_req| {
        Response::builder()
            .status(302)
            .body(Full::new(Bytes::new()))
            .unwrap()
    })
    .await;

    let result = fetch_http_blob(
        &build_ssl_connector(),
        &server.url("/start"),
        None,
        &[],
        DigestFn::Sha256,
        &test_handle(),
    )
    .await;

    match result {
        Err(HttpFetchError::RequestFailed(msg)) => {
            assert!(
                msg.contains("redirect without Location"),
                "unexpected message: {msg}"
            );
        }
        other => panic!("expected RequestFailed with 'redirect without Location', got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Tests: size limits
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fetch_content_length_too_large() {
    enable_loopback();
    // Use a raw TCP server so hyper doesn't override our Content-Length header.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let _server = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf).await;
                let resp = b"HTTP/1.1 200 OK\r\nContent-Length: 268435457\r\n\r\n";
                let _ = stream.write_all(resp).await;
            });
        }
    });

    let result = fetch_http_blob(
        &build_ssl_connector(),
        &format!("http://127.0.0.1:{}/huge", addr.port()),
        None,
        &[],
        DigestFn::Sha256,
        &test_handle(),
    )
    .await;

    assert!(matches!(result, Err(HttpFetchError::TooLarge(_))));
}

#[tokio::test]
async fn fetch_without_content_length_succeeds() {
    enable_loopback();
    // Use raw TCP to send a response without Content-Length header.
    // hyper's server auto-adds Content-Length for Full bodies, so we
    // must bypass it to actually test the no-Content-Length code path.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let _server = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf).await;
                // Close connection after body to signal end-of-stream.
                let resp = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nstreamed";
                let _ = stream.write_all(resp).await;
            });
        }
    });

    let result = fetch_http_blob(
        &build_ssl_connector(),
        &format!("http://127.0.0.1:{}/stream", addr.port()),
        None,
        &[],
        DigestFn::Sha256,
        &test_handle(),
    )
    .await
    .unwrap();

    assert_eq!(result.data.as_ref(), b"streamed");
}

// ---------------------------------------------------------------------------
// Tests: timeout
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fetch_timeout() {
    enable_loopback();
    // Server that accepts connections but never sends a response.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let _hold = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let _keep = stream;
                tokio::time::sleep(std::time::Duration::from_secs(300)).await;
            });
        }
    });

    let result = fetch_http_blob(
        &build_ssl_connector(),
        &format!("http://127.0.0.1:{}/slow", addr.port()),
        Some(std::time::Duration::from_millis(500)),
        &[],
        DigestFn::Sha256,
        &test_handle(),
    )
    .await;

    assert!(matches!(result, Err(HttpFetchError::Timeout)));
}

// ---------------------------------------------------------------------------
// Tests: digest computation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fetch_digest_sha256() {
    enable_loopback();
    let body = b"digest test data";
    let expected_hash = DigestFn::Sha256.hash_data(body);

    let server = TestServer::start(|_req| {
        Response::builder()
            .status(200)
            .body(Full::new(Bytes::from_static(b"digest test data")))
            .unwrap()
    })
    .await;

    let result = fetch_http_blob(
        &build_ssl_connector(),
        &server.url("/digest"),
        None,
        &[],
        DigestFn::Sha256,
        &test_handle(),
    )
    .await
    .unwrap();

    assert_eq!(result.digest_hash, expected_hash);
    assert_eq!(result.digest_size, body.len() as i64);
}

#[tokio::test]
async fn fetch_digest_blake3() {
    enable_loopback();
    let body = b"blake3 test data";
    let expected_hash = DigestFn::Blake3.hash_data(body);

    let server = TestServer::start(|_req| {
        Response::builder()
            .status(200)
            .body(Full::new(Bytes::from_static(b"blake3 test data")))
            .unwrap()
    })
    .await;

    let result = fetch_http_blob(
        &build_ssl_connector(),
        &server.url("/digest"),
        None,
        &[],
        DigestFn::Blake3,
        &test_handle(),
    )
    .await
    .unwrap();

    assert_eq!(result.digest_hash, expected_hash);
    assert_eq!(result.digest_size, body.len() as i64);
}
