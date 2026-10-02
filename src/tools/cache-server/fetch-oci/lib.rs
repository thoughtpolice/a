// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Fetch OCI container images from a registry, verifying every digest along
//! the way.
//!
//! This crate is a peer to `fetch-http` and reuses its SSRF guard, TLS, and
//! low-level hyper request plumbing. It adds only what OCI-specific flows
//! need: media-type negotiation, registry authentication, image-index
//! platform selection, and laying an image out as an OCI Image Layout.
//!
//! A [`Repository`] resolves a digest to one image's manifest and config,
//! small documents it holds in memory, and streams the layers, which may be
//! gigabytes: each [`BlobReader`] hands its blob over piece by piece and
//! checks its size and digest at the end, so the caller decides where the
//! bytes go.
//!
//! # Reference
//!
//! ```no_run
//! # async fn demo() -> Result<(), fetch_oci::OciFetchError> {
//! # let ssl = fetch_http::build_ssl_connector();
//! # let handle: &dial9::Dial9TokioHandle = unimplemented!();
//! let uri = "oci://ghcr.io/example/image@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
//! let reference = fetch_oci::parse_oci_uri(uri)?;
//! let repository = fetch_oci::Repository::new(&ssl, handle, &reference, Default::default());
//! let image = repository.resolve_image(&reference.digest).await?;
//! let layout = image.layout(uri);
//! for layer in &layout.layers {
//!     let mut blob = repository.open_blob(layer).await?;
//!     while let Some(piece) = blob.next().await? {
//!         println!("{}: {} more bytes", fetch_oci::blob_path(&layer.digest), piece.len());
//!     }
//! }
//! # Ok(())
//! # }
//! ```

mod auth;
mod credentials;
mod layout;
mod manifest;
mod registry;
pub mod uri;

#[cfg(test)]
mod test_integration;

use std::collections::HashSet;
use std::fmt;

use bytes::{Bytes, BytesMut};
use dial9::Dial9TokioHandle;
use fetch_http::HttpFetchError;
use http_body_util::BodyExt as _;
use hyper::body::Incoming;
use openssl::ssl::SslConnector;
use sha2::{Digest as _, Sha256};

pub use credentials::{Credentials, RegistryCredentials};
pub use layout::{OciBlob, OciFile, OciLayout, blob_path};
pub use manifest::{Descriptor, Platform};
pub use uri::{OciReference, is_oci_uri, parse_oci_uri};

use registry::RegistryClient;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum size for a single OCI blob: a layer, or a blob fetched by digest
/// alone. Larger than `fetch_http::MAX_HTTP_FETCH_SIZE`, since OCI layers
/// routinely exceed 256 MiB.
pub const MAX_OCI_BLOB_SIZE: u64 = 2 * 1024 * 1024 * 1024;

/// Total size cap summed across config + all layers, checked before any blob
/// download begins.
pub const MAX_OCI_TOTAL_SIZE: u64 = 16 * 1024 * 1024 * 1024;

/// Maximum size of a JSON document: a manifest, an index, a config, or a
/// token endpoint's answer. Each is held in memory whole.
pub const MAX_DOCUMENT_SIZE: usize = 4 * 1024 * 1024;

const DOCUMENT_LIMIT: u64 = MAX_DOCUMENT_SIZE as u64;

const DEFAULT_PLATFORM_OS: &str = "linux";
const DEFAULT_PLATFORM_ARCH: &str = "amd64";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum OciFetchError {
    InvalidUri(String),
    UnsupportedReference(String),
    Http(HttpFetchError),
    AuthChallengeMalformed(String),
    AuthTokenFetchFailed(String),
    UnsupportedAuth(String),
    ManifestParse(String),
    UnsupportedMediaType(String),
    NoMatchingPlatform {
        wanted: String,
        available: Vec<String>,
    },
    NestedIndex,
    DigestMismatch {
        what: &'static str,
        expected: String,
        actual: String,
    },
    /// A blob's length differs from the size its descriptor declares.
    SizeMismatch {
        what: &'static str,
        expected: u64,
        actual: u64,
    },
    TotalSizeExceeded {
        total: u64,
        limit: u64,
    },
}

impl From<HttpFetchError> for OciFetchError {
    fn from(e: HttpFetchError) -> Self {
        Self::Http(e)
    }
}

