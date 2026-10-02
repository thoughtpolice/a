// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Connections and the RPCs the workloads share.

use std::sync::Arc;

use anyhow::{Context as _, Result, bail};
use bytes::Bytes;
use futures::{StreamExt as _, TryStreamExt as _};
use sha2::{Digest as _, Sha256};
use tonic::transport::{Channel, Endpoint};

use protos::build::bazel::remote::execution::v2::{
    BatchReadBlobsRequest, BatchUpdateBlobsRequest, Digest, action_cache_client::ActionCacheClient,
    batch_update_blobs_request, compressor,
    content_addressable_storage_client::ContentAddressableStorageClient,
};
use protos::google::bytestream::{ReadRequest, WriteRequest, byte_stream_client::ByteStreamClient};

use crate::data::{Blob, Rng};

/// Blobs at most this large go up in BatchUpdateBlobs, larger by ByteStream.
pub const BATCH_BLOB_LIMIT: usize = 1 << 20;
/// Most bytes one batch request carries (the server takes 4 MB).
pub const BATCH_BYTES: usize = 3_500_000;

/// A fixed set of HTTP/2 connections, handed out round robin by worker.
#[derive(Clone)]
pub struct Clients {
    channels: Arc<Vec<Channel>>,
    pub instance: String,
    /// Bytes per ByteStream WriteRequest.
    pub message_bytes: usize,
}

impl Clients {
    pub async fn connect(
        url: &str,
        connections: usize,
        instance: String,
        message_bytes: usize,
    ) -> Result<Self> {
        let mut channels = Vec::with_capacity(connections);
        for _ in 0..connections.max(1) {
            let channel = Endpoint::from_shared(url.to_string())?
                .tcp_nodelay(true)
                .initial_stream_window_size(8 << 20)
                .initial_connection_window_size(32 << 20)
                .http2_keep_alive_interval(std::time::Duration::from_secs(30))
                .connect()
                .await
                .with_context(|| format!("connecting to {url}"))?;
            channels.push(channel);
        }
        Ok(Self {
            channels: Arc::new(channels),
            instance,
            message_bytes,
        })
    }

    fn channel(&self, worker: usize) -> Channel {
        self.channels[worker % self.channels.len()].clone()
    }

    pub fn cas(&self, worker: usize) -> ContentAddressableStorageClient<Channel> {
        ContentAddressableStorageClient::new(self.channel(worker))
            .max_decoding_message_size(usize::MAX)
            .max_encoding_message_size(usize::MAX)
    }

    pub fn bs(&self, worker: usize) -> ByteStreamClient<Channel> {
        ByteStreamClient::new(self.channel(worker))
            .max_decoding_message_size(usize::MAX)
            .max_encoding_message_size(usize::MAX)
    }

    pub fn ac(&self, worker: usize) -> ActionCacheClient<Channel> {
        ActionCacheClient::new(self.channel(worker))
            .max_decoding_message_size(usize::MAX)
            .max_encoding_message_size(usize::MAX)
    }

    fn prefix(&self) -> String {
        if self.instance.is_empty() {
            String::new()
        } else {
            format!("{}/", self.instance)
        }
    }

    /// ByteStream-write `blob`, zstd-compressed on the wire if `zstd`.
    /// Returns the committed size the server reported.
    pub async fn bs_write(
        &self,
        worker: usize,
        blob: &Blob,
        zstd: Option<&Bytes>,
        rng: &mut Rng,
    ) -> Result<i64, tonic::Status> {
        let uuid = format!(
            "{:016x}-{:016x}",
            rng.next_u64(),
            rng.next_u64() & 0x0fff_ffff_ffff_ffff
        );
        let (kind, payload) = match zstd {
            Some(packed) => ("compressed-blobs/zstd", packed.clone()),
            None => ("blobs", blob.data.clone()),
        };
        let resource_name = format!(
            "{}uploads/{uuid}/{kind}/{}/{}",
            self.prefix(),
            blob.digest.hash,
            blob.digest.size_bytes
        );
        let step = self.message_bytes.max(1);
        let mut messages = Vec::with_capacity(payload.len() / step + 1);
        let mut at = 0;
        loop {
            let end = (at + step).min(payload.len());
            messages.push(WriteRequest {
                resource_name: if at == 0 {
                    resource_name.clone()
                } else {
                    String::new()
                },
                write_offset: at as i64,
                finish_write: end == payload.len(),
                data: payload.slice(at..end),
            });
            at = end;
            if at == payload.len() {
                break;
            }
        }
        let resp = self
            .bs(worker)
            .write(futures::stream::iter(messages))
            .await?;
        Ok(resp.into_inner().committed_size)
    }

