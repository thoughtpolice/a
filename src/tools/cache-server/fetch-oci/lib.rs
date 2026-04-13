// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Fetch OCI container images from a registry into an in-memory OCI Image
//! Layout, verifying every digest along the way.
//!
//! This crate is a peer to `fetch-http` and reuses its SSRF guard, TLS, and
//! low-level hyper request plumbing. It adds only what OCI-specific flows
//! need: media-type negotiation, bearer-token challenge handling, image-index
//! platform selection, and multi-blob orchestration.
//!
//! # Reference
//!
//! ```no_run
//! # async fn demo() {
//! # let ssl = fetch_http::build_ssl_connector();
//! # let handle = unimplemented!();
//! let fetch = fetch_oci::fetch_oci_image(
//!     &ssl,
//!     "oci://ghcr.io/example/image@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
//!     None,
//!     handle,
//! )
//! .await
//! .unwrap();
//! for file in &fetch.files {
//!     println!("{} -- {} bytes", file.path, file.data.len());
//! }
//! # }
//! ```

mod auth;
mod layout;
mod manifest;
mod registry;
pub mod uri;

#[cfg(test)]
mod test_integration;

use std::fmt;
use std::time::Duration;

use bytes::Bytes;
use dial9::Dial9TokioHandle;
use fetch_http::HttpFetchError;
use openssl::ssl::SslConnector;
use sha2::{Digest as _, Sha256};

pub use layout::{OciBlob, OciFile, OciImageFetch};
pub use manifest::Platform;
pub use uri::{OciReference, is_oci_uri, parse_oci_uri};

use registry::RegistryClient;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OCI_TIMEOUT: Duration = Duration::from_secs(300);

/// Maximum size for a single OCI blob (manifest, config, or layer).
/// Larger than `fetch_http::MAX_HTTP_FETCH_SIZE` since OCI layers routinely
/// exceed 256 MiB.
pub const MAX_OCI_BLOB_SIZE: usize = 1024 * 1024 * 1024;

/// Total size cap summed across config + all layers, checked before any blob
/// download begins.
pub const MAX_OCI_TOTAL_SIZE: u64 = 2 * 1024 * 1024 * 1024;

const LAYER_FETCH_CONCURRENCY: usize = 4;

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
    TotalSizeExceeded {
        total: u64,
        limit: u64,
    },
    Timeout,
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
            Self::TotalSizeExceeded { total, limit } => write!(
                f,
                "image total size {total} bytes exceeds limit of {limit} bytes"
            ),
            Self::Timeout => write!(f, "OCI fetch timed out"),
        }
    }
}

