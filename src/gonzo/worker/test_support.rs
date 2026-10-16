// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A daemon for the worker to talk to, in process: its CAS and its
//! scheduler.

use std::sync::Arc;

use bytes::Bytes;
use prost::Message as _;
use tokio::sync::oneshot;
use tonic::transport::{Channel, Endpoint};

use gonzo_protos::worker::v1::scheduler_server::SchedulerServer;
use protos::build::bazel::remote::execution::v2::{
    Digest, Directory, execution_server::ExecutionServer,
};
use protos::google::bytestream::byte_stream_server::ByteStreamServer;
use storage::{CacheStore, CacheStoreSettings, Compression, ContentDigest, DigestFn, StoreBackend};

use crate::cas::Cas;

pub struct Daemon {
    pub channel: Channel,
    pub store: Arc<CacheStore>,
    _stop: oneshot::Sender<()>,
}

impl Daemon {
    pub async fn start() -> Self {
        let store = Arc::new(
            CacheStore::open(StoreBackend::Memory, CacheStoreSettings::default())
                .await
                .expect("open store"),
        );
        let handle = dial9::Dial9TokioHandle::disabled();
        let scheduler = scheduler::Scheduler::new(scheduler::Config::default());
        let routes = tonic::service::Routes::new(api::CasServer::new(
            api::ContentAddressableStorageService::new(store.clone(), handle.clone()),
        ))
        .add_service(ByteStreamServer::new(api::ByteStreamService::new(
            store.clone(),
            handle.clone(),
        )))
        .add_service(ExecutionServer::new(scheduler::ExecutionService::new(
            scheduler.clone(),
            store.clone(),
        )))
        .add_service(SchedulerServer::new(scheduler::WorkerSessions::new(
            scheduler,
            store.clone(),
        )))
        .prepare();
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

    pub fn cas(&self) -> Cas {
        Cas::new(self.channel.clone(), "")
    }

    /// Store `data`, returning its SHA-256 digest.
    pub async fn put(&self, data: impl Into<Bytes>) -> Digest {
        let data = data.into();
        let cd = ContentDigest::compute(DigestFn::Sha256, &data);
        self.store
            .cas_put_blob(&cd, data.clone(), Compression::Identity)
            .await
            .expect("put");
        Digest {
            hash: hex::encode(cd.hash),
            size_bytes: data.len() as i64,
        }
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
}

fn sha256(digest: &Digest) -> ContentDigest {
    let hash = storage::parse_digest_hash(&digest.hash).expect("a sha256 digest");
    ContentDigest::new(DigestFn::Sha256, hash)
}
