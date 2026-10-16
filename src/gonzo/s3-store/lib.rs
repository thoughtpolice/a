// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! First-party S3 backend for the [`object_store`] API.
//!
//! This crate implements [`ObjectStore`] against the S3 REST API directly:
//! requests go through reqwest (TLS via native-tls, which this repository
//! backs with BoringSSL) and are signed with an in-crate AWS Signature
//! Version 4 implementation on the RustCrypto stack. Nothing here links
//! ring or aws-lc-rs, which is the reason this exists instead of the
//! upstream `object_store` `aws` feature.
//!
//! Feature notes:
//!
//! - Conditional writes are always available: `PutMode::Create` maps onto
//!   `If-None-Match: *` and `PutMode::Update` onto `If-Match`, which AWS S3
//!   has supported natively since late 2024 (and MinIO, R2, Tigris, etc.
//!   support as well). SlateDB relies on this for manifest CAS.
//! - `copy_opts` with `CopyMode::Create` returns `NotSupported`: plain S3
//!   `CopyObject` has no atomic destination precondition.
//! - `delete_stream` issues individual `DeleteObject` requests with bounded
//!   concurrency rather than `DeleteObjects` batches, keeping the client on
//!   the universally-supported core API.
//! - Credentials are static (explicit or from `AWS_*` environment
//!   variables); IMDS/STS credential providers can slot into
//!   [`S3StoreBuilder`] later if ever needed.

mod client;
mod config;
mod multipart;
mod sigv4;
mod xml;

use std::sync::Arc;

use async_trait::async_trait;
use futures::stream::BoxStream;
use futures::{StreamExt as _, TryStreamExt as _};
use object_store::path::Path;
use object_store::{
    CopyMode, CopyOptions, GetOptions, GetRange, GetResult, GetResultPayload, ListResult,
    MultipartUpload, ObjectMeta, ObjectStore, PutMode, PutMultipartOptions, PutOptions, PutPayload,
    PutResult,
};

use crate::client::{PutRequestOptions, S3Client, generic_msg};
use crate::multipart::S3MultipartUpload;

pub use crate::config::S3StoreBuilder;
pub use crate::sigv4::Credentials;

// Re-exported so callers can name the trait/types without a separate
// dependency edge.
pub use object_store;

type Result<T, E = object_store::Error> = std::result::Result<T, E>;

/// An [`ObjectStore`] backed by an S3 (or S3-compatible) bucket.
///
/// Construct with [`S3StoreBuilder`].
#[derive(Debug)]
pub struct S3Store {
    client: Arc<S3Client>,
}

impl S3Store {
    pub(crate) fn from_client(client: S3Client) -> Self {
        Self {
            client: Arc::new(client),
        }
    }
}

impl std::fmt::Display for S3Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "S3({})", self.client.config.bucket)
    }
}

/// Paginate `ListObjectsV2`, one [`ListResult`] per page.
fn list_pages(
    client: Arc<S3Client>,
    prefix: Option<&Path>,
    delimiter: bool,
    offset: Option<&Path>,
) -> BoxStream<'static, Result<ListResult>> {
    let prefix = prefix.map(|p| format!("{}/", p.as_ref()));
    let offset = offset.map(|o| o.as_ref().to_string());
    // The state is the continuation token for the next page (none for the
    // first), or `None` once the last page is out.
    futures::stream::try_unfold(Some(None::<String>), move |token| {
        let client = Arc::clone(&client);
        let prefix = prefix.clone();
        let offset = offset.clone();
        async move {
            let Some(token) = token else {
                return Ok(None);
            };
            let page = client
                .list_page(
                    prefix.as_deref(),
                    delimiter,
                    offset.as_deref(),
                    token.as_deref(),
                )
                .await?;
            Ok(Some((page.result, page.next_token.map(Some))))
        }
    })
    .boxed()
}

