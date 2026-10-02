// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::Duration;

use dial9::Dial9TokioHandle;
use openssl::ssl::SslConnector;

use protos::build::bazel::remote::asset::v1::{
    FetchBlobRequest, FetchBlobResponse, FetchDirectoryRequest, FetchDirectoryResponse,
    PushBlobRequest, PushBlobResponse, PushDirectoryRequest, PushDirectoryResponse, Qualifier,
    fetch_server, push_server,
};
use protos::build::bazel::remote::execution::v2::Digest;

use crate::store::{
    AssetEntry, CacheStore, Compression, ContentDigest, DigestFn, IncrementalHasher, unix_now_secs,
};

use super::helpers::{
    http_fetch_status, instrumented_rpc, parse_and_validate_digest, qualifier, request_timeout,
    resolve_digest_function, rpc_status, rpc_status_ok, store_error_to_status,
};
use super::{git_clone, oci_image};

// ---------------------------------------------------------------------------------------------------------------------
// Qualifier helpers
// ---------------------------------------------------------------------------------------------------------------------

fn extract_qualifiers(qualifiers: &[Qualifier]) -> Vec<(String, String)> {
    qualifiers
        .iter()
        .map(|q| (q.name.clone(), q.value.clone()))
        .collect()
}

/// Qualifiers understood by `FetchBlob`.
///
/// `bazel.canonical_id` carries no fetch semantics of its own — it exists to
/// salt the cache key, which qualifiers do here by construction (they are
/// part of the asset-cache key). The `vcs.*`/`directory` family names a
/// tree, which only `FetchDirectory` fetches: a blob fetch with them finds
/// blobs pushed under them, and fetches nothing from origin (see
/// [`names_a_tree`]).
const FETCH_BLOB_QUALIFIERS: &[&str] = &[
    "checksum.sri",
    "bazel.canonical_id",
    "resource_type",
    "vcs.branch",
    "vcs.commit",
    "directory",
];

/// Qualifiers understood by `FetchDirectory`. Note `checksum.sri` is absent:
/// there is no checksum-verified directory fetch path (an OCI image's URI
/// pins its digest instead). `oci.platform` (`os/architecture[/variant]`,
/// as in `linux/arm64/v8`) picks the manifest an OCI image index resolves
/// to.
const FETCH_DIRECTORY_QUALIFIERS: &[&str] = &[
    "vcs.branch",
    "vcs.commit",
    "directory",
    "resource_type",
    "bazel.canonical_id",
    "oci.platform",
];

/// Whether `qualifiers` ask for a tree: a git commit or branch, a
/// subdirectory, or a git repository's resource type. Fetched as a blob,
/// the URI would give something else entirely (a repository's web page),
/// stored under qualifiers that say otherwise.
fn names_a_tree(qualifiers: &[(String, String)]) -> bool {
    git_clone::has_vcs_qualifiers(qualifiers)
        || qualifier(qualifiers, "directory").is_some()
        || qualifier(qualifiers, "resource_type") == Some("application/x-git")
}

/// The Remote Asset spec requires servers to reject requests containing
/// qualifiers they do not support with `INVALID_ARGUMENT`; silently ignoring
/// one (say, a misspelled `vcs.commit`) would fetch the wrong content.
fn reject_unsupported_qualifiers(
    qualifiers: &[(String, String)],
    supported: &[&str],
) -> Result<(), tonic::Status> {
    match qualifiers
        .iter()
        .map(|(name, _)| name.as_str())
        .find(|name| !supported.contains(name))
    {
        Some(name) => Err(tonic::Status::invalid_argument(format!(
            "qualifier \"{name}\" not supported (supported: {})",
            supported.join(", ")
        ))),
        None => Ok(()),
    }
}

