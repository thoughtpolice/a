// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Integration tests for [`Repository`] against an in-process fake OCI
//! registry.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use sha2::{Digest as _, Sha256};
use tokio::net::TcpListener;

use crate::{
    Credentials, FetchOptions, MAX_DOCUMENT_SIZE, MAX_OCI_BLOB_SIZE, MAX_OCI_TOTAL_SIZE,
    OciFetchError, OciFile, OciReference, Platform, Repository, blob_path, manifest,
};
use fetch_http::{ALLOW_LOOPBACK_FOR_TESTS, build_ssl_connector};

// ---------------------------------------------------------------------------
// Test scaffolding: telemetry handle, SSRF bypass
// ---------------------------------------------------------------------------

fn enable_loopback() {
    ALLOW_LOOPBACK_FOR_TESTS.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// An inert handle: `spawn` falls through to `tokio::spawn` on whichever
/// runtime the test is running under, with no wake tracking.
fn test_handle() -> dial9::Dial9TokioHandle {
    dial9::Dial9TokioHandle::disabled()
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn sha256_digest(data: &[u8]) -> String {
    format!("sha256:{}", sha256_hex(data))
}

// ---------------------------------------------------------------------------
// Recording fake registry
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Recorded {
    path: String,
    headers: HashMap<String, String>,
}

struct FakeRegistry {
    addr: SocketAddr,
    requests: Arc<Mutex<Vec<Recorded>>>,
    _task: tokio::task::JoinHandle<()>,
}

impl FakeRegistry {
    async fn start<F>(handler: F) -> Self
    where
        F: Fn(&Recorded) -> Response<Full<Bytes>> + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        Self::start_with_listener(listener, handler).await
    }

    async fn start_with_listener<F>(listener: TcpListener, handler: F) -> Self
    where
        F: Fn(&Recorded) -> Response<Full<Bytes>> + Send + Sync + 'static,
    {
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::<Recorded>::new()));
        let requests_task = requests.clone();
        let handler = Arc::new(handler);

        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let handler = handler.clone();
                let requests = requests_task.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let svc = service_fn(move |req: Request<Incoming>| {
                        let handler = handler.clone();
                        let requests = requests.clone();
                        async move {
                            // Record only the path, not query. Tests route on
                            // the path; the token endpoint is hit with a
                            // `?service=…&scope=…` query that tests don't need
                            // to match on.
                            let path = req.uri().path().to_string();
                            let headers = req
                                .headers()
                                .iter()
                                .map(|(k, v)| {
                                    (
                                        k.as_str().to_ascii_lowercase(),
                                        v.to_str().unwrap_or("").to_string(),
                                    )
                                })
                                .collect();
                            let rec = Recorded { path, headers };
                            let resp = (handler)(&rec);
                            requests.lock().unwrap().push(rec);
                            Ok::<_, Infallible>(resp)
                        }
                    });
                    let _ = http1::Builder::new().serve_connection(io, svc).await;
                });
            }
        });

        FakeRegistry {
            addr,
            requests,
            _task: task,
        }
    }

    fn host_port(&self) -> String {
        format!("127.0.0.1:{}", self.addr.port())
    }

    fn port(&self) -> u16 {
        self.addr.port()
    }

    fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }
}

fn ok_json(body: impl Into<Bytes>) -> Response<Full<Bytes>> {
    Response::builder()
        .status(200)
        .header("Content-Type", "application/json")
        .body(Full::new(body.into()))
        .unwrap()
}

fn ok_blob(body: impl Into<Bytes>) -> Response<Full<Bytes>> {
    Response::builder()
        .status(200)
        .header("Content-Type", "application/octet-stream")
        .body(Full::new(body.into()))
        .unwrap()
}

fn status(code: u16) -> Response<Full<Bytes>> {
    Response::builder()
        .status(code)
        .body(Full::new(Bytes::new()))
        .unwrap()
}

// ---------------------------------------------------------------------------
// Manifest fixtures
// ---------------------------------------------------------------------------

fn make_config() -> Bytes {
    Bytes::from_static(
        br#"{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}"#,
    )
}

fn make_layer_a() -> Bytes {
    Bytes::from_static(b"layer-A-contents")
}

fn make_layer_b() -> Bytes {
    Bytes::from_static(b"layer-B-contents-longer")
}

fn make_manifest(config: &Bytes, layers: &[&Bytes]) -> Bytes {
    let layers_json: Vec<serde_json::Value> = layers
        .iter()
        .map(|l| {
            serde_json::json!({
                "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                "digest": sha256_digest(l),
                "size": l.len(),
            })
        })
        .collect();
    let manifest = serde_json::json!({
        "schemaVersion": 2,
        "mediaType": manifest::MT_OCI_MANIFEST,
        "config": {
            "mediaType": manifest::MT_OCI_CONFIG,
            "digest": sha256_digest(config),
            "size": config.len(),
        },
        "layers": layers_json,
    });
    Bytes::from(serde_json::to_vec(&manifest).unwrap())
}

fn make_index(platforms: &[(&str, &str, &Bytes)]) -> Bytes {
    let manifests: Vec<serde_json::Value> = platforms
        .iter()
        .map(|(os, arch, m)| {
            serde_json::json!({
                "mediaType": manifest::MT_OCI_MANIFEST,
                "digest": sha256_digest(m),
                "size": m.len(),
                "platform": { "os": os, "architecture": arch },
            })
        })
        .collect();
    let idx = serde_json::json!({
        "schemaVersion": 2,
        "mediaType": manifest::MT_OCI_INDEX,
        "manifests": manifests,
    });
    Bytes::from(serde_json::to_vec(&idx).unwrap())
}

