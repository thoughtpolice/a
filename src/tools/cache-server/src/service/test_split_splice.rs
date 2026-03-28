// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use super::test_helpers::*;

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