/// Flatten [`list_pages`] into a stream of [`ObjectMeta`].
fn list_objects(
    client: Arc<S3Client>,
    prefix: Option<&Path>,
    offset: Option<&Path>,
) -> BoxStream<'static, Result<ObjectMeta>> {
    list_pages(client, prefix, false, offset)
        .map_ok(|page| futures::stream::iter(page.objects.into_iter().map(Ok)))
        .try_flatten()
        .boxed()
}

/// Resume a `GetObject` body that breaks off partway.
///
/// A dropped connection, or a server ending the body short of the length it
/// promised, fails the stream after the status line already said success.
/// Each failure is followed by a request for just the bytes not yet
/// delivered, with `If-Match` on the original ETag so the continuation comes
/// from the same object version. Without an ETag that cannot be checked, so
/// the error is returned. Consecutive failures without progress share the
/// request retry budget.
fn resume_broken_body(client: Arc<S3Client>, location: Path, mut result: GetResult) -> GetResult {
    let Some(e_tag) = result.meta.e_tag.clone() else {
        return result;
    };
    result.payload = match result.payload {
        GetResultPayload::Stream(body) => GetResultPayload::Stream(resumable(Resume {
            client,
            location,
            e_tag,
            version: result.meta.version.clone(),
            remaining: result.range.clone(),
            body,
            failures: 0,
        })),
        // Never a local file here.
        payload => payload,
    };
    result
}

/// What [`resumable`] needs to re-request the rest of a body.
struct Resume {
    client: Arc<S3Client>,
    location: Path,
    e_tag: String,
    version: Option<String>,
    /// The part of the requested range not yet delivered.
    remaining: std::ops::Range<u64>,
    body: BoxStream<'static, Result<bytes::Bytes>>,
    failures: usize,
}

fn resumable(state: Resume) -> BoxStream<'static, Result<bytes::Bytes>> {
    futures::stream::try_unfold(state, |mut state| async move {
        loop {
            match state.body.next().await {
                None => return Ok(None),
                Some(Ok(bytes)) => {
                    state.remaining.start += bytes.len() as u64;
                    state.failures = 0;
                    return Ok(Some((bytes, state)));
                }
                Some(Err(error)) => {
                    if state.remaining.is_empty() {
                        // Every promised byte arrived; only the end failed.
                        return Ok(None);
                    }
                    state.failures += 1;
                    let config = &state.client.config;
                    if state.failures >= config.max_attempts {
                        return Err(error);
                    }
                    tracing::debug!(
                        location = %state.location,
                        %error,
                        remaining = ?state.remaining,
                        "resuming S3 response body",
                    );
                    tokio::time::sleep(config.backoff(state.failures)).await;
                    let options = GetOptions {
                        range: Some(GetRange::Bounded(state.remaining.clone())),
                        if_match: Some(state.e_tag.clone()),
                        version: state.version.clone(),
                        ..Default::default()
                    };
                    state.body = match state.client.get_opts(&state.location, options).await {
                        Ok(GetResult {
                            payload: GetResultPayload::Stream(body),
                            ..
                        }) => body,
                        // The object changed since the body started: its
                        // remaining bytes are gone, and the read has failed.
                        Err(object_store::Error::Precondition { .. }) => return Err(error),
                        Err(other) => return Err(other),
                        Ok(_) => unreachable!("S3 responses are always streamed"),
                    };
                }
            }
        }
    })
    .boxed()
}