impl From<egress_http::Error> for OciFetchError {
    fn from(e: egress_http::Error) -> Self {
        match e {
            egress_http::Error::InvalidUrl { .. } => Self::InvalidUri(e.to_string()),
            e => Self::Http(e.into()),
        }
    }
}

impl fmt::Display for OciFetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidUri(m) => write!(f, "invalid URI: {m}"),
            Self::UnsupportedReference(m) => write!(f, "unsupported reference: {m}"),
            Self::Http(e) => write!(f, "{e}"),
            Self::AuthChallengeMalformed(m) => write!(f, "malformed auth challenge: {m}"),
            Self::AuthTokenFetchFailed(m) => write!(f, "token fetch failed: {m}"),
            Self::UnsupportedAuth(m) => write!(f, "unsupported auth: {m}"),
            Self::ManifestParse(m) => write!(f, "manifest parse: {m}"),
            Self::UnsupportedMediaType(m) => write!(f, "unsupported media type: {m}"),
            Self::NoMatchingPlatform { wanted, available } => write!(
                f,
                "no manifest for platform {wanted} (available: {})",
                available.join(", ")
            ),
            Self::NestedIndex => write!(f, "image index points at another index"),
            Self::DigestMismatch {
                what,
                expected,
                actual,
            } => write!(
                f,
                "{what} digest mismatch: expected {expected}, got {actual}"
            ),
            Self::SizeMismatch {
                what,
                expected,
                actual,
            } => write!(
                f,
                "{what} size mismatch: descriptor declares {expected} bytes, got {actual}"
            ),
            Self::TotalSizeExceeded { total, limit } => write!(
                f,
                "image total size {total} bytes exceeds limit of {limit} bytes"
            ),
        }
    }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/// How a [`Repository`] fetches.
#[derive(Clone, Debug, Default)]
pub struct FetchOptions {
    /// The platform to take from an image index, and to require of an image
    /// named directly. `None` takes `linux/amd64` from an index, and an
    /// image named directly whatever its platform.
    pub platform: Option<Platform>,
    /// Credentials for the registry, presented when it challenges a request.
    pub credentials: Option<Credentials>,
    /// Reach the registry over plain HTTP rather than HTTPS. For tests'
    /// fake registries only.
    #[doc(hidden)]
    pub plain_http: bool,
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/// One repository on a registry, fetched from over a session that keeps the
/// bearer token it was given. Blob downloads may run concurrently.
pub struct Repository<'a> {
    client: RegistryClient<'a>,
    platform: Option<Platform>,
}

/// An image resolved to one platform: its manifest and config, fetched and
/// verified, and its layers, still to be downloaded.
#[derive(Debug)]
pub struct ResolvedImage {
    /// The image manifest, with its own media type.
    pub manifest: OciBlob,
    pub config: OciBlob,
    pub layers: Vec<Descriptor>,
}

impl ResolvedImage {
    /// This image as an OCI Image Layout whose `index.json` names it
    /// `ref_name`.
    pub fn layout(&self, ref_name: &str) -> OciLayout {
        layout::build_layout(ref_name, &self.manifest, &self.config, &self.layers)
    }
}

impl<'a> Repository<'a> {
    pub fn new(
        ssl_connector: &'a SslConnector,
        handle: &'a Dial9TokioHandle,
        reference: &OciReference,
        options: FetchOptions,
    ) -> Self {
        let scheme = if options.plain_http { "http" } else { "https" };
        Self {
            client: RegistryClient::new(
                ssl_connector,
                handle,
                scheme,
                &reference.registry,
                &reference.repository,
                options.credentials,
            ),
            platform: options.platform,
        }
    }