fn qualifiers_to_proto(quals: &[(String, String)]) -> Vec<Qualifier> {
    quals
        .iter()
        .map(|(n, v)| Qualifier {
            name: n.clone(),
            value: v.clone(),
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------------------------------------------------

fn timestamp_to_secs(ts: &Option<prost_types::Timestamp>) -> u64 {
    match ts {
        Some(t) if t.seconds > 0 => t.seconds as u64,
        _ => 0,
    }
}

fn secs_to_timestamp(secs: u64) -> Option<prost_types::Timestamp> {
    if secs == 0 {
        None
    } else {
        Some(prost_types::Timestamp {
            seconds: secs as i64,
            nanos: 0,
        })
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// FetchService
// ---------------------------------------------------------------------------------------------------------------------

/// Resolves Push'd asset mappings from the store, and fetches what it does
/// not have from origin into CAS, recording an asset mapping for it: blobs
/// over HTTP (checked against a `checksum.sri` qualifier when there is one),
/// and directories from git repositories and OCI registries.
#[derive(Clone)]
pub struct FetchService {
    store: Arc<CacheStore>,
    ssl_connector: SslConnector,
    handle: Dial9TokioHandle,
    config: Arc<FetchConfig>,
    http_slots: Arc<tokio::sync::Semaphore>,
    git_slots: Arc<tokio::sync::Semaphore>,
    oci_slots: Arc<tokio::sync::Semaphore>,
    fetches: Arc<InFlight>,
    registries: Arc<oci_image::Registries>,
}

/// Settings for a [`FetchService`].
#[derive(Clone, Debug)]
pub struct FetchConfig {
    /// The CPUs the server may use (the runtime's count, which a cgroup's
    /// quota and the affinity mask bound), shared out between clones.
    pub cpus: usize,
    /// Directory for spooling git packfiles during clones (system temp when
    /// `None`).
    pub git_spool_dir: Option<PathBuf>,
    /// The longest any fetch may run, whatever its request asks for; `None`
    /// for no limit. Fetch requests are cut off [`FETCH_TIMEOUT_MARGIN`]
    /// after it, so a fetch out of time still answers for itself.
    pub max_fetch_time: Option<Duration>,
    /// HTTP fetches allowed to run at once. Each may hold up to
    /// [`fetch_http::MAX_HTTP_FETCH_SIZE`] in memory.
    pub max_http_fetches: usize,
    /// Git clones allowed to run at once. Each spools its pack to disk and
    /// holds the pack's index in memory.
    pub max_git_clones: usize,
    /// OCI image fetches allowed to run at once. Each streams its layers
    /// into the store a few at a time, holding a few MiB of each.
    pub max_oci_fetches: usize,
    /// Credentials for OCI registries that refuse anonymous pulls.
    pub oci_credentials: fetch_oci::RegistryCredentials,
}

impl FetchConfig {
    /// How each clone spools its pack, and how many threads it may use to
    /// index and convert it: the server's CPUs, shared between the clones
    /// allowed at once.
    fn git_clone_options(&self) -> fetch_git::CloneOptions {
        fetch_git::CloneOptions {
            spool_dir: self.git_spool_dir.clone(),
            index_threads: (self.cpus / self.max_git_clones.max(1)).max(1),
        }
    }
}

impl Default for FetchConfig {
    fn default() -> Self {
        Self {
            cpus: std::thread::available_parallelism().map_or(1, usize::from),
            git_spool_dir: None,
            max_fetch_time: None,
            max_http_fetches: 16,
            max_git_clones: 2,
            max_oci_fetches: 4,
            oci_credentials: fetch_oci::RegistryCredentials::default(),
        }
    }
}

/// [`FetchService::fetch_git_asset`]'s future, boxed and type-erased.
type GitAssetFetch<'a> = std::pin::Pin<
    Box<
        dyn std::future::Future<
                Output = Result<Result<AssetEntry, git_clone::GitCloneError>, tonic::Status>,
            > + Send
            + 'a,
    >,
>;

/// What an origin fetch will store: whether it is a directory, the digest
/// function, the URI, and the qualifiers in canonical order.
type FetchKey = (bool, i32, String, Vec<(String, String)>);

fn fetch_key(
    directory: bool,
    digest_fn: DigestFn,
    uri: &str,
    qualifiers: &[(String, String)],
) -> FetchKey {
    let mut qualifiers = qualifiers.to_vec();
    qualifiers.sort();
    (
        directory,
        digest_fn.to_proto_i32(),
        uri.to_string(),
        qualifiers,
    )
}

/// Origin fetches in progress, so that concurrent requests for the same
/// asset wait for one fetch and then find it cached, instead of each going
/// to the origin.
#[derive(Default)]
struct InFlight(std::sync::Mutex<HashMap<FetchKey, Weak<tokio::sync::Mutex<()>>>>);

impl InFlight {
    /// Wait until no other request is fetching `key`, then hold it until the
    /// guard is dropped.
    async fn enter(&self, key: FetchKey) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            let mut fetches = self.0.lock().expect("in-flight map lock never poisoned");
            fetches.retain(|_, held| held.strong_count() > 0);
            match fetches.get(&key).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(tokio::sync::Mutex::new(()));
                    fetches.insert(key, Arc::downgrade(&lock));
                    lock
                }
            }
        };
        lock.lock_owned().await
    }
}

/// How long an HTTP fetch may take when the request sets no timeout.
const DEFAULT_HTTP_FETCH_TIMEOUT: Duration = Duration::from_secs(60);

/// How long a git clone and its ingest may take when the request sets no
/// timeout. Large repositories take minutes to download and index.
const DEFAULT_GIT_FETCH_TIMEOUT: Duration = Duration::from_secs(1800);

/// How long an OCI image fetch and its ingest may take when the request sets
/// no timeout: an image may be gigabytes.
const DEFAULT_OCI_FETCH_TIMEOUT: Duration = Duration::from_secs(600);

/// How much longer than [`FetchConfig::max_fetch_time`] the server lets a
/// Fetch request run, so a fetch that runs out of time answers
/// `DEADLINE_EXCEEDED` itself, with its own message, before the server's
/// limit cuts it off.
pub const FETCH_TIMEOUT_MARGIN: Duration = Duration::from_secs(2);

/// The answer for a fetch that ran out of time.
fn deadline_exceeded(budget: Duration) -> protos::google::rpc::Status {
    rpc_status(
        tonic::Code::DeadlineExceeded as i32,
        format!("fetch did not finish within {budget:?}"),
    )
}

impl std::fmt::Debug for FetchService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FetchService").finish_non_exhaustive()
    }
}

