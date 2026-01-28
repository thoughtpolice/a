// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! S3 protocol implementation.
//!
//! This module provides the s3s::S3 trait implementation that translates
//! S3 protocol operations to our abstract [`Store`] interface.

use std::sync::Arc;

use bytes::Bytes;
use futures::stream;
use futures::TryStreamExt;
use s3s::dto::*;
use s3s::s3_error;
use s3s::S3;
use s3s::{S3Request, S3Response, S3Result};

use super::error::StoreError;
use super::traits::{CompletedPart, ListObjectsOptions, ObjectMeta, PutObjectOptions, Store};

/// S3-compatible server implementation.
///
/// This struct implements the `s3s::S3` trait by delegating to an abstract
/// [`Store`] backend. This allows the same S3 protocol implementation to
/// work with different storage backends (memory, Fjall, etc.).
pub struct SmolS3 {
    /// The underlying storage backend.
    store: Arc<dyn Store>,
}

impl SmolS3 {
    /// Create a new S3 server with the given storage backend.
    pub fn new(store: Arc<dyn Store>) -> Self {
        Self { store }
    }
}

/// Convert a StoreError to an S3 error.
fn store_error_to_s3(e: StoreError) -> s3s::S3Error {
    match e {
        StoreError::BucketNotFound(_) => s3_error!(NoSuchBucket),
        StoreError::BucketAlreadyExists(_) => s3_error!(BucketAlreadyExists),
        StoreError::BucketNotEmpty(_) => s3_error!(BucketNotEmpty),
        StoreError::ObjectNotFound { .. } => s3_error!(NoSuchKey),
        StoreError::MultipartNotFound(_) => s3_error!(NoSuchUpload),
        StoreError::InvalidPartNumber(n) => s3_error!(InvalidArgument, "Invalid part number: {}", n),
        StoreError::PartNotFound { part_number, .. } => {
            s3_error!(InvalidPart, "Part {} not found", part_number)
        }
        StoreError::InvalidRange(msg) => s3_error!(InvalidRange, "{}", msg),
        StoreError::PreconditionFailed(msg) => s3_error!(PreconditionFailed, "{}", msg),
        StoreError::ConditionalRequestConflict(msg) => {
            // S3 returns 409 Conflict for concurrent modification during conditional writes
            s3_error!(ConditionalRequestConflict, "{}", msg)
        }
        StoreError::Database(e) => s3_error!(InternalError, "Database error: {}", e),
        StoreError::SlateDb(e) => s3_error!(InternalError, "SlateDB error: {}", e),
        StoreError::Internal(msg) => s3_error!(InternalError, "{}", msg),
    }
}

/// Format content range header value.
fn fmt_content_range(start: u64, end_inclusive: u64, size: u64) -> String {
    format!("bytes {start}-{end_inclusive}/{size}")
}

/// Convert s3s input fields to our ObjectMeta.
fn input_to_object_meta(
    content_type: Option<String>,
    content_encoding: Option<String>,
    content_disposition: Option<String>,
    content_language: Option<String>,
    cache_control: Option<String>,
    metadata: Option<Metadata>,
) -> ObjectMeta {
    ObjectMeta {
        content_type,
        content_encoding,
        content_disposition,
        content_language,
        cache_control,
        user_metadata: metadata,
        ..Default::default()
    }
}

#[async_trait::async_trait]
impl S3 for SmolS3 {
    // =========================================================================
    // Bucket operations
    // =========================================================================

    #[tracing::instrument(skip(self))]
    async fn create_bucket(
        &self,
        req: S3Request<CreateBucketInput>,
    ) -> S3Result<S3Response<CreateBucketOutput>> {
        let input = req.input;

        self.store
            .create_bucket(&input.bucket)
            .await
            .map_err(store_error_to_s3)?;

        let output = CreateBucketOutput::default();
        Ok(S3Response::new(output))
    }

    #[tracing::instrument(skip(self))]
    async fn delete_bucket(
        &self,
        req: S3Request<DeleteBucketInput>,
    ) -> S3Result<S3Response<DeleteBucketOutput>> {
        let input = req.input;

        self.store
            .delete_bucket(&input.bucket)
            .await
            .map_err(store_error_to_s3)?;

        Ok(S3Response::new(DeleteBucketOutput {}))
    }

