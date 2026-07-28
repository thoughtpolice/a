// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! A client for [Remote Build APIs][REAPI] servers.
//!
//! Fetch and store blobs, ask which blobs are missing, resolve and record
//! URI → blob mappings through the Remote Asset API, materialize directory
//! trees, and read a server's advertised capabilities.
//!
//! `prost`, `tonic` and the generated proto crate are private implementation
//! details — nothing in the public API mentions them, so consumers depend on
//! this crate alone.
//!
//! # Transfer strategy
//!
//! [`read_blob`](ReapiClient::read_blob) and
//! [`write_blob`](ReapiClient::write_blob) choose between the batch CAS RPCs
//! and ByteStream by size, at [`BATCH_THRESHOLD`]. Callers do not pick: a
//! blob's size already determines which is cheaper, and a miss reads as
//! `Ok(None)` either way.
//!
//! # Deliberate omissions
//!
//! - **Digest functions other than SHA-256 and BLAKE3.** This client verifies
//!   everything it reads, so it only offers functions it can compute.
//!   [`ServerCapabilities`] still *reports* whatever else a server advertises.
//! - **TLS.** Endpoints must be `http://`. See [`ConnectOptions`].
//! - **Execution and the Action Cache.** Not needed by any consumer yet.
//!
//! [REAPI]: https://github.com/bazelbuild/remote-apis

mod capabilities;
mod digest;
mod error;
mod progress;

#[cfg(all(test, integration_tests))]
mod test_integration;

use std::path::Path;
use std::pin::Pin;
use std::time::Duration;

use bytes::Bytes;
use prost::Message as _;
use tonic::transport::Channel;

use protos::build::bazel::remote::asset::v1 as asset;
use protos::build::bazel::remote::execution::v2 as reapi;
use protos::google::bytestream as bytestream;

pub use crate::capabilities::{ApiVersion, ServerCapabilities};
pub use crate::digest::{Digest, DigestFunction};
pub use crate::error::{Error, Result};
pub use crate::progress::Progress;

use crate::digest::{read_resource_name, write_resource_name};

/// Blobs at or below this size use the batch CAS RPCs; larger ones stream.
///
/// Servers advertise their own ceiling as
/// [`ServerCapabilities::max_batch_total_size_bytes`]; this is comfortably
/// under the common default.
pub const BATCH_THRESHOLD: i64 = 2 * 1024 * 1024;

/// Payload size of a single ByteStream `Write` message.
const WRITE_CHUNK_SIZE: usize = 2 * 1024 * 1024;

/// How long to wait for a connection before giving up.
///
/// Short by default: this client is used on latency-sensitive paths where a
/// blackholed endpoint must fail fast enough to fall back to an origin, rather
/// than stalling until a TCP timeout.
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

/// `google.rpc.Code.NOT_FOUND`.
const CODE_NOT_FOUND: i32 = 5;

/// How to reach an REAPI server.
///
/// Only plaintext h2c (`http://`) is supported. The server this was written
/// against has no authentication, so transport encryption alone would not make
/// a public endpoint safe; terminate TLS in a sidecar if you need it on the
/// wire.
#[derive(Debug, Clone)]
pub struct ConnectOptions {
    url: String,
    instance_name: String,
    connect_timeout: Duration,
    request_timeout: Option<Duration>,
}

impl ConnectOptions {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            instance_name: String::new(),
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            request_timeout: None,
        }
    }

    /// REAPI instance name; empty (the default) addresses the server's
    /// default instance.
    pub fn instance_name(mut self, name: impl Into<String>) -> Self {
        self.instance_name = name.into();
        self
    }

    pub fn connect_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = timeout;
        self
    }

    /// Upper bound on any single RPC. Unset by default, since a large blob
    /// transfer has no meaningful deadline that is not also a stall detector.
    pub fn request_timeout(mut self, timeout: Duration) -> Self {
        self.request_timeout = Some(timeout);
        self
    }
}

