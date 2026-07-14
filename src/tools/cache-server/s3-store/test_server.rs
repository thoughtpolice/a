// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! An in-memory S3 implementation served over HTTP for integration tests.
//!
//! Built on [`s3s`], which handles the S3 wire protocol: request routing,
//! XML serialization, and — critically — independent AWS SigV4 signature
//! verification via [`SimpleAuth`]. Every request the store client sends in
//! tests therefore has its signature checked by an implementation this crate
//! does not share code with.
//!
//! The behavior modeled here follows real S3 where the client depends on
//! it: conditional puts (`If-None-Match: *`, `If-Match`), conditional gets,
//! byte ranges with `206 Partial Content`, lexicographic `ListObjectsV2`
//! pagination with delimiter roll-up, idempotent deletes, server-side copy,
//! and multipart uploads. A configurable page limit stands in for S3's
//! 1000-key page cap so pagination is exercised with small key counts.

use std::collections::{BTreeMap, HashMap};
use std::ops::Range;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use bytes::Bytes;
use futures::TryStreamExt as _;
use s3s::auth::SimpleAuth;
use s3s::dto;
use s3s::service::S3ServiceBuilder;
use s3s::{S3, S3Error, S3ErrorCode, S3Request, S3Response, S3Result, s3_error};

use crate::sigv4::sha256_hex;

pub(crate) const TEST_ACCESS_KEY: &str = "AKIAIOSFODNN7EXAMPLE";
pub(crate) const TEST_SECRET_KEY: &str = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
pub(crate) const TEST_BUCKET: &str = "test-bucket";
pub(crate) const TEST_REGION: &str = "us-east-1";

#[derive(Debug, Clone)]
struct StoredObject {
    data: Bytes,
    e_tag: dto::ETag,
    last_modified: SystemTime,
    content_type: Option<String>,
    metadata: Option<dto::Metadata>,
}

#[derive(Debug, Default)]
struct State {
    objects: BTreeMap<String, StoredObject>,
    /// upload id -> part number -> (etag, data)
    uploads: HashMap<String, BTreeMap<i32, (dto::ETag, Bytes)>>,
}

/// The in-memory `S3` trait implementation (single implicit bucket).
#[derive(Debug, Default)]
pub(crate) struct InMemoryS3 {
    state: Mutex<State>,
    upload_counter: AtomicU64,
    /// Maximum entries per list page, standing in for S3's 1000-key cap.
    page_limit: usize,
}

fn object_etag(data: &[u8]) -> dto::ETag {
    dto::ETag::Strong(sha256_hex(data)[..32].to_string())
}

/// `If-Match`-style comparison: `*` matches any object, otherwise the
/// condition's ETag must equal the stored one.
fn etag_matches(condition: &dto::ETagCondition, e_tag: &dto::ETag) -> bool {
    match condition {
        dto::ETagCondition::Any => true,
        dto::ETagCondition::ETag(expected) => expected == e_tag,
    }
}

async fn collect_body(body: Option<dto::StreamingBlob>) -> S3Result<Bytes> {
    let Some(body) = body else {
        return Ok(Bytes::new());
    };
    let chunks: Vec<Bytes> = body
        .try_collect()
        .await
        .map_err(|e| s3_error!(InternalError, "failed to read request body: {e}"))?;
    Ok(chunks.concat().into())
}

/// Truncate to whole seconds, the resolution of HTTP conditional dates.
fn truncate_to_seconds(time: SystemTime) -> SystemTime {
    match time.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(d) => SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(d.as_secs()),
        Err(_) => SystemTime::UNIX_EPOCH,
    }
}

impl InMemoryS3 {
    fn new(page_limit: usize) -> Self {
        Self {
            page_limit,
            ..Self::default()
        }
    }
}

#[async_trait::async_trait]
impl S3 for InMemoryS3 {
    async fn put_object(
        &self,
        req: S3Request<dto::PutObjectInput>,
    ) -> S3Result<S3Response<dto::PutObjectOutput>> {
        let input = req.input;
        let data = collect_body(input.body).await?;

        let mut state = self.state.lock().unwrap();
        let existing = state.objects.get(&input.key);
        if let Some(condition) = &input.if_none_match {
            if let Some(object) = existing {
                if etag_matches(condition, &object.e_tag) {
                    return Err(s3_error!(PreconditionFailed, "object already exists"));
                }
            }
        }
        if let Some(condition) = &input.if_match {
            match existing {
                None => return Err(s3_error!(NoSuchKey, "no object to update")),
                Some(object) if !etag_matches(condition, &object.e_tag) => {
                    return Err(s3_error!(PreconditionFailed, "etag mismatch"));
                }
                Some(_) => {}
            }
        }

        let e_tag = object_etag(&data);
        state.objects.insert(
            input.key,
            StoredObject {
                data,
                e_tag: e_tag.clone(),
                last_modified: SystemTime::now(),
                content_type: input.content_type,
                metadata: input.metadata,
            },
        );
        Ok(S3Response::new(dto::PutObjectOutput {
            e_tag: Some(e_tag),
            ..Default::default()
        }))
    }

