// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The daemon's CAS, as the worker uses it: blobs of any size, batched
//! when small and streamed when large, in memory or on disk, and
//! everything read checked against its digest. Callers never choose
//! between the two.

use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::{Context as _, Result, bail};
use bytes::Bytes;
use futures::{StreamExt as _, TryStreamExt as _};
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
const BATCH_BLOB_MAX: i64 = 1024 * 1024;

/// Most bytes of blobs in one batch, under the daemon's 4 MB limit with
/// room for the messages around them.
const BATCH_BYTES: i64 = 3 * 1024 * 1024;

/// Batches read at once.
const PARALLEL_BATCHES: usize = 4;

/// Blobs streamed from the CAS at once.
const PARALLEL_READS: usize = 16;

/// Blobs streamed into the CAS at once.
const PARALLEL_WRITES: usize = 4;

/// Most digests asked about in one FindMissingBlobs.
const FIND_MISSING_MAX: usize = 4096;

/// Payload of one ByteStream write.
const WRITE_CHUNK: usize = 1024 * 1024;

/// A blob to store, and where it is.
#[derive(Debug)]
pub enum Blob {
    File(PathBuf),
    Memory(Bytes),
}

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
}

impl Cas {
    pub fn new(channel: Channel) -> Self {
        Self {
            cas: ContentAddressableStorageClient::new(channel.clone())
                .max_decoding_message_size(usize::MAX),
            bytestream: ByteStreamClient::new(channel),
        }
    }

    /// Read blobs of any size into memory: small ones by batches, and large
    /// ones streamed meanwhile, a few at a time. Fails with [`Missing`],
    /// naming every one the CAS does not have.
    pub async fn read_blobs(
        &self,
        function: DigestFunction,
        digests: &[Digest],
    ) -> Result<HashMap<Key, Bytes>> {
        let (small, large): (Vec<Digest>, Vec<Digest>) = digests
            .iter()
            .cloned()
            .partition(|d| d.size_bytes <= BATCH_BLOB_MAX);
        let streamed = futures::stream::iter(large)
            .map(|digest| async move {
                let mut data = Vec::with_capacity(digest.size_bytes as usize);
                let found = self.read_stream(function, &digest, &mut data).await?;
                anyhow::Ok((digest, found.then(|| Bytes::from(data))))
            })
            .buffer_unordered(PARALLEL_READS)
            .try_collect::<Vec<_>>();
        let ((mut blobs, mut missing), streamed) =
            futures::try_join!(self.read_batches(function, &small), streamed)?;
        for (digest, data) in streamed {
            match data {
                Some(data) => {
                    blobs.insert(key(&digest), data);
                }
                None => missing.push(digest),
            }
        }
        if !missing.is_empty() {
            return Err(Missing(missing).into());
        }
        Ok(blobs)
    }

    /// Read each blob into a new file at its path: small ones by batches,
    /// written at once, and large ones streamed meanwhile, a few at a time.
    /// Fails with [`Missing`], naming every one the CAS does not have;
    /// files already written are the caller's to remove.
    pub async fn read_to_files(
        &self,
        function: DigestFunction,
        blobs: Vec<(Digest, PathBuf)>,
    ) -> Result<()> {
        let (small, large): (Vec<_>, Vec<_>) = blobs
            .into_iter()
            .partition(|(d, _)| d.size_bytes <= BATCH_BLOB_MAX);
        let batched = async {
            let digests: Vec<Digest> = small.iter().map(|(d, _)| d.clone()).collect();
            let (mut data, missing) = self.read_batches(function, &digests).await?;
            let writes: Vec<(PathBuf, Bytes)> = small
                .into_iter()
                .filter_map(|(digest, path)| data.remove(&key(&digest)).map(|data| (path, data)))
                .collect();
            tokio::task::spawn_blocking(move || {
                for (path, data) in writes {
                    std::fs::write(&path, data)
                        .with_context(|| format!("writing {}", path.display()))?;
                }
                anyhow::Ok(())
            })
            .await??;
            anyhow::Ok(missing)
        };
        let streamed = futures::stream::iter(large)
            .map(|(digest, path)| async move {
                let mut file = tokio::fs::File::create_new(&path)
                    .await
                    .with_context(|| format!("creating {}", path.display()))?;
                let found = self
                    .read_stream(function, &digest, &mut file)
                    .await
                    .with_context(|| {
                        format!("reading {} into {}", show(&digest), path.display())
                    })?;
                file.flush().await?;
                anyhow::Ok((!found).then_some(digest))
            })
            .buffer_unordered(PARALLEL_READS)
            .try_collect::<Vec<_>>();
        let (mut missing, streamed) = futures::try_join!(batched, streamed)?;
        missing.extend(streamed.into_iter().flatten());
        if !missing.is_empty() {
            return Err(Missing(missing).into());
        }
        Ok(())
    }