#[async_trait]
impl ObjectStore for S3Store {
    async fn put_opts(
        &self,
        location: &Path,
        payload: PutPayload,
        opts: PutOptions,
    ) -> Result<PutResult> {
        let PutOptions {
            mode,
            tags,
            attributes,
            extensions: _,
        } = opts;
        match mode {
            PutMode::Overwrite => {
                let options = PutRequestOptions::default();
                self.client
                    .put(location, payload, &attributes, &tags, options)
                    .await
            }
            PutMode::Create => {
                let options = PutRequestOptions {
                    if_none_match: Some("*"),
                    ..Default::default()
                };
                match self
                    .client
                    .put(location, payload, &attributes, &tags, options)
                    .await
                {
                    // If-None-Match failures surface as 412 (or 304 from
                    // some implementations); both mean "already there"
                    Err(
                        e @ (object_store::Error::Precondition { .. }
                        | object_store::Error::NotModified { .. }),
                    ) => Err(object_store::Error::AlreadyExists {
                        path: location.to_string(),
                        source: Box::new(e),
                    }),
                    result => result,
                }
            }
            PutMode::Update(version) => {
                let e_tag = version
                    .e_tag
                    .ok_or_else(|| generic_msg("an ETag is required for conditional updates"))?;
                let options = PutRequestOptions {
                    if_match: Some(e_tag.as_str()),
                    retry_on_conflict: true,
                    ..Default::default()
                };
                match self
                    .client
                    .put(location, payload, &attributes, &tags, options)
                    .await
                {
                    // real S3 reports 404 rather than 412 when the object
                    // vanished; normalize to a precondition failure
                    Err(object_store::Error::NotFound { path, source }) => {
                        Err(object_store::Error::Precondition { path, source })
                    }
                    result => result,
                }
            }
        }
    }

    async fn put_multipart_opts(
        &self,
        location: &Path,
        opts: PutMultipartOptions,
    ) -> Result<Box<dyn MultipartUpload>> {
        let PutMultipartOptions {
            tags,
            attributes,
            extensions: _,
        } = opts;
        let upload_id = self
            .client
            .create_multipart(location, &attributes, &tags)
            .await?;
        Ok(Box::new(S3MultipartUpload::new(
            Arc::clone(&self.client),
            location.clone(),
            upload_id,
            attributes,
        )))
    }

    async fn get_opts(&self, location: &Path, options: GetOptions) -> Result<GetResult> {
        let result = self.client.get_opts(location, options).await?;
        Ok(resume_broken_body(
            Arc::clone(&self.client),
            location.clone(),
            result,
        ))
    }

    fn delete_stream(
        &self,
        locations: BoxStream<'static, Result<Path>>,
    ) -> BoxStream<'static, Result<Path>> {
        let client = Arc::clone(&self.client);
        locations
            .map(move |location| {
                let client = Arc::clone(&client);
                async move {
                    let location = location?;
                    client.delete(&location).await?;
                    Ok(location)
                }
            })
            .buffered(10)
            .boxed()
    }

    fn list(&self, prefix: Option<&Path>) -> BoxStream<'static, Result<ObjectMeta>> {
        list_objects(Arc::clone(&self.client), prefix, None)
    }

    fn list_with_offset(
        &self,
        prefix: Option<&Path>,
        offset: &Path,
    ) -> BoxStream<'static, Result<ObjectMeta>> {
        list_objects(Arc::clone(&self.client), prefix, Some(offset))
    }

    async fn list_with_delimiter(&self, prefix: Option<&Path>) -> Result<ListResult> {
        let empty = ListResult {
            common_prefixes: Vec::new(),
            objects: Vec::new(),
            extensions: Default::default(),
        };
        list_pages(Arc::clone(&self.client), prefix, true, None)
            .try_fold(empty, |mut merged, page| async move {
                merged.common_prefixes.extend(page.common_prefixes);
                merged.objects.extend(page.objects);
                Ok(merged)
            })
            .await
    }

    async fn copy_opts(&self, from: &Path, to: &Path, options: CopyOptions) -> Result<()> {
        match options.mode {
            CopyMode::Overwrite => self.client.copy(from, to).await,
            // CopyObject has no atomic "fail if destination exists"
            // precondition; emulating it with HEAD would race
            CopyMode::Create => Err(object_store::Error::NotSupported {
                source: "S3 does not support copy-if-not-exists".into(),
            }),
        }
    }
}

#[cfg(any(test_module_store, test_module_slatedb))]
mod test_server;

#[cfg(test_module_sigv4)]
mod test_sigv4;

#[cfg(test_module_xml)]
mod test_xml;

#[cfg(test_module_store)]
mod test_store;

#[cfg(test_module_slatedb)]
mod test_slatedb;

#[cfg(test_module_chaos3)]
mod test_chaos3;
