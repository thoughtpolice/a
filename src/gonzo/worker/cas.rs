// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The daemon's CAS, as the worker uses it: batches of small blobs, files
//! streamed whole, and everything read checked against its digest.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context as _, Result, bail};
use bytes::Bytes;
use futures::StreamExt as _;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tonic::transport::Channel;

use protos::build::bazel::remote::execution::v2::{
    BatchReadBlobsRequest, BatchUpdateBlobsRequest, Digest, FindMissingBlobsRequest,
    batch_update_blobs_request,
    content_addressable_storage_client::ContentAddressableStorageClient,
};
use protos::google::bytestream::{ReadRequest, WriteRequest, byte_stream_client::ByteStreamClient};

use crate::digest::{DigestFunction, Key, key, show};

/// Blobs up to this size travel in batches; larger ones stream.
pub const BATCH_BLOB_MAX: i64 = 1024 * 1024;

/// Most bytes of blobs in one batch, under the daemon's 4 MB limit with
/// room for the messages around them.
const BATCH_BYTES: i64 = 3 * 1024 * 1024;

/// Most digests asked about in one FindMissingBlobs.
const FIND_MISSING_MAX: usize = 4096;

/// Payload of one ByteStream write.
const WRITE_CHUNK: usize = 1024 * 1024;

/// Blobs an action needs that the CAS does not have. The action fails
/// with `FAILED_PRECONDITION`, which tells the client to upload them again.
#[derive(Debug, thiserror::Error)]
#[error("missing from the CAS: {}", .0.iter().map(show).collect::<Vec<_>>().join(", "))]
pub struct Missing(pub Vec<Digest>);

/// See the module documentation. Cheap to clone.
#[derive(Clone, Debug)]
pub struct Cas {
    cas: ContentAddressableStorageClient<Channel>,
    bytestream: ByteStreamClient<Channel>,
    instance_name: String,
}

impl Cas {
    pub fn new(channel: Channel, instance_name: impl Into<String>) -> Self {
        Self {
            cas: ContentAddressableStorageClient::new(channel.clone())
                .max_decoding_message_size(usize::MAX),
            bytestream: ByteStreamClient::new(channel),
            instance_name: instance_name.into(),
        }
    }

    /// Read small blobs, by batches; fails with [`Missing`] if any is not
    /// stored.
    pub async fn read_blobs(
        &self,
        function: DigestFunction,
        digests: &[Digest],
    ) -> Result<HashMap<Key, Bytes>> {
        let mut blobs = HashMap::with_capacity(digests.len());
        let mut missing = Vec::new();
        for batch in batches(digests) {
            let response = self
                .cas
                .clone()
                .batch_read_blobs(BatchReadBlobsRequest {
                    instance_name: self.instance_name.clone(),
                    digests: batch.to_vec(),
                    acceptable_compressors: Vec::new(),
                    digest_function: function.to_proto(),
                })
                .await
                .context("BatchReadBlobs")?
                .into_inner();
            for blob in response.responses {
                let digest = blob
                    .digest
                    .context("BatchReadBlobs answered without a digest")?;
                match blob.status.map_or(0, |s| s.code) {
                    0 => {}
                    5 => {
                        missing.push(digest);
                        continue;
                    }
                    code => bail!(
                        "BatchReadBlobs failed for {} with code {code}",
                        show(&digest)
                    ),
                }
                check(function, &digest, &blob.data)?;
                blobs.insert(key(&digest), blob.data);
            }
        }
        if !missing.is_empty() {
            return Err(Missing(missing).into());
        }
        Ok(blobs)
    }