impl FetchService {
    pub fn new(store: Arc<CacheStore>, handle: Dial9TokioHandle, config: FetchConfig) -> Self {
        Self {
            store,
            ssl_connector: fetch_http::build_ssl_connector(),
            handle,
            http_slots: Arc::new(tokio::sync::Semaphore::new(config.max_http_fetches.max(1))),
            git_slots: Arc::new(tokio::sync::Semaphore::new(config.max_git_clones.max(1))),
            oci_slots: Arc::new(tokio::sync::Semaphore::new(config.max_oci_fetches.max(1))),
            registries: Arc::new(oci_image::Registries {
                credentials: config.oci_credentials.clone(),
                ..Default::default()
            }),
            config: Arc::new(config),
            fetches: Arc::default(),
        }
    }

    /// This service, reaching OCI registries over plain HTTP.
    #[cfg(test)]
    pub(super) fn with_plain_http_registries(mut self) -> Self {
        Arc::make_mut(&mut self.registries).plain_http = true;
        self
    }

    /// When a fetch must be done by, and how long that gives it: the time the
    /// request asked for, or `default`, but always inside the server's own
    /// request timeout. One deadline covers every URI a request lists, and
    /// the ingest as well as the download.
    fn deadline(
        &self,
        requested: Option<&prost_types::Duration>,
        default: Duration,
    ) -> (tokio::time::Instant, Duration) {
        let mut budget = request_timeout(requested).unwrap_or(default);
        if let Some(max) = self.config.max_fetch_time {
            budget = budget.min(max);
        }
        (tokio::time::Instant::now() + budget, budget)
    }

    /// Try to resolve a URI from the asset cache. Returns Some(entry) if found
    /// and valid (not expired, not too old, referenced content still in CAS).
    async fn try_cached_lookup(
        &self,
        digest_fn: DigestFn,
        uri: &str,
        qualifiers: &[(String, String)],
        oldest_content_accepted: u64,
        expect_directory: bool,
    ) -> Result<Option<AssetEntry>, tonic::Status> {
        let entry = match self
            .store
            .asset_get(digest_fn, uri, qualifiers)
            .await
            .map_err(store_error_to_status)?
        {
            Some(e) => e,
            None => return Ok(None),
        };

        if entry.is_directory != expect_directory {
            return Ok(None);
        }

        // Check expiry
        if entry.expires_at != 0 && unix_now_secs() >= entry.expires_at {
            return Ok(None);
        }

        // Check oldest_content_accepted
        if oldest_content_accepted != 0 && entry.created_at < oldest_content_accepted {
            return Ok(None);
        }

        // Verify the referenced content is still in CAS, with enough of its
        // TTL left to be worth answering with; otherwise fetch again, which
        // rewrites it (for a directory, its whole tree) with a fresh TTL.
        let cd = ContentDigest::new(digest_fn, entry.digest_hash);
        let fresh = self
            .store
            .cas_blob_fresh(&cd)
            .await
            .map_err(store_error_to_status)?;
        if !fresh {
            return Ok(None);
        }

        Ok(Some(entry))
    }

