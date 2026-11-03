// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The CAS, one blob at a time or many at once.
//!
//! Blobs at or below [`BATCH_THRESHOLD`] travel in batches, packed up to
//! [`BATCH_BYTES`] a request; larger ones stream over ByteStream. Callers
//! never choose: a blob's size already decides which is cheaper. Everything
//! read is checked against its digest, and a blob the server lacks is a
//! miss, `Ok(None)` for one blob and [`Error::Missing`] for many, never an
//! RPC error.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use bytes::Bytes;
use futures::{StreamExt as _, TryStreamExt as _};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tonic::transport::Channel;

use protos::build::bazel::remote::execution::v2 as reapi;
use protos::google::bytestream;
use reapi_cas::resource::{read_name, write_name};
use reapi_cas::{Compression, Digest, DigestFn};

use crate::{Error, Progress, Result};

/// Blobs at or below this size use the batch CAS RPCs; larger ones stream.
///
/// Servers advertise their own ceiling as
/// [`ServerCapabilities::max_batch_total_size_bytes`](crate::ServerCapabilities);
/// this is comfortably under the common default.
pub const BATCH_THRESHOLD: u64 = 1024 * 1024;

/// Most bytes of blobs in one batch request, under gRPC's default 4 MB
/// message limit, which servers keep, with room for the messages around
/// them.
pub const BATCH_BYTES: u64 = 3 * 1024 * 1024;

/// Batch requests under way at once.
const PARALLEL_BATCHES: usize = 4;

/// Blobs streamed from the CAS at once.
const PARALLEL_READS: usize = 16;

/// Blobs streamed into the CAS at once.
const PARALLEL_WRITES: usize = 4;

/// Most digests asked about in one FindMissingBlobs.
const FIND_MISSING_MAX: usize = 4096;

/// Payload of one ByteStream `Write` message.
const WRITE_CHUNK_SIZE: usize = 1024 * 1024;

/// `google.rpc.Code.NOT_FOUND`.
const CODE_NOT_FOUND: i32 = 5;

/// A blob to store, and where it is.
#[derive(Debug, Clone)]
pub enum Blob {
    File(PathBuf),
    Memory(Bytes),
}

/// See the module documentation. Cheap to clone: the clients share one
/// channel.
#[derive(Clone, Debug)]
pub struct Cas {
    cas: reapi::content_addressable_storage_client::ContentAddressableStorageClient<Channel>,
    bytestream: bytestream::byte_stream_client::ByteStreamClient<Channel>,
    instance: String,
}

impl Cas {
    /// The CAS served over `channel`, under the default instance name.
    ///
    /// This is the one place the crate's API names a `tonic` type: callers
    /// that reach a server some other way than
    /// [`ReapiClient::connect`](crate::ReapiClient::connect), such as over a
    /// tunnel, bring their own channel.
    pub fn new(channel: Channel) -> Self {
        Self {
            cas: reapi::content_addressable_storage_client::ContentAddressableStorageClient::new(
                channel.clone(),
            )
            .max_decoding_message_size(usize::MAX),
            bytestream: bytestream::byte_stream_client::ByteStreamClient::new(channel),
            instance: String::new(),
        }
    }

    /// This CAS under the instance name `instance`.
    pub fn with_instance(self, instance: impl Into<String>) -> Self {
        Self {
            instance: instance.into(),
            ..self
        }
    }

    /// The instance name this addresses.
    pub fn instance_name(&self) -> &str {
        &self.instance
    }

    /// Read one blob, checked, reporting bytes as they arrive; `None` if
    /// the CAS does not have it.
    pub async fn read_blob(
        &self,
        function: DigestFn,
        digest: &Digest,
        progress: &Progress,
    ) -> Result<Option<Bytes>> {
        let total = digest.size;
        progress.report(0, total);
        if digest.size <= BATCH_THRESHOLD {
            let (mut blobs, _) = self
                .read_batches(function, std::slice::from_ref(digest))
                .await?;
            let data = blobs.remove(digest);
            if data.is_some() {
                progress.report(total, total);
            }
            return Ok(data);
        }
        let mut data = Vec::with_capacity(usize::try_from(digest.size).unwrap_or(0));
        let found = self
            .read_stream(function, digest, &mut data, progress)
            .await?;
        Ok(found.then(|| Bytes::from(data)))
    }

