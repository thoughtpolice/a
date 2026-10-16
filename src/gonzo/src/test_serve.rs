// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The server end to end: real listeners, real HTTP/2 connections, a real
//! gRPC client. What the in-process service tests cannot see (how the
//! transport treats a request answered early, say) shows up here.

use std::net::SocketAddr;
use std::sync::Arc;

use bytes::Bytes;
use dial9::Dial9TokioHandle;
use futures::{StreamExt as _, TryStreamExt as _};
use prost::Message as _;
use protos::google::bytestream::{WriteRequest, byte_stream_client::ByteStreamClient};
use sha2::{Digest as _, Sha256};
use tonic::transport::{Channel, Endpoint};

use crate::store::{CacheStore, CacheStoreSettings, StoreBackend};

/// A server on a free loopback port, stopped when this is dropped.
struct Server {
    addr: SocketAddr,
    store: Arc<CacheStore>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl Server {
    async fn start() -> Self {
        let _ = telemetry::init_metrics(&telemetry::OtelConfig::default());
        let addr = std::net::TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .expect("a free port");
        let store = Arc::new(
            CacheStore::open(StoreBackend::Memory, CacheStoreSettings::default())
                .await
                .expect("open store"),
        );
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let task = tokio::spawn({
            let store = store.clone();
            async move {
                crate::reapi_grpc::start_reapi_grpc(
                    addr,
                    None,
                    async move {
                        let _ = stopped.await;
                    },
                    store,
                    None,
                    Some(8192),
                    1024,
                    crate::service::FetchConfig::default(),
                    Dial9TokioHandle::disabled(),
                    None,
                )
                .await
                .expect("serve");
            }
        });
        // Up once it accepts connections.
        for _ in 0..200 {
            if tokio::net::TcpStream::connect(addr).await.is_ok() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        Self {
            addr,
            store,
            stop: Some(stop),
            task,
        }
    }

    /// One HTTP/2 connection.
    async fn channel(&self) -> Channel {
        Endpoint::from_shared(format!("http://{}", self.addr))
            .expect("endpoint")
            .connect()
            .await
            .expect("connect")
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.task.abort();
    }
}

/// The messages of a Write of `data`, `step` bytes each.
fn write_messages(data: &Bytes, step: usize) -> Vec<WriteRequest> {
    let hash = hex::encode(Sha256::digest(data));
    let name = format!("uploads/u/blobs/{hash}/{}", data.len());
    (0..data.len())
        .step_by(step)
        .map(|at| WriteRequest {
            resource_name: if at == 0 { name.clone() } else { String::new() },
            write_offset: at as i64,
            finish_write: at + step >= data.len(),
            data: data.slice(at..(at + step).min(data.len())),
        })
        .collect()
}

/// Writes of a stored blob are answered from their first message. The
/// rest of each upload is still on its way when the answer goes out; if the
/// server reset those streams, h2 would count the frames arriving for them
/// against a per-connection limit (1024 late frames) and then close the
/// connection with everything else on it. Thousands of early answers on one
/// connection must all succeed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn early_answers_do_not_cost_the_connection() {
    let server = Server::start().await;
    // Larger than a stream's flow-control window (8 MiB), so the client
    // cannot finish sending before the answer arrives.
    let data = Bytes::from(vec![0x5a; 32 << 20]);
    let digest = crate::store::ContentDigest::compute(crate::store::DigestFn::Sha256, &data);
    server
        .store
        .cas_put_blob(&digest, data.clone(), crate::store::Compression::Identity)
        .await
        .expect("store the blob");

    let client = ByteStreamClient::new(server.channel().await);
    let messages = write_messages(&data, 1 << 20);
    let committed: Vec<i64> = futures::stream::iter(0..3000)
        .map(|_| {
            let mut client = client.clone();
            let messages = messages.clone();
            async move {
                client
                    .write(futures::stream::iter(messages))
                    .await
                    .map(|r| r.into_inner().committed_size)
            }
        })
        .buffer_unordered(32)
        .try_collect()
        .await
        .expect("every write answered");
    assert!(committed.iter().all(|&c| c == data.len() as i64));
}

/// Store `dir` in `server`'s CAS and return its digest.
async fn put_directory(
    server: &Server,
    dir: &protos::build::bazel::remote::execution::v2::Directory,
) -> protos::build::bazel::remote::execution::v2::Digest {
    let bytes = Bytes::from(dir.encode_to_vec());
    let digest = crate::store::ContentDigest::compute(crate::store::DigestFn::Sha256, &bytes);
    server
        .store
        .cas_put_blob(&digest, bytes.clone(), crate::store::Compression::Identity)
        .await
        .expect("store the directory");
    protos::build::bazel::remote::execution::v2::Digest {
        hash: hex::encode(digest.hash),
        size_bytes: bytes.len() as i64,
    }
}

/// A GetTreeResponse page read without decoding its Directories.
#[derive(Clone, PartialEq, prost::Message)]
struct RawTreePage {
    #[prost(bytes = "bytes", repeated, tag = "1")]
    directories: Vec<Bytes>,
}

/// GetTree over a real connection, which the server answers with stored
/// Directories as they are: a gRPC client decodes every Directory of the
/// tree, root first, and a field the server does not know (which decoding
/// and encoding the Directory again would drop) arrives intact.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_tree_answers_over_grpc() {
    use protos::build::bazel::remote::execution::v2::{
        Directory, DirectoryNode, FileNode, GetTreeRequest,
        content_addressable_storage_client::ContentAddressableStorageClient,
    };
    let server = Server::start().await;
    let leaf = Directory {
        files: vec![FileNode {
            name: "tool".into(),
            digest: Some(protos::build::bazel::remote::execution::v2::Digest {
                hash: hex::encode(Sha256::digest(b"tool")),
                size_bytes: 4,
            }),
            is_executable: true,
            node_properties: None,
        }],
        ..Default::default()
    };
    let root = Directory {
        directories: vec![DirectoryNode {
            name: "bin".into(),
            digest: Some(put_directory(&server, &leaf).await),
        }],
        ..Default::default()
    };
    // The root as some later REAPI might write it: with a field 99.
    let mut stored = root.encode_to_vec();
    prost::encoding::encode_key(99, prost::encoding::WireType::Varint, &mut stored);
    prost::encoding::encode_varint(7, &mut stored);
    let stored = Bytes::from(stored);
    let digest = crate::store::ContentDigest::compute(crate::store::DigestFn::Sha256, &stored);
    server
        .store
        .cas_put_blob(&digest, stored.clone(), crate::store::Compression::Identity)
        .await
        .expect("store the root");
    let request = GetTreeRequest {
        root_digest: Some(protos::build::bazel::remote::execution::v2::Digest {
            hash: hex::encode(digest.hash),
            size_bytes: stored.len() as i64,
        }),
        ..Default::default()
    };

    let mut client = ContentAddressableStorageClient::new(server.channel().await);
    let pages: Vec<_> = client
        .get_tree(request.clone())
        .await
        .expect("GetTree")
        .into_inner()
        .try_collect()
        .await
        .expect("every page");
    let directories: Vec<Directory> = pages.into_iter().flat_map(|p| p.directories).collect();
    assert_eq!(directories, [root, leaf]);

    let mut raw = tonic::client::Grpc::new(server.channel().await);
    raw.ready().await.expect("ready");
    let pages: Vec<RawTreePage> = raw
        .server_streaming(
            tonic::Request::new(request),
            tonic::codegen::http::uri::PathAndQuery::from_static(
                "/build.bazel.remote.execution.v2.ContentAddressableStorage/GetTree",
            ),
            tonic_prost::ProstCodec::<GetTreeRequest, RawTreePage>::default(),
        )
        .await
        .expect("GetTree")
        .into_inner()
        .try_collect()
        .await
        .expect("every page");
    assert_eq!(pages[0].directories[0], stored, "the root, byte for byte");
}