    /// Fetch `uri` with `fetch`, once a turn of `slots` comes, and record
    /// what it stored (a blob, or a Directory for a `directory`) as an asset;
    /// unless a request that was already fetching it has stored it by the
    /// time this one's turn comes. `fetch` answers the digest hash and size
    /// of what it stored. The inner error is the origin's; the outer one,
    /// the store's.
    #[allow(clippy::too_many_arguments)]
    async fn fetch_asset<E>(
        &self,
        slots: &tokio::sync::Semaphore,
        directory: bool,
        digest_fn: DigestFn,
        uri: &str,
        qualifiers: &[(String, String)],
        oldest_content_accepted: u64,
        fetch: impl Future<Output = Result<Result<([u8; 32], i64), E>, tonic::Status>>,
    ) -> Result<Result<AssetEntry, E>, tonic::Status> {
        let _fetching = self
            .fetches
            .enter(fetch_key(directory, digest_fn, uri, qualifiers))
            .await;
        if let Some(entry) = self
            .try_cached_lookup(
                digest_fn,
                uri,
                qualifiers,
                oldest_content_accepted,
                directory,
            )
            .await?
        {
            return Ok(Ok(entry));
        }
        let _slot = slots.acquire().await.expect("never closed");
        let (digest_hash, digest_size_bytes) = match fetch.await? {
            Ok(stored) => stored,
            Err(e) => return Ok(Err(e)),
        };
        let entry = AssetEntry {
            digest_hash,
            digest_size_bytes,
            created_at: unix_now_secs(),
            expires_at: 0,
            is_directory: directory,
            qualifiers: qualifiers.to_vec(),
        };
        self.store
            .asset_put(digest_fn, uri, qualifiers, &entry)
            .await
            .map_err(store_error_to_status)?;
        Ok(Ok(entry))
    }

    /// Fetch `uri` over HTTP into CAS and record it as an asset (see
    /// [`fetch_asset`](Self::fetch_asset)).
    async fn fetch_http_asset(
        &self,
        digest_fn: DigestFn,
        uri: &str,
        qualifiers: &[(String, String)],
        oldest_content_accepted: u64,
        sri_checksums: &[fetch_http::SriChecksum],
    ) -> Result<Result<AssetEntry, fetch_http::HttpFetchError>, tonic::Status> {
        let fetch = async {
            // The CAS digest is computed as the body arrives, so the blob is
            // stored without hashing it again.
            let mut hasher = IncrementalHasher::new(digest_fn, 0);
            let data = match fetch_http::fetch_http_blob(
                &self.ssl_connector,
                uri,
                sri_checksums,
                &mut |chunk| hasher.update(chunk),
                &self.handle,
            )
            .await
            {
                Ok(data) => data,
                Err(e) => return Ok(Err(e)),
            };
            let (hash, size) = (hasher.finalize(), data.len() as i64);
            self.store
                .cas_put_blob_prehashed(
                    &ContentDigest::new(digest_fn, hash),
                    data,
                    Compression::Identity,
                )
                .await
                .map_err(store_error_to_status)?;
            Ok(Ok((hash, size)))
        };
        let slots = &self.http_slots;
        self.fetch_asset(
            slots,
            false,
            digest_fn,
            uri,
            qualifiers,
            oldest_content_accepted,
            fetch,
        )
        .await
    }

    /// Clone `uri` into CAS and record its tree as an asset (see
    /// [`fetch_asset`](Self::fetch_asset)).
    async fn fetch_git_asset(
        &self,
        digest_fn: DigestFn,
        uri: &str,
        qualifiers: &[(String, String)],
        oldest_content_accepted: u64,
    ) -> Result<Result<AssetEntry, git_clone::GitCloneError>, tonic::Status> {
        let fetch = async {
            let clone_options = self.config.git_clone_options();
            let clone = git_clone::fetch_git_directory(
                &self.ssl_connector,
                &self.store,
                uri,
                qualifiers,
                digest_fn,
                &clone_options,
                &self.handle,
            );
            Ok(clone
                .await
                .map(|result| (result.root_digest_hash, result.root_digest_size)))
        };
        let slots = &self.git_slots;
        self.fetch_asset(
            slots,
            true,
            digest_fn,
            uri,
            qualifiers,
            oldest_content_accepted,
            fetch,
        )
        .await
    }

