// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Container images from OCI registries, stored in CAS.
//!
//! A [`Repository`] resolves a digest-pinned image to one platform's
//! manifest and config. Its layers stream from the registry straight into
//! the store, each checked against its digest as it arrives, so an image of
//! any size holds only a few MiB here at a time. The image is stored as the
//! tree a client would get by uploading its OCI Image Layout directory:
//!
//! ```text
//! oci-layout
//! index.json
//! blobs/sha256/<hex>    the manifest, the config, and each layer
//! ```
//!
//! Files are written before the Directories that name them. Under SHA-256 a
//! layer's CAS digest is the OCI digest that names it, so a layer already
//! stored with at least half its TTL left is not downloaded again: fetching
//! an image that shares layers with one fetched before downloads only the
//! layers that are new. Under any other digest function every layer is
//! downloaded, to hash it.
//!
//! A single blob named by digest alone, for `FetchBlob`, streams into the
//! store the same way.

use std::collections::BTreeMap;

use bytes::Bytes;
use dial9::Dial9TokioHandle;
use fetch_http::{HttpFetchError, SriChecksum, SriVerifier};
use fetch_oci::{
    BlobReader, Descriptor, FetchOptions, OciFetchError, OciReference, Platform,
    RegistryCredentials, Repository,
};
use futures::stream::{StreamExt as _, TryStreamExt as _};
use openssl::ssl::SslConnector;
use prost::Message as _;

use protos::build::bazel::remote::execution::v2::{Digest, Directory, DirectoryNode, FileNode};

use crate::store::{
    CPU_INLINE_BYTES, CacheStore, Compression, ContentDigest, DigestFn, parse_digest_hash,
};

use super::helpers::{http_fetch_status, rpc_status, store_error_to_status};

/// Layers downloaded at once, per image.
const LAYER_CONCURRENCY: usize = 4;

/// Small files and Directories share writes of up to this many bytes.
const BATCH_BYTES: usize = 16 * 1024 * 1024;

/// How image fetches reach registries.
#[derive(Clone, Debug, Default)]
pub struct Registries {
    /// Credentials for the registries that need them.
    pub credentials: RegistryCredentials,
    /// Reach registries over plain HTTP: tests' fake registries have no TLS.
    pub(super) plain_http: bool,
}

impl Registries {
    /// A session with the repository `reference` names, taking `platform`
    /// from image indexes.
    pub(super) fn open<'a>(
        &self,
        ssl_connector: &'a SslConnector,
        handle: &'a Dial9TokioHandle,
        reference: &OciReference,
        platform: Option<Platform>,
    ) -> Repository<'a> {
        let options = FetchOptions {
            platform,
            credentials: self.credentials.get(&reference.registry).cloned(),
            plain_http: self.plain_http,
        };
        Repository::new(ssl_connector, handle, reference, options)
    }
}

/// The status reporting a failed image fetch.
pub(super) fn oci_fetch_status(e: &OciFetchError) -> protos::google::rpc::Status {
    use tonic::Code;
    let code = match e {
        OciFetchError::Http(e) => return http_fetch_status(e),
        OciFetchError::InvalidUri(_) | OciFetchError::UnsupportedReference(_) => {
            Code::InvalidArgument
        }
        // The registry wants credentials this server does not have.
        OciFetchError::UnsupportedAuth(_) | OciFetchError::AuthTokenFetchFailed(_) => {
            Code::PermissionDenied
        }
        OciFetchError::AuthChallengeMalformed(_) => Code::Unavailable,
        OciFetchError::NoMatchingPlatform { .. } => Code::NotFound,
        OciFetchError::ManifestParse(_)
        | OciFetchError::UnsupportedMediaType(_)
        | OciFetchError::NestedIndex => Code::FailedPrecondition,
        // As for an HTTP fetch whose body fails its checksum.
        OciFetchError::DigestMismatch { .. } | OciFetchError::SizeMismatch { .. } => Code::Aborted,
        OciFetchError::TotalSizeExceeded { .. } => Code::ResourceExhausted,
    };
    rpc_status(code as i32, e.to_string())
}

/// What fetching an image stored.
#[derive(Debug)]
pub(super) struct StoredImage {
    /// The root Directory's digest and size.
    pub root: (ContentDigest, i64),
    /// Distinct files in the layout, and their total size.
    pub files: usize,
    pub bytes: u64,
    /// Layers downloaded; the rest were already stored.
    pub downloaded: usize,
    /// Small files and Directories written; the rest were already stored.
    pub written: usize,
}

/// A fetch's failure: the registry's, or the store's.
enum Failure {
    Registry(OciFetchError),
    Store(tonic::Status),
}

impl From<OciFetchError> for Failure {
    fn from(e: OciFetchError) -> Self {
        Self::Registry(e)
    }
}

impl From<tonic::Status> for Failure {
    fn from(e: tonic::Status) -> Self {
        Self::Store(e)
    }
}