    async fn get_object(
        &self,
        req: S3Request<dto::GetObjectInput>,
    ) -> S3Result<S3Response<dto::GetObjectOutput>> {
        let input = req.input;
        let state = self.state.lock().unwrap();
        let Some(object) = state.objects.get(&input.key) else {
            return Err(s3_error!(NoSuchKey, "no such key"));
        };

        if let Some(condition) = &input.if_match {
            if !etag_matches(condition, &object.e_tag) {
                return Err(s3_error!(PreconditionFailed, "etag mismatch"));
            }
        }
        if let Some(condition) = &input.if_none_match {
            if etag_matches(condition, &object.e_tag) {
                return Err(S3Error::new(S3ErrorCode::NotModified));
            }
        }
        let http_precision_mtime = dto::Timestamp::from(truncate_to_seconds(object.last_modified));
        if input.if_match.is_none() {
            if let Some(date) = &input.if_unmodified_since {
                if http_precision_mtime > *date {
                    return Err(s3_error!(PreconditionFailed, "object modified"));
                }
            }
        }
        if input.if_none_match.is_none() {
            if let Some(date) = &input.if_modified_since {
                if http_precision_mtime <= *date {
                    return Err(S3Error::new(S3ErrorCode::NotModified));
                }
            }
        }

        let total = object.data.len() as u64;
        let (slice, content_range) = match input.range {
            Some(range) => {
                let bounds: Range<u64> = match range {
                    dto::Range::Int { first, last } => {
                        let end = last.map(|l| (l + 1).min(total)).unwrap_or(total);
                        first..end
                    }
                    dto::Range::Suffix { length } => total.saturating_sub(length)..total,
                };
                if bounds.start >= total || bounds.start >= bounds.end {
                    return Err(s3_error!(InvalidRange, "range out of bounds"));
                }
                let slice = object
                    .data
                    .slice(bounds.start as usize..bounds.end as usize);
                let content_range = format!("bytes {}-{}/{}", bounds.start, bounds.end - 1, total);
                (slice, Some(content_range))
            }
            None => (object.data.clone(), None),
        };

        let output = dto::GetObjectOutput {
            content_length: Some(slice.len() as i64),
            content_range,
            content_type: object.content_type.clone(),
            metadata: object.metadata.clone(),
            e_tag: Some(object.e_tag.clone()),
            last_modified: Some(object.last_modified.into()),
            body: Some(dto::StreamingBlob::wrap(futures::stream::iter([Ok::<
                _,
                std::io::Error,
            >(
                slice
            )]))),
            ..Default::default()
        };
        Ok(S3Response::new(output))
    }

    async fn head_object(
        &self,
        req: S3Request<dto::HeadObjectInput>,
    ) -> S3Result<S3Response<dto::HeadObjectOutput>> {
        let input = req.input;
        let state = self.state.lock().unwrap();
        let Some(object) = state.objects.get(&input.key) else {
            return Err(s3_error!(NoSuchKey, "no such key"));
        };
        Ok(S3Response::new(dto::HeadObjectOutput {
            content_length: Some(object.data.len() as i64),
            content_type: object.content_type.clone(),
            metadata: object.metadata.clone(),
            e_tag: Some(object.e_tag.clone()),
            last_modified: Some(object.last_modified.into()),
            ..Default::default()
        }))
    }

    async fn delete_object(
        &self,
        req: S3Request<dto::DeleteObjectInput>,
    ) -> S3Result<S3Response<dto::DeleteObjectOutput>> {
        // deleting a nonexistent key succeeds, matching S3
        self.state.lock().unwrap().objects.remove(&req.input.key);
        Ok(S3Response::new(dto::DeleteObjectOutput::default()))
    }