    /// Fetch the manifest `digest` names and resolve it to one image: an
    /// image index to its manifest for the wanted platform. Checks the
    /// image's declared size against [`MAX_OCI_TOTAL_SIZE`] before fetching
    /// its config.
    pub async fn resolve_image(&self, digest: &str) -> Result<ResolvedImage, OciFetchError> {
        let top = self.fetch_manifest(digest, None).await?;
        let (manifest_digest, manifest_bytes, image, named_directly) =
            match manifest::parse_manifest(&top)? {
                manifest::ParsedManifest::Index(index) => {
                    let wanted = self.platform.clone().unwrap_or_else(default_platform);
                    let chosen = manifest::select_platform(&index, &wanted)?;
                    let bytes = self
                        .fetch_manifest(&chosen.digest, Some(chosen.size))
                        .await?;
                    match manifest::parse_manifest(&bytes)? {
                        manifest::ParsedManifest::Index(_) => {
                            return Err(OciFetchError::NestedIndex);
                        }
                        manifest::ParsedManifest::Manifest(m) => {
                            (chosen.digest.clone(), bytes, m, false)
                        }
                    }
                }
                manifest::ParsedManifest::Manifest(m) => (digest.to_string(), top, m, true),
            };

        let mut distinct = HashSet::new();
        let declared_total: u64 = std::iter::once(&image.config)
            .chain(&image.layers)
            .filter(|d| distinct.insert(&d.digest))
            .map(|d| d.size)
            .sum();
        if declared_total > MAX_OCI_TOTAL_SIZE {
            return Err(OciFetchError::TotalSizeExceeded {
                total: declared_total,
                limit: MAX_OCI_TOTAL_SIZE,
            });
        }

        let config = self
            .fetch_document(&image.config, "config", manifest::CONFIG_ACCEPT)
            .await?;
        // An index says which platform each manifest is for; an image named
        // directly says so only in its config.
        if let (true, Some(wanted)) = (named_directly, &self.platform) {
            let have = manifest::Platform::of_config(&config);
            if !have
                .as_ref()
                .is_some_and(|have| manifest::platform_matches(have, wanted))
            {
                return Err(OciFetchError::NoMatchingPlatform {
                    wanted: wanted.display(),
                    available: have.iter().map(Platform::display).collect(),
                });
            }
        }

        // index.json describes the manifest by its own media type: tools
        // reading the layout refuse a Docker manifest that claims to be an
        // OCI one.
        let manifest = OciBlob {
            digest: manifest_digest,
            media_type: image
                .media_type
                .clone()
                .unwrap_or_else(|| manifest::MT_OCI_MANIFEST.to_string()),
            data: manifest_bytes,
        };
        let config = OciBlob {
            digest: image.config.digest.clone(),
            media_type: non_empty_or(&image.config.media_type, manifest::MT_OCI_CONFIG),
            data: config,
        };
        Ok(ResolvedImage {
            manifest,
            config,
            layers: image.layers,
        })
    }

    /// Start downloading the blob `descriptor` names. The body is refused as
    /// soon as it passes the declared size (or [`MAX_OCI_BLOB_SIZE`]).
    pub async fn open_blob(&self, descriptor: &Descriptor) -> Result<BlobReader, OciFetchError> {
        self.open(
            &descriptor.digest,
            "blobs",
            "layer",
            "*/*",
            Some(descriptor.size),
            MAX_OCI_BLOB_SIZE,
        )
        .await
    }

    /// Start downloading whatever `digest` names in this repository, with no
    /// size declared for it: a blob, or failing that, a manifest. Up to
    /// [`MAX_OCI_BLOB_SIZE`].
    pub async fn open_digest(&self, digest: &str) -> Result<BlobReader, OciFetchError> {
        let manifest = || {
            let accept = manifest::MANIFEST_ACCEPT;
            self.open(
                digest,
                "manifests",
                "manifest",
                accept,
                None,
                MAX_OCI_BLOB_SIZE,
            )
        };
        match self
            .open(digest, "blobs", "blob", "*/*", None, MAX_OCI_BLOB_SIZE)
            .await
        {
            Err(OciFetchError::Http(HttpFetchError::HttpStatus(404, _))) => manifest().await,
            result => result,
        }
    }

    /// Fetch the manifest `digest` names, which its index may say is `size`
    /// bytes.
    async fn fetch_manifest(
        &self,
        digest: &str,
        size: Option<u64>,
    ) -> Result<Bytes, OciFetchError> {
        let accept = manifest::MANIFEST_ACCEPT;
        self.open(
            digest,
            "manifests",
            "manifest",
            accept,
            size,
            DOCUMENT_LIMIT,
        )
        .await?
        .bytes()
        .await
    }

    /// Fetch a small blob, such as a config, whole.
    async fn fetch_document(
        &self,
        descriptor: &Descriptor,
        what: &'static str,
        accept: &str,
    ) -> Result<Bytes, OciFetchError> {
        let size = Some(descriptor.size);
        self.open(
            &descriptor.digest,
            "blobs",
            what,
            accept,
            size,
            DOCUMENT_LIMIT,
        )
        .await?
        .bytes()
        .await
    }

