// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! First-party S3 backend for the [`object_store`] API.
//!
//! This crate implements [`ObjectStore`] over [`s3_client`], which talks to
//! the S3 REST API directly through reqwest and signs requests with its own
//! AWS Signature Version 4 implementation. Nothing here links ring or
//! aws-lc-rs, which is the reason this exists instead of the upstream
//! `object_store` `aws` feature. The client retries transient failures,
//! reconciles ambiguous conditional writes and multipart completions, and
//! resumes broken response bodies; this crate maps its types and errors
//! onto `object_store`'s.
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

mod config;
mod multipart;

use async_trait::async_trait;
use futures::stream::BoxStream;
use futures::{StreamExt as _, TryStreamExt as _};
use object_store::path::Path;
use object_store::{
    Attribute, AttributeValue, Attributes, CopyMode, CopyOptions, GetOptions, GetRange, GetResult,
    GetResultPayload, ListResult, MultipartUpload, ObjectMeta, ObjectStore, PutMode,
    PutMultipartOptions, PutOptions, PutPayload, PutResult, TagSet,
};
use s3_client::{
    ByteRange, Client, ErrorKind, ListObjects, ObjectAttributes, ObjectInfo, PutObject,
    PutObjectOutput, WriteCondition,
};

use crate::multipart::S3MultipartUpload;

pub use crate::config::S3StoreBuilder;
pub use s3_client::Credentials;

// Re-exported so callers can name the trait/types without a separate
// dependency edge.
pub use object_store;

type Result<T, E = object_store::Error> = std::result::Result<T, E>;

/// Store name used in [`object_store::Error::Generic`] errors.
const STORE: &str = "S3";

/// An [`ObjectStore`] backed by an S3 (or S3-compatible) bucket.
///
/// Construct with [`S3StoreBuilder`].
#[derive(Debug)]
pub struct S3Store {
    client: Client,
}

impl S3Store {
    pub(crate) fn from_client(client: Client) -> Self {
        Self { client }
    }
}

impl std::fmt::Display for S3Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "S3({})", self.client.bucket())
    }
}

/// The `object_store` error for a failed request about `path`.
pub(crate) fn map_error(path: &str, error: s3_client::Error) -> object_store::Error {
    let path = path.to_string();
    let source = Box::new(error);
    match source.kind() {
        ErrorKind::NotFound => object_store::Error::NotFound { path, source },
        ErrorKind::NotModified => object_store::Error::NotModified { path, source },
        ErrorKind::PreconditionFailed => object_store::Error::Precondition { path, source },
        ErrorKind::Conflict => object_store::Error::AlreadyExists { path, source },
        ErrorKind::PermissionDenied => object_store::Error::PermissionDenied { path, source },
        ErrorKind::Unauthenticated => object_store::Error::Unauthenticated { path, source },
        _ => object_store::Error::Generic {
            store: STORE,
            source,
        },
    }
}

pub(crate) fn generic_msg(message: impl Into<String>) -> object_store::Error {
    object_store::Error::Generic {
        store: STORE,
        source: message.into().into(),
    }
}

/// The client's attributes for `attributes` and `tags`.
pub(crate) fn put_object(
    attributes: &Attributes,
    tags: &TagSet,
    condition: WriteCondition,
) -> Result<PutObject> {
    let mut converted = ObjectAttributes::default();
    for (attribute, value) in attributes {
        let value = value.to_string();
        match attribute {
            Attribute::CacheControl => converted.cache_control = Some(value),
            Attribute::ContentDisposition => converted.content_disposition = Some(value),
            Attribute::ContentEncoding => converted.content_encoding = Some(value),
            Attribute::ContentLanguage => converted.content_language = Some(value),
            Attribute::ContentType => converted.content_type = Some(value),
            Attribute::StorageClass => converted.storage_class = Some(value),
            Attribute::Metadata(key) => {
                converted.metadata.insert(key.to_string(), value);
            }
            other => {
                return Err(object_store::Error::NotSupported {
                    source: format!("unsupported attribute {other:?}").into(),
                });
            }
        }
    }
    Ok(PutObject {
        condition,
        attributes: converted,
        tagging: Some(tags.encoded().to_string()).filter(|t| !t.is_empty()),
    })
}