    #[tracing::instrument(skip(self))]
    async fn head_bucket(
        &self,
        req: S3Request<HeadBucketInput>,
    ) -> S3Result<S3Response<HeadBucketOutput>> {
        let input = req.input;

        let exists = self
            .store
            .bucket_exists(&input.bucket)
            .await
            .map_err(store_error_to_s3)?;

        if !exists {
            return Err(s3_error!(NoSuchBucket));
        }

        Ok(S3Response::new(HeadBucketOutput::default()))
    }

    #[tracing::instrument(skip(self))]
    async fn list_buckets(
        &self,
        _req: S3Request<ListBucketsInput>,
    ) -> S3Result<S3Response<ListBucketsOutput>> {
        let bucket_infos = self.store.list_buckets().await.map_err(store_error_to_s3)?;

        let buckets: Vec<Bucket> = bucket_infos
            .into_iter()
            .map(|b| Bucket {
                name: Some(b.name),
                creation_date: Some(Timestamp::from(b.created_at)),
                bucket_region: None,
            })
            .collect();

        let output = ListBucketsOutput {
            buckets: Some(buckets),
            owner: None,
            ..Default::default()
        };
        Ok(S3Response::new(output))
    }

    #[tracing::instrument(skip(self))]
    async fn get_bucket_location(
        &self,
        req: S3Request<GetBucketLocationInput>,
    ) -> S3Result<S3Response<GetBucketLocationOutput>> {
        let input = req.input;

        let exists = self
            .store
            .bucket_exists(&input.bucket)
            .await
            .map_err(store_error_to_s3)?;

        if !exists {
            return Err(s3_error!(NoSuchBucket));
        }

        let output = GetBucketLocationOutput::default();
        Ok(S3Response::new(output))
    }

    // =========================================================================
    // Object operations
    // =========================================================================

    #[tracing::instrument(skip(self))]
    async fn get_object(
        &self,
        req: S3Request<GetObjectInput>,
    ) -> S3Result<S3Response<GetObjectOutput>> {
        let input = req.input;

        let obj = self
            .store
            .get_object(&input.bucket, &input.key)
            .await
            .map_err(store_error_to_s3)?;

        let file_len = obj.meta.size;
        let last_modified = Timestamp::from(obj.meta.last_modified);

        let (data, content_length, content_range) = match input.range {
            None => (obj.data, file_len, None),
            Some(range) => {
                let file_range = range.check(file_len)?;
                let start = file_range.start;
                let end = file_range.end;
                let content_length = end - start;
                let content_range = fmt_content_range(start, end - 1, file_len);

                let range_data = self
                    .store
                    .get_object_range(&input.bucket, &input.key, start..end)
                    .await
                    .map_err(store_error_to_s3)?;

                (range_data, content_length, Some(content_range))
            }
        };

        let content_length_i64 =
            i64::try_from(content_length).map_err(|_| s3_error!(InternalError))?;

        // Create a streaming blob from bytes
        let body_stream = stream::once(async move { Ok::<_, std::io::Error>(data) });
        let body = StreamingBlob::wrap(body_stream);

        let output = GetObjectOutput {
            body: Some(body),
            content_length: Some(content_length_i64),
            content_range,
            last_modified: Some(last_modified),
            metadata: obj.meta.user_metadata.clone(),
            content_encoding: obj.meta.content_encoding,
            content_type: obj.meta.content_type,
            content_disposition: obj.meta.content_disposition,
            content_language: obj.meta.content_language,
            cache_control: obj.meta.cache_control,
            e_tag: Some(ETag::Strong(obj.meta.etag)),
            ..Default::default()
        };
        Ok(S3Response::new(output))
    }