    async fn copy_object(
        &self,
        req: S3Request<dto::CopyObjectInput>,
    ) -> S3Result<S3Response<dto::CopyObjectOutput>> {
        let input = req.input;
        let dto::CopySource::Bucket { key, .. } = input.copy_source else {
            return Err(s3_error!(
                NotImplemented,
                "only bucket copy sources are supported"
            ));
        };

        let mut state = self.state.lock().unwrap();
        let Some(source) = state.objects.get(key.as_ref()).cloned() else {
            return Err(s3_error!(NoSuchKey, "no such copy source"));
        };
        let now = SystemTime::now();
        let result = dto::CopyObjectResult {
            e_tag: Some(source.e_tag.clone()),
            last_modified: Some(now.into()),
            ..Default::default()
        };
        state.objects.insert(
            input.key,
            StoredObject {
                last_modified: now,
                ..source
            },
        );
        Ok(S3Response::new(dto::CopyObjectOutput {
            copy_object_result: Some(result),
            ..Default::default()
        }))
    }

    async fn list_objects_v2(
        &self,
        req: S3Request<dto::ListObjectsV2Input>,
    ) -> S3Result<S3Response<dto::ListObjectsV2Output>> {
        let input = req.input;
        let prefix = input.prefix.unwrap_or_default();
        let delimiter = input.delimiter;
        if let Some(delimiter) = &delimiter {
            if delimiter != "/" {
                return Err(s3_error!(
                    NotImplemented,
                    "only the / delimiter is supported"
                ));
            }
        }

        // resume strictly after the continuation token (a raw key) or the
        // caller-provided start-after, whichever is greater
        let bound = [
            input.continuation_token.as_deref(),
            input.start_after.as_deref(),
        ]
        .into_iter()
        .flatten()
        .max()
        .map(str::to_string);

        let state = self.state.lock().unwrap();
        let mut contents = Vec::new();
        let mut common_prefixes: Vec<String> = Vec::new();
        let mut entries = 0usize;
        // the last raw key consumed, including keys hidden under a rolled-up
        // common prefix; becomes the continuation token when the page fills
        let mut last_consumed: Option<&String> = None;
        let mut next_token = None;
        let mut skip_group: Option<String> = None;

        for (key, object) in state.objects.range(prefix.clone()..) {
            if !key.starts_with(&prefix) {
                break;
            }
            if let Some(bound) = &bound {
                if key <= bound {
                    continue;
                }
            }
            // consume the rest of a rolled-up common-prefix group without
            // counting additional entries
            if let Some(group) = &skip_group {
                if key.starts_with(group) {
                    last_consumed = Some(key);
                    continue;
                }
                skip_group = None;
            }
            if entries == self.page_limit {
                next_token = last_consumed.cloned();
                break;
            }

            let rest = &key[prefix.len()..];
            match delimiter.as_ref().and_then(|_| rest.find('/')) {
                Some(pos) => {
                    let group = format!("{prefix}{}", &rest[..pos + 1]);
                    common_prefixes.push(group.clone());
                    skip_group = Some(group);
                }
                None => {
                    contents.push(dto::Object {
                        key: Some(key.clone()),
                        size: Some(object.data.len() as i64),
                        last_modified: Some(object.last_modified.into()),
                        e_tag: Some(object.e_tag.clone()),
                        ..Default::default()
                    });
                }
            }
            entries += 1;
            last_consumed = Some(key);
        }

        let is_truncated = next_token.is_some();
        let output = dto::ListObjectsV2Output {
            contents: Some(contents),
            common_prefixes: Some(
                common_prefixes
                    .into_iter()
                    .map(|prefix| dto::CommonPrefix {
                        prefix: Some(prefix),
                    })
                    .collect(),
            ),
            is_truncated: Some(is_truncated),
            next_continuation_token: next_token,
            ..Default::default()
        };
        Ok(S3Response::new(output))
    }

    async fn create_multipart_upload(
        &self,
        req: S3Request<dto::CreateMultipartUploadInput>,
    ) -> S3Result<S3Response<dto::CreateMultipartUploadOutput>> {
        let id = format!(
            "upload-{}",
            self.upload_counter.fetch_add(1, Ordering::Relaxed)
        );
        self.state
            .lock()
            .unwrap()
            .uploads
            .insert(id.clone(), BTreeMap::new());
        Ok(S3Response::new(dto::CreateMultipartUploadOutput {
            bucket: Some(req.input.bucket),
            key: Some(req.input.key),
            upload_id: Some(id),
            ..Default::default()
        }))
    }