fn reference(host_port: &str, repo: &str, digest: &str) -> OciReference {
    OciReference {
        registry: host_port.to_string(),
        repository: repo.to_string(),
        digest: digest.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

struct Routes {
    /// Path (exact match, e.g. `/v2/foo/bar/manifests/sha256:…`) → body.
    manifests: HashMap<String, Bytes>,
    blobs: HashMap<String, Bytes>,
}

impl Routes {
    fn new() -> Self {
        Self {
            manifests: HashMap::new(),
            blobs: HashMap::new(),
        }
    }

    fn add_manifest(&mut self, repo: &str, data: &Bytes) {
        let digest = sha256_digest(data);
        self.manifests
            .insert(format!("/v2/{repo}/manifests/{digest}"), data.clone());
    }

    fn add_blob(&mut self, repo: &str, data: &Bytes) {
        let digest = sha256_digest(data);
        self.blobs
            .insert(format!("/v2/{repo}/blobs/{digest}"), data.clone());
    }

    fn respond(&self, rec: &Recorded) -> Response<Full<Bytes>> {
        if let Some(body) = self.manifests.get(&rec.path) {
            return ok_json(body.clone());
        }
        if let Some(body) = self.blobs.get(&rec.path) {
            return ok_blob(body.clone());
        }
        status(404)
    }
}

/// Every file of an image's layout, its layers downloaded into memory.
#[derive(Debug)]
struct Fetched {
    files: Vec<OciFile>,
}

async fn fetch(reg: &FakeRegistry, repo: &str, digest: &str) -> Result<Fetched, OciFetchError> {
    fetch_with(&reg.host_port(), repo, digest, FetchOptions::default()).await
}

async fn fetch_with(
    host_port: &str,
    repo: &str,
    digest: &str,
    options: FetchOptions,
) -> Result<Fetched, OciFetchError> {
    let (ssl, handle) = (build_ssl_connector(), test_handle());
    let options = FetchOptions {
        plain_http: true,
        ..options
    };
    let repository = Repository::new(&ssl, &handle, &reference(host_port, repo, digest), options);
    let image = repository.resolve_image(digest).await?;
    let layout = image.layout(&format!("oci://{host_port}/{repo}@{digest}"));
    let mut files = layout.files;
    for layer in &layout.layers {
        let data = repository.open_blob(layer).await?.bytes().await?;
        files.push(OciFile {
            path: blob_path(&layer.digest),
            data,
        });
    }
    Ok(Fetched { files })
}

/// A 401 asking for a bearer token from `/token` on `port`.
fn bearer_challenge(port: u16) -> Response<Full<Bytes>> {
    Response::builder()
        .status(401)
        .header(
            "WWW-Authenticate",
            format!(r#"Bearer realm="http://127.0.0.1:{port}/token",service="registry""#),
        )
        .body(Full::new(Bytes::new()))
        .unwrap()
}

/// An image of one layer, served from `foo/bar`.
fn one_layer_image() -> (Routes, String, Bytes) {
    let config = make_config();
    let layer = make_layer_a();
    let manifest = make_manifest(&config, &[&layer]);
    let mut routes = Routes::new();
    routes.add_manifest("foo/bar", &manifest);
    routes.add_blob("foo/bar", &config);
    routes.add_blob("foo/bar", &layer);
    (routes, sha256_digest(&manifest), layer)
}

// ===========================================================================
// Tests
// ===========================================================================

#[tokio::test]
async fn requests_carry_the_registry_port_in_host() {
    enable_loopback();
    let config = make_config();
    let layer = make_layer_a();
    let manifest = make_manifest(&config, &[&layer]);
    let manifest_digest = sha256_digest(&manifest);

    let mut routes = Routes::new();
    routes.add_manifest("foo/bar", &manifest);
    routes.add_blob("foo/bar", &config);
    routes.add_blob("foo/bar", &layer);
    let routes = Arc::new(routes);
    let routes_cl = routes.clone();

    let reg = FakeRegistry::start(move |rec| routes_cl.respond(rec)).await;
    fetch(&reg, "foo/bar", &manifest_digest).await.unwrap();

    let requests = reg.requests();
    assert!(!requests.is_empty());
    for rec in requests {
        assert_eq!(
            rec.headers.get("host").map(String::as_str),
            Some(reg.host_port().as_str()),
            "{}",
            rec.path
        );
    }
}

#[tokio::test]
async fn happy_path_single_manifest() {
    enable_loopback();
    let config = make_config();
    let layer_a = make_layer_a();
    let layer_b = make_layer_b();
    let manifest = make_manifest(&config, &[&layer_a, &layer_b]);
    let manifest_digest = sha256_digest(&manifest);

    let mut routes = Routes::new();
    routes.add_manifest("foo/bar", &manifest);
    routes.add_blob("foo/bar", &config);
    routes.add_blob("foo/bar", &layer_a);
    routes.add_blob("foo/bar", &layer_b);
    let routes = Arc::new(routes);
    let routes_cl = routes.clone();

    let reg = FakeRegistry::start(move |rec| routes_cl.respond(rec)).await;
    let fetch = fetch(&reg, "foo/bar", &manifest_digest).await.unwrap();

    // oci-layout + index.json + manifest + config + 2 layers = 6
    assert_eq!(
        fetch.files.len(),
        6,
        "files: {:?}",
        fetch.files.iter().map(|f| &f.path).collect::<Vec<_>>()
    );
    let paths: Vec<&str> = fetch.files.iter().map(|f| f.path.as_str()).collect();
    assert!(paths.contains(&"oci-layout"));
    assert!(paths.contains(&"index.json"));
    assert!(paths.iter().any(|p| p.starts_with("blobs/sha256/")));

    // index.json should reference the manifest digest.
    let idx = fetch.files.iter().find(|f| f.path == "index.json").unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&idx.data).unwrap();
    assert_eq!(parsed["manifests"][0]["digest"], manifest_digest);
    assert_eq!(
        parsed["manifests"][0]["mediaType"],
        manifest::MT_OCI_MANIFEST
    );
}

#[tokio::test]
async fn layout_keeps_a_docker_manifests_media_type() {
    enable_loopback();
    let config = make_config();
    let layer = make_layer_a();
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&make_manifest(&config, &[&layer])).unwrap();
    manifest["mediaType"] = manifest::MT_DOCKER_MANIFEST.into();
    manifest["config"]["mediaType"] = manifest::MT_DOCKER_CONFIG.into();
    let manifest = Bytes::from(serde_json::to_vec(&manifest).unwrap());
    let manifest_digest = sha256_digest(&manifest);

    let mut routes = Routes::new();
    routes.add_manifest("foo/bar", &manifest);
    routes.add_blob("foo/bar", &config);
    routes.add_blob("foo/bar", &layer);
    let reg = FakeRegistry::start(move |rec| routes.respond(rec)).await;
    let fetch = fetch(&reg, "foo/bar", &manifest_digest).await.unwrap();

    let idx = fetch.files.iter().find(|f| f.path == "index.json").unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&idx.data).unwrap();
    assert_eq!(parsed["manifests"][0]["digest"], manifest_digest);
    assert_eq!(
        parsed["manifests"][0]["mediaType"],
        manifest::MT_DOCKER_MANIFEST
    );
}