    #[tracing::instrument(skip(self))]
    async fn put_object(
        &self,
        req: S3Request<PutObjectInput>,
    ) -> S3Result<S3Response<PutObjectOutput>> {
        let input = req.input;

        let body = input.body.ok_or_else(|| s3_error!(IncompleteBody))?;

        // Collect the body stream into bytes
        let data: Bytes = body
            .try_collect::<Vec<Bytes>>()
            .await
            .map_err(|e| s3_error!(InternalError, "Failed to read body: {}", e))?
            .into_iter()
            .fold(Vec::new(), |mut acc, chunk| {
                acc.extend_from_slice(&chunk);
                acc
            })
            .into();

        let meta = input_to_object_meta(
            input.content_type,
            input.content_encoding,
            input.content_disposition,
            input.content_language,
            input.cache_control,
            input.metadata,
        );

        // Handle conditional write headers
        // S3 uses ETagCondition which can be Strong or Weak etags
        let if_none_match = match &input.if_none_match {
            Some(ETagCondition::Any) => true,
            _ => false,
        };
        let if_match = input.if_match.as_ref().map(|etag| match etag {
            ETagCondition::Any => "*".to_string(),
            ETagCondition::ETag(ETag::Strong(s) | ETag::Weak(s)) => s.clone(),
        });

        let options = PutObjectOptions {
            if_none_match,
            if_match,
        };

        let result = self
            .store
            .put_object(&input.bucket, &input.key, data, meta, options)
            .await
            .map_err(store_error_to_s3)?;

        let output = PutObjectOutput {
            e_tag: Some(ETag::Strong(result.etag)),
            ..Default::default()
        };
        Ok(S3Response::new(output))
    }

    #[tracing::instrument(skip(self))]
    async fn delete_object(
        &self,
        req: S3Request<DeleteObjectInput>,
    ) -> S3Result<S3Response<DeleteObjectOutput>> {
        let input = req.input;

        self.store
            .delete_object(&input.bucket, &input.key)
            .await
            .map_err(store_error_to_s3)?;

        let output = DeleteObjectOutput::default();
        Ok(S3Response::new(output))
    }

    #[tracing::instrument(skip(self))]
    async fn delete_objects(
        &self,
        req: S3Request<DeleteObjectsInput>,
    ) -> S3Result<S3Response<DeleteObjectsOutput>> {
        let input = req.input;

        let mut deleted_objects: Vec<DeletedObject> = Vec::new();

        for object in input.delete.objects {
            // S3 delete is idempotent - we don't error on missing objects
            let _ = self.store.delete_object(&input.bucket, &object.key).await;

            let deleted_object = DeletedObject {
                key: Some(object.key),
                ..Default::default()
            };
            deleted_objects.push(deleted_object);
        }

        let output = DeleteObjectsOutput {
            deleted: Some(deleted_objects),
            ..Default::default()
        };
        Ok(S3Response::new(output))
    }

    #[tracing::instrument(skip(self))]
    async fn head_object(
        &self,
        req: S3Request<HeadObjectInput>,
    ) -> S3Result<S3Response<HeadObjectOutput>> {
        let input = req.input;

        let meta = self
            .store
            .head_object(&input.bucket, &input.key)
            .await
            .map_err(store_error_to_s3)?;

        let content_length =
            i64::try_from(meta.size).map_err(|_| s3_error!(InternalError, "Size overflow"))?;

        let output = HeadObjectOutput {
            content_length: Some(content_length),
            content_type: meta.content_type,
            content_encoding: meta.content_encoding,
            content_disposition: meta.content_disposition,
            content_language: meta.content_language,
            cache_control: meta.cache_control,
            last_modified: Some(Timestamp::from(meta.last_modified)),
            metadata: meta.user_metadata,
            e_tag: Some(ETag::Strong(meta.etag)),
            ..Default::default()
        };
        Ok(S3Response::new(output))
    }

    #[tracing::instrument(skip(self))]
    async fn copy_object(
        &self,
        req: S3Request<CopyObjectInput>,
    ) -> S3Result<S3Response<CopyObjectOutput>> {
        let input = req.input;

        let (src_bucket, src_key) = match &input.copy_source {
            CopySource::AccessPoint { .. } => return Err(s3_error!(NotImplemented)),
            CopySource::Bucket { bucket, key, .. } => (bucket.as_ref(), key.as_ref()),
        };

        let result = self
            .store
            .copy_object(src_bucket, src_key, &input.bucket, &input.key)
            .await
            .map_err(store_error_to_s3)?;

        let copy_object_result = CopyObjectResult {
            e_tag: Some(ETag::Strong(result.etag)),
            last_modified: Some(Timestamp::from(result.last_modified)),
            ..Default::default()
        };

        let output = CopyObjectOutput {
            copy_object_result: Some(copy_object_result),
            ..Default::default()
        };
        Ok(S3Response::new(output))
    }