/// An asset resolved through the Remote Asset API.
#[derive(Debug, Clone)]
pub struct FetchedAsset {
    /// The URI the server actually resolved, which may not be the first one
    /// offered.
    pub uri: String,
    /// The blob, or root directory, the URI resolves to.
    pub digest: Digest,
    /// Qualifiers the server associated with the mapping.
    pub qualifiers: Vec<(String, String)>,
}

/// A connected REAPI client.
///
/// Cheap to clone: the underlying `Channel` is reference-counted and
/// multiplexes over one HTTP/2 connection.
#[derive(Debug, Clone)]
pub struct ReapiClient {
    cas: reapi::content_addressable_storage_client::ContentAddressableStorageClient<Channel>,
    bytestream: bytestream::byte_stream_client::ByteStreamClient<Channel>,
    push: asset::push_client::PushClient<Channel>,
    fetch: asset::fetch_client::FetchClient<Channel>,
    caps: reapi::capabilities_client::CapabilitiesClient<Channel>,
    instance_name: String,
}

impl ReapiClient {
    /// Connect to an REAPI server.
    pub async fn connect(options: ConnectOptions) -> Result<Self> {
        if !options.url.starts_with("http://") {
            return Err(Error::InvalidEndpoint {
                url: options.url.clone(),
                reason: if options.url.starts_with("https://") {
                    "TLS endpoints are not supported; use http:// or terminate TLS in a sidecar"
                        .to_string()
                } else {
                    "endpoint must start with http://".to_string()
                },
            });
        }

        let mut endpoint =
            Channel::from_shared(options.url.clone()).map_err(|e| Error::InvalidEndpoint {
                url: options.url.clone(),
                reason: e.to_string(),
            })?;
        endpoint = endpoint
            .connect_timeout(options.connect_timeout)
            // Interactive clients hold a channel open across long idle
            // stretches; without keepalive a silently dropped connection is
            // only discovered on the next request.
            .http2_keep_alive_interval(Duration::from_secs(30))
            .keep_alive_timeout(Duration::from_secs(20))
            .keep_alive_while_idle(true);
        if let Some(timeout) = options.request_timeout {
            endpoint = endpoint.timeout(timeout);
        }

        let channel = endpoint.connect().await.map_err(|source| Error::Connect {
            url: options.url.clone(),
            source,
        })?;

        Ok(Self::from_channel(channel, options.instance_name))
    }

    fn from_channel(channel: Channel, instance_name: String) -> Self {
        Self {
            cas: reapi::content_addressable_storage_client::ContentAddressableStorageClient::new(
                channel.clone(),
            ),
            bytestream: bytestream::byte_stream_client::ByteStreamClient::new(channel.clone()),
            push: asset::push_client::PushClient::new(channel.clone()),
            fetch: asset::fetch_client::FetchClient::new(channel.clone()),
            caps: reapi::capabilities_client::CapabilitiesClient::new(channel),
            instance_name,
        }
    }

    /// The instance name this client addresses.
    pub fn instance_name(&self) -> &str {
        &self.instance_name
    }

    /// Read the server's advertised capabilities.
    pub async fn get_capabilities(&mut self) -> Result<ServerCapabilities> {
        let response = self
            .caps
            .get_capabilities(reapi::GetCapabilitiesRequest {
                instance_name: self.instance_name.clone(),
            })
            .await
            .map_err(|source| Error::Rpc {
                rpc: "Capabilities.GetCapabilities",
                source,
            })?
            .into_inner();

        Ok(ServerCapabilities::from_proto(response))
    }

    /// Read a blob from the CAS, verifying it against `digest` before
    /// returning it.
    ///
    /// `Ok(None)` means the server does not have the blob — an ordinary cache
    /// miss, not an error. A blob that is present but hashes to something else
    /// is [`Error::DigestMismatch`]: the store returned content that is not
    /// what was asked for, and silently falling back would hide it.
    pub async fn read_blob(
        &mut self,
        function: DigestFunction,
        digest: &Digest,
    ) -> Result<Option<Bytes>> {
        self.read_blob_with_progress(function, digest, &Progress::none())
            .await
    }

