// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use anyhow::{Context, Result};
use bytes::Bytes;
use sha2::{Digest as Sha2Digest, Sha256};
use tokio::sync::mpsc;
use tonic::transport::Channel;

use protos::build::bazel::remote::asset::v1 as asset;
use protos::build::bazel::remote::execution::v2::{
    self as reapi, action_cache_client::ActionCacheClient, capabilities_client::CapabilitiesClient,
    content_addressable_storage_client::ContentAddressableStorageClient,
};
use protos::google::bytestream::byte_stream_client::ByteStreamClient;

const BATCH_THRESHOLD: usize = 2 * 1024 * 1024; // 2 MiB
const CHUNK_SIZE: usize = 2 * 1024 * 1024; // 2 MiB

/// Progress update sent from background gRPC operations.
#[derive(Debug, Clone)]
pub struct ProgressUpdate {
    pub transferred: u64,
    pub total: u64,
}

/// Result of a successful upload.
#[derive(Debug, Clone)]
pub struct UploadResult {
    pub hash: String,
    pub size: u64,
    pub already_present: bool,
}

/// Result of a successful download.
#[derive(Debug, Clone)]
pub struct DownloadResult {
    pub hash: String,
    pub size: u64,
    pub output_path: String,
}

/// Result of a successful fetch (URI resolution + download).
#[derive(Debug, Clone)]
pub struct FetchResult {
    pub uri: String,
    pub hash: String,
    pub size: u64,
    pub output_path: String,
}

/// Wrapper around REAPI gRPC client stubs.
pub struct ReapiClient {
    cas: ContentAddressableStorageClient<Channel>,
    bytestream: ByteStreamClient<Channel>,
    ac: ActionCacheClient<Channel>,
    caps: CapabilitiesClient<Channel>,
    push: asset::push_client::PushClient<Channel>,
    fetch: asset::fetch_client::FetchClient<Channel>,
    instance_name: String,
}

impl ReapiClient {
    /// Connect to an REAPI server.
    pub async fn connect(url: &str, instance_name: &str) -> Result<Self> {
        let channel = Channel::from_shared(url.to_string())
            .context("invalid server URL")?
            .http2_keep_alive_interval(std::time::Duration::from_secs(30))
            .keep_alive_timeout(std::time::Duration::from_secs(20))
            .keep_alive_while_idle(true)
            .connect()
            .await
            .context("failed to connect to server")?;

        Ok(Self {
            cas: ContentAddressableStorageClient::new(channel.clone()),
            bytestream: ByteStreamClient::new(channel.clone()),
            ac: ActionCacheClient::new(channel.clone()),
            caps: CapabilitiesClient::new(channel.clone()),
            push: asset::push_client::PushClient::new(channel.clone()),
            fetch: asset::fetch_client::FetchClient::new(channel),
            instance_name: instance_name.to_string(),
        })
    }

    /// Fetch server capabilities.
    pub async fn get_capabilities(&mut self) -> Result<reapi::ServerCapabilities> {
        let resp = self
            .caps
            .get_capabilities(reapi::GetCapabilitiesRequest {
                instance_name: self.instance_name.clone(),
            })
            .await
            .context("GetCapabilities RPC failed")?;
        Ok(resp.into_inner())
    }

    /// Upload a file to CAS. Returns the digest.
    pub async fn upload_file(
        &mut self,
        path: &std::path::Path,
        progress_tx: mpsc::UnboundedSender<ProgressUpdate>,
    ) -> Result<UploadResult> {
        let data = tokio::fs::read(path)
            .await
            .with_context(|| format!("failed to read {}", path.display()))?;
        self.upload_bytes(data, progress_tx).await
    }

    /// Upload raw bytes to CAS. Returns the digest.
    pub async fn upload_bytes(
        &mut self,
        data: Vec<u8>,
        progress_tx: mpsc::UnboundedSender<ProgressUpdate>,
    ) -> Result<UploadResult> {
        let total = data.len() as u64;
        let hash = {
            let mut hasher = Sha256::new();
            hasher.update(&data);
            hex::encode(hasher.finalize())
        };

        let _ = progress_tx.send(ProgressUpdate {
            transferred: 0,
            total,
        });

        // Check if blob already exists
        let digest = reapi::Digest {
            hash: hash.clone(),
            size_bytes: total as i64,
            ..Default::default()
        };
        let missing = self
            .cas
            .find_missing_blobs(reapi::FindMissingBlobsRequest {
                instance_name: self.instance_name.clone(),
                blob_digests: vec![digest.clone()],
                digest_function: 0, // SHA-256 default
            })
            .await
            .context("FindMissingBlobs RPC failed")?
            .into_inner();

        if missing.missing_blob_digests.is_empty() {
            let _ = progress_tx.send(ProgressUpdate {
                transferred: total,
                total,
            });
            return Ok(UploadResult {
                hash,
                size: total,
                already_present: true,
            });
        }

        if data.len() <= BATCH_THRESHOLD {
            self.upload_batch(&hash, Bytes::from(data), &progress_tx)
                .await?;
        } else {
            self.upload_bytestream(&hash, total, Bytes::from(data), &progress_tx)
                .await?;
        }

        Ok(UploadResult {
            hash,
            size: total,
            already_present: false,
        })
    }