    /// ByteStream-read `digest`, checking what arrives hashes to it.
    /// Returns the bytes received on the wire and whether they checked out.
    /// With `hold`, the read stops after its first message for that long
    /// before going on, as a client that falls behind would.
    pub async fn bs_read(
        &self,
        worker: usize,
        digest: &Digest,
        zstd: bool,
        hold: Option<std::time::Duration>,
    ) -> Result<(u64, bool), tonic::Status> {
        let kind = if zstd {
            "compressed-blobs/zstd"
        } else {
            "blobs"
        };
        let resource_name = format!(
            "{}{kind}/{}/{}",
            self.prefix(),
            digest.hash,
            digest.size_bytes
        );
        let mut stream = self
            .bs(worker)
            .read(ReadRequest {
                resource_name,
                read_offset: 0,
                read_limit: 0,
            })
            .await?
            .into_inner();
        let mut hasher = Sha256::new();
        let mut wire = 0u64;
        let mut size = 0u64;
        let mut first = None;
        if let Some(hold) = hold {
            first = stream.message().await?;
            tokio::time::sleep(hold).await;
        }
        let mut stream = futures::stream::iter(first.map(Ok)).chain(stream);
        if zstd {
            let mut decoder = zstd::stream::write::Decoder::new(HashSink {
                hasher: &mut hasher,
                size: &mut size,
            })
            .map_err(|e| tonic::Status::internal(e.to_string()))?;
            while let Some(msg) = stream.next().await.transpose()? {
                wire += msg.data.len() as u64;
                std::io::Write::write_all(&mut decoder, &msg.data)
                    .map_err(|e| tonic::Status::data_loss(format!("zstd: {e}")))?;
            }
            std::io::Write::flush(&mut decoder)
                .map_err(|e| tonic::Status::data_loss(format!("zstd: {e}")))?;
        } else {
            while let Some(msg) = stream.next().await.transpose()? {
                wire += msg.data.len() as u64;
                size += msg.data.len() as u64;
                hasher.update(&msg.data);
            }
        }
        let ok = size == digest.size_bytes as u64 && hex::encode(hasher.finalize()) == digest.hash;
        Ok((wire, ok))
    }

    /// BatchReadBlobs `digests`. Returns the bytes received, and how many
    /// came back other than OK with contents hashing to their digest.
    pub async fn batch_read(
        &self,
        worker: usize,
        digests: Vec<Digest>,
        zstd: bool,
    ) -> Result<(u64, Vec<String>), tonic::Status> {
        let resp = self
            .cas(worker)
            .batch_read_blobs(BatchReadBlobsRequest {
                instance_name: self.instance.clone(),
                digests,
                acceptable_compressors: if zstd {
                    vec![compressor::Value::Zstd as i32]
                } else {
                    vec![]
                },
                digest_function: 0,
            })
            .await?
            .into_inner();
        let mut wire = 0;
        let mut bad = Vec::new();
        for r in resp.responses {
            let digest = r.digest.unwrap_or_default();
            let code = r.status.as_ref().map_or(-1, |s| s.code);
            if code != 0 {
                bad.push(format!("{}: status {code}", digest.hash));
                continue;
            }
            wire += r.data.len() as u64;
            let data = if r.compressor == compressor::Value::Zstd as i32 {
                match zstd::stream::decode_all(&r.data[..]) {
                    Ok(d) => Bytes::from(d),
                    Err(e) => {
                        bad.push(format!("{}: zstd {e}", digest.hash));
                        continue;
                    }
                }
            } else {
                r.data
            };
            if data.len() as i64 != digest.size_bytes
                || hex::encode(Sha256::digest(&data)) != digest.hash
            {
                bad.push(format!("{}: contents do not match", digest.hash));
            }
        }
        Ok((wire, bad))
    }

    /// Upload `blobs` (batched or by ByteStream as their size calls for),
    /// `concurrency` requests at a time. Fails on any blob not stored.
    pub async fn upload_all(&self, blobs: &[Blob], concurrency: usize) -> Result<()> {
        let mut batches: Vec<Vec<&Blob>> = Vec::new();
        let mut large = Vec::new();
        let mut current = Vec::new();
        let mut current_bytes = 0;
        for b in blobs {
            if b.data.len() > BATCH_BLOB_LIMIT {
                large.push(b);
                continue;
            }
            if current_bytes + b.data.len() > BATCH_BYTES || current.len() >= 1000 {
                batches.push(std::mem::take(&mut current));
                current_bytes = 0;
            }
            current_bytes += b.data.len();
            current.push(b);
        }
        if !current.is_empty() {
            batches.push(current);
        }

        futures::stream::iter(batches.into_iter().enumerate())
            .map(|(i, batch)| async move {
                let resp = self
                    .cas(i)
                    .batch_update_blobs(batch_update(&self.instance, &batch))
                    .await?
                    .into_inner();
                for r in resp.responses {
                    let code = r.status.as_ref().map_or(-1, |s| s.code);
                    if code != 0 {
                        bail!("upload of {:?} failed: {:?}", r.digest, r.status);
                    }
                }
                Ok(())
            })
            .buffer_unordered(concurrency)
            .try_collect::<()>()
            .await?;

        futures::stream::iter(large.into_iter().enumerate())
            .map(|(i, b)| async move {
                let mut rng = Rng::keyed(&[i as u64, 0xb5]);
                let committed = self.bs_write(i, b, None, &mut rng).await?;
                if committed != b.digest.size_bytes {
                    bail!(
                        "ByteStream upload committed {committed} of {}",
                        b.data.len()
                    );
                }
                Ok(())
            })
            .buffer_unordered(concurrency)
            .try_collect::<()>()
            .await
    }
}

/// A BatchUpdateBlobs request for `blobs`, uncompressed.
pub fn batch_update(instance: &str, blobs: &[&Blob]) -> BatchUpdateBlobsRequest {
    BatchUpdateBlobsRequest {
        instance_name: instance.to_string(),
        requests: blobs
            .iter()
            .map(|b| batch_update_blobs_request::Request {
                digest: Some(b.digest.clone()),
                data: b.data.clone(),
                compressor: compressor::Value::Identity as i32,
            })
            .collect(),
        digest_function: 0,
    }
}

/// Feeds decompressed bytes into a hash.
struct HashSink<'a> {
    hasher: &'a mut Sha256,
    size: &'a mut u64,
}

impl std::io::Write for HashSink<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.hasher.update(buf);
        *self.size += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