    /// Fetch the OCI image `uri` into CAS, resolving an image index to
    /// `platform`, and record its layout's tree as an asset (see
    /// [`fetch_asset`](Self::fetch_asset)).
    async fn fetch_oci_asset(
        &self,
        digest_fn: DigestFn,
        uri: &str,
        qualifiers: &[(String, String)],
        oldest_content_accepted: u64,
        platform: Option<&fetch_oci::Platform>,
    ) -> Result<Result<AssetEntry, fetch_oci::OciFetchError>, tonic::Status> {
        let fetch = async {
            let reference = match fetch_oci::parse_oci_uri(uri) {
                Ok(reference) => reference,
                Err(e) => return Ok(Err(e)),
            };
            let repository = self.registries.open(
                &self.ssl_connector,
                &self.handle,
                &reference,
                platform.cloned(),
            );
            let fetched =
                oci_image::fetch_image(&self.store, digest_fn, &repository, &reference.digest, uri);
            let stored = match fetched.await? {
                Ok(stored) => stored,
                Err(e) => return Ok(Err(e)),
            };
            tracing::info!(
                uri,
                files = stored.files,
                mib = stored.bytes / (1024 * 1024),
                downloaded = stored.downloaded,
                written = stored.written,
                "stored OCI image",
            );
            let (root, root_size) = stored.root;
            Ok(Ok((root.hash, root_size)))
        };
        let slots = &self.oci_slots;
        self.fetch_asset(
            slots,
            true,
            digest_fn,
            uri,
            qualifiers,
            oldest_content_accepted,
            fetch,
        )
        .await
    }

    /// Fetch the blob (or manifest) the OCI URI `uri`'s digest names into
    /// CAS, checked against `sri_checksums` as well, and record it as an
    /// asset (see [`fetch_asset`](Self::fetch_asset)).
    async fn fetch_oci_blob_asset(
        &self,
        digest_fn: DigestFn,
        uri: &str,
        qualifiers: &[(String, String)],
        oldest_content_accepted: u64,
        sri_checksums: &[fetch_http::SriChecksum],
    ) -> Result<Result<AssetEntry, fetch_oci::OciFetchError>, tonic::Status> {
        let fetch = async {
            let reference = match fetch_oci::parse_oci_uri(uri) {
                Ok(reference) => reference,
                Err(e) => return Ok(Err(e)),
            };
            let repository =
                self.registries
                    .open(&self.ssl_connector, &self.handle, &reference, None);
            let fetched = oci_image::fetch_blob(
                &self.store,
                digest_fn,
                &repository,
                &reference,
                sri_checksums,
            );
            Ok(fetched
                .await?
                .map(|(digest, size)| (digest.hash, size as i64)))
        };
        let slots = &self.oci_slots;
        self.fetch_asset(
            slots,
            false,
            digest_fn,
            uri,
            qualifiers,
            oldest_content_accepted,
            fetch,
        )
        .await
    }
}

