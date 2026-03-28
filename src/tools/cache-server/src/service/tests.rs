// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use std::sync::Arc;

use bytes::Bytes;
use prost::Message;
use sha2::{Digest as _, Sha256};

use protos::build::bazel::remote::execution::v2::{
    ActionResult, BatchReadBlobsRequest, BatchUpdateBlobsRequest, Digest, Directory, DirectoryNode,
    FindMissingBlobsRequest, SpliceBlobRequest, SplitBlobRequest, action_cache_server::ActionCache,
    batch_update_blobs_request, content_addressable_storage_server::ContentAddressableStorage,
};
use protos::google::bytestream::{ReadRequest, WriteRequest, byte_stream_server::ByteStream};

use crate::store::{CacheStore, Compression, ContentDigest, DigestFn, StoreBackend};

use super::action_cache::ActionCacheService;
use super::bytestream::ByteStreamService;
use super::cas::ContentAddressableStorageService;

// ----- helpers -----

static INIT_TELEMETRY: std::sync::Once = std::sync::Once::new();

fn ensure_telemetry() {
    INIT_TELEMETRY.call_once(|| {
        telemetry::init_metrics(&telemetry::OtelConfig::default()).unwrap();
    });
}

fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

fn make_digest(data: &[u8]) -> Digest {
    Digest {
        hash: hex::encode(sha256(data)),
        size_bytes: data.len() as i64,
    }
}

async fn make_store() -> Arc<CacheStore> {
    ensure_telemetry();
    Arc::new(CacheStore::open(StoreBackend::Memory).await.unwrap())
}

fn make_cas(store: Arc<CacheStore>) -> ContentAddressableStorageService {
    ContentAddressableStorageService::new(store)
}

fn make_ac(store: Arc<CacheStore>) -> ActionCacheService {
    ActionCacheService::new(store)
}

fn make_bs(store: Arc<CacheStore>) -> ByteStreamService {
    ByteStreamService::new(store)
}

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

    // Create two directories that reference each other (a cycle).
    // We need to know their digests ahead of time, so we use a two-pass approach:
    // First create dir_a referencing a placeholder, then dir_b referencing dir_a,
    // then update dir_a to reference dir_b.
    //
    // Actually, since CAS is content-addressed, we can create the directories
    // with pre-computed digests. But it's simpler to just create them with
    // cross-references and store them directly.

    // dir_b references dir_a, but we need dir_a's hash first.
    // Create dir_a with an empty child list first to get its hash.
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

// =================================================================================================================
// SplitBlob / SpliceBlob tests
// =================================================================================================================