    /// Begin reading a blob, returning a pull-based reader instead of
    /// buffering the whole thing; `None` if the CAS does not have it.
    /// Unlike [`read_blob`](Self::read_blob), **the caller must check the
    /// content itself**. This always streams, whatever the blob's size.
    pub async fn read_blob_stream(
        &self,
        function: DigestFn,
        digest: &Digest,
    ) -> Result<Option<BlobStream>> {
        let request = bytestream::ReadRequest {
            resource_name: read_name(&self.instance, function, Compression::Identity, digest),
            read_offset: 0,
            read_limit: 0,
        };
        match self.bytestream.clone().read(request).await {
            Ok(response) => Ok(Some(BlobStream {
                inner: response.into_inner(),
            })),
            Err(status) if status.code() == tonic::Code::NotFound => Ok(None),
            Err(source) => Err(Error::Rpc {
                rpc: "ByteStream.Read",
                source,
            }),
        }
    }

    /// Store one blob, reporting bytes as they are handed to the transport.
    ///
    /// The server checks the content against `digest` and refuses a
    /// mismatch; a `data` whose length is not the digest's size is refused
    /// here, before it reaches the wire.
    pub async fn write_blob(
        &self,
        function: DigestFn,
        digest: &Digest,
        data: Bytes,
        progress: &Progress,
    ) -> Result<()> {
        if data.len() as u64 != digest.size {
            return Err(Error::SizeMismatch {
                expected: *digest,
                actual_size: data.len() as u64,
            });
        }
        let total = digest.size;
        progress.report(0, total);
        if digest.size <= BATCH_THRESHOLD {
            self.write_batches(function, vec![(*digest, data)]).await?;
            progress.report(total, total);
            return Ok(());
        }
        self.write_stream(function, digest, &data[..], progress)
            .await
    }

    /// Which of `digests` the CAS does not have. All share one digest
    /// function, since a request names one for all of them.
    pub async fn find_missing(
        &self,
        function: DigestFn,
        digests: &[Digest],
    ) -> Result<Vec<Digest>> {
        let mut missing = Vec::new();
        for chunk in digests.chunks(FIND_MISSING_MAX) {
            let response = self
                .cas
                .clone()
                .find_missing_blobs(reapi::FindMissingBlobsRequest {
                    instance_name: self.instance.clone(),
                    blob_digests: chunk.iter().map(Digest::to_proto).collect(),
                    digest_function: function.to_proto_i32(),
                })
                .await
                .map_err(|source| Error::Rpc {
                    rpc: "ContentAddressableStorage.FindMissingBlobs",
                    source,
                })?
                .into_inner();
            for digest in &response.missing_blob_digests {
                missing.push(Digest::from_proto(digest)?);
            }
        }
        Ok(missing)
    }

    /// Read blobs of any size into memory: small ones by batches, and large
    /// ones streamed meanwhile, a few at a time. Fails with
    /// [`Error::Missing`], naming every one the CAS does not have.
    pub async fn read_blobs(
        &self,
        function: DigestFn,
        digests: &[Digest],
    ) -> Result<HashMap<Digest, Bytes>> {
        let (small, large): (Vec<Digest>, Vec<Digest>) = digests
            .iter()
            .copied()
            .partition(|d| d.size <= BATCH_THRESHOLD);
        let streamed = futures::stream::iter(large)
            .map(|digest| async move {
                let mut data = Vec::with_capacity(usize::try_from(digest.size).unwrap_or(0));
                let found = self
                    .read_stream(function, &digest, &mut data, &Progress::none())
                    .await?;
                Ok::<_, Error>((digest, found.then(|| Bytes::from(data))))
            })
            .buffer_unordered(PARALLEL_READS)
            .try_collect::<Vec<_>>();
        let ((mut blobs, mut missing), streamed) =
            futures::try_join!(self.read_batches(function, &small), streamed)?;
        for (digest, data) in streamed {
            match data {
                Some(data) => {
                    blobs.insert(digest, data);
                }
                None => missing.push(digest),
            }
        }
        if !missing.is_empty() {
            return Err(Error::Missing(missing));
        }
        Ok(blobs)
    }

