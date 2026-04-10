// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use super::test_helpers::*;

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
async fn bytestream_write_wrong_offset_too_high() {
    let store = make_store().await;
    let bs = make_bs(store);

    let data = b"chunked write test data here";
    let resource_name = format!(
        "uploads/test-uuid/blobs/{}/{}",
        hex::encode(sha256(data)),
        data.len()
    );

    let mid = data.len() / 2;
    let result = bs
        .write_from_messages(vec![
            WriteRequest {
                resource_name: resource_name.clone(),
                write_offset: 0,
                finish_write: false,
                data: Bytes::copy_from_slice(&data[..mid]),
            },
            WriteRequest {
                resource_name: String::new(),
                write_offset: 9999,
                finish_write: true,
                data: Bytes::copy_from_slice(&data[mid..]),
            },
        ])
        .await;

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code(), tonic::Code::InvalidArgument);
}

#[tokio::test]
async fn bytestream_write_wrong_offset_zero() {
    let store = make_store().await;
    let bs = make_bs(store);

    let data = b"chunked write test data here";
    let resource_name = format!(
        "uploads/test-uuid/blobs/{}/{}",
        hex::encode(sha256(data)),
        data.len()
    );

    let mid = data.len() / 2;
    let result = bs
        .write_from_messages(vec![
            WriteRequest {
                resource_name: resource_name.clone(),
                write_offset: 0,
                finish_write: false,
                data: Bytes::copy_from_slice(&data[..mid]),
            },
            WriteRequest {
                resource_name: String::new(),
                write_offset: 0, // wrong: should be mid
                finish_write: true,
                data: Bytes::copy_from_slice(&data[mid..]),
            },
        ])
        .await;

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code(), tonic::Code::InvalidArgument);
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

#[tokio::test]
async fn query_write_status_returns_unimplemented() {
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

// =================================================================================================================
// Blake3 ByteStream tests
// =================================================================================================================

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
