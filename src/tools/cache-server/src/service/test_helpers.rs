// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

pub use std::sync::Arc;

pub use bytes::Bytes;
pub use prost::Message;
pub use sha2::{Digest as _, Sha256};

pub use protos::build::bazel::remote::execution::v2::{
    ActionResult, BatchReadBlobsRequest, BatchUpdateBlobsRequest, Digest, Directory, DirectoryNode,
    FileNode, FindMissingBlobsRequest, SpliceBlobRequest, SplitBlobRequest, SymlinkNode,
    action_cache_server::ActionCache, batch_update_blobs_request,
    capabilities_server::Capabilities,
    content_addressable_storage_server::ContentAddressableStorage,
};
pub use protos::google::bytestream::{ReadRequest, WriteRequest, byte_stream_server::ByteStream};

pub use protos::build::bazel::remote::asset::v1::{
    FetchBlobRequest, FetchDirectoryRequest, PushBlobRequest, PushDirectoryRequest, Qualifier,
    fetch_server::Fetch, push_server::Push,
};

pub use dial9::Dial9TokioHandle;

pub use crate::store::{
    CacheStore, CacheStoreSettings, Compression, ContentDigest, DigestFn, StoreBackend,
};

pub use super::action_cache::ActionCacheService;
pub use super::bytestream::ByteStreamService;
pub use super::cas::ContentAddressableStorageService;

static INIT_TELEMETRY: std::sync::Once = std::sync::Once::new();

pub fn ensure_telemetry() {
    INIT_TELEMETRY.call_once(|| {
        telemetry::init_metrics(&telemetry::OtelConfig::default()).unwrap();
    });
}

/// An inert handle: `spawn` falls through to `tokio::spawn` on whichever
/// runtime the test is running under, with no wake tracking.
pub fn test_handle() -> Dial9TokioHandle {
    Dial9TokioHandle::disabled()
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

pub fn make_digest(data: &[u8]) -> Digest {
    Digest {
        hash: hex::encode(sha256(data)),
        size_bytes: data.len() as i64,
    }
}

pub async fn make_store() -> Arc<CacheStore> {
    ensure_telemetry();
    Arc::new(
        CacheStore::open(StoreBackend::Memory, CacheStoreSettings::default())
            .await
            .unwrap(),
    )
}

pub fn make_cas(store: Arc<CacheStore>) -> ContentAddressableStorageService {
    ContentAddressableStorageService::new(store, test_handle())
}

pub fn make_ac(store: Arc<CacheStore>) -> ActionCacheService {
    ActionCacheService::new(store)
}

pub fn make_bs(store: Arc<CacheStore>) -> ByteStreamService {
    ByteStreamService::new(store, test_handle())
}

pub fn blake3_hash(data: &[u8]) -> [u8; 32] {
    DigestFn::Blake3.hash_data(data)
}

pub fn make_blake3_digest(data: &[u8]) -> Digest {
    Digest {
        hash: hex::encode(blake3_hash(data)),
        size_bytes: data.len() as i64,
    }
}

pub fn make_data(size: usize) -> Vec<u8> {
    let mut data = Vec::with_capacity(size);
    for i in 0..size {
        data.push(((i.wrapping_mul(251).wrapping_add(i >> 8)) & 0xFF) as u8);
    }
    data
}

pub fn make_fetch(store: Arc<CacheStore>) -> super::remote_asset::FetchService {
    super::remote_asset::FetchService::new(store, test_handle(), None)
}

pub fn make_push(store: Arc<CacheStore>) -> super::remote_asset::PushService {
    super::remote_asset::PushService::new(store)
}