/// The registry's error inside, the store's outside, as fetches report.
fn split<T>(result: Result<T, Failure>) -> Result<Result<T, OciFetchError>, tonic::Status> {
    match result {
        Ok(value) => Ok(Ok(value)),
        Err(Failure::Registry(e)) => Ok(Err(e)),
        Err(Failure::Store(e)) => Err(e),
    }
}

/// Fetch the image `digest` names from `repository` into CAS, laid out
/// under an `index.json` that names it `ref_name`. The inner error is the
/// registry's; the outer one, the store's.
pub(super) async fn fetch_image(
    store: &CacheStore,
    digest_fn: DigestFn,
    repository: &Repository<'_>,
    digest: &str,
    ref_name: &str,
) -> Result<Result<StoredImage, OciFetchError>, tonic::Status> {
    split(fetch_and_store(store, digest_fn, repository, digest, ref_name).await)
}

async fn fetch_and_store(
    store: &CacheStore,
    digest_fn: DigestFn,
    repository: &Repository<'_>,
    digest: &str,
    ref_name: &str,
) -> Result<StoredImage, Failure> {
    let layout = repository.resolve_image(digest).await?.layout(ref_name);

    // Collected first: a stream holding a borrowing iterator's closure trips
    // rustc's higher-ranked lifetime limits (rust#100013) in boxed RPC
    // futures.
    let downloads: Vec<_> = layout
        .layers
        .iter()
        .map(|layer| store_layer(store, digest_fn, repository, layer))
        .collect();
    let layers: Vec<(ContentDigest, bool)> = futures::stream::iter(downloads)
        .buffered(LAYER_CONCURRENCY)
        .try_collect()
        .await?;

    let mut root = Tree::default();
    let mut small = Vec::with_capacity(layout.files.len());
    for file in layout.files {
        let digest = ContentDigest::new(digest_fn, hash_file(digest_fn, &file).await?);
        root.insert(&file.path, node_digest(&digest, file.data.len() as u64))?;
        small.push((digest, file.data));
    }
    for (layer, (digest, _)) in layout.layers.iter().zip(&layers) {
        root.insert(
            &fetch_oci::blob_path(&layer.digest),
            node_digest(digest, layer.size),
        )?;
    }
    let bytes = small.iter().map(|(_, data)| data.len() as u64).sum::<u64>()
        + layout.layers.iter().map(|layer| layer.size).sum::<u64>();
    let files = small.len() + layers.len();

    let mut directories = Vec::new();
    let root_digest = root.encode(digest_fn, &mut directories);
    // Directories go last, children before parents, so none is stored
    // before what it names.
    let mut written = 0;
    for batch in batches(small.into_iter().chain(directories)) {
        written += store
            .cas_put_verified_blobs(batch)
            .await
            .map_err(store_error_to_status)?;
    }

    Ok(StoredImage {
        root: root_digest,
        files,
        bytes,
        downloaded: layers.iter().filter(|(_, downloaded)| *downloaded).count(),
        written,
    })
}

/// Store one layer, downloading it unless it is already stored with enough
/// TTL left. Returns its CAS digest, and whether it was downloaded.
async fn store_layer(
    store: &CacheStore,
    digest_fn: DigestFn,
    repository: &Repository<'_>,
    layer: &Descriptor,
) -> Result<(ContentDigest, bool), Failure> {
    let named =
        named_sha256(digest_fn, &layer.digest).map(|hash| ContentDigest::new(digest_fn, hash));
    if let Some(digest) = named
        && store
            .cas_blob_fresh(&digest)
            .await
            .map_err(store_error_to_status)?
    {
        return Ok((digest, false));
    }
    let blob = repository.open_blob(layer).await?;
    let (digest, _) = write_blob(store, digest_fn, blob, named, SriVerifier::new(&[])).await?;
    Ok((digest, true))
}

/// Fetch whatever `reference`'s digest names, a blob or failing that a
/// manifest, into CAS, checked against `sri` as well when it holds
/// checksums. Returns the CAS digest and size. The inner error is the
/// registry's; the outer one, the store's.
pub(super) async fn fetch_blob(
    store: &CacheStore,
    digest_fn: DigestFn,
    repository: &Repository<'_>,
    reference: &OciReference,
    sri: &[SriChecksum],
) -> Result<Result<(ContentDigest, u64), OciFetchError>, tonic::Status> {
    let blob = match repository.open_digest(&reference.digest).await {
        Ok(blob) => blob,
        Err(e) => return Ok(Err(e)),
    };
    let named =
        named_sha256(digest_fn, &reference.digest).map(|hash| ContentDigest::new(digest_fn, hash));
    split(write_blob(store, digest_fn, blob, named, SriVerifier::new(sri)).await)
}