#[tonic::async_trait]
impl fetch_server::Fetch for FetchService {
    #[tracing::instrument(skip(self, req))]
    async fn fetch_blob(
        &self,
        req: tonic::Request<FetchBlobRequest>,
    ) -> Result<tonic::Response<FetchBlobResponse>, tonic::Status> {
        let svc = self.clone();
        instrumented_rpc("fetch.fetch_blob", async move {
            let inner = req.into_inner();

            if inner.uris.is_empty() {
                return Err(tonic::Status::invalid_argument(
                    "at least one URI is required",
                ));
            }

            let digest_fn = resolve_digest_function(inner.digest_function)?;
            let qualifiers = extract_qualifiers(&inner.qualifiers);
            reject_unsupported_qualifiers(&qualifiers, FETCH_BLOB_QUALIFIERS)?;
            let oldest_content_accepted = timestamp_to_secs(&inner.oldest_content_accepted);
            let failure = |status| {
                tonic::Response::new(FetchBlobResponse {
                    status: Some(status),
                    uri: inner.uris.first().cloned().unwrap_or_default(),
                    qualifiers: qualifiers_to_proto(&qualifiers),
                    expires_at: None,
                    blob_digest: None,
                    digest_function: digest_fn.to_proto_i32(),
                })
            };
            let found = |uri: &str, entry: &AssetEntry| {
                tonic::Response::new(FetchBlobResponse {
                    status: Some(rpc_status_ok()),
                    uri: uri.to_string(),
                    qualifiers: qualifiers_to_proto(&entry.qualifiers),
                    expires_at: secs_to_timestamp(entry.expires_at),
                    blob_digest: Some(Digest {
                        hash: hex::encode(entry.digest_hash),
                        size_bytes: entry.digest_size_bytes,
                    }),
                    digest_function: digest_fn.to_proto_i32(),
                })
            };

            // Phase 1: try cached lookups
            for uri in &inner.uris {
                if let Some(entry) = svc
                    .try_cached_lookup(digest_fn, uri, &qualifiers, oldest_content_accepted, false)
                    .await?
                {
                    return Ok(found(uri, &entry));
                }
            }

            // Phase 2: fetch from origin, unless the qualifiers name a tree,
            // which only FetchDirectory fetches.
            if names_a_tree(&qualifiers) {
                return Ok(failure(rpc_status(
                    tonic::Code::NotFound as i32,
                    "no blob pushed under these qualifiers, which name a tree; \
                     FetchDirectory fetches git repositories",
                )));
            }
            let fetchable = |uri: &str| fetch_http::is_http_uri(uri) || fetch_oci::is_oci_uri(uri);
            if inner.uris.iter().any(|u| fetchable(u)) {
                // Parse SRI checksums if provided; empty vec means no validation
                let sri_checksums = match qualifier(&qualifiers, "checksum.sri") {
                    Some(sri_value) => match fetch_http::parse_sri(sri_value) {
                        Ok(c) => c,
                        Err(msg) => {
                            return Ok(failure(rpc_status(
                                tonic::Code::InvalidArgument as i32,
                                format!("invalid checksum.sri: {msg}"),
                            )));
                        }
                    },
                    None => vec![],
                };
                let default_timeout = if inner.uris.iter().any(|u| fetch_oci::is_oci_uri(u)) {
                    DEFAULT_OCI_FETCH_TIMEOUT
                } else {
                    DEFAULT_HTTP_FETCH_TIMEOUT
                };
                let (deadline, budget) = svc.deadline(inner.timeout.as_ref(), default_timeout);

                let mut last_error = None;
                for uri in &inner.uris {
                    // The origin's error, if any, as the status reporting it.
                    let fetched = if fetch_http::is_http_uri(uri) {
                        let fetch = svc.fetch_http_asset(
                            digest_fn,
                            uri,
                            &qualifiers,
                            oldest_content_accepted,
                            &sri_checksums,
                        );
                        tokio::time::timeout_at(deadline, fetch)
                            .await
                            .map(|r| r.map(|r| r.map_err(|e| http_fetch_status(&e))))
                    } else if fetch_oci::is_oci_uri(uri) {
                        let fetch = svc.fetch_oci_blob_asset(
                            digest_fn,
                            uri,
                            &qualifiers,
                            oldest_content_accepted,
                            &sri_checksums,
                        );
                        tokio::time::timeout_at(deadline, fetch)
                            .await
                            .map(|r| r.map(|r| r.map_err(|e| oci_image::oci_fetch_status(&e))))
                    } else {
                        continue;
                    };
                    let Ok(fetched) = fetched else {
                        return Ok(failure(deadline_exceeded(budget)));
                    };
                    match fetched? {
                        Ok(entry) => return Ok(found(uri, &entry)),
                        Err(status) => {
                            tracing::warn!(uri, error = %status.message, "fetch failed, trying next URI");
                            last_error = Some(status);
                        }
                    }
                }

                // Every fetchable URI failed: report the last failure.
                if let Some(status) = last_error {
                    return Ok(failure(status));
                }
            }

            Ok(failure(rpc_status(
                tonic::Code::NotFound as i32,
                "no matching content found for any URI",
            )))
        })
        .await
    }

