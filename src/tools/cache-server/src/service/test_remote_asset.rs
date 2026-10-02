// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use super::test_helpers::*;

// =================================================================================================================
// Push + Fetch blob roundtrip
// =================================================================================================================

#[tokio::test]
async fn push_blob_then_fetch_blob_roundtrip() {
    let store = make_store().await;
    let push = make_push(store.clone());
    let fetch = make_fetch(store.clone());

    let data = b"remote asset blob";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    push.push_blob(tonic::Request::new(PushBlobRequest {
        instance_name: String::new(),
        uris: vec!["https://example.com/file.tar".into()],
        qualifiers: vec![],
        expire_at: None,
        blob_digest: Some(make_digest(data)),
        references_blobs: vec![],
        references_directories: vec![],
        digest_function: 0,
    }))
    .await
    .unwrap();

    let resp = fetch
        .fetch_blob(tonic::Request::new(FetchBlobRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["https://example.com/file.tar".into()],
            qualifiers: vec![],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.status.as_ref().unwrap().code, 0);
    assert_eq!(
        resp.blob_digest.as_ref().unwrap().hash,
        hex::encode(sha256(data))
    );
    assert_eq!(
        resp.blob_digest.as_ref().unwrap().size_bytes,
        data.len() as i64
    );
    assert_eq!(resp.uri, "https://example.com/file.tar");
}

// =================================================================================================================
// Push + Fetch directory roundtrip
// =================================================================================================================

#[tokio::test]
async fn push_directory_then_fetch_directory_roundtrip() {
    let store = make_store().await;
    let push = make_push(store.clone());
    let fetch = make_fetch(store.clone());

    let dir_data = b"fake directory tree";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(dir_data));
    store
        .cas_put_blob(&cd, Bytes::from_static(dir_data), Compression::Identity)
        .await
        .unwrap();

    push.push_directory(tonic::Request::new(PushDirectoryRequest {
        instance_name: String::new(),
        uris: vec!["urn:dir:abc".into()],
        qualifiers: vec![],
        expire_at: None,
        root_directory_digest: Some(make_digest(dir_data)),
        references_blobs: vec![],
        references_directories: vec![],
        digest_function: 0,
    }))
    .await
    .unwrap();

    let resp = fetch
        .fetch_directory(tonic::Request::new(FetchDirectoryRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["urn:dir:abc".into()],
            qualifiers: vec![],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.status.as_ref().unwrap().code, 0);
    assert_eq!(
        resp.root_directory_digest.as_ref().unwrap().hash,
        hex::encode(sha256(dir_data))
    );
}

// =================================================================================================================
// Push with multiple URIs, fetch with any single one
// =================================================================================================================

#[tokio::test]
async fn push_multiple_uris_fetch_any() {
    let store = make_store().await;
    let push = make_push(store.clone());
    let fetch = make_fetch(store.clone());

    let data = b"multi-uri content";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    push.push_blob(tonic::Request::new(PushBlobRequest {
        instance_name: String::new(),
        uris: vec![
            "https://mirror1.example.com/file".into(),
            "https://mirror2.example.com/file".into(),
        ],
        qualifiers: vec![],
        expire_at: None,
        blob_digest: Some(make_digest(data)),
        references_blobs: vec![],
        references_directories: vec![],
        digest_function: 0,
    }))
    .await
    .unwrap();

    // Fetch using second URI only
    let resp = fetch
        .fetch_blob(tonic::Request::new(FetchBlobRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["https://mirror2.example.com/file".into()],
            qualifiers: vec![],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.status.as_ref().unwrap().code, 0);
    assert_eq!(resp.uri, "https://mirror2.example.com/file");
}

// =================================================================================================================
// Push with qualifiers, fetch must match qualifiers
// =================================================================================================================

#[tokio::test]
async fn push_with_qualifiers_fetch_must_match() {
    let store = make_store().await;
    let push = make_push(store.clone());
    let fetch = make_fetch(store.clone());

    let data = b"qualified content";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    push.push_blob(tonic::Request::new(PushBlobRequest {
        instance_name: String::new(),
        uris: vec!["urn:qualified".into()],
        qualifiers: vec![Qualifier {
            name: "resource_type".into(),
            value: "application/octet-stream".into(),
        }],
        expire_at: None,
        blob_digest: Some(make_digest(data)),
        references_blobs: vec![],
        references_directories: vec![],
        digest_function: 0,
    }))
    .await
    .unwrap();

    // Fetch without qualifier — should NOT find
    let resp = fetch
        .fetch_blob(tonic::Request::new(FetchBlobRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["urn:qualified".into()],
            qualifiers: vec![],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();
    assert_ne!(resp.status.as_ref().unwrap().code, 0);

    // Fetch with matching qualifier — should find
    let resp = fetch
        .fetch_blob(tonic::Request::new(FetchBlobRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["urn:qualified".into()],
            qualifiers: vec![Qualifier {
                name: "resource_type".into(),
                value: "application/octet-stream".into(),
            }],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(resp.status.as_ref().unwrap().code, 0);
}

// =================================================================================================================
// FetchBlob with non-HTTP URI returns NOT_FOUND (no fetch attempted)
// =================================================================================================================

#[tokio::test]
async fn fetch_blob_non_http_uri_returns_not_found() {
    let store = make_store().await;
    let fetch = make_fetch(store);

    let resp = fetch
        .fetch_blob(tonic::Request::new(FetchBlobRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["urn:example:file.tar.gz".into()],
            qualifiers: vec![],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(
        resp.status.as_ref().unwrap().code,
        tonic::Code::NotFound as i32
    );
}

// =================================================================================================================
// FetchBlob against a stalled origin → DEADLINE_EXCEEDED in response status
// =================================================================================================================

#[tokio::test]
async fn fetch_blob_answers_deadline_exceeded_within_the_request_timeout() {
    fetch_http::ALLOW_LOOPBACK_FOR_TESTS.store(true, std::sync::atomic::Ordering::Relaxed);
    // An origin that accepts connections and never answers.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((stream, _)) = listener.accept().await {
            held.push(stream);
        }
    });

    let store = make_store().await;
    let fetch = make_fetch(store);
    let started = std::time::Instant::now();
    let resp = fetch
        .fetch_blob(tonic::Request::new(FetchBlobRequest {
            instance_name: String::new(),
            timeout: Some(prost_types::Duration {
                seconds: 0,
                nanos: 300_000_000,
            }),
            oldest_content_accepted: None,
            uris: vec![format!("http://127.0.0.1:{port}/stalled")],
            qualifiers: vec![],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(
        resp.status.as_ref().unwrap().code,
        tonic::Code::DeadlineExceeded as i32
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
}

// =================================================================================================================
// Origin fetches: identical requests share one, and slots bound how many run
// =================================================================================================================

/// A loopback origin that answers every request with `body` after `delay`,
/// counting the requests it has seen and the most it served at once.
struct SlowOrigin {
    port: u16,
    requests: Arc<std::sync::atomic::AtomicUsize>,
    peak: Arc<std::sync::atomic::AtomicUsize>,
}

impl SlowOrigin {
    async fn start(body: &'static [u8], delay: std::time::Duration) -> Self {
        use std::sync::atomic::Ordering;
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        fetch_http::ALLOW_LOOPBACK_FOR_TESTS.store(true, Ordering::Relaxed);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let peak = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (seen, now, most) = (requests.clone(), active.clone(), peak.clone());
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let (seen, now, most) = (seen.clone(), now.clone(), most.clone());
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buf = [0u8; 1024];
                    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                        match stream.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => request.extend_from_slice(&buf[..n]),
                        }
                    }
                    seen.fetch_add(1, Ordering::SeqCst);
                    let running = now.fetch_add(1, Ordering::SeqCst) + 1;
                    most.fetch_max(running, Ordering::SeqCst);
                    tokio::time::sleep(delay).await;
                    now.fetch_sub(1, Ordering::SeqCst);
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(head.as_bytes()).await;
                    let _ = stream.write_all(body).await;
                });
            }
        });
        Self {
            port,
            requests,
            peak,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
}

fn http_fetch(uri: String) -> tonic::Request<FetchBlobRequest> {
    tonic::Request::new(FetchBlobRequest {
        instance_name: String::new(),
        timeout: None,
        oldest_content_accepted: None,
        uris: vec![uri],
        qualifiers: vec![],
        digest_function: 0,
    })
}

#[tokio::test]
async fn concurrent_fetches_of_one_asset_share_one_origin_request() {
    let origin = SlowOrigin::start(b"shared body", std::time::Duration::from_millis(300)).await;
    let fetch = make_fetch(make_store().await);

    let (a, b, c) = tokio::join!(
        fetch.fetch_blob(http_fetch(origin.url("/same"))),
        fetch.fetch_blob(http_fetch(origin.url("/same"))),
        fetch.fetch_blob(http_fetch(origin.url("/same"))),
    );
    let digests: Vec<_> = [a, b, c]
        .into_iter()
        .map(|r| {
            let r = r.unwrap().into_inner();
            assert_eq!(r.status.unwrap().code, 0);
            r.blob_digest.unwrap()
        })
        .collect();
    assert!(digests.iter().all(|d| *d == digests[0]));
    assert_eq!(digests[0], make_digest(b"shared body"));
    assert_eq!(
        origin.requests.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the waiting requests must find the first one's result in the cache"
    );
}

#[tokio::test]
async fn http_fetches_wait_for_a_slot() {
    let origin = SlowOrigin::start(b"body", std::time::Duration::from_millis(100)).await;
    let fetch = make_fetch_with(
        make_store().await,
        super::remote_asset::FetchConfig {
            max_http_fetches: 1,
            ..Default::default()
        },
    );

    let (a, b, c) = tokio::join!(
        fetch.fetch_blob(http_fetch(origin.url("/a"))),
        fetch.fetch_blob(http_fetch(origin.url("/b"))),
        fetch.fetch_blob(http_fetch(origin.url("/c"))),
    );
    for r in [a, b, c] {
        assert_eq!(r.unwrap().into_inner().status.unwrap().code, 0);
    }
    assert_eq!(origin.requests.load(std::sync::atomic::Ordering::SeqCst), 3);
    assert_eq!(origin.peak.load(std::sync::atomic::Ordering::SeqCst), 1);
}

// =================================================================================================================
// FetchBlob with HTTP URI and invalid checksum.sri → INVALID_ARGUMENT in response status
// =================================================================================================================

#[tokio::test]
async fn fetch_blob_http_uri_invalid_sri_returns_error() {
    let store = make_store().await;
    let fetch = make_fetch(store);

    let resp = fetch
        .fetch_blob(tonic::Request::new(FetchBlobRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["https://example.com/file.tar.gz".into()],
            qualifiers: vec![Qualifier {
                name: "checksum.sri".into(),
                value: "not-a-valid-sri".into(),
            }],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    // Malformed SRI returns INVALID_ARGUMENT in the response status
    assert_eq!(
        resp.status.as_ref().unwrap().code,
        tonic::Code::InvalidArgument as i32
    );
    assert!(
        resp.status
            .as_ref()
            .unwrap()
            .message
            .contains("checksum.sri")
    );
}

// =================================================================================================================
// FetchBlob with non-HTTP URI still returns NOT_FOUND (no HTTP fetch for urn:)
// =================================================================================================================

#[tokio::test]
async fn fetch_blob_non_http_uri_with_sri_returns_not_found() {
    let store = make_store().await;
    let fetch = make_fetch(store);

    let resp = fetch
        .fetch_blob(tonic::Request::new(FetchBlobRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["urn:nonexistent".into()],
            qualifiers: vec![Qualifier {
                name: "checksum.sri".into(),
                value: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=".into(),
            }],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    // Non-HTTP URIs are not fetched via HTTP, even with SRI → NOT_FOUND
    assert_eq!(
        resp.status.as_ref().unwrap().code,
        tonic::Code::NotFound as i32
    );
}

// =================================================================================================================
// Push with expiry, verify expired entries are not returned
// =================================================================================================================

#[tokio::test]
async fn push_with_expiry_expired_not_returned() {
    let store = make_store().await;
    let push = make_push(store.clone());
    let fetch = make_fetch(store.clone());

    let data = b"expiring content";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    // Push with an expiry in the past
    push.push_blob(tonic::Request::new(PushBlobRequest {
        instance_name: String::new(),
        uris: vec!["urn:expired".into()],
        qualifiers: vec![],
        expire_at: Some(prost_types::Timestamp {
            seconds: 1,
            nanos: 0,
        }),
        blob_digest: Some(make_digest(data)),
        references_blobs: vec![],
        references_directories: vec![],
        digest_function: 0,
    }))
    .await
    .unwrap();

    let resp = fetch
        .fetch_blob(tonic::Request::new(FetchBlobRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["urn:expired".into()],
            qualifiers: vec![],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    // Should be NOT_FOUND because the entry is expired
    assert_eq!(
        resp.status.as_ref().unwrap().code,
        tonic::Code::NotFound as i32
    );
}

// =================================================================================================================
// Fetch with oldest_content_accepted filtering
// =================================================================================================================

#[tokio::test]
async fn fetch_oldest_content_accepted_filters() {
    let store = make_store().await;
    let push = make_push(store.clone());
    let fetch = make_fetch(store.clone());

    let data = b"old content";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    push.push_blob(tonic::Request::new(PushBlobRequest {
        instance_name: String::new(),
        uris: vec!["urn:old".into()],
        qualifiers: vec![],
        expire_at: None,
        blob_digest: Some(make_digest(data)),
        references_blobs: vec![],
        references_directories: vec![],
        digest_function: 0,
    }))
    .await
    .unwrap();

    // Fetch with oldest_content_accepted far in the future
    let resp = fetch
        .fetch_blob(tonic::Request::new(FetchBlobRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: Some(prost_types::Timestamp {
                seconds: i64::MAX / 2,
                nanos: 0,
            }),
            uris: vec!["urn:old".into()],
            qualifiers: vec![],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(
        resp.status.as_ref().unwrap().code,
        tonic::Code::NotFound as i32
    );
}

// =================================================================================================================
// Error cases
// =================================================================================================================

#[tokio::test]
async fn fetch_no_pushd_content_returns_not_found() {
    let store = make_store().await;
    let fetch = make_fetch(store);

    let resp = fetch
        .fetch_blob(tonic::Request::new(FetchBlobRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["urn:nonexistent".into()],
            qualifiers: vec![],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(
        resp.status.as_ref().unwrap().code,
        tonic::Code::NotFound as i32
    );
}

// VCS qualifiers are accepted (no longer rejected). For fetch_blob, git URIs
// with VCS qualifiers fall through to NOT_FOUND since blob fetch does not
// perform git clones (only fetch_directory does).

// VCS qualifiers are accepted on fetch_blob (no longer rejected). Non-HTTP URIs
// with VCS qualifiers simply fall through to NOT_FOUND.

#[tokio::test]
async fn fetch_blob_non_http_uri_with_vcs_branch_returns_not_found() {
    let store = make_store().await;
    let fetch = make_fetch(store);

    let resp = fetch
        .fetch_blob(tonic::Request::new(FetchBlobRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["urn:git:foo/bar".into()],
            qualifiers: vec![Qualifier {
                name: "vcs.branch".into(),
                value: "main".into(),
            }],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(
        resp.status.as_ref().unwrap().code,
        tonic::Code::NotFound as i32,
    );
}

#[tokio::test]
async fn fetch_blob_non_http_uri_with_vcs_commit_returns_not_found() {
    let store = make_store().await;
    let fetch = make_fetch(store);

    let resp = fetch
        .fetch_blob(tonic::Request::new(FetchBlobRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["urn:git:foo/bar".into()],
            qualifiers: vec![Qualifier {
                name: "vcs.commit".into(),
                value: "abc123".into(),
            }],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(
        resp.status.as_ref().unwrap().code,
        tonic::Code::NotFound as i32,
    );
}

// Unsupported qualifiers are rejected up front (Remote Asset spec: the API
// MUST reject requests containing qualifiers it does not support).

#[tokio::test]
async fn fetch_blob_unknown_qualifier_rejected() {
    let store = make_store().await;
    let fetch = make_fetch(store);

    let err = fetch
        .fetch_blob(tonic::Request::new(FetchBlobRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["https://example.com/file.tar".into()],
            qualifiers: vec![Qualifier {
                name: "checksum.sha256".into(),
                value: "abc".into(),
            }],
            digest_function: 0,
        }))
        .await
        .unwrap_err();

    assert_eq!(err.code(), tonic::Code::InvalidArgument);
    assert!(err.message().contains("checksum.sha256"), "{err}");
    assert!(err.message().contains("not supported"), "{err}");
}

#[tokio::test]
async fn fetch_directory_unknown_qualifier_rejected() {
    let store = make_store().await;
    let fetch = make_fetch(store);

    let err = fetch
        .fetch_directory(tonic::Request::new(FetchDirectoryRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["https://example.com/repo.git".into()],
            qualifiers: vec![
                Qualifier {
                    name: "vcs.commit".into(),
                    value: "abc123".into(),
                },
                Qualifier {
                    name: "http_header:Authorization".into(),
                    value: "Bearer x".into(),
                },
            ],
            digest_function: 0,
        }))
        .await
        .unwrap_err();

    assert_eq!(err.code(), tonic::Code::InvalidArgument);
    assert!(err.message().contains("http_header:Authorization"), "{err}");
}

#[tokio::test]
async fn fetch_directory_checksum_sri_rejected() {
    // There is no integrity-verified directory fetch; silently ignoring the
    // checksum would be worse than rejecting it.
    let store = make_store().await;
    let fetch = make_fetch(store);

    let err = fetch
        .fetch_directory(tonic::Request::new(FetchDirectoryRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["https://example.com/repo.git".into()],
            qualifiers: vec![Qualifier {
                name: "checksum.sri".into(),
                value: "sha256-abc".into(),
            }],
            digest_function: 0,
        }))
        .await
        .unwrap_err();

    assert_eq!(err.code(), tonic::Code::InvalidArgument);
}

#[tokio::test]
async fn fetch_blob_supported_qualifiers_accepted() {
    // Every supported qualifier together: passes validation and falls
    // through to NOT_FOUND (non-HTTP URI, nothing cached).
    let store = make_store().await;
    let fetch = make_fetch(store);

    let resp = fetch
        .fetch_blob(tonic::Request::new(FetchBlobRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["urn:example:asset".into()],
            qualifiers: vec![
                Qualifier {
                    name: "checksum.sri".into(),
                    value: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=".into(),
                },
                Qualifier {
                    name: "bazel.canonical_id".into(),
                    value: "my-id".into(),
                },
                Qualifier {
                    name: "resource_type".into(),
                    value: "application/x-tar".into(),
                },
            ],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(
        resp.status.as_ref().unwrap().code,
        tonic::Code::NotFound as i32,
    );
}

#[tokio::test]
async fn push_blob_not_in_cas_returns_not_found() {
    let store = make_store().await;
    let push = make_push(store);

    let data = b"not in CAS";
    let result = push
        .push_blob(tonic::Request::new(PushBlobRequest {
            instance_name: String::new(),
            uris: vec!["urn:missing-blob".into()],
            qualifiers: vec![],
            expire_at: None,
            blob_digest: Some(make_digest(data)),
            references_blobs: vec![],
            references_directories: vec![],
            digest_function: 0,
        }))
        .await;

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code(), tonic::Code::NotFound);
}

#[tokio::test]
async fn push_empty_uris_rejected() {
    let store = make_store().await;
    let push = make_push(store);

    let result = push
        .push_blob(tonic::Request::new(PushBlobRequest {
            instance_name: String::new(),
            uris: vec![],
            qualifiers: vec![],
            expire_at: None,
            blob_digest: Some(make_digest(b"x")),
            references_blobs: vec![],
            references_directories: vec![],
            digest_function: 0,
        }))
        .await;

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code(), tonic::Code::InvalidArgument);
}

#[tokio::test]
async fn fetch_empty_uris_rejected() {
    let store = make_store().await;
    let fetch = make_fetch(store);

    let result = fetch
        .fetch_blob(tonic::Request::new(FetchBlobRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec![],
            qualifiers: vec![],
            digest_function: 0,
        }))
        .await;

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code(), tonic::Code::InvalidArgument);
}

#[tokio::test]
async fn fetch_directory_not_found() {
    let store = make_store().await;
    let fetch = make_fetch(store);

    let resp = fetch
        .fetch_directory(tonic::Request::new(FetchDirectoryRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["urn:no-dir".into()],
            qualifiers: vec![],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(
        resp.status.as_ref().unwrap().code,
        tonic::Code::NotFound as i32
    );
}

#[tokio::test]
async fn fetch_blob_does_not_return_directory_entry() {
    let store = make_store().await;
    let push = make_push(store.clone());
    let fetch = make_fetch(store.clone());

    let data = b"dir-only content";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    // Push as directory
    push.push_directory(tonic::Request::new(PushDirectoryRequest {
        instance_name: String::new(),
        uris: vec!["urn:dir-only".into()],
        qualifiers: vec![],
        expire_at: None,
        root_directory_digest: Some(make_digest(data)),
        references_blobs: vec![],
        references_directories: vec![],
        digest_function: 0,
    }))
    .await
    .unwrap();

    // FetchBlob should NOT find it (it's a directory)
    let resp = fetch
        .fetch_blob(tonic::Request::new(FetchBlobRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["urn:dir-only".into()],
            qualifiers: vec![],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(
        resp.status.as_ref().unwrap().code,
        tonic::Code::NotFound as i32
    );

    // FetchDirectory should find it
    let resp = fetch
        .fetch_directory(tonic::Request::new(FetchDirectoryRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["urn:dir-only".into()],
            qualifiers: vec![],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.status.as_ref().unwrap().code, 0);
}

// =================================================================================================================
// Git clone: fetch_directory with VCS qualifiers but no git server → NOT_FOUND
// (git clone fails on network, falls through)
// =================================================================================================================

/// A git repository named by its URI or its resource type, with no VCS
/// qualifiers, is cloned at its default branch: the origin is asked for its
/// refs.
#[tokio::test]
async fn fetch_directory_clones_a_git_uri_without_vcs_qualifiers() {
    use std::sync::atomic::Ordering;
    // Not a git server: any clone of it fails, once it has been asked.
    let origin = SlowOrigin::start(b"not a git server", std::time::Duration::ZERO).await;
    let fetch = make_fetch(make_store().await);
    let git = Qualifier {
        name: "resource_type".into(),
        value: "application/x-git".into(),
    };
    for (path, qualifiers) in [("/repo.git", vec![]), ("/repo", vec![git])] {
        let asked = origin.requests.load(Ordering::SeqCst);
        let resp = fetch
            .fetch_directory(tonic::Request::new(FetchDirectoryRequest {
                instance_name: String::new(),
                timeout: None,
                oldest_content_accepted: None,
                uris: vec![origin.url(path)],
                qualifiers,
                digest_function: 0,
            }))
            .await
            .unwrap()
            .into_inner();
        assert_ne!(resp.status.unwrap().code, 0, "{path}");
        assert!(
            origin.requests.load(Ordering::SeqCst) > asked,
            "{path}: no clone was attempted"
        );
    }
}

/// Qualifiers that name a tree ask FetchBlob for nothing it can fetch: the
/// origin is not asked, where it would answer with a web page.
#[tokio::test]
async fn fetch_blob_under_tree_qualifiers_fetches_nothing() {
    let origin = SlowOrigin::start(b"<html>a repository</html>", std::time::Duration::ZERO).await;
    let fetch = make_fetch(make_store().await);
    let qualifier = |name: &str, value: &str| Qualifier {
        name: name.into(),
        value: value.into(),
    };
    for tree in [
        qualifier("vcs.branch", "main"),
        qualifier("vcs.commit", "0123456789abcdef0123456789abcdef01234567"),
        qualifier("directory", "src"),
        qualifier("resource_type", "application/x-git"),
    ] {
        let mut req = http_fetch(origin.url("/repo.git"));
        req.get_mut().qualifiers = vec![tree.clone()];
        let resp = fetch.fetch_blob(req).await.unwrap().into_inner();
        assert_eq!(
            tonic::Code::from(resp.status.unwrap().code),
            tonic::Code::NotFound,
            "{}",
            tree.name
        );
    }
    let seen = origin.requests.load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(seen, 0);

    // Another resource type is fetched as usual.
    let mut req = http_fetch(origin.url("/page"));
    req.get_mut().qualifiers = vec![qualifier("resource_type", "text/html")];
    let resp = fetch.fetch_blob(req).await.unwrap().into_inner();
    assert_eq!(resp.status.unwrap().code, 0);
}

// =================================================================================================================
// Git clone: push_directory with VCS qualifiers, then fetch via cache
// =================================================================================================================

#[tokio::test]
async fn fetch_directory_git_uri_cached_roundtrip() {
    let store = make_store().await;
    let push = make_push(store.clone());
    let fetch = make_fetch(store.clone());

    let data = b"git repo directory content";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    // Push with VCS qualifiers
    push.push_directory(tonic::Request::new(PushDirectoryRequest {
        instance_name: String::new(),
        uris: vec!["https://github.com/foo/bar.git".into()],
        qualifiers: vec![
            Qualifier {
                name: "vcs.branch".into(),
                value: "main".into(),
            },
            Qualifier {
                name: "resource_type".into(),
                value: "application/x-git".into(),
            },
        ],
        expire_at: None,
        root_directory_digest: Some(make_digest(data)),
        references_blobs: vec![],
        references_directories: vec![],
        digest_function: 0,
    }))
    .await
    .unwrap();

    // Fetch with same qualifiers → should hit cache (Phase 1)
    let resp = fetch
        .fetch_directory(tonic::Request::new(FetchDirectoryRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["https://github.com/foo/bar.git".into()],
            qualifiers: vec![
                Qualifier {
                    name: "vcs.branch".into(),
                    value: "main".into(),
                },
                Qualifier {
                    name: "resource_type".into(),
                    value: "application/x-git".into(),
                },
            ],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.status.as_ref().unwrap().code, 0);
    assert_eq!(
        resp.root_directory_digest.as_ref().unwrap().hash,
        hex::encode(sha256(data)),
    );
}

// =================================================================================================================
// fetch_directory: non-HTTP git URI with VCS qualifiers is not attempted
// =================================================================================================================

#[tokio::test]
async fn fetch_directory_non_http_git_uri_with_vcs_returns_not_found() {
    let store = make_store().await;
    let fetch = make_fetch(store);

    let resp = fetch
        .fetch_directory(tonic::Request::new(FetchDirectoryRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["ssh://git@github.com/foo/bar.git".into()],
            qualifiers: vec![Qualifier {
                name: "vcs.branch".into(),
                value: "main".into(),
            }],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(
        resp.status.as_ref().unwrap().code,
        tonic::Code::NotFound as i32,
    );
}

// =================================================================================================================
// OCI images: FetchDirectory stores an image's layout as a Directory tree
// =================================================================================================================

use protos::build::bazel::remote::asset::v1::FetchDirectoryResponse;

/// A loopback registry answering GETs of fixed paths (404 for any other),
/// counting the requests it sees.
struct FakeRegistry {
    port: u16,
    requests: Arc<std::sync::atomic::AtomicUsize>,
}

impl FakeRegistry {
    async fn start(routes: std::collections::HashMap<String, Bytes>) -> Self {
        use std::sync::atomic::Ordering;
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        fetch_http::ALLOW_LOOPBACK_FOR_TESTS.store(true, Ordering::Relaxed);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (seen, routes) = (requests.clone(), Arc::new(routes));
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let (seen, routes) = (seen.clone(), routes.clone());
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buf = [0u8; 1024];
                    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                        match stream.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => request.extend_from_slice(&buf[..n]),
                        }
                    }
                    seen.fetch_add(1, Ordering::SeqCst);
                    let request = String::from_utf8_lossy(&request);
                    let path = request.split(' ').nth(1).unwrap_or_default();
                    let (status, body) = match routes.get(path) {
                        Some(body) => ("200 OK", body.clone()),
                        None => ("404 Not Found", Bytes::new()),
                    };
                    let head = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(head.as_bytes()).await;
                    let _ = stream.write_all(&body).await;
                });
            }
        });
        Self { port, requests }
    }

    fn uri(&self, reference: &str) -> String {
        format!("oci://127.0.0.1:{}/team/image{reference}", self.port)
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    fn requests(&self) -> usize {
        self.requests.load(std::sync::atomic::Ordering::SeqCst)
    }
}

fn oci_digest(data: &[u8]) -> String {
    format!("sha256:{}", hex::encode(sha256(data)))
}

/// An image: a manifest naming a config and layers. One layer is listed
/// twice (as images list an empty layer once per step that made one), and
/// one is too large to share a write with the others.
struct TestImage {
    manifest: Bytes,
    config: Bytes,
    layers: Vec<Bytes>,
}

impl TestImage {
    fn new() -> Self {
        let small = Bytes::from_static(b"a small layer");
        Self::with(vec![
            small.clone(),
            Bytes::from(noise(17 * 1024 * 1024)),
            small,
        ])
    }

    fn with(layers: Vec<Bytes>) -> Self {
        let config = Bytes::from_static(
            br#"{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}"#,
        );
        let descriptor = |media_type: &str, data: &Bytes| {
            format!(
                r#"{{"mediaType":"{media_type}","digest":"{}","size":{}}}"#,
                oci_digest(data),
                data.len()
            )
        };
        let layer_descriptors: Vec<_> = layers
            .iter()
            .map(|l| descriptor("application/vnd.oci.image.layer.v1.tar+gzip", l))
            .collect();
        let manifest = format!(
            r#"{{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{},"layers":[{}]}}"#,
            descriptor("application/vnd.oci.image.config.v1+json", &config),
            layer_descriptors.join(",")
        );
        Self {
            manifest: Bytes::from(manifest),
            config,
            layers,
        }
    }

    /// The registry paths serving this image, as `team/image`.
    fn routes(&self) -> std::collections::HashMap<String, Bytes> {
        let mut routes = std::collections::HashMap::new();
        routes.insert(
            format!("/v2/team/image/manifests/{}", oci_digest(&self.manifest)),
            self.manifest.clone(),
        );
        for blob in std::iter::once(&self.config).chain(&self.layers) {
            routes.insert(
                format!("/v2/team/image/blobs/{}", oci_digest(blob)),
                blob.clone(),
            );
        }
        routes
    }

    fn reference(&self) -> String {
        format!("@{}", oci_digest(&self.manifest))
    }

    /// The distinct blobs of the layout, by file name under `blobs/sha256`.
    fn blobs(&self) -> std::collections::BTreeMap<String, Bytes> {
        [&self.manifest, &self.config]
            .into_iter()
            .chain(&self.layers)
            .map(|blob| (hex::encode(sha256(blob)), blob.clone()))
            .collect()
    }
}

fn oci_fetch(
    uri: String,
    digest_fn: DigestFn,
    qualifiers: Vec<Qualifier>,
) -> tonic::Request<FetchDirectoryRequest> {
    tonic::Request::new(FetchDirectoryRequest {
        instance_name: String::new(),
        timeout: None,
        oldest_content_accepted: None,
        uris: vec![uri],
        qualifiers,
        digest_function: digest_fn.to_proto_i32(),
    })
}

fn make_oci_fetch(store: Arc<CacheStore>) -> super::remote_asset::FetchService {
    make_fetch(store).with_plain_http_registries()
}

async fn read_cas(store: &CacheStore, digest_fn: DigestFn, digest: &Digest) -> Bytes {
    let mut hash = [0u8; 32];
    hex::decode_to_slice(&digest.hash, &mut hash).unwrap();
    let data = store
        .cas_get_blob(&ContentDigest::new(digest_fn, hash))
        .await
        .unwrap()
        .unwrap_or_else(|| panic!("{} is not in CAS", digest.hash));
    assert_eq!(data.len() as i64, digest.size_bytes);
    data
}

async fn read_directory(store: &CacheStore, digest_fn: DigestFn, digest: &Digest) -> Directory {
    Directory::decode(read_cas(store, digest_fn, digest).await).unwrap()
}

fn names<'a>(names: impl IntoIterator<Item = &'a String>) -> Vec<&'a str> {
    names.into_iter().map(String::as_str).collect()
}

#[tokio::test]
async fn fetch_directory_stores_an_oci_image_layout() {
    for digest_fn in [DigestFn::Sha256, DigestFn::Blake3] {
        let image = TestImage::new();
        let registry = FakeRegistry::start(image.routes()).await;
        let store = make_store().await;
        let fetch = make_oci_fetch(store.clone());

        let uri = registry.uri(&image.reference());
        let resp = fetch
            .fetch_directory(oci_fetch(uri.clone(), digest_fn, vec![]))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(resp.status.unwrap().code, 0, "{digest_fn:?}");
        assert_eq!(resp.uri, uri);

        let root = read_directory(&store, digest_fn, &resp.root_directory_digest.unwrap()).await;
        assert_eq!(
            names(root.files.iter().map(|f| &f.name)),
            ["index.json", "oci-layout"]
        );
        assert_eq!(names(root.directories.iter().map(|d| &d.name)), ["blobs"]);
        let layout = read_cas(&store, digest_fn, root.files[1].digest.as_ref().unwrap()).await;
        assert_eq!(&layout[..], br#"{"imageLayoutVersion":"1.0.0"}"#);
        let index = read_cas(&store, digest_fn, root.files[0].digest.as_ref().unwrap()).await;
        let index = String::from_utf8(index.to_vec()).unwrap();
        assert!(index.contains(&oci_digest(&image.manifest)), "{index}");

        let blobs_dir = read_directory(
            &store,
            digest_fn,
            root.directories[0].digest.as_ref().unwrap(),
        )
        .await;
        assert!(blobs_dir.files.is_empty());
        assert_eq!(
            names(blobs_dir.directories.iter().map(|d| &d.name)),
            ["sha256"]
        );
        let sha256_dir = read_directory(
            &store,
            digest_fn,
            blobs_dir.directories[0].digest.as_ref().unwrap(),
        )
        .await;
        let expected = image.blobs();
        assert_eq!(
            names(sha256_dir.files.iter().map(|f| &f.name)),
            names(expected.keys()),
            "one file per distinct blob, sorted"
        );
        for file in &sha256_dir.files {
            let data = read_cas(&store, digest_fn, file.digest.as_ref().unwrap()).await;
            assert!(data == expected[&file.name], "{digest_fn:?}: {}", file.name);
        }
    }
}

#[tokio::test]
async fn fetch_directory_answers_a_fetched_oci_image_from_the_cache() {
    let image = TestImage::with(vec![Bytes::from_static(b"layer")]);
    let registry = FakeRegistry::start(image.routes()).await;
    let fetch = make_oci_fetch(make_store().await);
    let uri = registry.uri(&image.reference());

    let first = fetch
        .fetch_directory(oci_fetch(uri.clone(), DigestFn::Sha256, vec![]))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(first.status.unwrap().code, 0);
    let requests = registry.requests();
    assert_eq!(requests, 3, "the manifest, the config, and one layer");

    let again = fetch
        .fetch_directory(oci_fetch(uri, DigestFn::Sha256, vec![]))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(again.status.unwrap().code, 0);
    assert_eq!(again.root_directory_digest, first.root_directory_digest);
    assert_eq!(registry.requests(), requests, "answered from the cache");
}

#[tokio::test]
async fn fetching_an_oci_image_again_downloads_only_what_is_new() {
    let v1 = TestImage::with(vec![
        Bytes::from_static(b"base"),
        Bytes::from_static(b"app v1"),
    ]);
    let v2 = TestImage::with(vec![
        Bytes::from_static(b"base"),
        Bytes::from_static(b"app v2"),
    ]);
    let mut routes = v1.routes();
    routes.extend(v2.routes());
    let registry = FakeRegistry::start(routes).await;
    let store = make_store().await;
    let (ssl, handle) = (
        fetch_http::build_ssl_connector(),
        dial9::Dial9TokioHandle::disabled(),
    );
    let registries = super::oci_image::Registries {
        plain_http: true,
        ..Default::default()
    };

    let fetch_image = async |image: &TestImage| {
        let uri = registry.uri(&image.reference());
        let reference = fetch_oci::parse_oci_uri(&uri).unwrap();
        let repository = registries.open(&ssl, &handle, &reference, None);
        let before = registry.requests();
        let stored = super::oci_image::fetch_image(
            &store,
            DigestFn::Sha256,
            &repository,
            &reference.digest,
            &uri,
        )
        .await
        .unwrap()
        .unwrap();
        (stored, registry.requests() - before)
    };

    let (first, requests) = fetch_image(&v1).await;
    assert_eq!(
        (first.downloaded, requests),
        (2, 4),
        "the manifest, config, and layers"
    );
    assert_eq!(
        first.written, 7,
        "oci-layout, index.json, the manifest and config, blobs/sha256, blobs, and the root"
    );
    let (same, requests) = fetch_image(&v1).await;
    assert_eq!((same.downloaded, same.written, requests), (0, 0, 2));
    assert_eq!(same.root, first.root);
    let (next, requests) = fetch_image(&v2).await;
    assert_eq!((next.downloaded, requests), (1, 3), "only the new layer");
    assert_eq!(
        next.written, 5,
        "the new index.json and manifest, and the Directories naming them"
    );
}

#[tokio::test]
async fn fetch_directory_reports_oci_failures() {
    let image = TestImage::with(vec![Bytes::from_static(b"layer")]);
    let mut routes = image.routes();
    // A registry serving the wrong bytes, of the right length, for a layer.
    let corrupt = TestImage::with(vec![Bytes::from_static(b"other layer")]);
    routes.extend(corrupt.routes());
    routes.insert(
        format!("/v2/team/image/blobs/{}", oci_digest(&corrupt.layers[0])),
        Bytes::from_static(b"OTHER LAYER"),
    );
    let registry = FakeRegistry::start(routes).await;
    let fetch = make_oci_fetch(make_store().await);
    let code = |resp: FetchDirectoryResponse| tonic::Code::from(resp.status.unwrap().code);

    let missing = TestImage::with(vec![Bytes::from_static(b"never pushed")]);
    let cases = [
        (
            registry.uri(&missing.reference()),
            vec![],
            tonic::Code::NotFound,
        ),
        (
            registry.uri(&corrupt.reference()),
            vec![],
            tonic::Code::Aborted,
        ),
        (
            registry.uri(":latest"),
            vec![],
            tonic::Code::InvalidArgument,
        ),
        (
            registry.uri(&image.reference()),
            vec![Qualifier {
                name: "directory".into(),
                value: "blobs".into(),
            }],
            tonic::Code::InvalidArgument,
        ),
    ];
    for (uri, qualifiers, expected) in cases {
        let resp = fetch
            .fetch_directory(oci_fetch(uri.clone(), DigestFn::Sha256, qualifiers))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(code(resp), expected, "{uri}");
    }

    let platform = |value: &str| {
        vec![Qualifier {
            name: "oci.platform".into(),
            value: value.into(),
        }]
    };
    for (qualifiers, expected) in [
        (platform("linux"), tonic::Code::InvalidArgument),
        (platform("linux/arm64"), tonic::Code::NotFound),
    ] {
        let resp = fetch
            .fetch_directory(oci_fetch(
                registry.uri(&image.reference()),
                DigestFn::Sha256,
                qualifiers,
            ))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(code(resp), expected);
    }
    let mut git = oci_fetch(
        registry.url("/repo.git"),
        DigestFn::Sha256,
        platform("linux/amd64"),
    );
    git.get_mut().qualifiers.push(Qualifier {
        name: "vcs.branch".into(),
        value: "main".into(),
    });
    let resp = fetch.fetch_directory(git).await.unwrap().into_inner();
    assert_eq!(code(resp), tonic::Code::InvalidArgument);
}

#[tokio::test]
async fn fetch_directory_takes_the_requested_platform_from_an_index() {
    let amd64 = TestImage::with(vec![Bytes::from_static(b"amd64 layer")]);
    let arm64 = TestImage::with(vec![Bytes::from_static(b"arm64 layer")]);
    let index = Bytes::from(
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": oci_digest(&amd64.manifest),
                    "size": amd64.manifest.len(),
                    "platform": { "os": "linux", "architecture": "amd64" },
                },
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": oci_digest(&arm64.manifest),
                    "size": arm64.manifest.len(),
                    "platform": { "os": "linux", "architecture": "arm64", "variant": "v8" },
                },
            ],
        }))
        .unwrap(),
    );
    let mut routes = amd64.routes();
    routes.extend(arm64.routes());
    routes.insert(
        format!("/v2/team/image/manifests/{}", oci_digest(&index)),
        index.clone(),
    );
    let registry = FakeRegistry::start(routes).await;
    let store = make_store().await;
    let fetch = make_oci_fetch(store.clone());
    let uri = registry.uri(&format!("@{}", oci_digest(&index)));

    let mut layouts = Vec::new();
    for qualifiers in [
        vec![],
        vec![Qualifier {
            name: "oci.platform".into(),
            value: "linux/arm64".into(),
        }],
    ] {
        let resp = fetch
            .fetch_directory(oci_fetch(uri.clone(), DigestFn::Sha256, qualifiers))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(resp.status.unwrap().code, 0);
        let root = read_directory(
            &store,
            DigestFn::Sha256,
            &resp.root_directory_digest.unwrap(),
        )
        .await;
        let index = read_cas(
            &store,
            DigestFn::Sha256,
            root.files[0].digest.as_ref().unwrap(),
        )
        .await;
        layouts.push(String::from_utf8(index.to_vec()).unwrap());
    }
    assert!(
        layouts[0].contains(&oci_digest(&amd64.manifest)),
        "{}",
        layouts[0]
    );
    assert!(
        layouts[1].contains(&oci_digest(&arm64.manifest)),
        "{}",
        layouts[1]
    );
}

/// FetchBlob of an `oci://` URI fetches whatever its digest names: a layer,
/// or a manifest.
#[tokio::test]
async fn fetch_blob_fetches_a_blob_from_a_registry() {
    use base64::Engine as _;
    let image = TestImage::new();
    let registry = FakeRegistry::start(image.routes()).await;
    let store = make_store().await;
    let fetch = make_oci_fetch(store.clone());
    let blob_fetch = |blob: &Bytes, digest_fn: DigestFn, qualifiers: Vec<Qualifier>| {
        let mut req = http_fetch(registry.uri(&format!("@{}", oci_digest(blob))));
        req.get_mut().digest_function = digest_fn.to_proto_i32();
        req.get_mut().qualifiers = qualifiers;
        req
    };

    for digest_fn in [DigestFn::Sha256, DigestFn::Blake3] {
        for blob in [&image.layers[1], &image.manifest] {
            let resp = fetch
                .fetch_blob(blob_fetch(blob, digest_fn, vec![]))
                .await
                .unwrap()
                .into_inner();
            assert_eq!(resp.status.unwrap().code, 0, "{digest_fn:?}");
            let digest = resp.blob_digest.unwrap();
            assert_eq!(digest.size_bytes, blob.len() as i64);
            assert!(
                read_cas(&store, digest_fn, &digest).await == *blob,
                "{digest_fn:?}"
            );
        }
    }

    let sri = |data: &[u8]| {
        vec![Qualifier {
            name: "checksum.sri".into(),
            value: format!(
                "sha256-{}",
                base64::engine::general_purpose::STANDARD.encode(sha256(data))
            ),
        }]
    };
    let layer = &image.layers[0];
    let resp = fetch
        .fetch_blob(blob_fetch(layer, DigestFn::Sha256, sri(layer)))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(resp.status.unwrap().code, 0);
    let resp = fetch
        .fetch_blob(blob_fetch(layer, DigestFn::Sha256, sri(b"something else")))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(
        tonic::Code::from(resp.status.unwrap().code),
        tonic::Code::Aborted
    );

    let missing = Bytes::from_static(b"never pushed");
    let resp = fetch
        .fetch_blob(blob_fetch(&missing, DigestFn::Sha256, vec![]))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(
        tonic::Code::from(resp.status.unwrap().code),
        tonic::Code::NotFound
    );
}