/// Write a blob to CAS as it arrives from the registry, committing it only
/// once its OCI digest, `sri`, and `expected` (its CAS digest, when that is
/// known beforehand) all check out. Returns its CAS digest and size.
async fn write_blob(
    store: &CacheStore,
    digest_fn: DigestFn,
    mut blob: BlobReader,
    expected: Option<ContentDigest>,
    mut sri: SriVerifier<'_>,
) -> Result<(ContentDigest, u64), Failure> {
    let mut writer = store.cas_blob_writer(digest_fn, Compression::Identity);
    while let Some(piece) = blob.next().await? {
        sri.update(&piece);
        writer.write(&piece).await.map_err(store_error_to_status)?;
    }
    sri.finish()
        .map_err(|e| OciFetchError::Http(HttpFetchError::IntegrityMismatch(e)))?;
    let (digest, size) = match expected {
        Some(expected) => writer.finalize_verified(&expected).await,
        None => writer.finalize().await,
    }
    .map_err(store_error_to_status)?;
    Ok((digest, size as u64))
}

/// A layout file's CAS hash. Under SHA-256 a blob's is the digest that
/// names it, which its download has already checked; anything else is
/// hashed, large files on blocking threads.
async fn hash_file(
    digest_fn: DigestFn,
    file: &fetch_oci::OciFile,
) -> Result<[u8; 32], tonic::Status> {
    if let Some(hash) = file
        .path
        .strip_prefix("blobs/sha256/")
        .filter(|_| digest_fn == DigestFn::Sha256)
        .and_then(parse_digest_hash)
    {
        return Ok(hash);
    }
    if file.data.len() < CPU_INLINE_BYTES {
        return Ok(digest_fn.hash_data(&file.data));
    }
    let data = file.data.clone();
    tokio::task::spawn_blocking(move || digest_fn.hash_data(&data))
        .await
        .map_err(|e| tonic::Status::internal(format!("hashing an image file: {e}")))
}

/// The SHA-256 hash an OCI digest (`sha256:<hex>`) names, if CAS hashes are
/// SHA-256.
fn named_sha256(digest_fn: DigestFn, digest: &str) -> Option<[u8; 32]> {
    if digest_fn != DigestFn::Sha256 {
        return None;
    }
    fetch_oci::uri::digest_hex(digest)
        .ok()
        .and_then(parse_digest_hash)
}

/// `blobs` grouped into writes of about [`BATCH_BYTES`] each, in order.
fn batches(
    blobs: impl IntoIterator<Item = (ContentDigest, Bytes)>,
) -> Vec<Vec<(ContentDigest, Bytes)>> {
    let mut batches = vec![Vec::new()];
    let mut size = 0;
    for (digest, data) in blobs {
        if size + data.len() > BATCH_BYTES && size > 0 {
            batches.push(Vec::new());
            size = 0;
        }
        size += data.len();
        batches
            .last_mut()
            .expect("never empty")
            .push((digest, data));
    }
    batches
}

fn node_digest(digest: &ContentDigest, size: u64) -> Digest {
    Digest {
        hash: hex::encode(digest.hash),
        size_bytes: size as i64,
    }
}

/// A directory of the layout being built, its entries sorted by name as
/// REAPI requires.
#[derive(Default)]
struct Tree {
    files: BTreeMap<String, Digest>,
    directories: BTreeMap<String, Tree>,
}

impl Tree {
    /// Add the file at `path` (relative, `/`-separated).
    fn insert(&mut self, path: &str, digest: Digest) -> Result<(), tonic::Status> {
        let invalid = || tonic::Status::internal(format!("invalid image layout path {path:?}"));
        let (parents, name) = match path.rsplit_once('/') {
            Some((parents, name)) => (Some(parents), name),
            None => (None, path),
        };
        let mut dir = self;
        for component in parents.into_iter().flat_map(|p| p.split('/')) {
            if component.is_empty() || dir.files.contains_key(component) {
                return Err(invalid());
            }
            dir = dir.directories.entry(component.to_string()).or_default();
        }
        if name.is_empty() || dir.directories.contains_key(name) {
            return Err(invalid());
        }
        dir.files.insert(name.to_string(), digest);
        Ok(())
    }

    /// Encode this directory and everything under it, appending each
    /// Directory to `out` after its subdirectories. Returns this one's
    /// digest and size.
    fn encode(
        self,
        digest_fn: DigestFn,
        out: &mut Vec<(ContentDigest, Bytes)>,
    ) -> (ContentDigest, i64) {
        let directories = self
            .directories
            .into_iter()
            .map(|(name, tree)| {
                let (digest, size) = tree.encode(digest_fn, out);
                DirectoryNode {
                    name,
                    digest: Some(Digest {
                        hash: hex::encode(digest.hash),
                        size_bytes: size,
                    }),
                }
            })
            .collect();
        let files = self
            .files
            .into_iter()
            .map(|(name, digest)| FileNode {
                name,
                digest: Some(digest),
                is_executable: false,
                node_properties: None,
            })
            .collect();
        let bytes = Bytes::from(
            Directory {
                files,
                directories,
                ..Default::default()
            }
            .encode_to_vec(),
        );
        let digest = ContentDigest::new(digest_fn, digest_fn.hash_data(&bytes));
        let size = bytes.len() as i64;
        out.push((digest, bytes));
        (digest, size)
    }
}