    // =========================================================================
    // List operations
    // =========================================================================

    #[tracing::instrument(skip(self))]
    async fn list_objects(
        &self,
        req: S3Request<ListObjectsInput>,
    ) -> S3Result<S3Response<ListObjectsOutput>> {
        // Delegate to list_objects_v2 and convert the output
        let v2_resp = self.list_objects_v2(req.map_input(Into::into)).await?;

        Ok(v2_resp.map_output(|v2| ListObjectsOutput {
            contents: v2.contents,
            common_prefixes: v2.common_prefixes,
            delimiter: v2.delimiter,
            encoding_type: v2.encoding_type,
            name: v2.name,
            prefix: v2.prefix,
            max_keys: v2.max_keys,
            is_truncated: v2.is_truncated,
            ..Default::default()
        }))
    }

    #[tracing::instrument(skip(self))]
    async fn list_objects_v2(
        &self,
        req: S3Request<ListObjectsV2Input>,
    ) -> S3Result<S3Response<ListObjectsV2Output>> {
        let input = req.input;

        let max_keys = input.max_keys.unwrap_or(1000);

        let options = ListObjectsOptions {
            prefix: input.prefix.clone(),
            delimiter: input.delimiter.clone(),
            start_after: input.start_after.clone(),
            max_keys: max_keys as u32,
            continuation_token: input.continuation_token.clone(),
        };

        let result = self
            .store
            .list_objects(&input.bucket, options)
            .await
            .map_err(store_error_to_s3)?;

        let contents: Vec<Object> = result
            .objects
            .into_iter()
            .map(|e| Object {
                key: Some(e.key),
                last_modified: Some(Timestamp::from(e.last_modified)),
                size: Some(e.size as i64),
                e_tag: Some(ETag::Strong(e.etag)),
                ..Default::default()
            })
            .collect();

        let common_prefixes: Vec<CommonPrefix> = result
            .common_prefixes
            .into_iter()
            .map(|p| CommonPrefix {
                prefix: Some(p.prefix),
            })
            .collect();

        let key_count =
            i32::try_from(result.key_count).map_err(|_| s3_error!(InternalError, "Count overflow"))?;

        let output = ListObjectsV2Output {
            key_count: Some(key_count),
            max_keys: Some(max_keys),
            is_truncated: Some(result.is_truncated),
            contents: if contents.is_empty() {
                None
            } else {
                Some(contents)
            },
            common_prefixes: if common_prefixes.is_empty() {
                None
            } else {
                Some(common_prefixes)
            },
            delimiter: input.delimiter,
            encoding_type: input.encoding_type,
            name: Some(input.bucket),
            prefix: input.prefix,
            next_continuation_token: result.next_continuation_token,
            ..Default::default()
        };
        Ok(S3Response::new(output))
    }

    // =========================================================================
    // Multipart upload operations
    // =========================================================================

    #[tracing::instrument(skip(self))]
    async fn create_multipart_upload(
        &self,
        req: S3Request<CreateMultipartUploadInput>,
    ) -> S3Result<S3Response<CreateMultipartUploadOutput>> {
        let input = req.input;

        let meta = input_to_object_meta(
            input.content_type,
            input.content_encoding,
            input.content_disposition,
            input.content_language,
            input.cache_control,
            input.metadata,
        );

        let upload_id = self
            .store
            .create_multipart_upload(&input.bucket, &input.key, meta)
            .await
            .map_err(store_error_to_s3)?;

        let output = CreateMultipartUploadOutput {
            bucket: Some(input.bucket),
            key: Some(input.key),
            upload_id: Some(upload_id),
            ..Default::default()
        };

        Ok(S3Response::new(output))
    }