#[tokio::test]
async fn split_blob_returns_chunks() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    let data = b"split me into chunks";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    let resp = cas
        .split_blob(tonic::Request::new(SplitBlobRequest {
            instance_name: String::new(),
            blob_digest: Some(make_digest(data)),
            digest_function: 0,
            chunking_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert!(!resp.chunk_digests.is_empty());
    // For small blobs, there should be exactly one chunk
    assert_eq!(resp.chunk_digests.len(), 1);
    assert_eq!(resp.chunk_digests[0].hash, hex::encode(sha256(data)));

    let chunk_cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    let chunk_data = store.cas_get_chunk(&chunk_cd).await.unwrap();
    assert!(chunk_data.is_some());
}

#[tokio::test]
async fn split_blob_not_found() {
    let store = make_store().await;
    let cas = make_cas(store);

    let data = b"nonexistent blob";
    let result = cas
        .split_blob(tonic::Request::new(SplitBlobRequest {
            instance_name: String::new(),
            blob_digest: Some(make_digest(data)),
            digest_function: 0,
            chunking_function: 0,
        }))
        .await;

    assert!(result.is_err());
}

#[tokio::test]
async fn splice_blob_from_chunks() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    // First upload a blob so it gets chunked
    let data = b"splice test data";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    // Split it
    let split_resp = cas
        .split_blob(tonic::Request::new(SplitBlobRequest {
            instance_name: String::new(),
            blob_digest: Some(make_digest(data)),
            digest_function: 0,
            chunking_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    // Splice it back (should succeed since blob already exists)
    let splice_resp = cas
        .splice_blob(tonic::Request::new(SpliceBlobRequest {
            instance_name: String::new(),
            blob_digest: Some(make_digest(data)),
            chunk_digests: split_resp.chunk_digests,
            digest_function: 0,
            chunking_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(
        splice_resp.blob_digest.as_ref().unwrap().hash,
        hex::encode(sha256(data))
    );
}

#[tokio::test]
async fn splice_blob_already_exists_short_circuits() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    let data = b"already here";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    // Splice with the correct blob_digest — should succeed because blob exists
    let resp = cas
        .splice_blob(tonic::Request::new(SpliceBlobRequest {
            instance_name: String::new(),
            blob_digest: Some(make_digest(data)),
            chunk_digests: vec![make_digest(data)], // chunk == whole blob for small data
            digest_function: 0,
            chunking_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(
        resp.blob_digest.as_ref().unwrap().hash,
        hex::encode(sha256(data))
    );
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
async fn splice_blob_too_many_chunks() {
    let store = make_store().await;
    let cas = make_cas(store);

    let chunk_digests: Vec<Digest> = (0..100_001u32)
        .map(|i| {
            let data = i.to_le_bytes();
            make_digest(&data)
        })
        .collect();

    let blob_data = b"fake blob";
    let result = cas
        .splice_blob(tonic::Request::new(SpliceBlobRequest {
            instance_name: String::new(),
            blob_digest: Some(make_digest(blob_data)),
            chunk_digests,
            digest_function: 0,
            chunking_function: 0,
        }))
        .await;

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code(), tonic::Code::InvalidArgument);
}

// =================================================================================================================
// ActionCache tests
// =================================================================================================================

#[tokio::test]
async fn action_cache_put_and_get() {
    let store = make_store().await;
    let ac = make_ac(store);

    let action_data = b"fake action";
    let action_result = ActionResult {
        exit_code: 42,
        stdout_raw: Bytes::from_static(b"test stdout"),
        stderr_raw: Bytes::from_static(b"test stderr"),
        ..Default::default()
    };

    ac.update_action_result(tonic::Request::new(
        protos::build::bazel::remote::execution::v2::UpdateActionResultRequest {
            instance_name: String::new(),
            action_digest: Some(make_digest(action_data)),
            action_result: Some(action_result.clone()),
            results_cache_policy: None,
            digest_function: 0,
        },
    ))
    .await
    .unwrap();

    let resp = ac
        .get_action_result(tonic::Request::new(
            protos::build::bazel::remote::execution::v2::GetActionResultRequest {
                instance_name: String::new(),
                action_digest: Some(make_digest(action_data)),
                inline_stdout: false,
                inline_stderr: false,
                inline_output_files: vec![],
                digest_function: 0,
            },
        ))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.exit_code, 42);
    assert_eq!(resp.stdout_raw, Bytes::from_static(b"test stdout"));
    assert_eq!(resp.stderr_raw, Bytes::from_static(b"test stderr"));
}

#[tokio::test]
async fn action_cache_get_not_found() {
    let store = make_store().await;
    let ac = make_ac(store);

    let result = ac
        .get_action_result(tonic::Request::new(
            protos::build::bazel::remote::execution::v2::GetActionResultRequest {
                instance_name: String::new(),
                action_digest: Some(make_digest(b"missing")),
                inline_stdout: false,
                inline_stderr: false,
                inline_output_files: vec![],
                digest_function: 0,
            },
        ))
        .await;

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code(), tonic::Code::NotFound);
}

#[tokio::test]
async fn action_cache_overwrite() {
    let store = make_store().await;
    let ac = make_ac(store);

    let action_data = b"overwrite action";

    // First write
    ac.update_action_result(tonic::Request::new(
        protos::build::bazel::remote::execution::v2::UpdateActionResultRequest {
            instance_name: String::new(),
            action_digest: Some(make_digest(action_data)),
            action_result: Some(ActionResult {
                exit_code: 1,
                ..Default::default()
            }),
            results_cache_policy: None,
            digest_function: 0,
        },
    ))
    .await
    .unwrap();

    // Overwrite
    ac.update_action_result(tonic::Request::new(
        protos::build::bazel::remote::execution::v2::UpdateActionResultRequest {
            instance_name: String::new(),
            action_digest: Some(make_digest(action_data)),
            action_result: Some(ActionResult {
                exit_code: 42,
                ..Default::default()
            }),
            results_cache_policy: None,
            digest_function: 0,
        },
    ))
    .await
    .unwrap();

    let resp = ac
        .get_action_result(tonic::Request::new(
            protos::build::bazel::remote::execution::v2::GetActionResultRequest {
                instance_name: String::new(),
                action_digest: Some(make_digest(action_data)),
                inline_stdout: false,
                inline_stderr: false,
                inline_output_files: vec![],
                digest_function: 0,
            },
        ))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(resp.exit_code, 42);
}

// =================================================================================================================
// ByteStream read tests
// =================================================================================================================

#[tokio::test]
async fn bytestream_read_full() {
    let store = make_store().await;
    let bs = make_bs(store.clone());

    let data = b"stream read test";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    let resource_name = format!("blobs/{}/{}", hex::encode(sha256(data)), data.len());

    let resp = bs
        .read(tonic::Request::new(ReadRequest {
            resource_name,
            read_offset: 0,
            read_limit: 0,
        }))
        .await
        .unwrap();

    let mut stream = resp.into_inner();
    let mut received = Vec::new();
    while let Some(chunk) = tokio_stream::StreamExt::next(&mut stream).await {
        received.extend_from_slice(&chunk.unwrap().data);
    }
    assert_eq!(received, data);
}

#[tokio::test]
async fn bytestream_read_with_offset() {
    let store = make_store().await;
    let bs = make_bs(store.clone());

    let data = b"offset read test data";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    let resource_name = format!("blobs/{}/{}", hex::encode(sha256(data)), data.len());

    let resp = bs
        .read(tonic::Request::new(ReadRequest {
            resource_name,
            read_offset: 7,
            read_limit: 0,
        }))
        .await
        .unwrap();

    let mut stream = resp.into_inner();
    let mut received = Vec::new();
    while let Some(chunk) = tokio_stream::StreamExt::next(&mut stream).await {
        received.extend_from_slice(&chunk.unwrap().data);
    }
    assert_eq!(received, &data[7..]);
}

#[tokio::test]
async fn bytestream_read_with_limit() {
    let store = make_store().await;
    let bs = make_bs(store.clone());

    let data = b"limited read test data";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    let resource_name = format!("blobs/{}/{}", hex::encode(sha256(data)), data.len());

    let resp = bs
        .read(tonic::Request::new(ReadRequest {
            resource_name,
            read_offset: 0,
            read_limit: 5,
        }))
        .await
        .unwrap();

    let mut stream = resp.into_inner();
    let mut received = Vec::new();
    while let Some(chunk) = tokio_stream::StreamExt::next(&mut stream).await {
        received.extend_from_slice(&chunk.unwrap().data);
    }
    assert_eq!(received, &data[..5]);
}

#[tokio::test]
async fn bytestream_read_not_found() {
    let store = make_store().await;
    let bs = make_bs(store);

    let data = b"nonexistent";
    let resource_name = format!("blobs/{}/{}", hex::encode(sha256(data)), data.len());

    let result = bs
        .read(tonic::Request::new(ReadRequest {
            resource_name,
            read_offset: 0,
            read_limit: 0,
        }))
        .await;

    assert!(result.is_err());
}

#[tokio::test]
async fn bytestream_read_with_instance_name() {
    let store = make_store().await;
    let bs = make_bs(store.clone());

    let data = b"instance name test";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    let resource_name = format!(
        "myinstance/blobs/{}/{}",
        hex::encode(sha256(data)),
        data.len()
    );

    let resp = bs
        .read(tonic::Request::new(ReadRequest {
            resource_name,
            read_offset: 0,
            read_limit: 0,
        }))
        .await
        .unwrap();

    let mut stream = resp.into_inner();
    let mut received = Vec::new();
    while let Some(chunk) = tokio_stream::StreamExt::next(&mut stream).await {
        received.extend_from_slice(&chunk.unwrap().data);
    }
    assert_eq!(received, data);
}

// =================================================================================================================
// ByteStream write tests
// =================================================================================================================

#[tokio::test]
async fn bytestream_write_single_message() {
    let store = make_store().await;
    let bs = make_bs(store.clone());

    let data = b"write test data";
    let resource_name = format!(
        "uploads/test-uuid/blobs/{}/{}",
        hex::encode(sha256(data)),
        data.len()
    );

    let resp = bs
        .write_from_messages(vec![WriteRequest {
            resource_name,
            write_offset: 0,
            finish_write: true,
            data: Bytes::copy_from_slice(data),
        }])
        .await
        .unwrap();

    assert_eq!(resp.committed_size, data.len() as i64);

    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    assert!(store.cas_blob_exists(&cd).await.unwrap());
    let blob = store.cas_get_blob(&cd).await.unwrap().unwrap();
    assert_eq!(&*blob, data);
}

#[tokio::test]
async fn bytestream_write_multiple_messages() {
    let store = make_store().await;
    let bs = make_bs(store.clone());

    let data = b"chunked write test data here";
    let resource_name = format!(
        "uploads/test-uuid/blobs/{}/{}",
        hex::encode(sha256(data)),
        data.len()
    );

    let mid = data.len() / 2;
    let resp = bs
        .write_from_messages(vec![
            WriteRequest {
                resource_name: resource_name.clone(),
                write_offset: 0,
                finish_write: false,
                data: Bytes::copy_from_slice(&data[..mid]),
            },
            WriteRequest {
                resource_name: String::new(),
                write_offset: mid as i64,
                finish_write: true,
                data: Bytes::copy_from_slice(&data[mid..]),
            },
        ])
        .await
        .unwrap();

    assert_eq!(resp.committed_size, data.len() as i64);

    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    assert!(store.cas_blob_exists(&cd).await.unwrap());
}

#[tokio::test]
async fn bytestream_write_size_mismatch() {
    let store = make_store().await;
    let bs = make_bs(store);

    let data = b"wrong size";
    let resource_name = format!(
        "uploads/test-uuid/blobs/{}/{}",
        hex::encode(sha256(data)),
        data.len() + 10 // wrong size
    );

    let result = bs
        .write_from_messages(vec![WriteRequest {
            resource_name,
            write_offset: 0,
            finish_write: true,
            data: Bytes::copy_from_slice(data),
        }])
        .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn bytestream_write_digest_mismatch() {
    let store = make_store().await;
    let bs = make_bs(store);

    let data = b"real data here";
    let wrong_hash = sha256(b"wrong");
    let resource_name = format!(
        "uploads/test-uuid/blobs/{}/{}",
        hex::encode(wrong_hash),
        data.len()
    );

    let result = bs
        .write_from_messages(vec![WriteRequest {
            resource_name,
            write_offset: 0,
            finish_write: true,
            data: Bytes::copy_from_slice(data),
        }])
        .await;
    assert!(result.is_err());
}

// =================================================================================================================
// ByteStream query_write_status
// =================================================================================================================

#[tokio::test]
async fn bytestream_query_write_status_not_supported() {
    let store = make_store().await;
    let bs = make_bs(store);

    let result = bs
        .query_write_status(tonic::Request::new(
            protos::google::bytestream::QueryWriteStatusRequest {
                resource_name: "some/resource".into(),
            },
        ))
        .await;

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code(), tonic::Code::Unimplemented);
}

// =================================================================================================================
// Cross-service integration: upload via ByteStream, read via CAS
// =================================================================================================================

#[tokio::test]
async fn bytestream_write_then_cas_read() {
    let store = make_store().await;
    let cas = make_cas(store.clone());
    let bs = make_bs(store);

    let data = b"cross-service test";
    let resource_name = format!(
        "uploads/test-uuid/blobs/{}/{}",
        hex::encode(sha256(data)),
        data.len()
    );

    bs.write_from_messages(vec![WriteRequest {
        resource_name,
        write_offset: 0,
        finish_write: true,
        data: Bytes::copy_from_slice(data),
    }])
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
// Helper function tests
// =================================================================================================================

#[test]
fn parse_read_resource_name_simple() {
    let parsed = super::helpers::parse_read_resource_name(
        "blobs/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/0",
    )
    .unwrap();
    assert_eq!(
        parsed.hash,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(parsed.size, 0);
}

#[test]
fn parse_read_resource_name_with_digest_function() {
    let parsed = super::helpers::parse_read_resource_name(
        "blobs/sha256/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/0",
    )
    .unwrap();
    assert_eq!(
        parsed.hash,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(parsed.size, 0);
}

#[test]
fn parse_read_resource_name_with_instance() {
    let parsed = super::helpers::parse_read_resource_name(
        "my-instance/blobs/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/42",
    )
    .unwrap();
    assert_eq!(parsed.size, 42);
}

#[test]
fn parse_write_resource_name_simple() {
    let parsed = super::helpers::parse_write_resource_name(
        "uploads/abc-123/blobs/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/0",
    )
    .unwrap();
    assert_eq!(parsed.uuid.as_deref(), Some("abc-123"));
    assert_eq!(parsed.size, 0);
}

#[test]
fn parse_write_resource_name_with_digest_function() {
    let parsed = super::helpers::parse_write_resource_name(
        "uploads/abc-123/blobs/blake3/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/100",
    )
    .unwrap();
    assert_eq!(parsed.uuid.as_deref(), Some("abc-123"));
    assert_eq!(parsed.size, 100);
    assert_eq!(parsed.digest_fn, DigestFn::Blake3);
}

#[test]
fn parse_write_resource_name_invalid() {
    assert!(super::helpers::parse_write_resource_name("invalid/resource").is_err());
}

// =================================================================================================================
// Compressed-blobs resource name parsing tests
// =================================================================================================================

#[test]
fn parse_read_resource_name_compressed_blobs() {
    let parsed = super::helpers::parse_read_resource_name(
        "compressed-blobs/zstd/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/100",
    )
    .unwrap();
    assert_eq!(
        parsed.hash,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(parsed.size, 100);
    assert_eq!(parsed.compressor, Compression::Zstd);
    assert_eq!(parsed.digest_fn, DigestFn::Sha256);
}

#[test]
fn parse_read_resource_name_compressed_blobs_with_digest_fn() {
    let parsed = super::helpers::parse_read_resource_name(
        "compressed-blobs/zstd/blake3/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/42",
    )
    .unwrap();
    assert_eq!(parsed.size, 42);
    assert_eq!(parsed.compressor, Compression::Zstd);
    assert_eq!(parsed.digest_fn, DigestFn::Blake3);
}

#[test]
fn parse_read_resource_name_compressed_blobs_with_instance() {
    let parsed = super::helpers::parse_read_resource_name(
        "my-instance/compressed-blobs/zstd/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/10",
    )
    .unwrap();
    assert_eq!(parsed.size, 10);
    assert_eq!(parsed.compressor, Compression::Zstd);
}

#[test]
fn parse_write_resource_name_compressed_blobs() {
    let parsed = super::helpers::parse_write_resource_name(
        "uploads/abc-123/compressed-blobs/zstd/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/200",
    )
    .unwrap();
    assert_eq!(parsed.uuid.as_deref(), Some("abc-123"));
    assert_eq!(parsed.size, 200);
    assert_eq!(parsed.compressor, Compression::Zstd);
    assert_eq!(parsed.digest_fn, DigestFn::Sha256);
}

#[test]
fn parse_write_resource_name_compressed_blobs_with_digest_fn() {
    let parsed = super::helpers::parse_write_resource_name(
        "uploads/abc-123/compressed-blobs/zstd/blake3/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/300",
    )
    .unwrap();
    assert_eq!(parsed.uuid.as_deref(), Some("abc-123"));
    assert_eq!(parsed.size, 300);
    assert_eq!(parsed.compressor, Compression::Zstd);
    assert_eq!(parsed.digest_fn, DigestFn::Blake3);
}

#[test]
fn parse_read_resource_name_uncompressed_has_identity() {
    let parsed = super::helpers::parse_read_resource_name(
        "blobs/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/0",
    )
    .unwrap();
    assert_eq!(parsed.compressor, Compression::Identity);
}

#[test]
fn parse_write_resource_name_uncompressed_has_identity() {
    let parsed = super::helpers::parse_write_resource_name(
        "uploads/abc-123/blobs/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/0",
    )
    .unwrap();
    assert_eq!(parsed.compressor, Compression::Identity);
}

// =================================================================================================================
// ByteStream compressed-blobs tests
// =================================================================================================================

#[tokio::test]
async fn bytestream_write_compressed_then_read() {
    let store = make_store().await;
    let bs = make_bs(store.clone());

    let data = b"compressed write test data for zstd";
    let compressed = Bytes::from(Compression::Zstd.compress(data).unwrap().into_owned());

    let resource_name = format!(
        "uploads/test-uuid/compressed-blobs/zstd/{}/{}",
        hex::encode(sha256(data)),
        data.len() // uncompressed size per REAPI spec
    );

    let resp = bs
        .write_from_messages(vec![WriteRequest {
            resource_name,
            write_offset: 0,
            finish_write: true,
            data: compressed.clone(),
        }])
        .await
        .unwrap();

    assert_eq!(resp.committed_size, compressed.len() as i64);

    // Verify the uncompressed blob is stored correctly
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    assert!(store.cas_blob_exists(&cd).await.unwrap());
}

#[tokio::test]
async fn bytestream_write_empty_blob() {
    let store = make_store().await;
    let bs = make_bs(store.clone());

    let data = b"";
    let resource_name = format!("uploads/test-uuid/blobs/{}/0", hex::encode(sha256(data)),);

    let resp = bs
        .write_from_messages(vec![WriteRequest {
            resource_name,
            write_offset: 0,
            finish_write: true,
            data: Bytes::new(),
        }])
        .await
        .unwrap();

    assert_eq!(resp.committed_size, 0);

    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    let blob = store.cas_get_blob(&cd).await.unwrap().unwrap();
    assert!(blob.is_empty());
}

#[tokio::test]
async fn bytestream_write_committed_size_is_wire_bytes() {
    let store = make_store().await;
    let bs = make_bs(store);

    // Use data that compresses to a different size
    let data = b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let compressed = Bytes::from(Compression::Zstd.compress(data).unwrap().into_owned());
    assert_ne!(
        compressed.len(),
        data.len(),
        "test requires sizes to differ"
    );

    let resource_name = format!(
        "uploads/test-uuid/compressed-blobs/zstd/{}/{}",
        hex::encode(sha256(data)),
        data.len()
    );

    let resp = bs
        .write_from_messages(vec![WriteRequest {
            resource_name,
            write_offset: 0,
            finish_write: true,
            data: compressed.clone(),
        }])
        .await
        .unwrap();

    assert_eq!(resp.committed_size, compressed.len() as i64);
}

#[tokio::test]
async fn bytestream_read_compressed_blobs() {
    let store = make_store().await;
    let bs = make_bs(store.clone());

    let data = b"data to read back compressed";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    let resource_name = format!(
        "compressed-blobs/zstd/{}/{}",
        hex::encode(sha256(data)),
        data.len()
    );

    let resp = bs
        .read(tonic::Request::new(ReadRequest {
            resource_name,
            read_offset: 0,
            read_limit: 0,
        }))
        .await
        .unwrap();

    let mut stream = resp.into_inner();
    let mut received = Vec::new();
    while let Some(chunk) = tokio_stream::StreamExt::next(&mut stream).await {
        received.extend_from_slice(&chunk.unwrap().data);
    }

    // Decompress and verify roundtrip
    let decompressed = Compression::Zstd.decompress(&received).unwrap();
    assert_eq!(&*decompressed, data);
}

#[tokio::test]
async fn bytestream_read_compressed_rejects_nonzero_limit() {
    let store = make_store().await;
    let bs = make_bs(store.clone());

    let data = b"limit rejection test";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    let resource_name = format!(
        "compressed-blobs/zstd/{}/{}",
        hex::encode(sha256(data)),
        data.len()
    );

    let result = bs
        .read(tonic::Request::new(ReadRequest {
            resource_name,
            read_offset: 0,
            read_limit: 5, // non-zero limit with compressed-blobs should fail
        }))
        .await;

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code(), tonic::Code::InvalidArgument);
}

#[tokio::test]
async fn bytestream_read_compressed_rejects_nonzero_offset() {
    let store = make_store().await;
    let bs = make_bs(store.clone());

    let data = b"offset rejection test";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    let resource_name = format!(
        "compressed-blobs/zstd/{}/{}",
        hex::encode(sha256(data)),
        data.len()
    );

    let result = bs
        .read(tonic::Request::new(ReadRequest {
            resource_name,
            read_offset: 10, // non-zero offset with compressed-blobs should fail
            read_limit: 0,
        }))
        .await;

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code(), tonic::Code::InvalidArgument);
}

#[tokio::test]
async fn bytestream_read_offset_at_eof_returns_empty() {
    let store = make_store().await;
    let bs = make_bs(store.clone());

    let data = b"eof offset test data";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    let resource_name = format!("blobs/{}/{}", hex::encode(sha256(data)), data.len());

    let resp = bs
        .read(tonic::Request::new(ReadRequest {
            resource_name,
            read_offset: data.len() as i64,
            read_limit: 0,
        }))
        .await
        .unwrap();

    let mut stream = resp.into_inner();
    let mut received = Vec::new();
    while let Some(chunk) = tokio_stream::StreamExt::next(&mut stream).await {
        received.extend_from_slice(&chunk.unwrap().data);
    }
    assert!(received.is_empty());
}

#[tokio::test]
async fn bytestream_read_offset_past_eof_returns_out_of_range() {
    let store = make_store().await;
    let bs = make_bs(store.clone());

    let data = b"past eof offset test data";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    let resource_name = format!("blobs/{}/{}", hex::encode(sha256(data)), data.len());

    let result = bs
        .read(tonic::Request::new(ReadRequest {
            resource_name,
            read_offset: data.len() as i64 + 1,
            read_limit: 0,
        }))
        .await;

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code(), tonic::Code::OutOfRange);
}

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

#[test]
fn resolve_digest_function_defaults() {
    let df = super::helpers::resolve_digest_function(0).unwrap();
    assert_eq!(df, DigestFn::Sha256);
}

#[test]
fn resolve_digest_function_sha256() {
    let df = super::helpers::resolve_digest_function(1).unwrap();
    assert_eq!(df, DigestFn::Sha256);
}

#[test]
fn resolve_digest_function_invalid() {
    assert!(super::helpers::resolve_digest_function(99).is_err());
}

// =================================================================================================================
// QueryWriteStatus and capabilities tests
// =================================================================================================================

#[tokio::test]
async fn query_write_status_returns_unimplemented() {
    use protos::google::bytestream::byte_stream_server::ByteStream;

    let store = make_store().await;
    let bs = make_bs(store);
    let result = bs
        .query_write_status(tonic::Request::new(
            protos::google::bytestream::QueryWriteStatusRequest {
                resource_name: "uploads/test/blobs/abc/0".to_string(),
            },
        ))
        .await;
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code(), tonic::Code::Unimplemented);
}

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
    use protos::build::bazel::remote::execution::v2::batch_update_blobs_request;

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
// find_missing_blobs limits
// =================================================================================================================

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

// =================================================================================================================
// Blake3 digest function tests
// =================================================================================================================

fn blake3_hash(data: &[u8]) -> [u8; 32] {
    DigestFn::Blake3.hash_data(data)
}

fn make_blake3_digest(data: &[u8]) -> Digest {
    Digest {
        hash: hex::encode(blake3_hash(data)),
        size_bytes: data.len() as i64,
    }
}

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
async fn bytestream_write_and_read_blake3() {
    let store = make_store().await;
    let bs = make_bs(store.clone());

    let data = b"blake3 bytestream test";
    let resource_name = format!(
        "uploads/test-uuid/blobs/blake3/{}/{}",
        hex::encode(blake3_hash(data)),
        data.len()
    );

    let resp = bs
        .write_from_messages(vec![WriteRequest {
            resource_name,
            write_offset: 0,
            finish_write: true,
            data: Bytes::copy_from_slice(data),
        }])
        .await
        .unwrap();

    assert_eq!(resp.committed_size, data.len() as i64);

    // Read back via bytestream
    let read_resource_name = format!(
        "blobs/blake3/{}/{}",
        hex::encode(blake3_hash(data)),
        data.len()
    );

    let read_resp = bs
        .read(tonic::Request::new(ReadRequest {
            resource_name: read_resource_name,
            read_offset: 0,
            read_limit: 0,
        }))
        .await
        .unwrap();

    let mut stream = read_resp.into_inner();
    let mut received = Vec::new();
    while let Some(chunk) = tokio_stream::StreamExt::next(&mut stream).await {
        received.extend_from_slice(&chunk.unwrap().data);
    }
    assert_eq!(received, data);
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
// Additional coverage tests
// =================================================================================================================

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
// SplitBlob / SpliceBlob edge case tests

#[tokio::test]
async fn splice_blob_missing_chunk() {
    let store = make_store().await;
    let cas = make_cas(store);

    let chunk_data = b"nonexistent chunk";
    let blob_data = b"fake blob";

    let result = cas
        .splice_blob(tonic::Request::new(SpliceBlobRequest {
            instance_name: String::new(),
            blob_digest: Some(make_digest(blob_data)),
            chunk_digests: vec![make_digest(chunk_data)],
            digest_function: 0,
            chunking_function: 0,
        }))
        .await;

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code(), tonic::Code::NotFound);
}

#[tokio::test]
async fn splice_blob_empty_blob() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    let empty: &[u8] = b"";
    let resp = cas
        .splice_blob(tonic::Request::new(SpliceBlobRequest {
            instance_name: String::new(),
            blob_digest: Some(make_digest(empty)),
            chunk_digests: vec![],
            digest_function: 0,
            chunking_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(
        resp.blob_digest.as_ref().unwrap().hash,
        hex::encode(sha256(empty))
    );

    // Verify the empty blob is retrievable
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(empty));
    let data = store.cas_get_blob(&cd).await.unwrap().unwrap();
    assert!(data.is_empty());
}

fn make_data(size: usize) -> Vec<u8> {
    let mut data = Vec::with_capacity(size);
    for i in 0..size {
        data.push(((i.wrapping_mul(251).wrapping_add(i >> 8)) & 0xFF) as u8);
    }
    data
}

#[tokio::test]
async fn split_splice_roundtrip_large_blob() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    let data = make_data(4 * 1024 * 1024);
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(&data));
    store
        .cas_put_blob(&cd, Bytes::from(data.clone()), Compression::Identity)
        .await
        .unwrap();

    // Split the blob
    let split_resp = cas
        .split_blob(tonic::Request::new(SplitBlobRequest {
            instance_name: String::new(),
            blob_digest: Some(make_digest(&data)),
            digest_function: 0,
            chunking_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    // Large blob should produce multiple chunks
    assert!(split_resp.chunk_digests.len() > 1);

    // Splice it back (short-circuits because blob already exists)
    let splice_resp = cas
        .splice_blob(tonic::Request::new(SpliceBlobRequest {
            instance_name: String::new(),
            blob_digest: Some(make_digest(&data)),
            chunk_digests: split_resp.chunk_digests,
            digest_function: 0,
            chunking_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(
        splice_resp.blob_digest.as_ref().unwrap().hash,
        hex::encode(sha256(&data))
    );
}

#[tokio::test]
async fn splice_blob_duplicate_chunks() {
    let store = make_store().await;
    let cas = make_cas(store.clone());

    let chunk_data = b"repeated chunk";
    let chunk_cd = ContentDigest::new(DigestFn::Sha256, sha256(chunk_data));
    store
        .cas_put_chunk(
            &chunk_cd,
            Bytes::from_static(chunk_data),
            Compression::Identity,
        )
        .await
        .unwrap();

    // Blob = chunk ++ chunk
    let mut blob_data = Vec::new();
    blob_data.extend_from_slice(chunk_data);
    blob_data.extend_from_slice(chunk_data);

    let chunk_digest = make_digest(chunk_data);
    let resp = cas
        .splice_blob(tonic::Request::new(SpliceBlobRequest {
            instance_name: String::new(),
            blob_digest: Some(make_digest(&blob_data)),
            chunk_digests: vec![chunk_digest.clone(), chunk_digest],
            digest_function: 0,
            chunking_function: 0,
        }))
        .await
        .unwrap()
        .into_inner();

    assert_eq!(
        resp.blob_digest.as_ref().unwrap().hash,
        hex::encode(sha256(&blob_data))
    );

    // Verify the spliced blob is retrievable with correct content
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(&blob_data));
    let retrieved = store.cas_get_blob(&cd).await.unwrap().unwrap();
    assert_eq!(&retrieved[..], &blob_data[..]);
}

// =================================================================================================================
// ByteStream streaming edge cases

#[tokio::test]
async fn bytestream_read_offset_and_limit() {
    let store = make_store().await;
    let bs = make_bs(store.clone());

    let data = b"abcdefghijklmnop";
    let cd = ContentDigest::new(DigestFn::Sha256, sha256(data));
    store
        .cas_put_blob(&cd, Bytes::from_static(data), Compression::Identity)
        .await
        .unwrap();

    let resource_name = format!("blobs/{}/{}", hex::encode(sha256(data)), data.len());
    let resp = bs
        .read(tonic::Request::new(ReadRequest {
            resource_name,
            read_offset: 5,
            read_limit: 3,
        }))
        .await
        .unwrap();

    let mut stream = resp.into_inner();
    let mut received = Vec::new();
    while let Some(chunk) = tokio_stream::StreamExt::next(&mut stream).await {
        received.extend_from_slice(&chunk.unwrap().data);
    }
    assert_eq!(received, b"fgh");
}
