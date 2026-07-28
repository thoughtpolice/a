// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! A small client for [Remote Build APIs][REAPI] servers.
//!
//! The surface is deliberately narrow: fetch a blob, store a blob, ask which
//! blobs are missing, and record a URI → blob mapping through the Remote Asset
//! API. That is enough to use an REAPI server as a content-addressed cache in
//! front of an HTTP origin, which is what this exists for.
//!
//! `prost`, `tonic` and the generated proto crate are private implementation
//! details — nothing in the public API mentions them, so consumers depend on
//! this crate alone.
//!
//! # Deliberate omissions
//!
//! - **Batch CAS RPCs.** Every transfer goes over ByteStream regardless of
//!   size. One code path, no threshold heuristic, and a clean `NOT_FOUND` on
//!   the initial response rather than a per-blob status buried in a batch.
//!   `BatchUpdateBlobs`/`BatchReadBlobs` would only pay off for many small
//!   blobs, which no current consumer has.
//! - **Digest functions other than SHA-256 and BLAKE3.** This client verifies
//!   what it reads, so it only offers functions it can compute.
//! - **TLS.** Endpoints must be `http://`. See [`ConnectOptions`].
//! - **Execution, ActionCache, FetchBlob/FetchDirectory.** Not needed yet.
//!
//! [REAPI]: https://github.com/bazelbuild/remote-apis

mod digest;
mod error;

#[cfg(all(test, integration_tests))]
mod test_integration;

use std::time::Duration;

use bytes::Bytes;
use tonic::transport::Channel;

use protos::build::bazel::remote::asset::v1 as asset;
use protos::build::bazel::remote::execution::v2 as reapi;
use protos::google::bytestream as bytestream;

pub use crate::digest::{Digest, DigestFunction};
pub use crate::error::{Error, Result};

use crate::digest::{read_resource_name, write_resource_name};

/// Payload size of a single ByteStream `Write` message.
const WRITE_CHUNK_SIZE: usize = 2 * 1024 * 1024;

/// How long to wait for a connection before giving up.
///
/// Short by default: this client is used on latency-sensitive paths where a
/// blackholed endpoint must fail fast enough to fall back to an origin, rather
/// than stalling until a TCP timeout.
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

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

/// A connected REAPI client.
///
/// Cheap to clone: the underlying `Channel` is reference-counted and
/// multiplexes over one HTTP/2 connection.
#[derive(Debug, Clone)]
pub struct ReapiClient {
    cas: reapi::content_addressable_storage_client::ContentAddressableStorageClient<Channel>,
    bytestream: bytestream::byte_stream_client::ByteStreamClient<Channel>,
    push: asset::push_client::PushClient<Channel>,
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
        endpoint = endpoint.connect_timeout(options.connect_timeout);
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
            push: asset::push_client::PushClient::new(channel),
            instance_name,
        }
    }

    /// The instance name this client addresses.
    pub fn instance_name(&self) -> &str {
        &self.instance_name
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
        let Some(mut stream) = self.read_blob_stream(function, digest).await? else {
            return Ok(None);
        };

        let mut buf = Vec::with_capacity(digest.size.max(0) as usize);
        while let Some(chunk) = stream.next_chunk().await? {
            buf.extend_from_slice(&chunk);
        }

        if buf.len() as i64 != digest.size {
            return Err(Error::SizeMismatch {
                expected: digest.hash.clone(),
                expected_size: digest.size,
                actual_size: buf.len() as i64,
            });
        }

        let actual = function.hash(&buf);
        if actual != digest.hash {
            return Err(Error::DigestMismatch {
                function,
                expected: digest.hash.clone(),
                actual,
            });
        }

        Ok(Some(Bytes::from(buf)))
    }

    /// Begin reading a blob, returning a pull-based reader instead of
    /// buffering the whole thing.
    ///
    /// `Ok(None)` is a miss, as with [`read_blob`](Self::read_blob). Unlike
    /// `read_blob`, **the caller must verify the content itself** — nothing
    /// here can check a hash it has not seen in full.
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
        digest.validate()?;
        if data.len() as i64 != digest.size {
            return Err(Error::SizeMismatch {
                expected: digest.hash.clone(),
                expected_size: digest.size,
                actual_size: data.len() as i64,
            });
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

        self.bytestream
            .write(futures::stream::iter(requests))
            .await
            .map_err(|source| Error::Rpc {
                rpc: "ByteStream.Write",
                source,
            })?;

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
            qualifiers: qualifiers
                .iter()
                .map(|(name, value)| asset::Qualifier {
                    name: name.clone(),
                    value: value.clone(),
                })
                .collect(),
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
}