    /// [`read_blob`](Self::read_blob), reporting bytes transferred as they
    /// arrive.
    pub async fn read_blob_with_progress(
        &mut self,
        function: DigestFunction,
        digest: &Digest,
        progress: &Progress,
    ) -> Result<Option<Bytes>> {
        digest.validate()?;
        let total = digest.size as u64;
        progress.report(0, total);

        let data = if digest.size <= BATCH_THRESHOLD {
            match self.read_blob_batched(function, digest).await? {
                Some(data) => {
                    progress.report(total, total);
                    data
                }
                None => return Ok(None),
            }
        } else {
            let Some(mut stream) = self.read_blob_stream(function, digest).await? else {
                return Ok(None);
            };
            let mut buf = Vec::with_capacity(digest.size.max(0) as usize);
            while let Some(chunk) = stream.next_chunk().await? {
                buf.extend_from_slice(&chunk);
                progress.report(buf.len() as u64, total);
            }
            Bytes::from(buf)
        };

        if data.len() as i64 != digest.size {
            return Err(Error::SizeMismatch {
                expected: digest.hash.clone(),
                expected_size: digest.size,
                actual_size: data.len() as i64,
            });
        }

        let actual = function.hash(&data);
        if actual != digest.hash {
            return Err(Error::DigestMismatch {
                function,
                expected: digest.hash.clone(),
                actual,
            });
        }

        Ok(Some(data))
    }

    async fn read_blob_batched(
        &mut self,
        function: DigestFunction,
        digest: &Digest,
    ) -> Result<Option<Bytes>> {
        let response = self
            .cas
            .batch_read_blobs(reapi::BatchReadBlobsRequest {
                instance_name: self.instance_name.clone(),
                digests: vec![to_proto_digest(digest)],
                acceptable_compressors: vec![],
                digest_function: function.to_proto(),
            })
            .await
            .map_err(|source| Error::Rpc {
                rpc: "ContentAddressableStorage.BatchReadBlobs",
                source,
            })?
            .into_inner();

        let Some(blob) = response.responses.into_iter().next() else {
            return Err(Error::MalformedResponse {
                rpc: "BatchReadBlobs",
                detail: "no response for the requested digest".to_string(),
            });
        };

        // A batch read reports a miss in the per-blob status rather than as an
        // RPC error, so it has to be translated to match the streaming path.
        if let Some(status) = &blob.status {
            if status.code == CODE_NOT_FOUND {
                return Ok(None);
            }
            if status.code != 0 {
                return Err(Error::MalformedResponse {
                    rpc: "BatchReadBlobs",
                    detail: format!("status {}: {}", status.code, status.message),
                });
            }
        }

        Ok(Some(blob.data))
    }

