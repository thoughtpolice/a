// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A CAS in memory, served over gRPC on localhost, for the tests to read
//! and write through [`Cas`] as they would a real server. It keeps gRPC's
//! default 4 MB message limit, as servers do, so a batch too large fails
//! here as it would there.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use prost::Message as _;
use tonic::{Request, Response, Status};

use protos::build::bazel::remote::execution::v2::{
    self as reapi, BatchReadBlobsRequest, BatchReadBlobsResponse, BatchUpdateBlobsRequest,
    BatchUpdateBlobsResponse, Directory, FindMissingBlobsRequest, FindMissingBlobsResponse,
    GetTreeRequest, GetTreeResponse, SpliceBlobRequest, SpliceBlobResponse, SplitBlobRequest,
    SplitBlobResponse, batch_read_blobs_response, batch_update_blobs_response,
    content_addressable_storage_server::{
        ContentAddressableStorage, ContentAddressableStorageServer,
    },
};
use protos::google::bytestream::{
    QueryWriteStatusRequest, QueryWriteStatusResponse, ReadRequest, ReadResponse, WriteRequest,
    WriteResponse,
    byte_stream_server::{ByteStream, ByteStreamServer},
};
use protos::google::rpc;
use reapi_cas::{Digest, DigestFn};

use reapi_client::Cas;

type Blobs = Arc<Mutex<HashMap<(DigestFn, Digest), Bytes>>>;

/// See the module documentation. The server stops when this is dropped.
pub struct TestCas {
    blobs: Blobs,
    channel: tonic::transport::Channel,
    _stop: tokio::sync::oneshot::Sender<()>,
}

impl TestCas {
    pub async fn start() -> Self {
        let blobs = Blobs::default();
        let service = Service(blobs.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let incoming = futures::stream::unfold(listener, |listener| async move {
            let accepted = listener.accept().await.map(|(stream, _)| stream);
            Some((accepted, listener))
        });
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(
            tonic::transport::Server::builder()
                .add_service(ContentAddressableStorageServer::new(service.clone()))
                .add_service(ByteStreamServer::new(service))
                .serve_with_incoming_shutdown(incoming, async {
                    let _ = stopped.await;
                }),
        );
        let channel = tonic::transport::Endpoint::from_shared(format!("http://{addr}"))
            .unwrap()
            .connect()
            .await
            .unwrap();
        Self {
            blobs,
            channel,
            _stop: stop,
        }
    }

    /// A client of this CAS.
    pub fn cas(&self) -> Cas {
        Cas::new(self.channel.clone())
    }

    /// Store `data` under SHA-256, returning its digest.
    pub async fn put(&self, data: impl Into<Bytes>) -> reapi::Digest {
        let data = data.into();
        let digest = DigestFn::Sha256.digest(&data);
        self.blobs
            .lock()
            .unwrap()
            .insert((DigestFn::Sha256, digest), data);
        digest.to_proto()
    }

    pub async fn put_dir(&self, dir: &Directory) -> reapi::Digest {
        self.put(dir.encode_to_vec()).await
    }

    fn lookup(&self, digest: &reapi::Digest) -> Option<Bytes> {
        let digest = Digest::from_proto(digest).unwrap();
        self.blobs
            .lock()
            .unwrap()
            .get(&(DigestFn::Sha256, digest))
            .cloned()
    }

    pub async fn has(&self, digest: &reapi::Digest) -> bool {
        self.lookup(digest).is_some()
    }

    pub async fn get(&self, digest: &reapi::Digest) -> Bytes {
        self.lookup(digest).expect("the blob is stored")
    }
}

#[derive(Clone)]
struct Service(Blobs);

fn function(value: i32) -> Result<DigestFn, Status> {
    DigestFn::of_request(value)
        .ok_or_else(|| Status::invalid_argument(format!("digest function {value}")))
}

fn digest(digest: Option<&reapi::Digest>) -> Result<Digest, Status> {
    let digest = digest.ok_or_else(|| Status::invalid_argument("no digest"))?;
    Digest::from_proto(digest).map_err(|e| Status::invalid_argument(e.to_string()))
}

fn ok() -> Option<rpc::Status> {
    Some(rpc::Status::default())
}

impl Service {
    fn get(&self, function: DigestFn, digest: &Digest) -> Option<Bytes> {
        self.0.lock().unwrap().get(&(function, *digest)).cloned()
    }

    /// Store `data` if it is what `digest` names.
    fn put(&self, function: DigestFn, digest: Digest, data: Bytes) -> Result<(), Status> {
        if function.digest(&data) != digest {
            return Err(Status::invalid_argument(format!("{digest} does not match")));
        }
        self.0.lock().unwrap().insert((function, digest), data);
        Ok(())
    }
}

#[tonic::async_trait]
impl ContentAddressableStorage for Service {
    async fn find_missing_blobs(
        &self,
        request: Request<FindMissingBlobsRequest>,
    ) -> Result<Response<FindMissingBlobsResponse>, Status> {
        let request = request.into_inner();
        let function = function(request.digest_function)?;
        let mut missing_blob_digests = Vec::new();
        for d in &request.blob_digests {
            if self.get(function, &digest(Some(d))?).is_none() {
                missing_blob_digests.push(d.clone());
            }
        }
        Ok(Response::new(FindMissingBlobsResponse {
            missing_blob_digests,
        }))
    }