    /// Read each blob into a new file at its path: small ones by batches,
    /// written at once, and large ones streamed meanwhile, a few at a time.
    /// Fails with [`Error::Missing`], naming every one the CAS does not
    /// have; files already written are the caller's to remove.
    pub async fn read_to_files(
        &self,
        function: DigestFn,
        blobs: Vec<(Digest, PathBuf)>,
    ) -> Result<()> {
        let (small, large): (Vec<_>, Vec<_>) = blobs
            .into_iter()
            .partition(|(d, _)| d.size <= BATCH_THRESHOLD);
        let batched = async {
            let digests: Vec<Digest> = small.iter().map(|(d, _)| *d).collect();
            let (mut data, missing) = self.read_batches(function, &digests).await?;
            let writes: Vec<(PathBuf, Bytes)> = small
                .into_iter()
                .filter_map(|(digest, path)| data.remove(&digest).map(|data| (path, data)))
                .collect();
            tokio::task::spawn_blocking(move || {
                for (path, data) in writes {
                    std::fs::write(&path, data).map_err(io("writing", &path))?;
                }
                Ok::<_, Error>(())
            })
            .await
            .map_err(|e| Error::Io {
                operation: "writing blobs",
                path: String::new(),
                source: std::io::Error::other(e),
            })??;
            Ok::<_, Error>(missing)
        };
        let streamed = futures::stream::iter(large)
            .map(|(digest, path)| async move {
                let mut file = tokio::fs::File::create_new(&path)
                    .await
                    .map_err(io("creating", &path))?;
                let found = self
                    .read_stream(function, &digest, &mut file, &Progress::none())
                    .await?;
                file.flush().await.map_err(io("writing", &path))?;
                Ok::<_, Error>((!found).then_some(digest))
            })
            .buffer_unordered(PARALLEL_READS)
            .try_collect::<Vec<_>>();
        let (mut missing, streamed) = futures::try_join!(batched, streamed)?;
        missing.extend(streamed.into_iter().flatten());
        if !missing.is_empty() {
            return Err(Error::Missing(missing));
        }
        Ok(())
    }

    /// Store `blobs`, of any size: small ones by batches, with any files
    /// among them read at once, and large ones streamed, a few at a time,
    /// meanwhile, since servers refuse a batch over their limit.
    pub async fn write_blobs(&self, function: DigestFn, blobs: Vec<(Digest, Blob)>) -> Result<()> {
        let mut small = Vec::new();
        let mut small_files = Vec::new();
        let mut large = Vec::new();
        for (digest, blob) in blobs {
            match blob {
                blob if digest.size > BATCH_THRESHOLD => large.push((digest, blob)),
                Blob::File(path) => small_files.push((digest, path)),
                Blob::Memory(data) => small.push((digest, data)),
            }
        }
        let batched = async {
            let read = tokio::task::spawn_blocking(move || {
                small_files
                    .into_iter()
                    .map(|(digest, path)| {
                        let data = std::fs::read(&path).map_err(io("reading", &path))?;
                        Ok::<_, Error>((digest, Bytes::from(data)))
                    })
                    .collect::<Result<Vec<_>>>()
            })
            .await
            .map_err(|e| Error::Io {
                operation: "reading blobs",
                path: String::new(),
                source: std::io::Error::other(e),
            })??;
            small.extend(read);
            self.write_batches(function, small).await
        };
        let streamed = futures::stream::iter(large)
            .map(|(digest, blob)| async move {
                let none = Progress::none();
                match blob {
                    Blob::File(path) => {
                        let file = tokio::fs::File::open(&path)
                            .await
                            .map_err(io("opening", &path))?;
                        self.write_stream(function, &digest, file, &none).await
                    }
                    Blob::Memory(data) => {
                        self.write_stream(function, &digest, &data[..], &none).await
                    }
                }
            })
            .buffer_unordered(PARALLEL_WRITES)
            .try_collect::<()>();
        futures::try_join!(batched, streamed)?;
        Ok(())
    }