    async fn upload_batch(
        &mut self,
        hash: &str,
        data: Bytes,
        progress_tx: &mpsc::UnboundedSender<ProgressUpdate>,
    ) -> Result<()> {
        let total = data.len() as u64;
        let req = reapi::BatchUpdateBlobsRequest {
            instance_name: self.instance_name.clone(),
            requests: vec![reapi::batch_update_blobs_request::Request {
                digest: Some(reapi::Digest {
                    hash: hash.to_string(),
                    size_bytes: total as i64,
                    ..Default::default()
                }),
                data,
                compressor: 0,
            }],
            digest_function: 0,
        };

        let resp = self
            .cas
            .batch_update_blobs(req)
            .await
            .context("BatchUpdateBlobs RPC failed")?
            .into_inner();

        for r in &resp.responses {
            if let Some(ref status) = r.status {
                if status.code != 0 {
                    anyhow::bail!("batch upload failed for {}: {}", hash, status.message);
                }
            }
        }

        let _ = progress_tx.send(ProgressUpdate {
            transferred: total,
            total,
        });
        Ok(())
    }

    async fn upload_bytestream(
        &mut self,
        hash: &str,
        total: u64,
        data: Bytes,
        progress_tx: &mpsc::UnboundedSender<ProgressUpdate>,
    ) -> Result<()> {
        let uuid = uuid::Uuid::new_v4();
        let resource_name = if self.instance_name.is_empty() {
            format!("uploads/{uuid}/blobs/{hash}/{total}")
        } else {
            format!("{}/uploads/{uuid}/blobs/{hash}/{total}", self.instance_name)
        };

        let mut offset: usize = 0;
        let mut requests = Vec::new();
        while offset < data.len() {
            let end = std::cmp::min(offset + CHUNK_SIZE, data.len());
            let chunk = data.slice(offset..end);
            let finish = end == data.len();
            requests.push(protos::google::bytestream::WriteRequest {
                resource_name: resource_name.clone(),
                write_offset: offset as i64,
                finish_write: finish,
                data: chunk,
            });
            offset = end;
        }

        let progress_tx = progress_tx.clone();
        let mut transferred: u64 = 0;
        let request_stream = futures::stream::iter(requests.into_iter().map(move |req| {
            transferred += req.data.len() as u64;
            let _ = progress_tx.send(ProgressUpdate { transferred, total });
            req
        }));

        self.bytestream
            .write(request_stream)
            .await
            .context("ByteStream.Write RPC failed")?;

        Ok(())
    }

    /// Download a blob from CAS by digest.
    pub async fn download_blob(
        &mut self,
        hash: &str,
        size: u64,
        output_path: &std::path::Path,
        progress_tx: mpsc::UnboundedSender<ProgressUpdate>,
    ) -> Result<DownloadResult> {
        let _ = progress_tx.send(ProgressUpdate {
            transferred: 0,
            total: size,
        });

        let data = if (size as usize) <= BATCH_THRESHOLD {
            self.download_batch(hash, size, &progress_tx).await?
        } else {
            self.download_bytestream(hash, size, &progress_tx).await?
        };

        // Verify hash
        let actual_hash = {
            let mut hasher = Sha256::new();
            hasher.update(&data);
            hex::encode(hasher.finalize())
        };
        if actual_hash != hash {
            anyhow::bail!("hash mismatch: expected {hash}, got {actual_hash}");
        }

        tokio::fs::write(output_path, &data)
            .await
            .with_context(|| format!("failed to write {}", output_path.display()))?;

        Ok(DownloadResult {
            hash: hash.to_string(),
            size,
            output_path: output_path.display().to_string(),
        })
    }