/// The `object_store` attributes for what a read reported.
fn attributes_of(attributes: ObjectAttributes) -> Attributes {
    let mut converted = Attributes::new();
    let standard = [
        (Attribute::CacheControl, attributes.cache_control),
        (
            Attribute::ContentDisposition,
            attributes.content_disposition,
        ),
        (Attribute::ContentEncoding, attributes.content_encoding),
        (Attribute::ContentLanguage, attributes.content_language),
        (Attribute::ContentType, attributes.content_type),
    ];
    for (attribute, value) in standard {
        if let Some(value) = value {
            converted.insert(attribute, AttributeValue::from(value));
        }
    }
    for (key, value) in attributes.metadata {
        converted.insert(Attribute::Metadata(key.into()), AttributeValue::from(value));
    }
    converted
}

fn meta_of(location: &Path, info: ObjectInfo) -> ObjectMeta {
    ObjectMeta {
        location: location.clone(),
        last_modified: info.last_modified.unwrap_or_default(),
        size: info.size,
        e_tag: info.e_tag,
        version: info.version,
    }
}

pub(crate) fn put_result(output: PutObjectOutput) -> PutResult {
    PutResult {
        e_tag: output.e_tag,
        version: output.version,
        extensions: Default::default(),
    }
}

/// Paginate `ListObjectsV2`, one [`ListResult`] per page.
fn list_pages(
    client: &Client,
    prefix: Option<&Path>,
    delimiter: bool,
    offset: Option<&Path>,
) -> BoxStream<'static, Result<ListResult>> {
    let prefix = prefix.map(|p| format!("{}/", p.as_ref()));
    let error_path = prefix.clone().unwrap_or_default();
    let options = ListObjects {
        prefix,
        delimiter,
        start_after: offset.map(|o| o.as_ref().to_string()),
        continuation_token: None,
    };
    client
        .list_pages(options)
        .map_err(move |e| map_error(&error_path, e))
        .and_then(|page| async move {
            let common_prefixes = page
                .common_prefixes
                .into_iter()
                .map(|p| Ok(Path::parse(p)?))
                .collect::<Result<Vec<_>>>()?;
            let objects = page
                .objects
                .into_iter()
                .map(|info| {
                    let location = Path::parse(&info.key)?;
                    Ok(meta_of(&location, info))
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(ListResult {
                common_prefixes,
                objects,
                extensions: Default::default(),
            })
        })
        .boxed()
}

/// Flatten [`list_pages`] into a stream of [`ObjectMeta`].
fn list_objects(
    client: &Client,
    prefix: Option<&Path>,
    offset: Option<&Path>,
) -> BoxStream<'static, Result<ObjectMeta>> {
    list_pages(client, prefix, false, offset)
        .map_ok(|page| futures::stream::iter(page.objects.into_iter().map(Ok)))
        .try_flatten()
        .boxed()
}