    /// Begin reading a blob, returning a pull-based reader instead of
    /// buffering the whole thing.
    ///
    /// `Ok(None)` is a miss, as with [`read_blob`](Self::read_blob). Unlike
    /// `read_blob`, **the caller must verify the content itself** — nothing
    /// here can check a hash it has not seen in full. This always streams,
    /// whatever the blob's size.
    pub async fn read_blob_stream(
        &mut self,
        function: DigestFunction,
        digest: &Digest,
    ) -> Result<Option<BlobStream>> {
        digest.validate()?;

        let request = bytestream::ReadRequest {
            resource_name: read_resource_name(&self.instance_name, function, digest),
            read_offset: 0,
            read_limit: 0,
        };

        match self.bytestream.read(request).await {
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

    /// Write a blob to the CAS.
    ///
    /// The server verifies the content against `digest` and rejects a
    /// mismatch, so this is safe to call with bytes from an untrusted origin
    /// only after you have checked them yourself.
    pub async fn write_blob(
        &mut self,
        function: DigestFunction,
        digest: &Digest,
        data: Bytes,
    ) -> Result<()> {
        self.write_blob_with_progress(function, digest, data, &Progress::none())
            .await
    }

    /// [`write_blob`](Self::write_blob), reporting bytes transferred as they
    /// are handed to the transport.
    pub async fn write_blob_with_progress(
        &mut self,
        function: DigestFunction,
        digest: &Digest,
        data: Bytes,
        progress: &Progress,
    ) -> Result<()> {
        digest.validate()?;
        if data.len() as i64 != digest.size {
            return Err(Error::SizeMismatch {
                expected: digest.hash.clone(),
                expected_size: digest.size,
                actual_size: data.len() as i64,
            });
        }

        let total = data.len() as u64;
        progress.report(0, total);

        if digest.size <= BATCH_THRESHOLD {
            self.write_blob_batched(function, digest, data).await?;
            progress.report(total, total);
            return Ok(());
        }

        let resource_name = write_resource_name(
            &self.instance_name,
            &uuid::Uuid::new_v4().to_string(),
            function,
            digest,
        );

        let mut requests = Vec::new();
        let mut offset = 0usize;
        // An empty blob still needs one message, to carry finish_write.
        loop {
            let end = std::cmp::min(offset + WRITE_CHUNK_SIZE, data.len());
            let chunk = data.slice(offset..end);
            let finish_write = end == data.len();
            requests.push(bytestream::WriteRequest {
                resource_name: resource_name.clone(),
                write_offset: offset as i64,
                finish_write,
                data: chunk,
            });
            offset = end;
            if finish_write {
                break;
            }
        }

        let progress = progress.clone();
        let mut sent = 0u64;
        let stream = futures::stream::iter(requests.into_iter().map(move |request| {
            sent += request.data.len() as u64;
            progress.report(sent, total);
            request
        }));

        self.bytestream
            .write(stream)
            .await
            .map_err(|source| Error::Rpc {
                rpc: "ByteStream.Write",
                source,
            })?;

        Ok(())
    }

    async fn write_blob_batched(
        &mut self,
        function: DigestFunction,
        digest: &Digest,
        data: Bytes,
    ) -> Result<()> {
        let response = self
            .cas
            .batch_update_blobs(reapi::BatchUpdateBlobsRequest {
                instance_name: self.instance_name.clone(),
                requests: vec![reapi::batch_update_blobs_request::Request {
                    digest: Some(to_proto_digest(digest)),
                    data,
                    compressor: 0,
                }],
                digest_function: function.to_proto(),
            })
            .await
            .map_err(|source| Error::Rpc {
                rpc: "ContentAddressableStorage.BatchUpdateBlobs",
                source,
            })?
            .into_inner();

        for blob in &response.responses {
            if let Some(status) = &blob.status {
                if status.code != 0 {
                    return Err(Error::MalformedResponse {
                        rpc: "BatchUpdateBlobs",
                        detail: format!("status {}: {}", status.code, status.message),
                    });
                }
            }
        }

        Ok(())
    }

    /// Ask which of `digests` the server does not already have.
    ///
    /// All digests in one call must share a digest function, because the
    /// request carries a single `digest_function` field.
    pub async fn find_missing(
        &mut self,
        function: DigestFunction,
        digests: &[Digest],
    ) -> Result<Vec<Digest>> {
        if digests.is_empty() {
            return Ok(Vec::new());
        }
        for digest in digests {
            digest.validate()?;
        }

        let request = reapi::FindMissingBlobsRequest {
            instance_name: self.instance_name.clone(),
            blob_digests: digests.iter().map(to_proto_digest).collect(),
            digest_function: function.to_proto(),
        };

        let response = self
            .cas
            .find_missing_blobs(request)
            .await
            .map_err(|source| Error::Rpc {
                rpc: "ContentAddressableStorage.FindMissingBlobs",
                source,
            })?
            .into_inner();

        Ok(response
            .missing_blob_digests
            .iter()
            .map(from_proto_digest)
            .collect())
    }

    /// Record that each URI in `uris` resolves to the blob named by `digest`.
    ///
    /// The blob must already be in the CAS; servers reject a mapping to
    /// content they do not hold.
    ///
    /// `qualifiers` participate in the lookup key, so a mapping pushed with
    /// qualifiers is only found by a fetch that presents the same ones. To be
    /// discoverable both by bare-URI and by checksum-carrying clients, push
    /// twice — once with no qualifiers, once with `checksum.sri` (see
    /// [`Digest::to_sri`]).
    pub async fn push_blob(
        &mut self,
        function: DigestFunction,
        digest: &Digest,
        uris: &[String],
        qualifiers: &[(String, String)],
    ) -> Result<()> {
        digest.validate()?;

        let request = asset::PushBlobRequest {
            instance_name: self.instance_name.clone(),
            uris: uris.to_vec(),
            qualifiers: to_proto_qualifiers(qualifiers),
            blob_digest: Some(to_proto_digest(digest)),
            digest_function: function.to_proto(),
            ..Default::default()
        };

        self.push
            .push_blob(request)
            .await
            .map_err(|source| Error::Rpc {
                rpc: "Push.PushBlob",
                source,
            })?;

        Ok(())
    }

    /// Resolve a URI to a blob through the Remote Asset API.
    ///
    /// Servers may satisfy this from a previously pushed mapping *or* by
    /// fetching from the origin themselves, so this can be slow on a miss.
    /// When the digest is already known, reading the CAS directly is both
    /// cheaper and free of side effects.
    pub async fn fetch_blob(
        &mut self,
        function: DigestFunction,
        uris: &[String],
        qualifiers: &[(String, String)],
    ) -> Result<FetchedAsset> {
        let response = self
            .fetch
            .fetch_blob(asset::FetchBlobRequest {
                instance_name: self.instance_name.clone(),
                uris: uris.to_vec(),
                qualifiers: to_proto_qualifiers(qualifiers),
                digest_function: function.to_proto(),
                ..Default::default()
            })
            .await
            .map_err(|source| Error::Rpc {
                rpc: "Fetch.FetchBlob",
                source,
            })?
            .into_inner();

        check_asset_status(response.status, uris)?;
        let digest = response
            .blob_digest
            .ok_or_else(|| Error::MalformedResponse {
                rpc: "FetchBlob",
                detail: "response reported success but carried no blob_digest".to_string(),
            })?;

        Ok(FetchedAsset {
            uri: fallback_uri(response.uri, uris),
            digest: from_proto_digest(&digest),
            qualifiers: from_proto_qualifiers(response.qualifiers),
        })
    }

    /// Resolve a URI to a directory tree through the Remote Asset API.
    ///
    /// Returns the root [`Digest`]; pass it to
    /// [`materialize_directory`](Self::materialize_directory) to write the
    /// tree to disk.
    pub async fn fetch_directory(
        &mut self,
        function: DigestFunction,
        uris: &[String],
        qualifiers: &[(String, String)],
    ) -> Result<FetchedAsset> {
        let response = self
            .fetch
            .fetch_directory(asset::FetchDirectoryRequest {
                instance_name: self.instance_name.clone(),
                uris: uris.to_vec(),
                qualifiers: to_proto_qualifiers(qualifiers),
                digest_function: function.to_proto(),
                ..Default::default()
            })
            .await
            .map_err(|source| Error::Rpc {
                rpc: "Fetch.FetchDirectory",
                source,
            })?
            .into_inner();

        check_asset_status(response.status, uris)?;
        let digest = response
            .root_directory_digest
            .ok_or_else(|| Error::MalformedResponse {
                rpc: "FetchDirectory",
                detail: "response reported success but carried no root_directory_digest"
                    .to_string(),
            })?;

        Ok(FetchedAsset {
            uri: fallback_uri(response.uri, uris),
            digest: from_proto_digest(&digest),
            qualifiers: from_proto_qualifiers(response.qualifiers),
        })
    }

    /// Write the directory tree rooted at `root` to `dest`.
    ///
    /// Every blob is verified against its digest on the way in, since each
    /// node is fetched through [`read_blob`](Self::read_blob). Filesystem
    /// I/O lives here rather than in the caller because a REAPI `Directory`
    /// *is* a filesystem shape — files with executable bits, symlinks, and
    /// nested directories — and there is no useful intermediate form.
    pub async fn materialize_directory(
        &mut self,
        function: DigestFunction,
        root: &Digest,
        dest: &Path,
        progress: &Progress,
    ) -> Result<()> {
        tokio::fs::create_dir_all(dest).await.map_err(|source| {
            Error::Io {
                operation: "creating directory",
                path: dest.display().to_string(),
                source,
            }
        })?;
        self.materialize_tree(function, root.clone(), dest.to_path_buf(), progress.clone())
            .await
    }

    fn materialize_tree(
        &mut self,
        function: DigestFunction,
        digest: Digest,
        dest: std::path::PathBuf,
        progress: Progress,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            let data = self
                .read_blob_with_progress(function, &digest, &progress)
                .await?
                .ok_or_else(|| Error::MalformedResponse {
                    rpc: "materialize_directory",
                    detail: format!("directory node {digest} is not in the CAS"),
                })?;

            let directory =
                reapi::Directory::decode(data.as_ref()).map_err(|source| Error::Decode {
                    what: "Directory",
                    source,
                })?;

            for file in &directory.files {
                let node = file.digest.as_ref().ok_or_else(|| Error::MalformedResponse {
                    rpc: "materialize_directory",
                    detail: format!("file {:?} has no digest", file.name),
                })?;
                let path = dest.join(&file.name);
                let contents = self
                    .read_blob_with_progress(function, &from_proto_digest(node), &progress)
                    .await?
                    .ok_or_else(|| Error::MalformedResponse {
                        rpc: "materialize_directory",
                        detail: format!("file {:?} is not in the CAS", file.name),
                    })?;

                tokio::fs::write(&path, &contents)
                    .await
                    .map_err(|source| Error::Io {
                        operation: "writing",
                        path: path.display().to_string(),
                        source,
                    })?;

                #[cfg(unix)]
                if file.is_executable {
                    use std::os::unix::fs::PermissionsExt;
                    tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                        .await
                        .map_err(|source| Error::Io {
                            operation: "setting permissions on",
                            path: path.display().to_string(),
                            source,
                        })?;
                }
            }

            for symlink in &directory.symlinks {
                let path = dest.join(&symlink.name);
                #[cfg(unix)]
                tokio::fs::symlink(&symlink.target, &path)
                    .await
                    .map_err(|source| Error::Io {
                        operation: "creating symlink",
                        path: path.display().to_string(),
                        source,
                    })?;
                #[cfg(not(unix))]
                let _ = &path;
            }

            for subdir in &directory.directories {
                let node = subdir
                    .digest
                    .as_ref()
                    .ok_or_else(|| Error::MalformedResponse {
                        rpc: "materialize_directory",
                        detail: format!("directory {:?} has no digest", subdir.name),
                    })?;
                let path = dest.join(&subdir.name);
                tokio::fs::create_dir_all(&path)
                    .await
                    .map_err(|source| Error::Io {
                        operation: "creating directory",
                        path: path.display().to_string(),
                        source,
                    })?;
                self.materialize_tree(function, from_proto_digest(node), path, progress.clone())
                    .await?;
            }

            Ok(())
        })
    }
}