    #[tracing::instrument(skip(self, req))]
    async fn fetch_directory(
        &self,
        req: tonic::Request<FetchDirectoryRequest>,
    ) -> Result<tonic::Response<FetchDirectoryResponse>, tonic::Status> {
        let svc = self.clone();
        instrumented_rpc("fetch.fetch_directory", async move {
            let inner = req.into_inner();

            if inner.uris.is_empty() {
                return Err(tonic::Status::invalid_argument(
                    "at least one URI is required",
                ));
            }

            let digest_fn = resolve_digest_function(inner.digest_function)?;
            let qualifiers = extract_qualifiers(&inner.qualifiers);
            reject_unsupported_qualifiers(&qualifiers, FETCH_DIRECTORY_QUALIFIERS)?;
            let oldest_content_accepted = timestamp_to_secs(&inner.oldest_content_accepted);
            let failure = |status| {
                tonic::Response::new(FetchDirectoryResponse {
                    status: Some(status),
                    uri: inner.uris.first().cloned().unwrap_or_default(),
                    qualifiers: qualifiers_to_proto(&qualifiers),
                    expires_at: None,
                    root_directory_digest: None,
                    digest_function: digest_fn.to_proto_i32(),
                })
            };
            let found = |uri: &str, entry: &AssetEntry| {
                tonic::Response::new(FetchDirectoryResponse {
                    status: Some(rpc_status_ok()),
                    uri: uri.to_string(),
                    qualifiers: qualifiers_to_proto(&entry.qualifiers),
                    expires_at: secs_to_timestamp(entry.expires_at),
                    root_directory_digest: Some(Digest {
                        hash: hex::encode(entry.digest_hash),
                        size_bytes: entry.digest_size_bytes,
                    }),
                    digest_function: digest_fn.to_proto_i32(),
                })
            };

            // Phase 1: try cached lookups
            for uri in &inner.uris {
                if let Some(entry) = svc
                    .try_cached_lookup(digest_fn, uri, &qualifiers, oldest_content_accepted, true)
                    .await?
                {
                    return Ok(found(uri, &entry));
                }
            }

            let platform = match qualifier(&qualifiers, "oci.platform")
                .map(str::parse::<fetch_oci::Platform>)
                .transpose()
            {
                Ok(platform) => platform,
                Err(msg) => {
                    return Ok(failure(rpc_status(
                        tonic::Code::InvalidArgument as i32,
                        format!("invalid oci.platform: {msg}"),
                    )));
                }
            };

            // Phase 2: clone git repositories, at the commit or branch the
            // VCS qualifiers name, or without them, the default branch.
            let git = git_clone::has_vcs_qualifiers(&qualifiers)
                || inner
                    .uris
                    .iter()
                    .any(|u| git_clone::is_git_uri(u, &qualifiers));
            if git {
                if platform.is_some() {
                    return Ok(failure(rpc_status(
                        tonic::Code::InvalidArgument as i32,
                        "the oci.platform qualifier applies only to OCI image fetches",
                    )));
                }
                let (deadline, budget) =
                    svc.deadline(inner.timeout.as_ref(), DEFAULT_GIT_FETCH_TIMEOUT);

                let mut last_error = None;
                for uri in &inner.uris {
                    if !git_clone::is_git_uri(uri, &qualifiers) {
                        continue;
                    }

                    // Type-erased: a clone's future nests deep enough that
                    // proving this RPC's future `Send` through it overflows
                    // the trait solver's recursion limit.
                    let fetch: GitAssetFetch<'_> = Box::pin(svc.fetch_git_asset(
                        digest_fn,
                        uri,
                        &qualifiers,
                        oldest_content_accepted,
                    ));
                    let fetched = tokio::time::timeout_at(deadline, fetch).await;
                    let Ok(fetched) = fetched else {
                        return Ok(failure(deadline_exceeded(budget)));
                    };
                    match fetched? {
                        Ok(entry) => return Ok(found(uri, &entry)),
                        Err(e) => {
                            tracing::warn!(uri, error = %e, "git clone failed, trying next URI");
                            last_error = Some(e);
                        }
                    }
                }

                if let Some(e) = last_error {
                    return Ok(failure(e.to_rpc_status()));
                }
            } else if inner.uris.iter().any(|u| fetch_oci::is_oci_uri(u)) {
                // Phase 2, without VCS qualifiers: fetch OCI images, whose
                // layouts have no subdirectory worth asking for.
                if qualifier(&qualifiers, "directory").is_some() {
                    return Ok(failure(rpc_status(
                        tonic::Code::InvalidArgument as i32,
                        "the directory qualifier applies only to git fetches",
                    )));
                }
                let (deadline, budget) =
                    svc.deadline(inner.timeout.as_ref(), DEFAULT_OCI_FETCH_TIMEOUT);

                let mut last_error = None;
                for uri in &inner.uris {
                    if !fetch_oci::is_oci_uri(uri) {
                        continue;
                    }

                    let fetch = svc.fetch_oci_asset(
                        digest_fn,
                        uri,
                        &qualifiers,
                        oldest_content_accepted,
                        platform.as_ref(),
                    );
                    let fetched = tokio::time::timeout_at(deadline, fetch).await;
                    let Ok(fetched) = fetched else {
                        return Ok(failure(deadline_exceeded(budget)));
                    };
                    match fetched? {
                        Ok(entry) => return Ok(found(uri, &entry)),
                        Err(e) => {
                            tracing::warn!(uri, error = %e, "OCI fetch failed, trying next URI");
                            last_error = Some(e);
                        }
                    }
                }

                if let Some(e) = last_error {
                    return Ok(failure(oci_image::oci_fetch_status(&e)));
                }
            }

            Ok(failure(rpc_status(
                tonic::Code::NotFound as i32,
                "no matching directory found for any URI",
            )))
        })
        .await
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// PushService
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct PushService {
    store: Arc<CacheStore>,
}

