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

#[tokio::test]
async fn fetch_directory_git_uri_no_vcs_returns_not_found() {
    let store = make_store().await;
    let fetch = make_fetch(store);

    // Git URI without VCS qualifiers → no git clone attempted → NOT_FOUND
    let resp = fetch
        .fetch_directory(tonic::Request::new(FetchDirectoryRequest {
            instance_name: String::new(),
            timeout: None,
            oldest_content_accepted: None,
            uris: vec!["https://github.com/foo/bar.git".into()],
            qualifiers: vec![],
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