    /// Read small blobs by batches, a few at once: those read, checked, and
    /// those the CAS does not have.
    async fn read_batches(
        &self,
        function: DigestFunction,
        digests: &[Digest],
    ) -> Result<(HashMap<Key, Bytes>, Vec<Digest>)> {
        let mut blobs = HashMap::with_capacity(digests.len());
        let mut missing = Vec::new();
        let requests: Vec<_> = batches(digests, |d| d.size_bytes)
            .map(|batch| BatchReadBlobsRequest {
                instance_name: String::new(),
                digests: batch.to_vec(),
                acceptable_compressors: Vec::new(),
                digest_function: function.to_proto(),
            })
            .collect();
        let cas = self.cas.clone();
        let mut responses = futures::stream::iter(requests)
            .map(move |request| {
                let mut cas = cas.clone();
                async move { cas.batch_read_blobs(request).await }
            })
            .buffer_unordered(PARALLEL_BATCHES);
        while let Some(response) = responses.next().await {
            let response = response.context("BatchReadBlobs")?.into_inner();
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
        Ok((blobs, missing))
    }

    /// Stream a blob into `sink`, checking it on the way; `false` if the
    /// CAS does not have it.
    async fn read_stream(
        &self,
        function: DigestFunction,
        digest: &Digest,
        sink: &mut (impl tokio::io::AsyncWrite + Unpin),
    ) -> Result<bool> {
        let request = ReadRequest {
            resource_name: self.resource(function, digest, None),
            read_offset: 0,
            read_limit: 0,
        };
        let mut stream = match self.bytestream.clone().read(request).await {
            Ok(response) => response.into_inner(),
            Err(status) if status.code() == tonic::Code::NotFound => return Ok(false),
            Err(status) => return Err(status).context("ByteStream.Read"),
        };
        let mut hasher = function.hasher();
        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk.data,
                Err(status) if status.code() == tonic::Code::NotFound => return Ok(false),
                Err(status) => return Err(status).context("ByteStream.Read"),
            };
            hasher.update(&chunk);
            sink.write_all(&chunk).await?;
        }
        same(&hasher.finish(), digest)?;
        Ok(true)
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
                    instance_name: String::new(),
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

    /// Store `blobs`, of any size: small ones by batches, with any files
    /// among them read at once, and large ones streamed, a few at a time,
    /// meanwhile, since the daemon refuses a batch over its limit.
    pub async fn write_blobs(
        &self,
        function: DigestFunction,
        blobs: Vec<(Digest, Blob)>,
    ) -> Result<()> {
        let mut small = Vec::new();
        let mut small_files = Vec::new();
        let mut large = Vec::new();
        for (digest, blob) in blobs {
            match blob {
                blob if digest.size_bytes > BATCH_BLOB_MAX => large.push((digest, blob)),
                Blob::File(path) => small_files.push((digest, path)),
                Blob::Memory(data) => small.push((digest, data)),
            }
        }
        let batched = async {
            let read = tokio::task::spawn_blocking(move || {
                small_files
                    .into_iter()
                    .map(|(digest, path)| {
                        let data = std::fs::read(&path)
                            .with_context(|| format!("reading {}", path.display()))?;
                        anyhow::Ok((digest, Bytes::from(data)))
                    })
                    .collect::<Result<Vec<_>>>()
            })
            .await??;
            small.extend(read);
            self.write_batches(function, small).await
        };
        let streamed = futures::stream::iter(large)
            .map(|(digest, blob)| async move {
                match blob {
                    Blob::File(path) => {
                        let file = tokio::fs::File::open(&path)
                            .await
                            .with_context(|| format!("opening {}", path.display()))?;
                        self.write_stream(function, &digest, file)
                            .await
                            .with_context(|| format!("uploading {}", path.display()))
                    }
                    Blob::Memory(data) => self.write_stream(function, &digest, &data[..]).await,
                }
            })
            .buffer_unordered(PARALLEL_WRITES)
            .try_collect::<()>();
        futures::try_join!(batched, streamed)?;
        Ok(())
    }

    async fn write_batches(
        &self,
        function: DigestFunction,
        blobs: Vec<(Digest, Bytes)>,
    ) -> Result<()> {
        for batch in batches(&blobs, |(d, _)| d.size_bytes) {
            let requests = batch
                .iter()
                .map(|(digest, data)| batch_update_blobs_request::Request {
                    digest: Some(digest.clone()),
                    data: data.clone(),
                    compressor: 0,
                })
                .collect();
            let response = self
                .cas
                .clone()
                .batch_update_blobs(BatchUpdateBlobsRequest {
                    instance_name: String::new(),
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

    async fn write_stream(
        &self,
        function: DigestFunction,
        digest: &Digest,
        mut blob: impl tokio::io::AsyncRead + Unpin,
    ) -> Result<()> {
        let resource_name = self.resource(function, digest, Some(uuid::Uuid::new_v4()));
        let size = digest.size_bytes;
        let (tx, rx) = tokio::sync::mpsc::channel::<WriteRequest>(4);
        let reader = async move {
            let mut offset = 0i64;
            let mut buffer = vec![0; WRITE_CHUNK];
            loop {
                let n = blob.read(&mut buffer).await?;
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
                    bail!("the blob ended before its {size} bytes");
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
    same(&function.of(data), digest)
}

/// Check that what was read, whose digest is `got`, is what `digest` names.
fn same(got: &Digest, digest: &Digest) -> Result<()> {
    if got != digest {
        bail!("read {} for {}", show(got), show(digest));
    }
    Ok(())
}

/// `blobs`, whose sizes `size` tells, in groups of at most [`BATCH_BYTES`]
/// each.
fn batches<T>(blobs: &[T], size: impl Fn(&T) -> i64) -> impl Iterator<Item = &[T]> {
    let mut rest = blobs;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let mut bytes = 0;
        let mut n = 0;
        while n < rest.len() && (n == 0 || bytes + size(&rest[n]) <= BATCH_BYTES) {
            bytes += size(&rest[n]);
            n += 1;
        }
        let (batch, tail) = rest.split_at(n);
        rest = tail;
        Some(batch)
    })
}