#[tokio::test]
async fn image_index_picks_linux_amd64() {
    enable_loopback();
    let config = make_config();
    let layer = make_layer_a();
    let manifest_amd64 = make_manifest(&config, &[&layer]);
    let manifest_arm64 = make_manifest(&make_config(), &[&make_layer_b()]);
    let amd64_digest = sha256_digest(&manifest_amd64);

    let mut routes = Routes::new();
    let index = make_index(&[
        ("linux", "arm64", &manifest_arm64),
        ("linux", "amd64", &manifest_amd64),
    ]);
    let index_digest = sha256_digest(&index);
    routes.add_manifest("foo/bar", &index);
    routes.add_manifest("foo/bar", &manifest_amd64);
    // Intentionally do NOT register manifest_arm64; if the fetcher followed
    // that digest the request would 404 and the test would fail.
    routes.add_blob("foo/bar", &config);
    routes.add_blob("foo/bar", &layer);
    let routes = Arc::new(routes);
    let routes_cl = routes.clone();

    let reg = FakeRegistry::start(move |rec| routes_cl.respond(rec)).await;
    let fetch = fetch(&reg, "foo/bar", &index_digest).await.unwrap();

    // index.json should point at the amd64 manifest, not the requested index.
    let idx = fetch.files.iter().find(|f| f.path == "index.json").unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&idx.data).unwrap();
    assert_eq!(parsed["manifests"][0]["digest"], amd64_digest);
}

#[tokio::test]
async fn image_index_no_amd64_errors() {
    enable_loopback();
    let config = make_config();
    let layer = make_layer_a();
    let manifest_arm64 = make_manifest(&config, &[&layer]);

    let mut routes = Routes::new();
    let index = make_index(&[("linux", "arm64", &manifest_arm64)]);
    let index_digest = sha256_digest(&index);
    routes.add_manifest("foo/bar", &index);
    let routes = Arc::new(routes);
    let routes_cl = routes.clone();

    let reg = FakeRegistry::start(move |rec| routes_cl.respond(rec)).await;
    let err = fetch(&reg, "foo/bar", &index_digest).await.unwrap_err();
    match err {
        OciFetchError::NoMatchingPlatform { wanted, available } => {
            assert_eq!(wanted, "linux/amd64");
            assert_eq!(available, vec!["linux/arm64".to_string()]);
        }
        other => panic!("wrong variant: {other:?}"),
    }
}

#[tokio::test]
async fn nested_index_rejected() {
    enable_loopback();
    // Outer index points to an inner index (via its linux/amd64 slot).
    let inner_index = make_index(&[("linux", "amd64", &Bytes::from_static(b"placeholder"))]);
    let outer_index = {
        let manifests = serde_json::json!([{
            "mediaType": manifest::MT_OCI_INDEX,
            "digest": sha256_digest(&inner_index),
            "size": inner_index.len(),
            "platform": { "os": "linux", "architecture": "amd64" },
        }]);
        let body = serde_json::json!({
            "schemaVersion": 2,
            "mediaType": manifest::MT_OCI_INDEX,
            "manifests": manifests,
        });
        Bytes::from(serde_json::to_vec(&body).unwrap())
    };
    let outer_digest = sha256_digest(&outer_index);

    let mut routes = Routes::new();
    routes.add_manifest("foo/bar", &outer_index);
    routes.add_manifest("foo/bar", &inner_index);
    let routes = Arc::new(routes);
    let routes_cl = routes.clone();

    let reg = FakeRegistry::start(move |rec| routes_cl.respond(rec)).await;
    let err = fetch(&reg, "foo/bar", &outer_digest).await.unwrap_err();
    assert!(matches!(err, OciFetchError::NestedIndex), "got {err:?}");
}

