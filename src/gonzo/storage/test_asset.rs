// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use super::test_helpers::*;
use super::*;

// =================================================================================================================
// AssetEntry serialization tests
// =================================================================================================================

#[test]
fn asset_entry_roundtrip() {
    let entry = AssetEntry {
        digest_hash: sha256(b"hello"),
        digest_size_bytes: 5,
        created_at: 1000,
        expires_at: 2000,
        is_directory: false,
        qualifiers: vec![
            ("resource_type".into(), "application/octet-stream".into()),
            ("checksum.sri".into(), "sha256-abc123".into()),
        ],
    };
    let bytes = entry.to_bytes();
    let decoded = AssetEntry::from_bytes(bytes).unwrap();
    assert_eq!(decoded.digest_hash, entry.digest_hash);
    assert_eq!(decoded.digest_size_bytes, 5);
    assert_eq!(decoded.created_at, 1000);
    assert_eq!(decoded.expires_at, 2000);
    assert!(!decoded.is_directory);
    assert_eq!(decoded.qualifiers.len(), 2);
    assert_eq!(decoded.qualifiers[0].0, "resource_type");
    assert_eq!(decoded.qualifiers[1].0, "checksum.sri");
}

#[test]
fn asset_entry_roundtrip_directory() {
    let entry = AssetEntry {
        digest_hash: sha256(b"dir"),
        digest_size_bytes: 128,
        created_at: 500,
        expires_at: 0,
        is_directory: true,
        qualifiers: vec![],
    };
    let bytes = entry.to_bytes();
    let decoded = AssetEntry::from_bytes(bytes).unwrap();
    assert!(decoded.is_directory);
    assert_eq!(decoded.expires_at, 0);
    assert!(decoded.qualifiers.is_empty());
}

#[test]
fn asset_entry_from_bytes_too_short() {
    let data = Bytes::from_static(&[0u8; 10]);
    assert!(AssetEntry::from_bytes(data).is_err());
}

// =================================================================================================================
// Asset mapping store tests
// =================================================================================================================

#[tokio::test]
async fn asset_put_get_roundtrip() {
    let store = open_memory_store().await;
    let entry = AssetEntry {
        digest_hash: sha256(b"content"),
        digest_size_bytes: 7,
        created_at: unix_now_secs(),
        expires_at: 0,
        is_directory: false,
        qualifiers: vec![("k".into(), "v".into())],
    };
    let quals = vec![("k".to_string(), "v".to_string())];
    store
        .asset_put(
            DigestFn::Sha256,
            "https://example.com/file.tar",
            &quals,
            &entry,
        )
        .await
        .unwrap();
    let got = store
        .asset_get(DigestFn::Sha256, "https://example.com/file.tar", &quals)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got.digest_hash, entry.digest_hash);
    assert_eq!(got.digest_size_bytes, 7);
    store.close().await.unwrap();
}

#[tokio::test]
async fn asset_get_not_found() {
    let store = open_memory_store().await;
    let got = store
        .asset_get(DigestFn::Sha256, "https://example.com/missing", &[])
        .await
        .unwrap();
    assert!(got.is_none());
    store.close().await.unwrap();
}

#[tokio::test]
async fn asset_qualifier_ordering_is_canonical() {
    let store = open_memory_store().await;
    let entry = AssetEntry {
        digest_hash: sha256(b"x"),
        digest_size_bytes: 1,
        created_at: 100,
        expires_at: 0,
        is_directory: false,
        qualifiers: vec![],
    };
    let quals_ab = vec![
        ("a".to_string(), "1".to_string()),
        ("b".to_string(), "2".to_string()),
    ];
    store
        .asset_put(DigestFn::Sha256, "urn:test", &quals_ab, &entry)
        .await
        .unwrap();
    // Look up with reversed qualifier order — should still find the entry
    let quals_ba = vec![
        ("b".to_string(), "2".to_string()),
        ("a".to_string(), "1".to_string()),
    ];
    let got = store
        .asset_get(DigestFn::Sha256, "urn:test", &quals_ba)
        .await
        .unwrap();
    assert!(got.is_some());
    store.close().await.unwrap();
}

#[tokio::test]
async fn asset_different_digest_fn_isolates() {
    let store = open_memory_store().await;
    let entry = AssetEntry {
        digest_hash: sha256(b"isolated"),
        digest_size_bytes: 8,
        created_at: 100,
        expires_at: 0,
        is_directory: false,
        qualifiers: vec![],
    };
    store
        .asset_put(DigestFn::Sha256, "urn:iso", &[], &entry)
        .await
        .unwrap();
    // Lookup with Blake3 should not find the SHA256 entry
    let got = store
        .asset_get(DigestFn::Blake3, "urn:iso", &[])
        .await
        .unwrap();
    assert!(got.is_none());
    store.close().await.unwrap();
}