    async fn upload_part(
        &self,
        req: S3Request<dto::UploadPartInput>,
    ) -> S3Result<S3Response<dto::UploadPartOutput>> {
        let input = req.input;
        let data = collect_body(input.body).await?;
        let e_tag = object_etag(&data);

        let mut state = self.state.lock().unwrap();
        let Some(upload) = state.uploads.get_mut(&input.upload_id) else {
            return Err(s3_error!(NoSuchUpload, "no such multipart upload"));
        };
        upload.insert(input.part_number, (e_tag.clone(), data));
        Ok(S3Response::new(dto::UploadPartOutput {
            e_tag: Some(e_tag),
            ..Default::default()
        }))
    }

    async fn complete_multipart_upload(
        &self,
        req: S3Request<dto::CompleteMultipartUploadInput>,
    ) -> S3Result<S3Response<dto::CompleteMultipartUploadOutput>> {
        let input = req.input;
        let requested = input
            .multipart_upload
            .and_then(|u| u.parts)
            .unwrap_or_default();
        if requested.is_empty() {
            return Err(s3_error!(InvalidRequest, "no parts to complete"));
        }

        let mut state = self.state.lock().unwrap();
        let Some(upload) = state.uploads.remove(&input.upload_id) else {
            return Err(s3_error!(NoSuchUpload, "no such multipart upload"));
        };

        let mut data = Vec::new();
        let mut previous_number = 0;
        for part in requested {
            let (Some(number), Some(requested_etag)) = (part.part_number, part.e_tag) else {
                return Err(s3_error!(
                    InvalidRequest,
                    "part number and etag are required"
                ));
            };
            if number <= previous_number {
                return Err(s3_error!(InvalidPartOrder, "parts must be ascending"));
            }
            previous_number = number;
            let Some((stored_etag, part_data)) = upload.get(&number) else {
                return Err(s3_error!(InvalidPart, "part {number} was never uploaded"));
            };
            if stored_etag != &requested_etag {
                return Err(s3_error!(InvalidPart, "etag mismatch for part {number}"));
            }
            data.extend_from_slice(part_data);
        }

        let data = Bytes::from(data);
        let e_tag = dto::ETag::Strong(format!("{}-{previous_number}", &sha256_hex(&data)[..32]));
        state.objects.insert(
            input.key.clone(),
            StoredObject {
                data,
                e_tag: e_tag.clone(),
                last_modified: SystemTime::now(),
                content_type: None,
                metadata: None,
            },
        );
        Ok(S3Response::new(dto::CompleteMultipartUploadOutput {
            bucket: Some(input.bucket),
            key: Some(input.key),
            e_tag: Some(e_tag),
            ..Default::default()
        }))
    }

    async fn abort_multipart_upload(
        &self,
        req: S3Request<dto::AbortMultipartUploadInput>,
    ) -> S3Result<S3Response<dto::AbortMultipartUploadOutput>> {
        let removed = self
            .state
            .lock()
            .unwrap()
            .uploads
            .remove(&req.input.upload_id);
        if removed.is_none() {
            return Err(s3_error!(NoSuchUpload, "no such multipart upload"));
        }
        Ok(S3Response::new(dto::AbortMultipartUploadOutput::default()))
    }
}

/// A running in-memory S3 server.
pub(crate) struct TestServer {
    /// Endpoint base URL, e.g. `http://127.0.0.1:41234`.
    pub endpoint: String,
}

impl TestServer {
    /// Spawn a server with S3's real 1000-entry list page limit.
    pub(crate) async fn spawn() -> Self {
        Self::spawn_with_page_limit(1000).await
    }

    /// Spawn a server that truncates list pages after `page_limit` entries.
    pub(crate) async fn spawn_with_page_limit(page_limit: usize) -> Self {
        let mut builder = S3ServiceBuilder::new(InMemoryS3::new(page_limit));
        builder.set_auth(SimpleAuth::from_single(TEST_ACCESS_KEY, TEST_SECRET_KEY));
        let service = builder.build();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test S3 server");
        let addr = listener
            .local_addr()
            .expect("test server has a local address");

        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let service = service.clone();
                tokio::spawn(async move {
                    let _ = hyper_util::server::conn::auto::Builder::new(
                        hyper_util::rt::TokioExecutor::new(),
                    )
                    .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                    .await;
                });
            }
        });

        Self {
            endpoint: format!("http://{addr}"),
        }
    }

    /// An [`S3Store`](crate::S3Store) wired to this server.
    pub(crate) fn store(&self) -> crate::S3Store {
        crate::S3StoreBuilder::new()
            .with_bucket(TEST_BUCKET)
            .with_region(TEST_REGION)
            .with_endpoint(&self.endpoint)
            .with_credentials(TEST_ACCESS_KEY, TEST_SECRET_KEY)
            .with_allow_http(true)
            .build()
            .expect("test store configuration is valid")
    }
}