#[tokio::test]
async fn bearer_token_challenge_flow() {
    enable_loopback();
    let config = make_config();
    let layer = make_layer_a();
    let manifest = make_manifest(&config, &[&layer]);
    let manifest_digest = sha256_digest(&manifest);

    let mut routes = Routes::new();
    routes.add_manifest("foo/bar", &manifest);
    routes.add_blob("foo/bar", &config);
    routes.add_blob("foo/bar", &layer);
    let routes = Arc::new(routes);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let routes_cl = routes.clone();

    let reg = FakeRegistry::start_with_listener(listener, move |rec| {
        if rec.path == "/token" {
            return ok_json(Bytes::from_static(br#"{"token":"abc-123"}"#));
        }
        match rec.headers.get("authorization").map(String::as_str) {
            Some("Bearer abc-123") => routes_cl.respond(rec),
            _ => {
                let challenge = format!(
                    r#"Bearer realm="http://127.0.0.1:{port}/token",service="registry",scope="repository:foo/bar:pull""#
                );
                Response::builder()
                    .status(401)
                    .header("WWW-Authenticate", challenge)
                    .body(Full::new(Bytes::new()))
                    .unwrap()
            }
        }
    })
    .await;

    fetch(&reg, "foo/bar", &manifest_digest).await.unwrap();

    let recs = reg.requests();
    // Every manifest/blob request that succeeded must have carried the bearer.
    let authed: Vec<&Recorded> = recs
        .iter()
        .filter(|r| !r.path.starts_with("/token"))
        .filter(|r| r.headers.get("authorization").map(String::as_str) == Some("Bearer abc-123"))
        .collect();
    assert!(
        authed.len() >= 3,
        "expected at least 3 authed requests (manifest + config + layer), got {}",
        authed.len()
    );
}

#[tokio::test]
async fn bearer_token_endpoint_non_200() {
    enable_loopback();
    let manifest = make_manifest(&make_config(), &[]);
    let manifest_digest = sha256_digest(&manifest);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let reg = FakeRegistry::start_with_listener(listener, move |rec| {
        if rec.path == "/token" {
            return status(503);
        }
        let challenge = format!(r#"Bearer realm="http://127.0.0.1:{port}/token""#);
        Response::builder()
            .status(401)
            .header("WWW-Authenticate", challenge)
            .body(Full::new(Bytes::new()))
            .unwrap()
    })
    .await;

    let err = fetch(&reg, "foo/bar", &manifest_digest).await.unwrap_err();
    assert!(
        matches!(err, OciFetchError::AuthTokenFetchFailed(_)),
        "got {err:?}"
    );
}

#[tokio::test]
async fn manifest_digest_mismatch() {
    enable_loopback();
    let served = make_manifest(&make_config(), &[]);
    // Use a digest matching a *different* payload so sha256 verification fails.
    let claimed_digest = sha256_digest(b"something else entirely");

    let path = format!("/v2/foo/bar/manifests/{claimed_digest}");
    let served_cl = served.clone();
    let reg = FakeRegistry::start(move |rec| {
        if rec.path == path {
            ok_json(served_cl.clone())
        } else {
            status(404)
        }
    })
    .await;

    let err = fetch(&reg, "foo/bar", &claimed_digest).await.unwrap_err();
    match err {
        OciFetchError::DigestMismatch { what, .. } => assert_eq!(what, "manifest"),
        other => panic!("wrong variant: {other:?}"),
    }
}

#[tokio::test]
async fn layer_digest_mismatch() {
    enable_loopback();
    let config = make_config();
    let layer = make_layer_a();
    // Build a manifest that claims the layer is something it isn't.
    let tampered_layer_digest = sha256_digest(b"different");
    let manifest = {
        let body = serde_json::json!({
            "schemaVersion": 2,
            "mediaType": manifest::MT_OCI_MANIFEST,
            "config": {
                "mediaType": manifest::MT_OCI_CONFIG,
                "digest": sha256_digest(&config),
                "size": config.len(),
            },
            "layers": [{
                "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                "digest": tampered_layer_digest,
                "size": layer.len(),
            }],
        });
        Bytes::from(serde_json::to_vec(&body).unwrap())
    };
    let manifest_digest = sha256_digest(&manifest);

    let mut routes = Routes::new();
    routes.add_manifest("foo/bar", &manifest);
    routes.add_blob("foo/bar", &config);
    // Serve the real layer under the *claimed* (wrong) digest path.
    routes
        .blobs
        .insert(format!("/v2/foo/bar/blobs/{tampered_layer_digest}"), layer);
    let routes = Arc::new(routes);
    let routes_cl = routes.clone();

    let reg = FakeRegistry::start(move |rec| routes_cl.respond(rec)).await;
    let err = fetch(&reg, "foo/bar", &manifest_digest).await.unwrap_err();
    match err {
        OciFetchError::DigestMismatch { what, .. } => assert_eq!(what, "layer"),
        other => panic!("wrong variant: {other:?}"),
    }
}

/// Serve `layer` under a manifest that declares `declared` bytes for it.
async fn fetch_with_declared_layer_size(layer: Bytes, declared: usize) -> OciFetchError {
    enable_loopback();
    let config = make_config();
    let manifest = {
        let body = serde_json::json!({
            "schemaVersion": 2,
            "mediaType": manifest::MT_OCI_MANIFEST,
            "config": {
                "mediaType": manifest::MT_OCI_CONFIG,
                "digest": sha256_digest(&config),
                "size": config.len(),
            },
            "layers": [{
                "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                "digest": sha256_digest(&layer),
                "size": declared,
            }],
        });
        Bytes::from(serde_json::to_vec(&body).unwrap())
    };
    let manifest_digest = sha256_digest(&manifest);

    let mut routes = Routes::new();
    routes.add_manifest("foo/bar", &manifest);
    routes.add_blob("foo/bar", &config);
    routes.add_blob("foo/bar", &layer);
    let routes = Arc::new(routes);
    let reg = FakeRegistry::start(move |rec| routes.respond(rec)).await;
    fetch(&reg, "foo/bar", &manifest_digest).await.unwrap_err()
}

#[tokio::test]
async fn a_layer_longer_than_declared_is_cut_off() {
    // The registry's own manifest under-declares the layer (which its digest
    // still matches): the body is refused at the declared size.
    let layer = make_layer_a();
    match fetch_with_declared_layer_size(layer.clone(), layer.len() - 1).await {
        OciFetchError::Http(fetch_http::HttpFetchError::TooLarge { limit, .. }) => {
            assert_eq!(limit, layer.len() - 1)
        }
        other => panic!("expected TooLarge, got {other:?}"),
    }
}

#[tokio::test]
async fn a_layer_shorter_than_declared_is_refused() {
    let layer = make_layer_a();
    match fetch_with_declared_layer_size(layer.clone(), layer.len() + 1).await {
        OciFetchError::SizeMismatch {
            what,
            expected,
            actual,
        } => {
            assert_eq!(
                (what, expected, actual),
                ("layer", layer.len() as u64 + 1, layer.len() as u64)
            );
        }
        other => panic!("expected SizeMismatch, got {other:?}"),
    }
}

#[tokio::test]
async fn pre_flight_total_size_exceeded() {
    enable_loopback();
    let config = make_config();
    // Manifest declaring a single absurdly-large layer.
    let fake_digest = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    let manifest = {
        let body = serde_json::json!({
            "schemaVersion": 2,
            "mediaType": manifest::MT_OCI_MANIFEST,
            "config": {
                "mediaType": manifest::MT_OCI_CONFIG,
                "digest": sha256_digest(&config),
                "size": config.len(),
            },
            "layers": [{
                "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                "digest": fake_digest,
                "size": MAX_OCI_TOTAL_SIZE + 1,
            }],
        });
        Bytes::from(serde_json::to_vec(&body).unwrap())
    };
    let manifest_digest = sha256_digest(&manifest);

    let mut routes = Routes::new();
    routes.add_manifest("foo/bar", &manifest);
    // Config is fetched AFTER the pre-flight check, so it should never be requested.
    let routes = Arc::new(routes);
    let routes_cl = routes.clone();

    let reg = FakeRegistry::start(move |rec| routes_cl.respond(rec)).await;
    let err = fetch(&reg, "foo/bar", &manifest_digest).await.unwrap_err();
    assert!(
        matches!(err, OciFetchError::TotalSizeExceeded { .. }),
        "got {err:?}"
    );

    // No blob requests should have been issued at all.
    let blob_requests = reg
        .requests()
        .into_iter()
        .filter(|r| r.path.contains("/blobs/"))
        .count();
    assert_eq!(blob_requests, 0);
}

#[tokio::test]
async fn manifest_404() {
    enable_loopback();
    let digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

    let reg = FakeRegistry::start(|_rec| status(404)).await;
    let err = fetch(&reg, "foo/bar", digest).await.unwrap_err();
    match err {
        OciFetchError::Http(fetch_http::HttpFetchError::HttpStatus(404, _)) => {}
        other => panic!("got {other:?}"),
    }
}

#[tokio::test]
async fn missing_www_authenticate_errors() {
    enable_loopback();
    let digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

    let reg = FakeRegistry::start(|_rec| status(401)).await;
    let err = fetch(&reg, "foo/bar", digest).await.unwrap_err();
    assert!(
        matches!(err, OciFetchError::AuthChallengeMalformed(_)),
        "got {err:?}"
    );
}

#[tokio::test]
async fn basic_auth_rejected() {
    enable_loopback();
    let digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

    let reg = FakeRegistry::start(|_rec| {
        Response::builder()
            .status(401)
            .header("WWW-Authenticate", r#"Basic realm="example""#)
            .body(Full::new(Bytes::new()))
            .unwrap()
    })
    .await;

    let err = fetch(&reg, "foo/bar", digest).await.unwrap_err();
    assert!(
        matches!(err, OciFetchError::UnsupportedAuth(_)),
        "got {err:?}"
    );
}

#[tokio::test]
async fn redirect_to_another_origin_strips_auth() {
    enable_loopback();
    let config = make_config();
    let layer = make_layer_a();
    let manifest = make_manifest(&config, &[&layer]);
    let manifest_digest = sha256_digest(&manifest);
    let layer_digest = sha256_digest(&layer);

    // Upstream CDN server, on the same host but another port: records
    // requests, serves the layer bytes.
    let cdn_layer = layer.clone();
    let cdn = FakeRegistry::start(move |_rec| ok_blob(cdn_layer.clone())).await;
    let cdn_port = cdn.port();

    let mut routes = Routes::new();
    routes.add_manifest("foo/bar", &manifest);
    routes.add_blob("foo/bar", &config);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let layer_path = format!("/v2/foo/bar/blobs/{layer_digest}");
    let reg = FakeRegistry::start_with_listener(listener, move |rec| {
        if rec.path == "/token" {
            return ok_json(Bytes::from_static(br#"{"token":"registry-only"}"#));
        }
        if rec.headers.get("authorization").map(String::as_str) != Some("Bearer registry-only") {
            return bearer_challenge(port);
        }
        if rec.path == layer_path {
            return Response::builder()
                .status(307)
                .header(
                    "Location",
                    format!("http://127.0.0.1:{cdn_port}/cdn/{layer_digest}"),
                )
                .body(Full::new(Bytes::new()))
                .unwrap();
        }
        routes.respond(rec)
    })
    .await;

    fetch(&reg, "foo/bar", &manifest_digest).await.unwrap();

    let cdn_recs = cdn.requests();
    assert!(
        !cdn_recs.is_empty(),
        "CDN should have received the redirect"
    );
    for r in &cdn_recs {
        assert!(
            !r.headers.contains_key("authorization"),
            "CDN unexpectedly received Authorization: {:?}",
            r.headers.get("authorization")
        );
    }
}

#[tokio::test]
async fn redirect_same_host_keeps_auth() {
    enable_loopback();
    let config = make_config();
    let layer = make_layer_a();
    let manifest = make_manifest(&config, &[&layer]);
    let manifest_digest = sha256_digest(&manifest);
    let layer_digest = sha256_digest(&layer);
    let config_digest = sha256_digest(&config);

    let layer_path = format!("/v2/foo/bar/blobs/{layer_digest}");
    let layer_redirected_path = format!("/cdn-sibling/{layer_digest}");
    let routes = {
        let mut r = Routes::new();
        r.add_manifest("foo/bar", &manifest);
        r.blobs
            .insert(format!("/v2/foo/bar/blobs/{config_digest}"), config.clone());
        r
    };
    let routes = Arc::new(routes);
    let layer_cl = layer.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let layer_redirected_path_cl = layer_redirected_path.clone();

    let reg = FakeRegistry::start_with_listener(listener, move |rec| {
        if rec.path == "/token" {
            return ok_json(Bytes::from_static(br#"{"token":"same-host-token"}"#));
        }
        // Require bearer on all non-token traffic.
        if rec.headers.get("authorization").map(String::as_str) != Some("Bearer same-host-token") {
            let challenge = format!(r#"Bearer realm="http://127.0.0.1:{port}/token""#);
            return Response::builder()
                .status(401)
                .header("WWW-Authenticate", challenge)
                .body(Full::new(Bytes::new()))
                .unwrap();
        }
        if rec.path == layer_path {
            return Response::builder()
                .status(307)
                .header(
                    "Location",
                    format!("http://127.0.0.1:{port}{layer_redirected_path_cl}"),
                )
                .body(Full::new(Bytes::new()))
                .unwrap();
        }
        if rec.path == layer_redirected_path_cl {
            return ok_blob(layer_cl.clone());
        }
        routes.respond(rec)
    })
    .await;

    fetch(&reg, "foo/bar", &manifest_digest).await.unwrap();

    // Confirm the same-host redirected layer request still had the bearer.
    let recs = reg.requests();
    let followed = recs
        .iter()
        .find(|r| r.path == layer_redirected_path)
        .expect("the layer redirect target should have been hit");
    assert_eq!(
        followed.headers.get("authorization").map(String::as_str),
        Some("Bearer same-host-token"),
        "same-host redirect should retain Authorization"
    );
}

#[tokio::test]
async fn tag_only_uri_rejected() {
    // Direct call into the uri parser — no registry needed.
    let err = crate::parse_oci_uri("oci://ghcr.io/foo/bar:latest").unwrap_err();
    assert!(matches!(err, OciFetchError::UnsupportedReference(_)));
}

#[tokio::test]
async fn docker_scheme_alias_parses() {
    let d = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let r = crate::parse_oci_uri(&format!("docker://ghcr.io/foo/bar@{d}")).unwrap();
    assert_eq!(r.registry, "ghcr.io");
    assert_eq!(r.repository, "foo/bar");
    assert_eq!(r.digest, d);
}

#[tokio::test]
async fn blob_too_large_over_limit() {
    enable_loopback();
    // Manifest whose *declared* sizes are small (so pre-flight passes) but
    // whose blob body is served larger than MAX_OCI_BLOB_SIZE.
    //
    // Serving a >1 GiB body in a test is not feasible, so we instead lie in
    // Content-Length: the registry sends a single blob claiming its body is
    // oversized. fetch-oci should reject on the header check before reading.
    let config = make_config();
    let layer_digest = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    let manifest = {
        let body = serde_json::json!({
            "schemaVersion": 2,
            "mediaType": manifest::MT_OCI_MANIFEST,
            "config": {
                "mediaType": manifest::MT_OCI_CONFIG,
                "digest": sha256_digest(&config),
                "size": config.len(),
            },
            "layers": [{
                "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                "digest": layer_digest,
                "size": 100,
            }],
        });
        Bytes::from(serde_json::to_vec(&body).unwrap())
    };
    let manifest_digest = sha256_digest(&manifest);
    let layer_path = format!("/v2/foo/bar/blobs/{layer_digest}");
    let config_path = format!("/v2/foo/bar/blobs/{}", sha256_digest(&config));
    let manifest_path = format!("/v2/foo/bar/manifests/{manifest_digest}");

    let manifest_cl = manifest.clone();
    let config_cl = config.clone();
    let over = MAX_OCI_BLOB_SIZE + 1;

    // Use a raw-TCP listener so we can lie about Content-Length without
    // hyper's server re-computing it.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let _task = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let manifest_path = manifest_path.clone();
            let config_path = config_path.clone();
            let layer_path = layer_path.clone();
            let manifest_cl = manifest_cl.clone();
            let config_cl = config_cl.clone();
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = vec![0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let first_line = req.lines().next().unwrap_or("");
                let path = first_line.split_whitespace().nth(1).unwrap_or("");
                let resp = if path == manifest_path {
                    let body = &manifest_cl;
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                        body.len()
                    )
                    .into_bytes()
                    .into_iter()
                    .chain(body.iter().copied())
                    .collect::<Vec<u8>>()
                } else if path == config_path {
                    let body = &config_cl;
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\n\r\n",
                        body.len()
                    )
                    .into_bytes()
                    .into_iter()
                    .chain(body.iter().copied())
                    .collect::<Vec<u8>>()
                } else if path == layer_path {
                    format!("HTTP/1.1 200 OK\r\nContent-Length: {over}\r\n\r\n").into_bytes()
                } else {
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_vec()
                };
                let _ = stream.write_all(&resp).await;
            });
        }
    });

    let host_port = format!("127.0.0.1:{}", addr.port());
    let res = fetch_with(
        &host_port,
        "foo/bar",
        &manifest_digest,
        FetchOptions::default(),
    )
    .await;
    match res {
        Err(OciFetchError::Http(fetch_http::HttpFetchError::TooLarge { .. })) => {}
        other => panic!("expected TooLarge, got {other:?}"),
    }
}

#[tokio::test]
async fn a_redirect_body_larger_than_the_blob_is_not_read() {
    // quay.io answers a blob request with a 302 whose HTML body is larger
    // than the config it points at.
    enable_loopback();
    let (routes, manifest_digest, _) = one_layer_image();
    let config_path = format!("/v2/foo/bar/blobs/{}", sha256_digest(&make_config()));
    let config = make_config();
    let reg = FakeRegistry::start(move |rec| {
        if rec.path == config_path {
            return Response::builder()
                .status(302)
                .header("Location", "/cdn/config")
                .header("Content-Type", "text/html")
                .body(Full::new(Bytes::from(vec![b'x'; 4096])))
                .unwrap();
        }
        if rec.path == "/cdn/config" {
            return ok_blob(config.clone());
        }
        routes.respond(rec)
    })
    .await;

    let fetched = fetch(&reg, "foo/bar", &manifest_digest).await.unwrap();
    assert_eq!(fetched.files.len(), 5);
}

#[tokio::test]
async fn an_expired_token_is_renewed_mid_fetch() {
    enable_loopback();
    let (routes, manifest_digest, _) = one_layer_image();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let tokens = Arc::new(Mutex::new(0));
    let issued = tokens.clone();
    let reg = FakeRegistry::start_with_listener(listener, move |rec| {
        if rec.path == "/token" {
            let mut n = issued.lock().unwrap();
            *n += 1;
            return ok_json(format!(r#"{{"token":"t{n}"}}"#));
        }
        // The first token is good for manifests only: it expires before
        // the blobs are fetched.
        let current = format!("Bearer t{}", issued.lock().unwrap());
        let authorization = rec.headers.get("authorization");
        let accepted = authorization == Some(&current)
            || (authorization.map(String::as_str) == Some("Bearer t1")
                && rec.path.contains("/manifests/"));
        if !accepted || (rec.path.contains("/blobs/") && current == "Bearer t1") {
            return bearer_challenge(port);
        }
        routes.respond(rec)
    })
    .await;

    fetch(&reg, "foo/bar", &manifest_digest).await.unwrap();
    assert_eq!(*tokens.lock().unwrap(), 2);
}

#[tokio::test]
async fn basic_auth_uses_configured_credentials() {
    enable_loopback();
    let (routes, manifest_digest, _) = one_layer_image();
    let creds = Credentials {
        username: "me".into(),
        password: "secret".into(),
    };
    let expected = creds.basic();
    let reg = FakeRegistry::start(move |rec| {
        if rec.headers.get("authorization") != Some(&expected) {
            return Response::builder()
                .status(401)
                .header("WWW-Authenticate", r#"Basic realm="example""#)
                .body(Full::new(Bytes::new()))
                .unwrap();
        }
        routes.respond(rec)
    })
    .await;

    let options = FetchOptions {
        credentials: Some(creds),
        ..FetchOptions::default()
    };
    fetch_with(&reg.host_port(), "foo/bar", &manifest_digest, options)
        .await
        .unwrap();
}

#[tokio::test]
async fn token_requests_present_configured_credentials() {
    enable_loopback();
    let (routes, manifest_digest, _) = one_layer_image();
    let creds = Credentials {
        username: "me".into(),
        password: "secret".into(),
    };
    let basic = creds.basic();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let reg = FakeRegistry::start_with_listener(listener, move |rec| {
        if rec.path == "/token" {
            if rec.headers.get("authorization") != Some(&basic) {
                return status(401);
            }
            return ok_json(Bytes::from_static(br#"{"token":"private"}"#));
        }
        if rec.headers.get("authorization").map(String::as_str) != Some("Bearer private") {
            return bearer_challenge(port);
        }
        routes.respond(rec)
    })
    .await;

    // Anonymously, the token endpoint refuses.
    let err = fetch(&reg, "foo/bar", &manifest_digest).await.unwrap_err();
    assert!(
        matches!(err, OciFetchError::AuthTokenFetchFailed(_)),
        "got {err:?}"
    );
    let options = FetchOptions {
        credentials: Some(creds),
        ..FetchOptions::default()
    };
    fetch_with(&reg.host_port(), "foo/bar", &manifest_digest, options)
        .await
        .unwrap();
    // The registry itself never sees the password.
    let leaked = reg
        .requests()
        .into_iter()
        .filter(|r| r.path != "/token")
        .any(|r| {
            r.headers
                .get("authorization")
                .is_some_and(|a| a.starts_with("Basic"))
        });
    assert!(!leaked);
}

fn platform(s: &str) -> FetchOptions {
    FetchOptions {
        platform: Some(s.parse::<Platform>().unwrap()),
        ..FetchOptions::default()
    }
}

#[tokio::test]
async fn an_index_resolves_to_the_requested_platform() {
    enable_loopback();
    let config = make_config();
    let manifest_amd64 = make_manifest(&config, &[&make_layer_a()]);
    let manifest_arm64 = make_manifest(&config, &[&make_layer_b()]);
    let index = {
        let mut index: serde_json::Value = serde_json::from_slice(&make_index(&[
            ("linux", "amd64", &manifest_amd64),
            ("linux", "arm64", &manifest_arm64),
        ]))
        .unwrap();
        index["manifests"][1]["platform"]["variant"] = "v8".into();
        Bytes::from(serde_json::to_vec(&index).unwrap())
    };
    let mut routes = Routes::new();
    routes.add_manifest("foo/bar", &index);
    routes.add_manifest("foo/bar", &manifest_arm64);
    routes.add_blob("foo/bar", &config);
    routes.add_blob("foo/bar", &make_layer_b());
    let reg = FakeRegistry::start(move |rec| routes.respond(rec)).await;
    let index_digest = sha256_digest(&index);

    for wanted in ["linux/arm64", "linux/arm64/v8"] {
        let fetched = fetch_with(&reg.host_port(), "foo/bar", &index_digest, platform(wanted))
            .await
            .unwrap();
        let idx = fetched
            .files
            .iter()
            .find(|f| f.path == "index.json")
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&idx.data).unwrap();
        assert_eq!(
            parsed["manifests"][0]["digest"],
            sha256_digest(&manifest_arm64),
            "{wanted}"
        );
    }
    let err = fetch_with(
        &reg.host_port(),
        "foo/bar",
        &index_digest,
        platform("linux/arm64/v7"),
    )
    .await
    .unwrap_err();
    assert!(
        matches!(err, OciFetchError::NoMatchingPlatform { .. }),
        "got {err:?}"
    );
}

#[tokio::test]
async fn an_image_named_directly_must_be_the_requested_platform() {
    enable_loopback();
    let (routes, manifest_digest, _) = one_layer_image();
    let reg = FakeRegistry::start(move |rec| routes.respond(rec)).await;

    // The config says linux/amd64.
    fetch_with(
        &reg.host_port(),
        "foo/bar",
        &manifest_digest,
        platform("linux/amd64"),
    )
    .await
    .unwrap();
    match fetch_with(
        &reg.host_port(),
        "foo/bar",
        &manifest_digest,
        platform("linux/arm64"),
    )
    .await
    .unwrap_err()
    {
        OciFetchError::NoMatchingPlatform { wanted, available } => {
            assert_eq!(wanted, "linux/arm64");
            assert_eq!(available, ["linux/amd64"]);
        }
        other => panic!("wrong variant: {other:?}"),
    }
    // Asked for nothing, it is taken as it is.
    fetch(&reg, "foo/bar", &manifest_digest).await.unwrap();
}

async fn open_digest(reg: &FakeRegistry, digest: &str) -> Result<Bytes, OciFetchError> {
    let (ssl, handle) = (build_ssl_connector(), test_handle());
    let options = FetchOptions {
        plain_http: true,
        ..FetchOptions::default()
    };
    let r = reference(&reg.host_port(), "foo/bar", digest);
    let repository = Repository::new(&ssl, &handle, &r, options);
    repository.open_digest(digest).await?.bytes().await
}

#[tokio::test]
async fn a_digest_alone_fetches_a_blob_or_a_manifest() {
    enable_loopback();
    let (mut routes, manifest_digest, layer) = one_layer_image();
    let lie = sha256_digest(b"not the layer");
    routes
        .blobs
        .insert(format!("/v2/foo/bar/blobs/{lie}"), layer.clone());
    let manifest = routes.manifests.values().next().unwrap().clone();
    let reg = FakeRegistry::start(move |rec| routes.respond(rec)).await;

    assert_eq!(
        open_digest(&reg, &sha256_digest(&layer)).await.unwrap(),
        layer
    );
    assert_eq!(open_digest(&reg, &manifest_digest).await.unwrap(), manifest);
    assert!(matches!(
        open_digest(&reg, &lie).await.unwrap_err(),
        OciFetchError::DigestMismatch { what: "blob", .. }
    ));
    let missing = sha256_digest(b"missing");
    assert!(matches!(
        open_digest(&reg, &missing).await.unwrap_err(),
        OciFetchError::Http(fetch_http::HttpFetchError::HttpStatus(404, _))
    ));
}

#[tokio::test]
async fn an_oversized_manifest_is_refused() {
    enable_loopback();
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&make_manifest(&make_config(), &[])).unwrap();
    manifest["annotations"] = serde_json::json!({ "padding": "x".repeat(MAX_DOCUMENT_SIZE) });
    let manifest = Bytes::from(serde_json::to_vec(&manifest).unwrap());
    let mut routes = Routes::new();
    routes.add_manifest("foo/bar", &manifest);
    let reg = FakeRegistry::start(move |rec| routes.respond(rec)).await;

    match fetch(&reg, "foo/bar", &sha256_digest(&manifest))
        .await
        .unwrap_err()
    {
        OciFetchError::Http(fetch_http::HttpFetchError::TooLarge { limit, .. }) => {
            assert_eq!(limit, MAX_DOCUMENT_SIZE)
        }
        other => panic!("expected TooLarge, got {other:?}"),
    }
}

/// The cache server boxes its fetches as `dyn Future + Send` inside its own
/// boxed RPC future; a change that makes that impossible (rust#100013) fails
/// to compile here rather than there.
#[allow(dead_code)]
fn fetch_can_be_boxed_as_send<'a>(
    repository: &'a Repository<'a>,
    layers: &'a [crate::Descriptor],
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
    use futures::stream::{StreamExt, TryStreamExt};
    type Fetch<'a> =
        std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), OciFetchError>> + Send + 'a>>;
    Box::pin(async move {
        let fetch: Fetch<'_> = Box::pin(async move {
            repository.resolve_image("").await?;
            let downloads: Vec<_> = layers
                .iter()
                .map(|layer| async move {
                    let mut blob = repository.open_blob(layer).await?;
                    while blob.next().await?.is_some() {}
                    Ok::<_, OciFetchError>(())
                })
                .collect();
            futures::stream::iter(downloads)
                .buffer_unordered(4)
                .try_collect::<Vec<()>>()
                .await?;
            Ok(())
        });
        let _ = fetch.await;
    })
}