    /// Read small blobs by batches, a few at once: those read, checked, and
    /// those the CAS does not have.
    async fn read_batches(
        &self,
        function: DigestFn,
        digests: &[Digest],
    ) -> Result<(HashMap<Digest, Bytes>, Vec<Digest>)> {
        let mut blobs = HashMap::with_capacity(digests.len());
        let mut missing = Vec::new();
        let requests: Vec<_> = batches(digests, |d| d.size)
            .map(|batch| reapi::BatchReadBlobsRequest {
                instance_name: self.instance.clone(),
                digests: batch.iter().map(Digest::to_proto).collect(),
                acceptable_compressors: Vec::new(),
                digest_function: function.to_proto_i32(),
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
            let response = response
                .map_err(|source| Error::Rpc {
                    rpc: "ContentAddressableStorage.BatchReadBlobs",
                    source,
                })?
                .into_inner();
            for blob in response.responses {
                let digest = blob
                    .digest
                    .as_ref()
                    .ok_or_else(|| Error::MalformedResponse {
                        rpc: "BatchReadBlobs",
                        detail: "a response without a digest".to_string(),
                    })?;
                let digest = Digest::from_proto(digest)?;
                match blob.status.as_ref().map_or(0, |s| s.code) {
                    0 => {}
                    CODE_NOT_FOUND => {
                        missing.push(digest);
                        continue;
                    }
                    code => {
                        return Err(Error::BlobFailed {
                            rpc: "BatchReadBlobs",
                            digest,
                            code,
                            message: blob.status.map(|s| s.message).unwrap_or_default(),
                        });
                    }
                }
                check(function, &digest, function.digest(&blob.data))?;
                blobs.insert(digest, blob.data);
            }
        }
        Ok((blobs, missing))
    }

    /// Stream a blob into `sink`, checking it on the way; `false` if the
    /// CAS does not have it.
    async fn read_stream(
        &self,
        function: DigestFn,
        digest: &Digest,
        sink: &mut (impl tokio::io::AsyncWrite + Unpin),
        progress: &Progress,
    ) -> Result<bool> {
        let Some(mut stream) = self.read_blob_stream(function, digest).await? else {
            return Ok(false);
        };
        let mut hasher = function.hasher();
        let mut read = 0;
        loop {
            let chunk = match stream.inner.message().await {
                Ok(Some(chunk)) => chunk.data,
                Ok(None) => break,
                Err(status) if status.code() == tonic::Code::NotFound => return Ok(false),
                Err(source) => {
                    return Err(Error::Rpc {
                        rpc: "ByteStream.Read",
                        source,
                    });
                }
            };
            hasher.update(&chunk);
            sink.write_all(&chunk).await.map_err(|source| Error::Io {
                operation: "writing",
                path: digest.to_string(),
                source,
            })?;
            read += chunk.len() as u64;
            progress.report(read, digest.size);
        }
        check(function, digest, hasher.finish())?;
        Ok(true)
    }

    async fn write_batches(&self, function: DigestFn, blobs: Vec<(Digest, Bytes)>) -> Result<()> {
        for batch in batches(&blobs, |(d, _)| d.size) {
            let requests = batch
                .iter()
                .map(
                    |(digest, data)| reapi::batch_update_blobs_request::Request {
                        digest: Some(digest.to_proto()),
                        data: data.clone(),
                        compressor: 0,
                    },
                )
                .collect();
            let response = self
                .cas
                .clone()
                .batch_update_blobs(reapi::BatchUpdateBlobsRequest {
                    instance_name: self.instance.clone(),
                    requests,
                    digest_function: function.to_proto_i32(),
                })
                .await
                .map_err(|source| Error::Rpc {
                    rpc: "ContentAddressableStorage.BatchUpdateBlobs",
                    source,
                })?
                .into_inner();
            for blob in response.responses {
                if let Some(status) = blob.status.filter(|s| s.code != 0) {
                    let digest = match &blob.digest {
                        Some(d) => Digest::from_proto(d)?,
                        None => {
                            return Err(Error::MalformedResponse {
                                rpc: "BatchUpdateBlobs",
                                detail: format!("status {}: {}", status.code, status.message),
                            });
                        }
                    };
                    return Err(Error::BlobFailed {
                        rpc: "BatchUpdateBlobs",
                        digest,
                        code: status.code,
                        message: status.message,
                    });
                }
            }
        }
        Ok(())
    }

    async fn write_stream(
        &self,
        function: DigestFn,
        digest: &Digest,
        mut blob: impl tokio::io::AsyncRead + Unpin,
        progress: &Progress,
    ) -> Result<()> {
        let uuid = uuid::Uuid::new_v4().to_string();
        let resource_name = write_name(
            &self.instance,
            &uuid,
            function,
            Compression::Identity,
            digest,
        );
        let size = digest.size;
        let (tx, rx) = tokio::sync::mpsc::channel::<bytestream::WriteRequest>(4);
        let reader = async move {
            let mut offset = 0u64;
            let mut buffer = vec![0; WRITE_CHUNK_SIZE];
            loop {
                let n = blob.read(&mut buffer).await.map_err(|source| Error::Io {
                    operation: "reading",
                    path: digest.to_string(),
                    source,
                })?;
                // An empty blob still needs one message, to carry
                // finish_write.
                let finish_write = offset + n as u64 >= size;
                let request = bytestream::WriteRequest {
                    resource_name: if offset == 0 {
                        resource_name.clone()
                    } else {
                        String::new()
                    },
                    write_offset: offset as i64,
                    finish_write,
                    data: Bytes::copy_from_slice(&buffer[..n]),
                };
                offset += n as u64;
                if tx.send(request).await.is_err() || finish_write {
                    progress.report(offset.min(size), size);
                    return Ok::<_, Error>(());
                }
                progress.report(offset, size);
                if n == 0 {
                    return Err(Error::SizeMismatch {
                        expected: *digest,
                        actual_size: offset,
                    });
                }
            }
        };
        let mut client = self.bytestream.clone();
        let write = client.write(tokio_stream::wrappers::ReceiverStream::new(rx));
        let (read, written) = tokio::join!(reader, write);
        read?;
        let written = written
            .map_err(|source| Error::Rpc {
                rpc: "ByteStream.Write",
                source,
            })?
            .into_inner();
        if written.committed_size != size as i64 {
            return Err(Error::MalformedResponse {
                rpc: "ByteStream.Write",
                detail: format!("committed {} of {size} bytes", written.committed_size),
            });
        }
        Ok(())
    }
}

/// A blob being read incrementally. See
/// [`Cas::read_blob_stream`].
#[derive(Debug)]
pub struct BlobStream {
    inner: tonic::Streaming<bytestream::ReadResponse>,
}

impl BlobStream {
    /// Pull the next chunk, or `None` at end of stream.
    pub async fn next_chunk(&mut self) -> Result<Option<Bytes>> {
        match self.inner.message().await {
            Ok(Some(response)) => Ok(Some(response.data)),
            Ok(None) => Ok(None),
            Err(source) => Err(Error::Rpc {
                rpc: "ByteStream.Read",
                source,
            }),
        }
    }
}

/// Check that what was read, whose digest is `got`, is what `digest` names.
fn check(function: DigestFn, digest: &Digest, got: Digest) -> Result<()> {
    if got.size != digest.size {
        return Err(Error::SizeMismatch {
            expected: *digest,
            actual_size: got.size,
        });
    }
    if got != *digest {
        return Err(Error::DigestMismatch {
            function,
            expected: *digest,
            actual: got,
        });
    }
    Ok(())
}

fn io<'a>(operation: &'static str, path: &'a Path) -> impl FnOnce(std::io::Error) -> Error + 'a {
    move |source| Error::Io {
        operation,
        path: path.display().to_string(),
        source,
    }
}

/// `blobs`, whose sizes `size` tells, in groups of at most [`BATCH_BYTES`]
/// each.
fn batches<T>(blobs: &[T], size: impl Fn(&T) -> u64) -> impl Iterator<Item = &[T]> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batches_fill_up_to_their_limit() {
        let sizes = [BATCH_BYTES - 10, 5, 5, 1, BATCH_BYTES + 1, 0];
        let grouped: Vec<Vec<u64>> = batches(&sizes, |s| *s).map(<[u64]>::to_vec).collect();
        assert_eq!(
            grouped,
            [
                vec![BATCH_BYTES - 10, 5, 5],
                vec![1],
                // A blob over the limit goes alone; the caller streams such.
                vec![BATCH_BYTES + 1],
                vec![0],
            ]
        );
        assert_eq!(batches(&[] as &[u64], |s| *s).count(), 0);
    }

    #[test]
    fn a_short_or_wrong_blob_is_told_apart() {
        let f = DigestFn::Sha256;
        let digest = f.digest(b"four");
        assert!(check(f, &digest, f.digest(b"four")).is_ok());
        assert!(matches!(
            check(f, &digest, f.digest(b"for")),
            Err(Error::SizeMismatch { actual_size: 3, .. })
        ));
        assert!(matches!(
            check(f, &digest, f.digest(b"fore")),
            Err(Error::DigestMismatch { .. })
        ));
    }
}
