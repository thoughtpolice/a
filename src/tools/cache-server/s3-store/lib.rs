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
    CopyMode, CopyOptions, GetOptions, GetResult, ListResult, MultipartUpload, ObjectMeta,
    ObjectStore, PutMode, PutMultipartOptions, PutOptions, PutPayload, PutResult,
};

use crate::client::{PutRequestOptions, S3Client, STORE};
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

/// Paginate `ListObjectsV2` into a flat stream of [`ObjectMeta`].
fn list_stream(
    client: Arc<S3Client>,
    prefix: Option<&Path>,
    offset: Option<&Path>,
) -> BoxStream<'static, Result<ObjectMeta>> {
    let prefix = prefix.map(|p| format!("{}/", p.as_ref()));
    let offset = offset.map(|o| o.as_ref().to_string());

    enum State {
        Start,
        Next(String),
        Done,
    }

    futures::stream::try_unfold(State::Start, move |state| {
        let client = Arc::clone(&client);
        let prefix = prefix.clone();
        let offset = offset.clone();
        async move {
            let token = match &state {
                State::Start => None,
                State::Next(token) => Some(token.as_str()),
                State::Done => return Ok::<_, object_store::Error>(None),
            };
            let page = client
                .list_page(prefix.as_deref(), false, offset.as_deref(), token)
                .await?;
            let next = match page.next_token {
                Some(token) => State::Next(token),
                None => State::Done,
            };
            let objects = futures::stream::iter(page.result.objects.into_iter().map(Ok));
            Ok(Some((objects, next)))
        }
    })
    .try_flatten()
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
                let e_tag = version.e_tag.ok_or_else(|| object_store::Error::Generic {
                    store: STORE,
                    source: "an ETag is required for conditional updates".into(),
                })?;
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
        if !tags.encoded().is_empty() || !attributes.is_empty() {
            return Err(object_store::Error::NotImplemented {
                operation: "put_multipart_opts with tags or attributes".to_string(),
                implementer: self.to_string(),
            });
        }
        let upload_id = self.client.create_multipart(location).await?;
        Ok(Box::new(S3MultipartUpload::new(
            Arc::clone(&self.client),
            location.clone(),
            upload_id,
        )))
    }

    async fn get_opts(&self, location: &Path, options: GetOptions) -> Result<GetResult> {
        self.client.get_opts(location, options).await
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
        list_stream(Arc::clone(&self.client), prefix, None)
    }

    fn list_with_offset(
        &self,
        prefix: Option<&Path>,
        offset: &Path,
    ) -> BoxStream<'static, Result<ObjectMeta>> {
        list_stream(Arc::clone(&self.client), prefix, Some(offset))
    }

    async fn list_with_delimiter(&self, prefix: Option<&Path>) -> Result<ListResult> {
        let prefix = prefix.map(|p| format!("{}/", p.as_ref()));
        let mut merged = ListResult {
            common_prefixes: Vec::new(),
            objects: Vec::new(),
            extensions: Default::default(),
        };
        let mut token: Option<String> = None;
        loop {
            let page = self
                .client
                .list_page(prefix.as_deref(), true, None, token.as_deref())
                .await?;
            merged.common_prefixes.extend(page.result.common_prefixes);
            merged.objects.extend(page.result.objects);
            match page.next_token {
                Some(next) => token = Some(next),
                None => return Ok(merged),
            }
        }
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
