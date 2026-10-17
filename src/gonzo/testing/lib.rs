// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A gonzo daemon in process, for tests: an in-memory store, its CAS and
//! ByteStream services, and whatever else a test serves beside them, over
//! real HTTP/2 on loopback; and the calls tests make of it.

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use prost::Message as _;
use tokio::sync::oneshot;
use tonic::Streaming;
use tonic::service::Routes;
use tonic::transport::{Channel, Endpoint};

use protos::build::bazel::remote::execution::v2::{
    Digest, Directory, ExecuteRequest, ExecuteResponse, execution_client::ExecutionClient,
};
use protos::google::bytestream::byte_stream_server::ByteStreamServer;
use protos::google::longrunning::{Operation, operation};
use storage::{CacheStore, CacheStoreSettings, Compression, ContentDigest, DigestFn, StoreBackend};

/// Long enough for anything a test waits on to happen.
const PATIENCE: Duration = Duration::from_secs(30);

/// See the crate documentation. Serves until dropped.
pub struct Daemon {
    pub channel: Channel,
    pub store: Arc<CacheStore>,
    _stop: oneshot::Sender<()>,
}

impl Daemon {
    /// Serve a new store's CAS and ByteStream, and the services `add`
    /// adds to them.
    pub async fn start(add: impl FnOnce(Routes, &Arc<CacheStore>) -> Routes) -> Self {
        let store = Arc::new(
            CacheStore::open(StoreBackend::Memory, CacheStoreSettings::default())
                .await
                .expect("open store"),
        );
        let handle = dial9::Dial9TokioHandle::disabled();
        let routes = Routes::new(api::CasServer::new(
            api::ContentAddressableStorageService::new(store.clone(), handle.clone()),
        ))
        .add_service(ByteStreamServer::new(api::ByteStreamService::new(
            store.clone(),
            handle.clone(),
        )));
        let routes = add(routes, &store).prepare();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("address");
        let (stop, stopped) = oneshot::channel::<()>();
        tokio::spawn(dial9_tonic::serve_traced(
            listener,
            routes,
            handle,
            async move {
                let _ = stopped.await;
            },
        ));
        let channel = Endpoint::from_shared(format!("http://{addr}"))
            .expect("endpoint")
            .connect()
            .await
            .expect("connect");
        Self {
            channel,
            store,
            _stop: stop,
        }
    }

    /// Store `data`, returning its SHA-256 digest.
    pub async fn put(&self, data: impl Into<Bytes>) -> Digest {
        put(&self.store, data).await
    }

    pub async fn put_dir(&self, dir: &Directory) -> Digest {
        self.put(dir.encode_to_vec()).await
    }

    /// Whether the store has the blob `digest` names.
    pub async fn has(&self, digest: &Digest) -> bool {
        self.store
            .cas_blob_exists(&sha256(digest))
            .await
            .expect("lookup")
    }

    /// The blob `digest` names.
    pub async fn get(&self, digest: &Digest) -> Bytes {
        self.store
            .cas_get_blob(&sha256(digest))
            .await
            .expect("read")
            .expect("stored")
    }

    /// Execute the action `digest` names, which must be served.
    pub async fn execute(&self, digest: &Digest) -> Streaming<Operation> {
        execute(&self.channel, digest).await
    }
}

/// Store `data` in `store`, returning its SHA-256 digest.
pub async fn put(store: &CacheStore, data: impl Into<Bytes>) -> Digest {
    let data = data.into();
    let cd = ContentDigest::compute(DigestFn::Sha256, &data);
    let digest = Digest {
        hash: hex::encode(cd.hash),
        size_bytes: data.len() as i64,
    };
    store
        .cas_put_blob(&cd, data, Compression::Identity)
        .await
        .expect("put");
    digest
}

/// Execute the action `digest` names over `channel`.
pub async fn execute(channel: &Channel, digest: &Digest) -> Streaming<Operation> {
    ExecutionClient::new(channel.clone())
        .execute(ExecuteRequest {
            action_digest: Some(digest.clone()),
            digest_function: 1,
            ..Default::default()
        })
        .await
        .expect("execute")
        .into_inner()
}

/// Read operations until one is done: its name and its response.
pub async fn completion(stream: &mut Streaming<Operation>) -> (String, ExecuteResponse) {
    loop {
        let op = tokio::time::timeout(PATIENCE, stream.message())
            .await
            .expect("in time")
            .expect("a message")
            .expect("not the end yet");
        if !op.done {
            continue;
        }
        let Some(operation::Result::Response(any)) = op.result else {
            panic!("operation {} ended without a response", op.name);
        };
        return (
            op.name,
            ExecuteResponse::decode(any.value.as_slice()).expect("decode"),
        );
    }
}

fn sha256(digest: &Digest) -> ContentDigest {
    let hash = storage::parse_digest_hash(&digest.hash).expect("a sha256 digest");
    ContentDigest::new(DigestFn::Sha256, hash)
}