impl OciFetchError {
    pub fn to_rpc_status(&self) -> protos::google::rpc::Status {
        let (code, message) = match self {
            Self::InvalidUri(m) => (tonic::Code::InvalidArgument as i32, m.clone()),
            Self::UnsupportedReference(m) => (tonic::Code::InvalidArgument as i32, m.clone()),
            Self::Http(e) => return e.to_rpc_status(),
            Self::AuthChallengeMalformed(m) => (tonic::Code::Unauthenticated as i32, m.clone()),
            Self::AuthTokenFetchFailed(m) => (tonic::Code::Unauthenticated as i32, m.clone()),
            Self::UnsupportedAuth(m) => (tonic::Code::Unauthenticated as i32, m.clone()),
            Self::ManifestParse(m) => (tonic::Code::InvalidArgument as i32, m.clone()),
            Self::UnsupportedMediaType(m) => (tonic::Code::InvalidArgument as i32, m.clone()),
            Self::NoMatchingPlatform { wanted, available } => (
                tonic::Code::InvalidArgument as i32,
                format!(
                    "no manifest for {wanted} (available: {})",
                    available.join(", ")
                ),
            ),
            Self::NestedIndex => (
                tonic::Code::InvalidArgument as i32,
                "image index points at another index".to_string(),
            ),
            Self::DigestMismatch {
                what,
                expected,
                actual,
            } => (
                tonic::Code::Aborted as i32,
                format!("{what} digest mismatch: expected {expected}, got {actual}"),
            ),
            Self::TotalSizeExceeded { total, limit } => (
                tonic::Code::ResourceExhausted as i32,
                format!("image total size {total} bytes exceeds limit of {limit} bytes"),
            ),
            Self::Timeout => (
                tonic::Code::DeadlineExceeded as i32,
                "OCI fetch timed out".to_string(),
            ),
        };
        protos::google::rpc::Status {
            code,
            message,
            details: vec![],
        }
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Fetch a full OCI image into an in-memory layout.
///
/// Parses `uri`, fetches its manifest (handling a single bearer-token
/// challenge), resolves any image index to the default `linux/amd64`
/// platform, fetches the config and all layers in parallel, and returns an
/// [`OciImageFetch`] containing the complete OCI Image Layout as a flat list
/// of [`OciFile`] entries ready for the consumer to place into CAS or build
/// a REAPI `Directory` from.
pub async fn fetch_oci_image(
    ssl_connector: &SslConnector,
    uri: &str,
    timeout: Option<Duration>,
    handle: &Dial9TokioHandle,
) -> Result<OciImageFetch, OciFetchError> {
    let reference = parse_oci_uri(uri)?;
    let timeout = timeout.unwrap_or(DEFAULT_OCI_TIMEOUT);
    tokio::time::timeout(
        timeout,
        fetch_oci_image_inner(ssl_connector, &reference, "https", uri, handle),
    )
    .await
    .map_err(|_| OciFetchError::Timeout)?
}

/// Test-only entry point that exposes the scheme for running against a fake
/// HTTP (non-TLS) registry on localhost. Production code must go through
/// [`fetch_oci_image`], which always uses `https`.
#[doc(hidden)]
pub async fn fetch_oci_image_with_scheme(
    ssl_connector: &SslConnector,
    reference: &OciReference,
    scheme: &str,
    original_uri: &str,
    timeout: Option<Duration>,
    handle: &Dial9TokioHandle,
) -> Result<OciImageFetch, OciFetchError> {
    let timeout = timeout.unwrap_or(DEFAULT_OCI_TIMEOUT);
    tokio::time::timeout(
        timeout,
        fetch_oci_image_inner(ssl_connector, reference, scheme, original_uri, handle),
    )
    .await
    .map_err(|_| OciFetchError::Timeout)?
}

async fn fetch_oci_image_inner(
    ssl_connector: &SslConnector,
    reference: &OciReference,
    scheme: &str,
    original_uri: &str,
    handle: &Dial9TokioHandle,
) -> Result<OciImageFetch, OciFetchError> {
    let mut client = RegistryClient::new(ssl_connector, handle, MAX_OCI_BLOB_SIZE);

    let manifest_bytes = fetch_manifest(&mut client, scheme, reference, &reference.digest).await?;

    let (final_manifest_bytes, final_manifest_digest, image_manifest) =
        match manifest::parse_manifest(&manifest_bytes)? {
            manifest::ParsedManifest::Index(index) => {
                let chosen = manifest::select_platform(&index, &default_platform())?;
                let inner_bytes = fetch_manifest(&mut client, scheme, reference, &chosen).await?;
                match manifest::parse_manifest(&inner_bytes)? {
                    manifest::ParsedManifest::Index(_) => return Err(OciFetchError::NestedIndex),
                    manifest::ParsedManifest::Manifest(m) => (inner_bytes, chosen, m),
                }
            }
            manifest::ParsedManifest::Manifest(m) => (manifest_bytes, reference.digest.clone(), m),
        };

    let declared_total: u64 =
        image_manifest.config.size + image_manifest.layers.iter().map(|l| l.size).sum::<u64>();
    if declared_total > MAX_OCI_TOTAL_SIZE {
        return Err(OciFetchError::TotalSizeExceeded {
            total: declared_total,
            limit: MAX_OCI_TOTAL_SIZE,
        });
    }

    let config_blob = fetch_verified_blob(
        &client,
        scheme,
        reference,
        &image_manifest.config,
        "config",
        manifest::CONFIG_ACCEPT,
        manifest::MT_OCI_CONFIG,
    )
    .await?;

    let layer_blobs = fetch_layers(&client, scheme, reference, &image_manifest.layers).await?;

    let manifest_blob = OciBlob {
        digest: final_manifest_digest,
        media_type: manifest::MT_OCI_MANIFEST.to_string(),
        data: final_manifest_bytes,
    };
    Ok(layout::build_layout(
        original_uri,
        manifest_blob,
        config_blob,
        layer_blobs,
    ))
}

// ---------------------------------------------------------------------------
// Manifest + layer orchestration
// ---------------------------------------------------------------------------

/// Fetch `/v2/{repo}/manifests/{digest}`, handling at most one bearer-token
/// challenge and verifying the response digest.
async fn fetch_manifest(
    client: &mut RegistryClient<'_>,
    scheme: &str,
    reference: &OciReference,
    digest: &str,
) -> Result<Bytes, OciFetchError> {
    let url = v2_url(scheme, reference, "manifests", digest);
    let resp = client.get(&url, manifest::MANIFEST_ACCEPT).await?;

    let resp = if resp.status == hyper::StatusCode::UNAUTHORIZED && !client.has_token() {
        try_bearer_auth(client, &resp, &reference.repository).await?;
        let second = client.get(&url, manifest::MANIFEST_ACCEPT).await?;
        require_success(second.status, "manifest")?;
        second
    } else {
        require_success(resp.status, "manifest")?;
        resp
    };

    verify_sha256(&resp.body, digest, "manifest")?;
    Ok(resp.body)
}

/// If the response is a Bearer challenge, parse it, fetch a token from the
/// realm, and store it on `client`. If it's a Basic challenge, return
/// `UnsupportedAuth`. Any other shape returns `AuthChallengeMalformed`.
async fn try_bearer_auth(
    client: &mut RegistryClient<'_>,
    resp: &registry::RegistryResponse,
    repository: &str,
) -> Result<(), OciFetchError> {
    let hdr = resp
        .headers
        .get(hyper::header::WWW_AUTHENTICATE)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            OciFetchError::AuthChallengeMalformed(
                "401 response missing WWW-Authenticate header".to_string(),
            )
        })?;