/// A blob being read incrementally. See
/// [`read_blob_stream`](ReapiClient::read_blob_stream).
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

/// Asset fetches report failure in the response body rather than as an RPC
/// error, so a successful RPC still has to be inspected.
fn check_asset_status(status: Option<protos::google::rpc::Status>, uris: &[String]) -> Result<()> {
    match status {
        Some(status) if status.code != 0 => Err(Error::AssetFetch {
            uri: uris.first().cloned().unwrap_or_default(),
            code: status.code,
            message: status.message,
        }),
        _ => Ok(()),
    }
}

/// Servers echo the URI they resolved, but not all populate it.
fn fallback_uri(reported: String, requested: &[String]) -> String {
    if reported.is_empty() {
        requested.first().cloned().unwrap_or_default()
    } else {
        reported
    }
}

fn to_proto_digest(digest: &Digest) -> reapi::Digest {
    reapi::Digest {
        hash: digest.hash.clone(),
        size_bytes: digest.size,
    }
}

fn from_proto_digest(digest: &reapi::Digest) -> Digest {
    Digest {
        hash: digest.hash.clone(),
        size: digest.size_bytes,
    }
}

fn to_proto_qualifiers(qualifiers: &[(String, String)]) -> Vec<asset::Qualifier> {
    qualifiers
        .iter()
        .map(|(name, value)| asset::Qualifier {
            name: name.clone(),
            value: value.clone(),
        })
        .collect()
}