    #[tracing::instrument(skip(self))]
    async fn upload_part(
        &self,
        req: S3Request<UploadPartInput>,
    ) -> S3Result<S3Response<UploadPartOutput>> {
        let input = req.input;

        let body = input.body.ok_or_else(|| s3_error!(IncompleteBody))?;

        // Collect the body stream into bytes
        let data: Bytes = body
            .try_collect::<Vec<Bytes>>()
            .await
            .map_err(|e| s3_error!(InternalError, "Failed to read body: {}", e))?
            .into_iter()
            .fold(Vec::new(), |mut acc, chunk| {
                acc.extend_from_slice(&chunk);
                acc
            })
            .into();

        let part_info = self
            .store
            .upload_part(&input.bucket, &input.upload_id, input.part_number, data)
            .await
            .map_err(store_error_to_s3)?;

        let output = UploadPartOutput {
            e_tag: Some(ETag::Strong(part_info.etag)),
            ..Default::default()
        };
        Ok(S3Response::new(output))
    }

    #[tracing::instrument(skip(self))]
    async fn complete_multipart_upload(
        &self,
        req: S3Request<CompleteMultipartUploadInput>,
    ) -> S3Result<S3Response<CompleteMultipartUploadOutput>> {
        let input = req.input;

        let multipart_upload = input
            .multipart_upload
            .ok_or_else(|| s3_error!(InvalidPart))?;

        let parts: Vec<CompletedPart> = multipart_upload
            .parts
            .unwrap_or_default()
            .into_iter()
            .map(|p| CompletedPart {
                part_number: p.part_number.unwrap_or(0),
                etag: p
                    .e_tag
                    .map(|e| match e {
                        ETag::Strong(s) | ETag::Weak(s) => s,
                    })
                    .unwrap_or_default(),
            })
            .collect();

        let result = self
            .store
            .complete_multipart_upload(&input.bucket, &input.key, &input.upload_id, &parts)
            .await
            .map_err(store_error_to_s3)?;

        let output = CompleteMultipartUploadOutput {
            bucket: Some(input.bucket),
            key: Some(input.key),
            e_tag: Some(ETag::Strong(result.etag)),
            ..Default::default()
        };

        Ok(S3Response::new(output))
    }

    #[tracing::instrument(skip(self))]
    async fn abort_multipart_upload(
        &self,
        req: S3Request<AbortMultipartUploadInput>,
    ) -> S3Result<S3Response<AbortMultipartUploadOutput>> {
        let input = req.input;

        self.store
            .abort_multipart_upload(&input.bucket, &input.upload_id)
            .await
            .map_err(store_error_to_s3)?;

        Ok(S3Response::new(AbortMultipartUploadOutput {
            ..Default::default()
        }))
    }

    #[tracing::instrument(skip(self))]
    async fn list_parts(
        &self,
        req: S3Request<ListPartsInput>,
    ) -> S3Result<S3Response<ListPartsOutput>> {
        let input = req.input;

        let part_infos = self
            .store
            .list_parts(&input.bucket, &input.upload_id)
            .await
            .map_err(store_error_to_s3)?;

        let parts: Vec<Part> = part_infos
            .into_iter()
            .map(|p| Part {
                part_number: Some(p.part_number),
                last_modified: Some(Timestamp::from(p.last_modified)),
                size: Some(p.size as i64),
                e_tag: Some(ETag::Strong(p.etag)),
                ..Default::default()
            })
            .collect();

        let output = ListPartsOutput {
            bucket: Some(input.bucket),
            key: Some(input.key),
            upload_id: Some(input.upload_id),
            parts: Some(parts),
            ..Default::default()
        };
        Ok(S3Response::new(output))
    }

    #[tracing::instrument(skip(self))]
    async fn list_multipart_uploads(
        &self,
        req: S3Request<ListMultipartUploadsInput>,
    ) -> S3Result<S3Response<ListMultipartUploadsOutput>> {
        let input = req.input;

        let upload_infos = self
            .store
            .list_multipart_uploads(&input.bucket)
            .await
            .map_err(store_error_to_s3)?;

        let uploads: Vec<MultipartUpload> = upload_infos
            .into_iter()
            .map(|u| MultipartUpload {
                upload_id: Some(u.upload_id),
                key: Some(u.key),
                initiated: Some(Timestamp::from(u.initiated)),
                ..Default::default()
            })
            .collect();

        let output = ListMultipartUploadsOutput {
            bucket: Some(input.bucket),
            uploads: Some(uploads),
            ..Default::default()
        };
        Ok(S3Response::new(output))
    }
}