    async fn batch_update_blobs(
        &self,
        request: Request<BatchUpdateBlobsRequest>,
    ) -> Result<Response<BatchUpdateBlobsResponse>, Status> {
        let request = request.into_inner();
        let function = function(request.digest_function)?;
        let mut responses = Vec::new();
        for blob in request.requests {
            let d = digest(blob.digest.as_ref())?;
            self.put(function, d, blob.data)?;
            responses.push(batch_update_blobs_response::Response {
                digest: blob.digest,
                status: ok(),
            });
        }
        Ok(Response::new(BatchUpdateBlobsResponse { responses }))
    }

    async fn batch_read_blobs(
        &self,
        request: Request<BatchReadBlobsRequest>,
    ) -> Result<Response<BatchReadBlobsResponse>, Status> {
        let request = request.into_inner();
        let function = function(request.digest_function)?;
        let mut responses = Vec::new();
        for d in request.digests {
            let found = self.get(function, &digest(Some(&d))?);
            let status = match found {
                Some(_) => ok(),
                None => Some(rpc::Status {
                    code: tonic::Code::NotFound as i32,
                    ..Default::default()
                }),
            };
            responses.push(batch_read_blobs_response::Response {
                digest: Some(d),
                data: found.unwrap_or_default(),
                compressor: 0,
                status,
            });
        }
        Ok(Response::new(BatchReadBlobsResponse { responses }))
    }

    type GetTreeStream = futures::stream::Empty<Result<GetTreeResponse, Status>>;

    async fn get_tree(
        &self,
        _: Request<GetTreeRequest>,
    ) -> Result<Response<Self::GetTreeStream>, Status> {
        Err(Status::unimplemented("GetTree"))
    }

    async fn split_blob(
        &self,
        _: Request<SplitBlobRequest>,
    ) -> Result<Response<SplitBlobResponse>, Status> {
        Err(Status::unimplemented("SplitBlob"))
    }

    async fn splice_blob(
        &self,
        _: Request<SpliceBlobRequest>,
    ) -> Result<Response<SpliceBlobResponse>, Status> {
        Err(Status::unimplemented("SpliceBlob"))
    }
}

#[tonic::async_trait]
impl ByteStream for Service {
    type ReadStream = futures::stream::Iter<std::vec::IntoIter<Result<ReadResponse, Status>>>;

    async fn read(
        &self,
        request: Request<ReadRequest>,
    ) -> Result<Response<Self::ReadStream>, Status> {
        let request = request.into_inner();
        let name = reapi_cas::resource::parse_read(&request.resource_name)
            .map_err(|e| Status::invalid_argument(e.to_string()))?;
        let d = Digest::parse(&name.hash, name.size)
            .map_err(|e| Status::invalid_argument(e.to_string()))?;
        let data = self
            .get(name.digest_fn, &d)
            .ok_or_else(|| Status::not_found(d.to_string()))?;
        let pieces: Vec<_> = data
            .chunks(1024 * 1024)
            .map(|piece| {
                Ok(ReadResponse {
                    data: Bytes::copy_from_slice(piece),
                })
            })
            .collect();
        Ok(Response::new(futures::stream::iter(pieces)))
    }

    async fn write(
        &self,
        request: Request<tonic::Streaming<WriteRequest>>,
    ) -> Result<Response<WriteResponse>, Status> {
        let mut stream = request.into_inner();
        let mut name = None;
        let mut data = Vec::new();
        while let Some(message) = stream.message().await? {
            if name.is_none() {
                name = Some(
                    reapi_cas::resource::parse_write(&message.resource_name)
                        .map_err(|e| Status::invalid_argument(e.to_string()))?,
                );
            }
            if message.write_offset != data.len() as i64 {
                return Err(Status::invalid_argument("writes must be in order"));
            }
            data.extend_from_slice(&message.data);
            if message.finish_write {
                break;
            }
        }
        let name = name.ok_or_else(|| Status::invalid_argument("an empty write"))?;
        let d = Digest::parse(&name.hash, name.size)
            .map_err(|e| Status::invalid_argument(e.to_string()))?;
        let committed_size = data.len() as i64;
        self.put(name.digest_fn, d, data.into())?;
        Ok(Response::new(WriteResponse { committed_size }))
    }

    async fn query_write_status(
        &self,
        _: Request<QueryWriteStatusRequest>,
    ) -> Result<Response<QueryWriteStatusResponse>, Status> {
        Err(Status::unimplemented("QueryWriteStatus"))
    }
}