impl PushService {
    pub fn new(store: Arc<CacheStore>) -> Self {
        Self { store }
    }
}

#[tonic::async_trait]
impl push_server::Push for PushService {
    #[tracing::instrument(skip(self, req))]
    async fn push_blob(
        &self,
        req: tonic::Request<PushBlobRequest>,
    ) -> Result<tonic::Response<PushBlobResponse>, tonic::Status> {
        let store = self.store.clone();
        instrumented_rpc("push.push_blob", async move {
            let inner = req.into_inner();

            if inner.uris.is_empty() {
                return Err(tonic::Status::invalid_argument(
                    "at least one URI is required",
                ));
            }

            let digest_fn = resolve_digest_function(inner.digest_function)?;
            let blob_cd = parse_and_validate_digest(&inner.blob_digest, digest_fn)?;

            if !store
                .cas_blob_exists(&blob_cd)
                .await
                .map_err(store_error_to_status)?
            {
                return Err(tonic::Status::not_found(format!(
                    "blob {} not found in CAS",
                    hex::encode(blob_cd.hash),
                )));
            }

            let qualifiers = extract_qualifiers(&inner.qualifiers);
            let expires_at = timestamp_to_secs(&inner.expire_at);
            let size_bytes = inner
                .blob_digest
                .as_ref()
                .map(|d| d.size_bytes)
                .unwrap_or(0);

            let entry = AssetEntry {
                digest_hash: blob_cd.hash,
                digest_size_bytes: size_bytes,
                created_at: unix_now_secs(),
                expires_at,
                is_directory: false,
                qualifiers: qualifiers.clone(),
            };

            for uri in &inner.uris {
                store
                    .asset_put(digest_fn, uri, &qualifiers, &entry)
                    .await
                    .map_err(store_error_to_status)?;
            }

            Ok(tonic::Response::new(PushBlobResponse {}))
        })
        .await
    }

    #[tracing::instrument(skip(self, req))]
    async fn push_directory(
        &self,
        req: tonic::Request<PushDirectoryRequest>,
    ) -> Result<tonic::Response<PushDirectoryResponse>, tonic::Status> {
        let store = self.store.clone();
        instrumented_rpc("push.push_directory", async move {
            let inner = req.into_inner();

            if inner.uris.is_empty() {
                return Err(tonic::Status::invalid_argument(
                    "at least one URI is required",
                ));
            }

            let digest_fn = resolve_digest_function(inner.digest_function)?;
            let dir_cd = parse_and_validate_digest(&inner.root_directory_digest, digest_fn)?;

            if !store
                .cas_blob_exists(&dir_cd)
                .await
                .map_err(store_error_to_status)?
            {
                return Err(tonic::Status::not_found(format!(
                    "directory {} not found in CAS",
                    hex::encode(dir_cd.hash),
                )));
            }

            let qualifiers = extract_qualifiers(&inner.qualifiers);
            let expires_at = timestamp_to_secs(&inner.expire_at);
            let size_bytes = inner
                .root_directory_digest
                .as_ref()
                .map(|d| d.size_bytes)
                .unwrap_or(0);

            let entry = AssetEntry {
                digest_hash: dir_cd.hash,
                digest_size_bytes: size_bytes,
                created_at: unix_now_secs(),
                expires_at,
                is_directory: true,
                qualifiers: qualifiers.clone(),
            };

            for uri in &inner.uris {
                store
                    .asset_put(digest_fn, uri, &qualifiers, &entry)
                    .await
                    .map_err(store_error_to_status)?;
            }

            Ok(tonic::Response::new(PushDirectoryResponse {}))
        })
        .await
    }
}

// ---------------------------------------------------------------------------------------------------------------------
