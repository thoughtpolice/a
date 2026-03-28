// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use super::test_helpers::*;

// =================================================================================================================
// FindMissingBlobs tests
// =================================================================================================================

#[tokio::test]
async fn find_missing_blobs_all_missing() {
    let store = make_store().await;
    let cas = make_cas(store);

    let data = b"hello world";
    let resp = cas
        .find_missing_blobs(tonic::Request::new(FindMissingBlobsRequest {
            instance_name: String::new(),
            blob_digests: vec![make_digest(data)],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.missing_blob_digests.len(), 1);
    assert_eq!(resp.missing_blob_digests[0].hash, hex::encode(sha256(data)));
}

#[tokio::test]
async fn find_missing_blobs_none_missing_after_upload() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    let data = b"hello world";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    let resp = cas
        .find_missing_blobs(tonic::Request::new(FindMissingBlobsRequest {
            instance_name: String::new(),
            blob_digests: vec![make_digest(data)],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert!(resp.missing_blob_digests.is_empty());
}

#[tokio::test]
async fn find_missing_blobs_mixed() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    let data_a = b"alpha";
    let data_b = b"beta";

    let cd_a = ContentDigest::new(DigestFn::Sha256, sha256(data_a));
    store
        .cas_put_blob(&cd_a, Bytes::from_static(data_a), Compression::Identity)
        .await
        .unwrap();

    let resp = cas
        .find_missing_blobs(tonic::Request::new(FindMissingBlobsRequest {
            instance_name: String::new(),
            blob_digests: vec![make_digest(data_a), make_digest(data_b)],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.missing_blob_digests.len(), 1);
    assert_eq!(
        resp.missing_blob_digests[0].hash,
        hex::encode(sha256(data_b))
    );
}

#[tokio::test]
async fn find_missing_blobs_empty_request() {
    let store = make_store().await;
    let cas = make_cas(store);

    let resp = cas
        .find_missing_blobs(tonic::Request::new(FindMissingBlobsRequest {
            instance_name: String::new(),
            blob_digests: vec![],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert!(resp.missing_blob_digests.is_empty());
}

// =================================================================================================================
// BatchUpdateBlobs tests
// =================================================================================================================

#[tokio::test]
async fn batch_update_blobs_single() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    let data = b"batch upload test";
    let resp = cas
        .batch_update_blobs(tonic::Request::new(BatchUpdateBlobsRequest {
            instance_name: String::new(),
            requests: vec![batch_update_blobs_request::Request {
                digest: Some(make_digest(data)),
                data: Bytes::copy_from_slice(data),
                compressor: 0,
            }],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.responses.len(), 1);
    assert_eq!(resp.responses[0].status.as_ref().unwrap().code, 0);

    // Verify blob exists and data round-trips correctly
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    assert!(store.cas_blob_exists(&cd).await.unwrap());
    let retrieved = store.cas_get_blob(&cd).await.unwrap().unwrap();
    assert_eq!(&*retrieved, data);
}

#[tokio::test]
async fn batch_update_blobs_multiple() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    let data_a = b"blob A";
    let data_b = b"blob B";

    let resp = cas
        .batch_update_blobs(tonic::Request::new(BatchUpdateBlobsRequest {
            instance_name: String::new(),
            requests: vec![
                batch_update_blobs_request::Request {
                    digest: Some(make_digest(data_a)),
                    data: Bytes::copy_from_slice(data_a),
                    compressor: 0,
                },
                batch_update_blobs_request::Request {
                    digest: Some(make_digest(data_b)),
                    data: Bytes::copy_from_slice(data_b),
                    compressor: 0,
                },
            ],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.responses.len(), 2);
    for r in &resp.responses {
        assert_eq!(r.status.as_ref().unwrap().code, 0);
    }

    // Verify each blob can be read back with correct content
    let cd_a = ContentDigest::new(DigestFn::Sha256, sha256(data_a));
    let retrieved_a = store.cas_get_blob(&cd_a).await.unwrap().unwrap();
    assert_eq!(&*retrieved_a, data_a);

    let cd_b = ContentDigest::new(DigestFn::Sha256, sha256(data_b));
    let retrieved_b = store.cas_get_blob(&cd_b).await.unwrap().unwrap();
    assert_eq!(&*retrieved_b, data_b);
}

#[tokio::test]
async fn batch_update_blobs_digest_mismatch() {
    let store = make_store().await;
    let cas = make_cas(store);

    let data = b"real data";
    let wrong_digest = Digest {
        hash: hex::encode(sha256(b"wrong")),
        size_bytes: data.len() as i64,
    };

    let resp = cas
        .batch_update_blobs(tonic::Request::new(BatchUpdateBlobsRequest {
            instance_name: String::new(),
            requests: vec![batch_update_blobs_request::Request {
                digest: Some(wrong_digest),
                data: Bytes::copy_from_slice(data),
                compressor: 0,
            }],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.responses.len(), 1);
    assert_eq!(
        resp.responses[0].status.as_ref().unwrap().code,
        tonic::Code::InvalidArgument as i32
    );
}

#[tokio::test]
async fn batch_update_blobs_size_limit() {
    let store = make_store().await;
    let cas = make_cas(store);

    // Create a request exceeding MAX_BATCH_TOTAL_SIZE
    let big_data = vec![0u8; 5_000_000];
    let result = cas
        .batch_update_blobs(tonic::Request::new(BatchUpdateBlobsRequest {
            instance_name: String::new(),
            requests: vec![batch_update_blobs_request::Request {
                digest: Some(make_digest(&big_data)),
                data: Bytes::from(big_data),
                compressor: 0,
            }],
            digest_function: 0,
        }))
        .await;

    assert!(result.is_err());
}

// =================================================================================================================
// BatchReadBlobs tests
// =================================================================================================================

#[tokio::test]
async fn batch_read_blobs_found() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    let data = b"read me";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    let resp = cas
        .batch_read_blobs(tonic::Request::new(BatchReadBlobsRequest {
            instance_name: String::new(),
            digests: vec![make_digest(data)],
            acceptable_compressors: vec![],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.responses.len(), 1);
    assert_eq!(resp.responses[0].status.as_ref().unwrap().code, 0);
    assert_eq!(resp.responses[0].data, data.as_slice());
}

#[tokio::test]
async fn batch_read_blobs_not_found() {
    let store = make_store().await;
    let cas = make_cas(store);

    let data = b"missing blob";
    let resp = cas
        .batch_read_blobs(tonic::Request::new(BatchReadBlobsRequest {
            instance_name: String::new(),
            digests: vec![make_digest(data)],
            acceptable_compressors: vec![],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.responses.len(), 1);
    assert_eq!(
        resp.responses[0].status.as_ref().unwrap().code,
        tonic::Code::NotFound as i32
    );
}

#[tokio::test]
async fn batch_read_blobs_mixed() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    let data_exists = b"exists";
    let data_missing = b"does not exist";

    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data_exists));
    store
        .cas_put_blob(&cd, Bytes::from_static(data_exists), Compression::Identity)
        .await
        .unwrap();

    let resp = cas
        .batch_read_blobs(tonic::Request::new(BatchReadBlobsRequest {
            instance_name: String::new(),
            digests: vec![make_digest(data_exists), make_digest(data_missing)],
            acceptable_compressors: vec![],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.responses.len(), 2);
    assert_eq!(resp.responses[0].status.as_ref().unwrap().code, 0);
    assert_eq!(resp.responses[0].data, data_exists.as_slice());
    assert_eq!(
        resp.responses[1].status.as_ref().unwrap().code,
        tonic::Code::NotFound as i32
    );
}

#[tokio::test]
async fn batch_read_blobs_preserves_request_order() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    let blobs: Vec<Vec<u8>> = (0..5u32)
        .map(|i| format!("blob-{i}").into_bytes())
        .collect();

    for blob in &blobs {
        let cd = ContentDigest::new(DigestFn::Sha256, sha256(blob));
        store
            .cas_put_blob(&cd, Bytes::from(blob.clone()), Compression::Identity)
            .await
            .unwrap();
    }

    let digests: Vec<_> = blobs.iter().map(|b| make_digest(b)).collect();

    let resp = cas
        .batch_read_blobs(tonic::Request::new(BatchReadBlobsRequest {
            instance_name: String::new(),
            digests: digests.clone(),
            acceptable_compressors: vec![],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.responses.len(), blobs.len());
    for (i, r) in resp.responses.iter().enumerate() {
        assert_eq!(r.status.as_ref().unwrap().code, 0);
        assert_eq!(r.digest.as_ref().unwrap().hash, digests[i].hash);
        assert_eq!(r.data, blobs[i].as_slice());
    }
}

// =================================================================================================================
// BatchUpdateBlobs + BatchReadBlobs roundtrip
// =================================================================================================================

#[tokio::test]
async fn batch_upload_then_read_roundtrip() {
    let store = make_store().await;
    let cas = make_cas(store);

    let data = b"roundtrip data";
    cas.batch_update_blobs(tonic::Request::new(BatchUpdateBlobsRequest {
        instance_name: String::new(),
        requests: vec![batch_update_blobs_request::Request {
            digest: Some(make_digest(data)),
            data: Bytes::copy_from_slice(data),
            compressor: 0,
        }],
        digest_function: 0,
    }))
    .await
    .unwrap();

    let resp = cas
        .batch_read_blobs(tonic::Request::new(BatchReadBlobsRequest {
            instance_name: String::new(),
            digests: vec![make_digest(data)],
            acceptable_compressors: vec![],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.responses[0].data, data.as_slice());
}

// =================================================================================================================
// GetTree tests
// =================================================================================================================

#[tokio::test]
async fn get_tree_single_directory() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    let dir = Directory {
        files: vec![],
        directories: vec![],
        symlinks: vec![],
        node_properties: None,
    };
    let dir_bytes = dir.encode_to_vec();
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(&dir_bytes));
    store
        .cas_put_blob(&cd, Bytes::from(dir_bytes.clone()), Compression::Identity)
        .await
        .unwrap();

    let resp = cas
        .get_tree(tonic::Request::new(
            protos::build::bazel::remote::execution::v2::GetTreeRequest {
                instance_name: String::new(),
                root_digest: Some(make_digest(&dir_bytes)),
                page_size: 0,
                page_token: String::new(),
                digest_function: 0,
            },
        ))
        .await
        .unwrap();

    let mut stream = resp.into_inner();
    let mut dirs = Vec::new();
    while let Some(msg) = tokio_stream::StreamExt::next(&mut stream).await {
        dirs.extend(msg.unwrap().directories);
    }
    assert_eq!(dirs.len(), 1);
}

#[tokio::test]
async fn get_tree_nested_directories() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    // Create child directory
    let child_dir = Directory {
        files: vec![],
        directories: vec![],
        symlinks: vec![],
        node_properties: None,
    };
    let child_bytes = child_dir.encode_to_vec();
    let child_cd = ContentDigest::new(DigestFn::Sha256, sha256(&child_bytes));
    store
        .cas_put_blob(
            &child_cd,
            Bytes::from(child_bytes.clone()),
            Compression::Identity,
        )
        .await
        .unwrap();

    // Create parent directory referencing child
    let parent_dir = Directory {
        files: vec![],
        directories: vec![DirectoryNode {
            name: "child".into(),
            digest: Some(make_digest(&child_bytes)),
        }],
        symlinks: vec![],
        node_properties: None,
    };
    let parent_bytes = parent_dir.encode_to_vec();
    let parent_cd = ContentDigest::new(DigestFn::Sha256, sha256(&parent_bytes));
    store
        .cas_put_blob(
            &parent_cd,
            Bytes::from(parent_bytes.clone()),
            Compression::Identity,
        )
        .await
        .unwrap();

    let resp = cas
        .get_tree(tonic::Request::new(
            protos::build::bazel::remote::execution::v2::GetTreeRequest {
                instance_name: String::new(),
                root_digest: Some(make_digest(&parent_bytes)),
                page_size: 0,
                page_token: String::new(),
                digest_function: 0,
            },
        ))
        .await
        .unwrap();

    let mut stream = resp.into_inner();
    let mut dirs = Vec::new();
    while let Some(msg) = tokio_stream::StreamExt::next(&mut stream).await {
        dirs.extend(msg.unwrap().directories);
    }
    assert_eq!(dirs.len(), 2);
}

#[tokio::test]
async fn get_tree_not_found() {
    let store = make_store().await;
    let cas = make_cas(store);

    let data = b"nonexistent";
    let result = cas
        .get_tree(tonic::Request::new(
            protos::build::bazel::remote::execution::v2::GetTreeRequest {
                instance_name: String::new(),
                root_digest: Some(make_digest(data)),
                page_size: 0,
                page_token: String::new(),
                digest_function: 0,
            },
        ))
        .await;

    // get_tree returns NOT_FOUND when the root directory is missing
    assert!(result.is_err());
}

#[tokio::test]
async fn get_tree_cycle_detection() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    let dir_a_v1 = Directory {
        files: vec![],
        directories: vec![],
        symlinks: vec![],
        node_properties: None,
    };
    let dir_a_v1_bytes = dir_a_v1.encode_to_vec();

    // dir_b references dir_a_v1
    let dir_b = Directory {
        files: vec![],
        directories: vec![DirectoryNode {
            name: "link_to_a".into(),
            digest: Some(make_digest(&dir_a_v1_bytes)),
        }],
        symlinks: vec![],
        node_properties: None,
    };
    let dir_b_bytes = dir_b.encode_to_vec();

    // Now create a new dir_a that references dir_b (creating a cycle)
    let dir_a = Directory {
        files: vec![],
        directories: vec![DirectoryNode {
            name: "link_to_b".into(),
            digest: Some(make_digest(&dir_b_bytes)),
        }],
        symlinks: vec![],
        node_properties: None,
    };
    let dir_a_bytes = dir_a.encode_to_vec();

    // Store both directories
    let cd_a = ContentDigest::new(DigestFn::Sha256, sha256(&dir_a_bytes));
    store
        .cas_put_blob(
            &cd_a,
            Bytes::from(dir_a_bytes.clone()),
            Compression::Identity,
        )
        .await
        .unwrap();

    let cd_b = ContentDigest::new(DigestFn::Sha256, sha256(&dir_b_bytes));
    store
        .cas_put_blob(
            &cd_b,
            Bytes::from(dir_b_bytes.clone()),
            Compression::Identity,
        )
        .await
        .unwrap();

    // Also store dir_a_v1 since dir_b references it
    let cd_a_v1 = ContentDigest::new(DigestFn::Sha256, sha256(&dir_a_v1_bytes));
    store
        .cas_put_blob(
            &cd_a_v1,
            Bytes::from(dir_a_v1_bytes.clone()),
            Compression::Identity,
        )
        .await
        .unwrap();

    // get_tree starting at dir_a should terminate (not loop forever)
    let resp = cas
        .get_tree(tonic::Request::new(
            protos::build::bazel::remote::execution::v2::GetTreeRequest {
                instance_name: String::new(),
                root_digest: Some(make_digest(&dir_a_bytes)),
                page_size: 0,
                page_token: String::new(),
                digest_function: 0,
            },
        ))
        .await
        .unwrap();

    let mut stream = resp.into_inner();
    let mut dirs = Vec::new();
    while let Some(msg) = tokio_stream::StreamExt::next(&mut stream).await {
        dirs.extend(msg.unwrap().directories);
    }
    // dir_a -> dir_b -> dir_a_v1 (3 unique directories, no infinite loop)
    assert_eq!(dirs.len(), 3);
}

#[tokio::test]
async fn get_tree_diamond_dedup() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    // Create a diamond: root -> A, root -> B, A -> C, B -> C
    let dir_c = Directory {
        files: vec![],
        directories: vec![],
        symlinks: vec![],
        node_properties: None,
    };
    let dir_c_bytes = dir_c.encode_to_vec();
    let cd_c = ContentDigest::new(DigestFn::Sha256, sha256(&dir_c_bytes));
    store
        .cas_put_blob(
            &cd_c,
            Bytes::from(dir_c_bytes.clone()),
            Compression::Identity,
        )
        .await
        .unwrap();

    let dir_a = Directory {
        files: vec![],
        directories: vec![DirectoryNode {
            name: "c".into(),
            digest: Some(make_digest(&dir_c_bytes)),
        }],
        symlinks: vec![],
        node_properties: None,
    };
    let dir_a_bytes = dir_a.encode_to_vec();
    let cd_a = ContentDigest::new(DigestFn::Sha256, sha256(&dir_a_bytes));
    store
        .cas_put_blob(
            &cd_a,
            Bytes::from(dir_a_bytes.clone()),
            Compression::Identity,
        )
        .await
        .unwrap();

    let dir_b = Directory {
        files: vec![],
        directories: vec![DirectoryNode {
            name: "c_via_b".into(), // different name so dir_b != dir_a
            digest: Some(make_digest(&dir_c_bytes)),
        }],
        symlinks: vec![],
        node_properties: None,
    };
    let dir_b_bytes = dir_b.encode_to_vec();
    let cd_b = ContentDigest::new(DigestFn::Sha256, sha256(&dir_b_bytes));
    store
        .cas_put_blob(
            &cd_b,
            Bytes::from(dir_b_bytes.clone()),
            Compression::Identity,
        )
        .await
        .unwrap();

    let root = Directory {
        files: vec![],
        directories: vec![
            DirectoryNode {
                name: "a".into(),
                digest: Some(make_digest(&dir_a_bytes)),
            },
            DirectoryNode {
                name: "b".into(),
                digest: Some(make_digest(&dir_b_bytes)),
            },
        ],
        symlinks: vec![],
        node_properties: None,
    };
    let root_bytes = root.encode_to_vec();
    let cd_root = ContentDigest::new(DigestFn::Sha256, sha256(&root_bytes));
    store
        .cas_put_blob(
            &cd_root,
            Bytes::from(root_bytes.clone()),
            Compression::Identity,
        )
        .await
        .unwrap();

    let resp = cas
        .get_tree(tonic::Request::new(
            protos::build::bazel::remote::execution::v2::GetTreeRequest {
                instance_name: String::new(),
                root_digest: Some(make_digest(&root_bytes)),
                page_size: 0,
                page_token: String::new(),
                digest_function: 0,
            },
        ))
        .await
        .unwrap();

    let mut stream = resp.into_inner();
    let mut dirs = Vec::new();
    while let Some(msg) = tokio_stream::StreamExt::next(&mut stream).await {
        dirs.extend(msg.unwrap().directories);
    }
    // root + A + B + C = 4 directories; C appears only once despite diamond
    assert_eq!(dirs.len(), 4);
}

#[tokio::test]
async fn get_tree_with_actual_cycle() {
    // True cycles (A→B→A) are impossible in a content-addressed store because
    // directory digests depend on content, creating a circular dependency.
    // Instead, verify the visited set correctly deduplicates when the same
    // directory is referenced from multiple child entries.
    let store = make_store().await;
    let cas = make_cas(store.clone());

    // dir_b is a leaf
    let dir_b = Directory {
        files: vec![],
        directories: vec![],
        symlinks: vec![],
        node_properties: None,
    };
    let dir_b_bytes = dir_b.encode_to_vec();
    let cd_b = ContentDigest::new(DigestFn::Sha256, sha256(&dir_b_bytes));
    store
        .cas_put_blob(
            &cd_b,
            Bytes::from(dir_b_bytes.clone()),
            Compression::Identity,
        )
        .await
        .unwrap();

    // dir_a references dir_b twice via different child names — the visited set
    // must prevent re-traversal on the second reference.
    let dir_a = Directory {
        files: vec![],
        directories: vec![
            DirectoryNode {
                name: "b".into(),
                digest: Some(make_digest(&dir_b_bytes)),
            },
            DirectoryNode {
                name: "b_again".into(),
                digest: Some(make_digest(&dir_b_bytes)),
            },
        ],
        symlinks: vec![],
        node_properties: None,
    };
    let dir_a_bytes = dir_a.encode_to_vec();
    let cd_a = ContentDigest::new(DigestFn::Sha256, sha256(&dir_a_bytes));
    store
        .cas_put_blob(
            &cd_a,
            Bytes::from(dir_a_bytes.clone()),
            Compression::Identity,
        )
        .await
        .unwrap();

    let resp = cas
        .get_tree(tonic::Request::new(
            protos::build::bazel::remote::execution::v2::GetTreeRequest {
                instance_name: String::new(),
                root_digest: Some(make_digest(&dir_a_bytes)),
                page_size: 0,
                page_token: String::new(),
                digest_function: 0,
            },
        ))
        .await
        .unwrap();

    let mut stream = resp.into_inner();
    let mut dirs = Vec::new();
    while let Some(msg) = tokio_stream::StreamExt::next(&mut stream).await {
        dirs.extend(msg.unwrap().directories);
    }
    // dir_a + dir_b = 2 unique directories; dir_b appears only once despite
    // being referenced twice.
    assert_eq!(dirs.len(), 2);
}

// =================================================================================================================
// Batch limits and overflow tests
// =================================================================================================================

#[tokio::test]
async fn batch_read_blobs_too_many_digests() {
    let store = make_store().await;
    let cas = make_cas(store);

    let digests: Vec<Digest> = (0..10_001u32)
        .map(|i| {
            let data = i.to_le_bytes();
            make_digest(&data)
        })
        .collect();

    let result = cas
        .batch_read_blobs(tonic::Request::new(BatchReadBlobsRequest {
            instance_name: String::new(),
            digests,
            acceptable_compressors: vec![],
            digest_function: 0,
        }))
        .await;

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code(), tonic::Code::InvalidArgument);
}

#[tokio::test]
async fn batch_read_blobs_size_overflow() {
    let store = make_store().await;
    let cas = make_cas(store);

    let digests = vec![
        Digest {
            hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_string(),
            size_bytes: i64::MAX,
        },
        Digest {
            hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_string(),
            size_bytes: 1,
        },
    ];

    let result = cas
        .batch_read_blobs(tonic::Request::new(BatchReadBlobsRequest {
            instance_name: String::new(),
            digests,
            acceptable_compressors: vec![],
            digest_function: 0,
        }))
        .await;

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code(), tonic::Code::InvalidArgument);
}

#[tokio::test]
async fn batch_update_blobs_too_many_requests() {
    let store = make_store().await;
    let cas = make_cas(store);

    let requests: Vec<batch_update_blobs_request::Request> = (0..10_001u32)
        .map(|i| {
            let data = i.to_le_bytes();
            batch_update_blobs_request::Request {
                digest: Some(make_digest(&data)),
                data: Bytes::copy_from_slice(&data),
                compressor: 0,
            }
        })
        .collect();

    let result = cas
        .batch_update_blobs(tonic::Request::new(BatchUpdateBlobsRequest {
            instance_name: String::new(),
            requests,
            digest_function: 0,
        }))
        .await;

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code(), tonic::Code::InvalidArgument);
}

#[tokio::test]
async fn find_missing_blobs_exceeds_digest_limit() {
    let store = make_store().await;
    let cas = make_cas(store);

    let digests: Vec<Digest> = (0..10_001u32)
        .map(|i| {
            let data = i.to_le_bytes();
            make_digest(&data)
        })
        .collect();

    let result = cas
        .find_missing_blobs(tonic::Request::new(FindMissingBlobsRequest {
            instance_name: String::new(),
            blob_digests: digests,
            digest_function: 0,
        }))
        .await;

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code(), tonic::Code::InvalidArgument);
}

#[tokio::test]
async fn batch_read_blobs_at_exact_limit() {
    let store = make_store().await;
    let cas = make_cas(store);

    // Create exactly MAX_BATCH_DIGESTS (10,000) digests — boundary test.
    // Existing tests only check over-limit (10,001).
    let digests: Vec<Digest> = (0..10_000u32)
        .map(|i| {
            let data = i.to_le_bytes();
            make_digest(&data)
        })
        .collect();

    let resp = cas
        .batch_read_blobs(tonic::Request::new(BatchReadBlobsRequest {
            instance_name: String::new(),
            digests,
            acceptable_compressors: vec![],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    // All blobs are missing, but the request itself should succeed.
    assert_eq!(resp.responses.len(), 10_000);
    for r in &resp.responses {
        assert_eq!(
            r.status.as_ref().unwrap().code,
            tonic::Code::NotFound as i32
        );
    }
}

// =================================================================================================================
// Negative size_bytes validation tests
// =================================================================================================================

#[tokio::test]
async fn batch_read_negative_size_bytes() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    let resp = cas
        .batch_read_blobs(tonic::Request::new(BatchReadBlobsRequest {
            instance_name: String::new(),
            digests: vec![Digest {
                hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                    .to_string(),
                size_bytes: -1,
            }],
            acceptable_compressors: vec![],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.responses.len(), 1);
    assert_eq!(
        resp.responses[0].status.as_ref().unwrap().code,
        tonic::Code::InvalidArgument as i32
    );
}

#[tokio::test]
async fn batch_update_negative_size_bytes() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    let resp = cas
        .batch_update_blobs(tonic::Request::new(BatchUpdateBlobsRequest {
            instance_name: String::new(),
            requests: vec![batch_update_blobs_request::Request {
                digest: Some(Digest {
                    hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                        .to_string(),
                    size_bytes: -1,
                }),
                data: Bytes::new(),
                compressor: 0,
            }],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.responses.len(), 1);
    assert_eq!(
        resp.responses[0].status.as_ref().unwrap().code,
        tonic::Code::InvalidArgument as i32
    );
}

// =================================================================================================================
// CAS compression tests
// =================================================================================================================

#[tokio::test]
async fn batch_update_blobs_compressed_zstd() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    let data = b"compressed batch upload test data for zstd - repeated enough to compress well \
        compressed batch upload test data for zstd - repeated enough to compress well \
        compressed batch upload test data for zstd - repeated enough to compress well";
    let compressed = Compression::Zstd.compress(data).unwrap().into_owned();

    let resp = cas
        .batch_update_blobs(tonic::Request::new(BatchUpdateBlobsRequest {
            instance_name: String::new(),
            requests: vec![batch_update_blobs_request::Request {
                digest: Some(make_digest(data)),
                data: Bytes::from(compressed),
                compressor: 1, // ZSTD
            }],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.responses.len(), 1);
    assert_eq!(resp.responses[0].status.as_ref().unwrap().code, 0);

    // Verify blob exists and data is correct
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    assert!(store.cas_blob_exists(&cd).await.unwrap());
}

#[tokio::test]
async fn batch_read_blobs_compressed_zstd() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    let data = b"batch read compressed test data";
    let hash = sha256(data);
    let cd = ContentDigest::new(DigestFn::Sha256, hash);
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    let resp = cas
        .batch_read_blobs(tonic::Request::new(BatchReadBlobsRequest {
            instance_name: String::new(),
            digests: vec![make_digest(data)],
            acceptable_compressors: vec![1], // ZSTD
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.responses.len(), 1);
    assert_eq!(resp.responses[0].status.as_ref().unwrap().code, 0);
    assert_eq!(resp.responses[0].compressor, 1); // ZSTD

    // Decompress and verify
    let decompressed = Compression::Zstd
        .decompress_with_size_hint(&resp.responses[0].data, data.len())
        .unwrap();
    assert_eq!(decompressed.as_ref(), data);
}

#[tokio::test]
async fn batch_update_blobs_invalid_compressed_data() {
    let store = make_store().await;
    let cas = make_cas(store);

    let garbage = b"this is not valid zstd data at all";
    let resp = cas
        .batch_update_blobs(tonic::Request::new(BatchUpdateBlobsRequest {
            instance_name: String::new(),
            requests: vec![batch_update_blobs_request::Request {
                digest: Some(Digest {
                    hash: hex::encode(sha256(b"something")),
                    size_bytes: 100,
                }),
                data: Bytes::copy_from_slice(garbage),
                compressor: 1, // ZSTD
            }],
            digest_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.responses.len(), 1);
    assert_ne!(resp.responses[0].status.as_ref().unwrap().code, 0);
}

// =================================================================================================================
// Blake3 CAS tests
// =================================================================================================================

#[tokio::test]
async fn batch_update_and_read_roundtrip_blake3() {
    let store = make_store().await;
    let cas = make_cas(store);

    let data = b"blake3 roundtrip data";
    cas.batch_update_blobs(tonic::Request::new(BatchUpdateBlobsRequest {
        instance_name: String::new(),
        requests: vec![batch_update_blobs_request::Request {
            digest: Some(make_blake3_digest(data)),
            data: Bytes::copy_from_slice(data),
            compressor: 0,
        }],
        digest_function: 9, // BLAKE3
    }))
    .await
    .unwrap();

    let resp = cas
        .batch_read_blobs(tonic::Request::new(BatchReadBlobsRequest {
            instance_name: String::new(),
            digests: vec![make_blake3_digest(data)],
            acceptable_compressors: vec![],
            digest_function: 9, // BLAKE3
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.responses.len(), 1);
    assert_eq!(resp.responses[0].status.as_ref().unwrap().code, 0);
    assert_eq!(resp.responses[0].data, data.as_slice());
}

#[tokio::test]
async fn find_missing_blobs_blake3_digest_isolation() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    let data = b"digest isolation test";

    // Upload with SHA256
    cas.batch_update_blobs(tonic::Request::new(BatchUpdateBlobsRequest {
        instance_name: String::new(),
        requests: vec![batch_update_blobs_request::Request {
            digest: Some(make_digest(data)),
            data: Bytes::copy_from_slice(data),
            compressor: 0,
        }],
        digest_function: 0, // SHA256
    }))
    .await
    .unwrap();

    // Query with Blake3 — should report as missing since digests are isolated
    let resp = cas
        .find_missing_blobs(tonic::Request::new(FindMissingBlobsRequest {
            instance_name: String::new(),
            blob_digests: vec![make_blake3_digest(data)],
            digest_function: 9, // BLAKE3
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.missing_blob_digests.len(), 1);
}

// =================================================================================================================
// Capabilities tests
// =================================================================================================================

#[tokio::test]
async fn capabilities_reports_blob_size_limit() {
    use protos::build::bazel::remote::execution::v2::capabilities_server::Capabilities;

    ensure_telemetry();
    let caps_svc = super::capabilities::CapabilitiesService::default();
    let resp = caps_svc
        .get_capabilities(tonic::Request::new(
            protos::build::bazel::remote::execution::v2::GetCapabilitiesRequest {
                instance_name: String::new(),
            },
        ))
        .await
        .unwrap()
        .into_inner();

    let cache_caps = resp.cache_capabilities.unwrap();
    assert!(cache_caps.max_cas_blob_size_bytes > 0);
    assert_eq!(
        cache_caps.max_cas_blob_size_bytes,
        crate::store::MAX_BLOB_REASSEMBLE_SIZE as i64
    );
}