fn byte_range(range: GetRange) -> ByteRange {
    match range {
        GetRange::Bounded(range) => ByteRange::Bounded(range),
        GetRange::Offset(start) => ByteRange::Offset(start),
        GetRange::Suffix(len) => ByteRange::Suffix(len),
    }
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
        let condition = match &mode {
            PutMode::Overwrite => WriteCondition::None,
            PutMode::Create => WriteCondition::Absent,
            PutMode::Update(version) => WriteCondition::Matches(
                version
                    .e_tag
                    .clone()
                    .ok_or_else(|| generic_msg("an ETag is required for conditional updates"))?,
            ),
        };
        let options = put_object(&attributes, &tags, condition)?;
        let result = self
            .client
            .put_object(location.as_ref(), payload.into(), &options)
            .await;
        match result {
            Ok(output) => Ok(put_result(output)),
            // If-None-Match failures surface as 412, or 304 from some
            // implementations, and both mean "already there".
            Err(e)
                if matches!(mode, PutMode::Create)
                    && matches!(
                        e.kind(),
                        ErrorKind::PreconditionFailed | ErrorKind::NotModified
                    ) =>
            {
                Err(object_store::Error::AlreadyExists {
                    path: location.to_string(),
                    source: Box::new(e),
                })
            }
            Err(e) => Err(map_error(location.as_ref(), e)),
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
        let options = put_object(&attributes, &tags, WriteCondition::None)?;
        let upload_id = self
            .client
            .create_multipart_upload(location.as_ref(), &options)
            .await
            .map_err(|e| map_error(location.as_ref(), e))?;
        Ok(Box::new(S3MultipartUpload::new(
            self.client.clone(),
            location.clone(),
            upload_id,
            options.attributes,
        )))
    }

    async fn get_opts(&self, location: &Path, options: GetOptions) -> Result<GetResult> {
        let GetOptions {
            if_match,
            if_none_match,
            if_modified_since,
            if_unmodified_since,
            range,
            version,
            head,
            extensions: _,
        } = options;
        let options = s3_client::GetObject {
            range: range.map(byte_range),
            if_match,
            if_none_match,
            if_modified_since,
            if_unmodified_since,
            version,
        };
        let key = location.as_ref();
        let output = if head {
            self.client.head_object(key, &options).await
        } else {
            self.client.get_object(key, &options).await
        }
        .map_err(|e| map_error(key, e))?;
        let error_path = location.to_string();
        Ok(GetResult {
            meta: meta_of(location, output.info),
            range: output.range,
            attributes: attributes_of(output.attributes),
            payload: GetResultPayload::Stream(
                output
                    .body
                    .map_err(move |e| map_error(&error_path, e))
                    .boxed(),
            ),
            extensions: Default::default(),
        })
    }

    fn delete_stream(
        &self,
        locations: BoxStream<'static, Result<Path>>,
    ) -> BoxStream<'static, Result<Path>> {
        let client = self.client.clone();
        locations
            .map(move |location| {
                let client = client.clone();
                async move {
                    let location = location?;
                    client
                        .delete_object(location.as_ref())
                        .await
                        .map_err(|e| map_error(location.as_ref(), e))?;
                    Ok(location)
                }
            })
            .buffered(10)
            .boxed()
    }

    fn list(&self, prefix: Option<&Path>) -> BoxStream<'static, Result<ObjectMeta>> {
        list_objects(&self.client, prefix, None)
    }

    fn list_with_offset(
        &self,
        prefix: Option<&Path>,
        offset: &Path,
    ) -> BoxStream<'static, Result<ObjectMeta>> {
        list_objects(&self.client, prefix, Some(offset))
    }

    async fn list_with_delimiter(&self, prefix: Option<&Path>) -> Result<ListResult> {
        let empty = ListResult {
            common_prefixes: Vec::new(),
            objects: Vec::new(),
            extensions: Default::default(),
        };
        list_pages(&self.client, prefix, true, None)
            .try_fold(empty, |mut merged, page| async move {
                merged.common_prefixes.extend(page.common_prefixes);
                merged.objects.extend(page.objects);
                Ok(merged)
            })
            .await
    }

    async fn copy_opts(&self, from: &Path, to: &Path, options: CopyOptions) -> Result<()> {
        match options.mode {
            CopyMode::Overwrite => self
                .client
                .copy_object(from.as_ref(), to.as_ref())
                .await
                .map_err(|e| map_error(to.as_ref(), e)),
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

#[cfg(test_module_store)]
mod test_store;

#[cfg(test_module_slatedb)]
mod test_slatedb;

#[cfg(test_module_chaos3)]
mod test_chaos3;