    if auth::is_basic_challenge(hdr) {
        return Err(OciFetchError::UnsupportedAuth(
            "Basic auth is not supported; this crate only handles anonymous + bearer flows"
                .to_string(),
        ));
    }

    let mut challenge = auth::parse_bearer_challenge(hdr)?;
    // Some registries (e.g. ghcr.io) omit scope from the challenge. Fill in
    // a default pull scope for the target repository so the token endpoint
    // issues a usable token.
    if challenge.scope.is_none() {
        challenge.scope = Some(format!("repository:{repository}:pull"));
    }

    let token_url = auth::build_token_url(&challenge);
    let token_resp = client
        .get_with_auth(&token_url, "application/json", None)
        .await?;
    if !token_resp.status.is_success() {
        return Err(OciFetchError::AuthTokenFetchFailed(format!(
            "token endpoint returned HTTP {}",
            token_resp.status.as_u16()
        )));
    }
    client.set_token(auth::extract_token(&token_resp.body)?);
    Ok(())
}

async fn fetch_layers(
    client: &RegistryClient<'_>,
    scheme: &str,
    reference: &OciReference,
    descriptors: &[manifest::Descriptor],
) -> Result<Vec<OciBlob>, OciFetchError> {
    use futures::stream::{StreamExt, TryStreamExt};

    let fetches = descriptors.iter().map(|desc| {
        fetch_verified_blob(
            client,
            scheme,
            reference,
            desc,
            "layer",
            "*/*",
            "application/vnd.oci.image.layer.v1.tar+gzip",
        )
    });

    futures::stream::iter(fetches)
        .buffer_unordered(LAYER_FETCH_CONCURRENCY)
        .try_collect()
        .await
}

/// Fetch a single blob by digest, verify its sha256, and return it as an
/// [`OciBlob`] ready for inclusion in the image layout.
async fn fetch_verified_blob(
    client: &RegistryClient<'_>,
    scheme: &str,
    reference: &OciReference,
    descriptor: &manifest::Descriptor,
    what: &'static str,
    accept: &str,
    default_media_type: &str,
) -> Result<OciBlob, OciFetchError> {
    let url = v2_url(scheme, reference, "blobs", &descriptor.digest);
    let resp = client.get(&url, accept).await?;
    require_success(resp.status, what)?;
    verify_sha256(&resp.body, &descriptor.digest, what)?;
    let media_type = if descriptor.media_type.is_empty() {
        default_media_type.to_string()
    } else {
        descriptor.media_type.clone()
    };
    Ok(OciBlob {
        digest: descriptor.digest.clone(),
        media_type,
        data: resp.body,
    })
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

fn v2_url(scheme: &str, reference: &OciReference, kind: &str, digest: &str) -> String {
    format!(
        "{scheme}://{}/v2/{}/{kind}/{digest}",
        reference.registry, reference.repository
    )
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

/// Verify that sha256(data) matches the hex in `expected_digest` (which must
/// be of the form `sha256:<hex>`).
fn verify_sha256(
    data: &[u8],
    expected_digest: &str,
    what: &'static str,
) -> Result<(), OciFetchError> {
    let expected_hex = uri::digest_hex(expected_digest)?;
    let actual_hex = hex::encode(Sha256::digest(data));
    if actual_hex != expected_hex {
        return Err(OciFetchError::DigestMismatch {
            what,
            expected: expected_digest.to_string(),
            actual: format!("sha256:{actual_hex}"),
        });
    }
    Ok(())
}