    /// Start downloading `digest` from the `kind` (`blobs` or `manifests`)
    /// endpoint: `what` names it in errors, `size` is what a descriptor
    /// declares for it, and `max` caps it whatever is declared.
    async fn open(
        &self,
        digest: &str,
        kind: &str,
        what: &'static str,
        accept: &str,
        size: Option<u64>,
        max: u64,
    ) -> Result<BlobReader, OciFetchError> {
        let expected = uri::digest_hex(digest)?;
        let limit = size.map_or(max, |size| size.min(max));
        let response = self
            .client
            .get(&self.client.url(kind, digest), accept)
            .await?;
        require_success(response.status(), what)?;
        if let Some(length) = content_length(&response)
            && length > limit
        {
            return Err(too_large(length, limit));
        }
        Ok(BlobReader {
            body: response.into_body(),
            what,
            expected: expected.to_string(),
            size,
            limit,
            received: 0,
            hasher: Some(Sha256::new()),
        })
    }
}

// ---------------------------------------------------------------------------
// Blob downloads
// ---------------------------------------------------------------------------

/// A blob arriving from the registry.
pub struct BlobReader {
    body: Incoming,
    what: &'static str,
    /// The hex of the blob's SHA-256 digest.
    expected: String,
    /// The size the blob's descriptor declares, if there is one.
    size: Option<u64>,
    limit: u64,
    received: u64,
    /// Taken when the body ends and the blob is checked.
    hasher: Option<Sha256>,
}

impl BlobReader {
    /// The next piece of the blob, or `None` once all of it has arrived and
    /// matched its declared size and its digest. A body that runs past the
    /// size or [`MAX_OCI_BLOB_SIZE`] fails as soon as it does.
    pub async fn next(&mut self) -> Result<Option<Bytes>, OciFetchError> {
        let Some(hasher) = self.hasher.as_mut() else {
            return Ok(None);
        };
        loop {
            let Some(frame) = self.body.frame().await else {
                let hash = self.hasher.take().expect("checked above").finalize();
                return self.check(&hash).map(|()| None);
            };
            let frame =
                frame.map_err(|e| HttpFetchError::from(egress_http::Error::Body(e.into())))?;
            let Ok(data) = frame.into_data() else {
                continue;
            };
            if data.is_empty() {
                continue;
            }
            self.received += data.len() as u64;
            if self.received > self.limit {
                return Err(too_large(self.received, self.limit));
            }
            hasher.update(&data);
            return Ok(Some(data));
        }
    }

    /// All of the blob, gathered in memory.
    pub async fn bytes(mut self) -> Result<Bytes, OciFetchError> {
        let capacity = self.size.map_or(0, |size| size.min(self.limit) as usize);
        let mut data = BytesMut::with_capacity(capacity);
        while let Some(piece) = self.next().await? {
            data.extend_from_slice(&piece);
        }
        Ok(data.freeze())
    }

    fn check(&self, hash: &[u8]) -> Result<(), OciFetchError> {
        if let Some(expected) = self.size
            && expected != self.received
        {
            return Err(OciFetchError::SizeMismatch {
                what: self.what,
                expected,
                actual: self.received,
            });
        }
        let actual = hex::encode(hash);
        if actual != self.expected {
            return Err(OciFetchError::DigestMismatch {
                what: self.what,
                expected: format!("sha256:{}", self.expected),
                actual: format!("sha256:{actual}"),
            });
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn default_platform() -> Platform {
    Platform {
        os: DEFAULT_PLATFORM_OS.to_string(),
        architecture: DEFAULT_PLATFORM_ARCH.to_string(),
        variant: None,
    }
}

fn non_empty_or(value: &str, default: &str) -> String {
    if value.is_empty() { default } else { value }.to_string()
}

fn content_length<B>(response: &hyper::Response<B>) -> Option<u64> {
    response
        .headers()
        .get(hyper::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
}

fn too_large(size: u64, limit: u64) -> OciFetchError {
    OciFetchError::Http(HttpFetchError::TooLarge {
        size: usize::try_from(size).unwrap_or(usize::MAX),
        limit: usize::try_from(limit).unwrap_or(usize::MAX),
    })
}

fn require_success(status: hyper::StatusCode, what: &str) -> Result<(), OciFetchError> {
    if status.is_success() {
        Ok(())
    } else {
        Err(OciFetchError::Http(HttpFetchError::HttpStatus(
            status.as_u16(),
            format!("while fetching {what}"),
        )))
    }
}