    /// Stream a blob into a new file at `path`, checking it on the way.
    pub async fn read_to_file(
        &self,
        function: DigestFunction,
        digest: &Digest,
        path: &Path,
    ) -> Result<()> {
        let request = ReadRequest {
            resource_name: self.resource(function, digest, None),
            read_offset: 0,
            read_limit: 0,
        };
        let mut stream = match self.bytestream.clone().read(request).await {
            Ok(response) => response.into_inner(),
            Err(status) if status.code() == tonic::Code::NotFound => {
                return Err(Missing(vec![digest.clone()]).into());
            }
            Err(status) => return Err(status).context("ByteStream.Read"),
        };
        let mut file = tokio::fs::File::create_new(path)
            .await
            .with_context(|| format!("creating {}", path.display()))?;
        let mut hasher = function.hasher();
        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk.data,
                Err(status) if status.code() == tonic::Code::NotFound => {
                    return Err(Missing(vec![digest.clone()]).into());
                }
                Err(status) => return Err(status).context("ByteStream.Read"),
            };
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .with_context(|| format!("writing {}", path.display()))?;
        }
        file.flush().await?;
        let got = hasher.finish();
        if got != *digest {
            bail!("read {} for {}", show(&got), show(digest));
        }
        Ok(())
    }

    /// Which of `digests` the CAS does not have.
    pub async fn find_missing(
        &self,
        function: DigestFunction,
        digests: &[Digest],
    ) -> Result<Vec<Digest>> {
        let mut missing = Vec::new();
        for chunk in digests.chunks(FIND_MISSING_MAX) {
            let response = self
                .cas
                .clone()
                .find_missing_blobs(FindMissingBlobsRequest {
                    instance_name: self.instance_name.clone(),
                    blob_digests: chunk.to_vec(),
                    digest_function: function.to_proto(),
                })
                .await
                .context("FindMissingBlobs")?
                .into_inner();
            missing.extend(response.missing_blob_digests);
        }
        Ok(missing)
    }

    /// Store small blobs, by batches.
    pub async fn write_blobs(
        &self,
        function: DigestFunction,
        blobs: Vec<(Digest, Bytes)>,
    ) -> Result<()> {
        let digests: Vec<Digest> = blobs.iter().map(|(d, _)| d.clone()).collect();
        let mut data: HashMap<Key, Bytes> = blobs.into_iter().map(|(d, b)| (key(&d), b)).collect();
        for batch in batches(&digests) {
            let requests = batch
                .iter()
                .map(|digest| batch_update_blobs_request::Request {
                    digest: Some(digest.clone()),
                    data: data.remove(&key(digest)).unwrap_or_default(),
                    compressor: 0,
                })
                .collect();
            let response = self
                .cas
                .clone()
                .batch_update_blobs(BatchUpdateBlobsRequest {
                    instance_name: self.instance_name.clone(),
                    requests,
                    digest_function: function.to_proto(),
                })
                .await
                .context("BatchUpdateBlobs")?
                .into_inner();
            for blob in response.responses {
                if let Some(status) = blob.status.filter(|s| s.code != 0) {
                    let digest = blob.digest.as_ref().map_or_else(String::new, show);
                    bail!("storing {digest} failed: {}", status.message);
                }
            }
        }
        Ok(())
    }

    /// Stream the file at `path`, whose digest is `digest`, into the CAS.
    pub async fn write_file(
        &self,
        function: DigestFunction,
        digest: &Digest,
        path: &Path,
    ) -> Result<()> {
        let mut file = tokio::fs::File::open(path)
            .await
            .with_context(|| format!("opening {}", path.display()))?;
        let resource_name = self.resource(function, digest, Some(uuid::Uuid::new_v4()));
        let size = digest.size_bytes;
        let (tx, rx) = tokio::sync::mpsc::channel::<WriteRequest>(4);
        let reader = async move {
            let mut offset = 0i64;
            let mut buffer = vec![0; WRITE_CHUNK];
            loop {
                let n = file.read(&mut buffer).await?;
                let finish_write = offset + n as i64 >= size;
                let request = WriteRequest {
                    resource_name: if offset == 0 {
                        resource_name.clone()
                    } else {
                        String::new()
                    },
                    write_offset: offset,
                    finish_write,
                    data: Bytes::copy_from_slice(&buffer[..n]),
                };
                offset += n as i64;
                if tx.send(request).await.is_err() || finish_write {
                    return anyhow::Ok(());
                }
                if n == 0 {
                    bail!("{} ended before its {size} bytes", path.display());
                }
            }
        };
        let mut client = self.bytestream.clone();
        let write = client.write(tokio_stream::wrappers::ReceiverStream::new(rx));
        let (read, written) = tokio::join!(reader, write);
        read?;
        let written = written.context("ByteStream.Write")?.into_inner();
        if written.committed_size != size {
            bail!(
                "ByteStream.Write committed {} of {size} bytes",
                written.committed_size
            );
        }
        Ok(())
    }

    fn resource(
        &self,
        function: DigestFunction,
        digest: &Digest,
        upload: Option<uuid::Uuid>,
    ) -> String {
        let mut name = String::new();
        if !self.instance_name.is_empty() {
            name.push_str(&self.instance_name);
            name.push('/');
        }
        if let Some(uuid) = upload {
            name.push_str(&format!("uploads/{uuid}/"));
        }
        name.push_str("blobs/");
        if let Some(function) = function.resource_name() {
            name.push_str(function);
            name.push('/');
        }
        name.push_str(&show(digest));
        name
    }
}

/// Check that `data` is what `digest` names.
fn check(function: DigestFunction, digest: &Digest, data: &[u8]) -> Result<()> {
    let got = function.of(data);
    if got != *digest {
        bail!("read {} for {}", show(&got), show(digest));
    }
    Ok(())
}

/// `digests` in groups of at most [`BATCH_BYTES`] of blobs each.
fn batches(digests: &[Digest]) -> impl Iterator<Item = &[Digest]> {
    let mut rest = digests;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let mut bytes = 0;
        let mut n = 0;
        while n < rest.len() && (n == 0 || bytes + rest[n].size_bytes <= BATCH_BYTES) {
            bytes += rest[n].size_bytes;
            n += 1;
        }
        let (batch, tail) = rest.split_at(n);
        rest = tail;
        Some(batch)
    })
}