    async fn download_batch(
        &mut self,
        hash: &str,
        size: u64,
        progress_tx: &mpsc::UnboundedSender<ProgressUpdate>,
    ) -> Result<Bytes> {
        let req = reapi::BatchReadBlobsRequest {
            instance_name: self.instance_name.clone(),
            digests: vec![reapi::Digest {
                hash: hash.to_string(),
                size_bytes: size as i64,
                ..Default::default()
            }],
            acceptable_compressors: vec![],
            digest_function: 0,
        };

        let resp = self
            .cas
            .batch_read_blobs(req)
            .await
            .context("BatchReadBlobs RPC failed")?
            .into_inner();

        let r = resp
            .responses
            .into_iter()
            .next()
            .context("empty BatchReadBlobs response")?;

        if let Some(ref status) = r.status {
            if status.code != 0 {
                anyhow::bail!("batch read failed for {hash}: {}", status.message);
            }
        }

        let _ = progress_tx.send(ProgressUpdate {
            transferred: size,
            total: size,
        });

        Ok(r.data)
    }

    async fn download_bytestream(
        &mut self,
        hash: &str,
        size: u64,
        progress_tx: &mpsc::UnboundedSender<ProgressUpdate>,
    ) -> Result<Bytes> {
        let resource_name = if self.instance_name.is_empty() {
            format!("blobs/{hash}/{size}")
        } else {
            format!("{}/blobs/{hash}/{size}", self.instance_name)
        };

        let resp = self
            .bytestream
            .read(protos::google::bytestream::ReadRequest {
                resource_name,
                read_offset: 0,
                read_limit: 0,
            })
            .await
            .context("ByteStream.Read RPC failed")?;

        let mut stream = resp.into_inner();
        let mut buf = Vec::with_capacity(size as usize);

        use tokio_stream::StreamExt;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("ByteStream.Read stream error")?;
            buf.extend_from_slice(&chunk.data);
            let _ = progress_tx.send(ProgressUpdate {
                transferred: buf.len() as u64,
                total: size,
            });
        }

        Ok(Bytes::from(buf))
    }

    /// Push a remote asset association, mapping URIs + qualifiers to a blob
    /// already present in CAS.
    pub async fn push_blob(
        &mut self,
        hash: &str,
        size: i64,
        uris: Vec<String>,
        qualifiers: Vec<(String, String)>,
    ) -> Result<()> {
        let req = asset::PushBlobRequest {
            instance_name: self.instance_name.clone(),
            uris,
            qualifiers: qualifiers
                .into_iter()
                .map(|(name, value)| asset::Qualifier { name, value })
                .collect(),
            blob_digest: Some(reapi::Digest {
                hash: hash.to_string(),
                size_bytes: size,
                ..Default::default()
            }),
            ..Default::default()
        };

        self.push
            .push_blob(req)
            .await
            .context("PushBlob RPC failed")?;

        Ok(())
    }

    /// Fetch a remote asset by URI + qualifiers and download it to a file.
    ///
    /// Resolves the URI via the FetchBlob RPC, then downloads the blob from
    /// CAS using the returned digest.
    pub async fn fetch_asset(
        &mut self,
        uri: &str,
        qualifiers: Vec<(String, String)>,
        output_path: &std::path::Path,
        progress_tx: mpsc::UnboundedSender<ProgressUpdate>,
    ) -> Result<FetchResult> {
        let req = asset::FetchBlobRequest {
            instance_name: self.instance_name.clone(),
            uris: vec![uri.to_string()],
            qualifiers: qualifiers
                .into_iter()
                .map(|(name, value)| asset::Qualifier { name, value })
                .collect(),
            ..Default::default()
        };

        let resp = self
            .fetch
            .fetch_blob(req)
            .await
            .context("FetchBlob RPC failed")?
            .into_inner();

        let digest = resp
            .blob_digest
            .context("FetchBlob response missing blob_digest")?;
        let hash = digest.hash;
        let size = digest.size_bytes as u64;

        self.download_blob(&hash, size, output_path, progress_tx)
            .await?;

        Ok(FetchResult {
            uri: if resp.uri.is_empty() {
                uri.to_string()
            } else {
                resp.uri
            },
            hash,
            size,
            output_path: output_path.display().to_string(),
        })
    }

    /// Get an action cache result by action digest.
    pub async fn get_action_result(
        &mut self,
        hash: &str,
        size: i64,
    ) -> Result<Option<reapi::ActionResult>> {
        let resp = self
            .ac
            .get_action_result(reapi::GetActionResultRequest {
                instance_name: self.instance_name.clone(),
                action_digest: Some(reapi::Digest {
                    hash: hash.to_string(),
                    size_bytes: size,
                    ..Default::default()
                }),
                ..Default::default()
            })
            .await;

        match resp {
            Ok(r) => Ok(Some(r.into_inner())),
            Err(status) if status.code() == tonic::Code::NotFound => Ok(None),
            Err(e) => Err(e).context("GetActionResult RPC failed"),
        }
    }
}