fn from_proto_qualifiers(qualifiers: Vec<asset::Qualifier>) -> Vec<(String, String)> {
    qualifiers
        .into_iter()
        .map(|qualifier| (qualifier.name, qualifier.value))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn https_endpoints_are_rejected_with_a_useful_message() {
        let err = ReapiClient::connect(ConnectOptions::new("https://example.com:8080"))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("TLS endpoints are not supported"));
    }

    #[tokio::test]
    async fn non_http_endpoints_are_rejected() {
        let err = ReapiClient::connect(ConnectOptions::new("grpc://example.com:8080"))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("must start with http://"));
    }

    #[test]
    fn connect_options_defaults() {
        let opts = ConnectOptions::new("http://127.0.0.1:8080");
        assert_eq!(opts.instance_name, "");
        assert_eq!(opts.connect_timeout, DEFAULT_CONNECT_TIMEOUT);
        assert_eq!(opts.request_timeout, None);
    }

    #[test]
    fn asset_status_zero_and_absent_both_mean_success() {
        let uris = vec!["https://example.com/a".to_string()];
        assert!(check_asset_status(None, &uris).is_ok());
        assert!(
            check_asset_status(
                Some(protos::google::rpc::Status {
                    code: 0,
                    ..Default::default()
                }),
                &uris
            )
            .is_ok()
        );
    }

    #[test]
    fn asset_status_failure_names_the_uri_and_code() {
        let uris = vec!["https://example.com/a".to_string()];
        let err = check_asset_status(
            Some(protos::google::rpc::Status {
                code: CODE_NOT_FOUND,
                message: "no such asset".to_string(),
                ..Default::default()
            }),
            &uris,
        )
        .unwrap_err();

        let rendered = err.to_string();
        assert!(rendered.contains("https://example.com/a"), "{rendered}");
        assert!(rendered.contains("no such asset"), "{rendered}");
    }

    #[test]
    fn reported_uri_wins_but_empty_falls_back() {
        let requested = vec!["https://a".to_string(), "https://b".to_string()];
        assert_eq!(fallback_uri("https://b".to_string(), &requested), "https://b");
        assert_eq!(fallback_uri(String::new(), &requested), "https://a");
        assert_eq!(fallback_uri(String::new(), &[]), "");
    }

    /// The batch/stream split is a size decision, and both sides of the
    /// boundary must behave identically to callers.
    #[test]
    fn batch_threshold_is_the_documented_size() {
        assert_eq!(BATCH_THRESHOLD, 2 * 1024 * 1024);
    }
}
