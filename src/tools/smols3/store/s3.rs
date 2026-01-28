// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! S3 protocol implementation.
//!
//! This module provides the s3s::S3 trait implementation that translates
//! S3 protocol operations to our abstract [`Store`] interface.

use std::sync::Arc;

use s3s::dto::*;
use s3s::S3;
use s3s::{S3Request, S3Response, S3Result};

use super::traits::Store;

/// S3-compatible server implementation.
///
/// This struct implements the `s3s::S3` trait by delegating to an abstract
/// [`Store`] backend. This allows the same S3 protocol implementation to
/// work with different storage backends (memory, Fjall, etc.).
pub struct SmolS3 {
    /// The underlying storage backend.
    #[allow(dead_code)]
    store: Arc<dyn Store>,
}

impl SmolS3 {
    /// Create a new S3 server with the given storage backend.
    pub fn new(store: Arc<dyn Store>) -> Self {
        Self { store }
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
        _req: S3Request<CreateBucketInput>,
    ) -> S3Result<S3Response<CreateBucketOutput>> {
        todo!("SmolS3::create_bucket")
    }

    #[tracing::instrument(skip(self))]
    async fn delete_bucket(
        &self,
        _req: S3Request<DeleteBucketInput>,
    ) -> S3Result<S3Response<DeleteBucketOutput>> {
        todo!("SmolS3::delete_bucket")
    }

    #[tracing::instrument(skip(self))]
    async fn head_bucket(
        &self,
        _req: S3Request<HeadBucketInput>,
    ) -> S3Result<S3Response<HeadBucketOutput>> {
        todo!("SmolS3::head_bucket")
    }

    #[tracing::instrument(skip(self))]
    async fn list_buckets(
        &self,
        _req: S3Request<ListBucketsInput>,
    ) -> S3Result<S3Response<ListBucketsOutput>> {
        todo!("SmolS3::list_buckets")
    }

    #[tracing::instrument(skip(self))]
    async fn get_bucket_location(
        &self,
        _req: S3Request<GetBucketLocationInput>,
    ) -> S3Result<S3Response<GetBucketLocationOutput>> {
        todo!("SmolS3::get_bucket_location")
    }

    // =========================================================================
    // Object operations
    // =========================================================================

    #[tracing::instrument(skip(self))]
    async fn get_object(
        &self,
        _req: S3Request<GetObjectInput>,
    ) -> S3Result<S3Response<GetObjectOutput>> {
        todo!("SmolS3::get_object")
    }

    #[tracing::instrument(skip(self))]
    async fn put_object(
        &self,
        _req: S3Request<PutObjectInput>,
    ) -> S3Result<S3Response<PutObjectOutput>> {
        todo!("SmolS3::put_object")
    }

    #[tracing::instrument(skip(self))]
    async fn delete_object(
        &self,
        _req: S3Request<DeleteObjectInput>,
    ) -> S3Result<S3Response<DeleteObjectOutput>> {
        todo!("SmolS3::delete_object")
    }

    #[tracing::instrument(skip(self))]
    async fn delete_objects(
        &self,
        _req: S3Request<DeleteObjectsInput>,
    ) -> S3Result<S3Response<DeleteObjectsOutput>> {
        todo!("SmolS3::delete_objects")
    }

    #[tracing::instrument(skip(self))]
    async fn head_object(
        &self,
        _req: S3Request<HeadObjectInput>,
    ) -> S3Result<S3Response<HeadObjectOutput>> {
        todo!("SmolS3::head_object")
    }

    #[tracing::instrument(skip(self))]
    async fn copy_object(
        &self,
        _req: S3Request<CopyObjectInput>,
    ) -> S3Result<S3Response<CopyObjectOutput>> {
        todo!("SmolS3::copy_object")
    }

    // =========================================================================
    // List operations
    // =========================================================================

    #[tracing::instrument(skip(self))]
    async fn list_objects(
        &self,
        _req: S3Request<ListObjectsInput>,
    ) -> S3Result<S3Response<ListObjectsOutput>> {
        todo!("SmolS3::list_objects")
    }

    #[tracing::instrument(skip(self))]
    async fn list_objects_v2(
        &self,
        _req: S3Request<ListObjectsV2Input>,
    ) -> S3Result<S3Response<ListObjectsV2Output>> {
        todo!("SmolS3::list_objects_v2")
    }

    // =========================================================================
    // Multipart upload operations
    // =========================================================================

    #[tracing::instrument(skip(self))]
    async fn create_multipart_upload(
        &self,
        _req: S3Request<CreateMultipartUploadInput>,
    ) -> S3Result<S3Response<CreateMultipartUploadOutput>> {
        todo!("SmolS3::create_multipart_upload")
    }

    #[tracing::instrument(skip(self))]
    async fn upload_part(
        &self,
        _req: S3Request<UploadPartInput>,
    ) -> S3Result<S3Response<UploadPartOutput>> {
        todo!("SmolS3::upload_part")
    }

    #[tracing::instrument(skip(self))]
    async fn complete_multipart_upload(
        &self,
        _req: S3Request<CompleteMultipartUploadInput>,
    ) -> S3Result<S3Response<CompleteMultipartUploadOutput>> {
        todo!("SmolS3::complete_multipart_upload")
    }

    #[tracing::instrument(skip(self))]
    async fn abort_multipart_upload(
        &self,
        _req: S3Request<AbortMultipartUploadInput>,
    ) -> S3Result<S3Response<AbortMultipartUploadOutput>> {
        todo!("SmolS3::abort_multipart_upload")
    }

    #[tracing::instrument(skip(self))]
    async fn list_parts(
        &self,
        _req: S3Request<ListPartsInput>,
    ) -> S3Result<S3Response<ListPartsOutput>> {
        todo!("SmolS3::list_parts")
    }

    #[tracing::instrument(skip(self))]
    async fn list_multipart_uploads(
        &self,
        _req: S3Request<ListMultipartUploadsInput>,
    ) -> S3Result<S3Response<ListMultipartUploadsOutput>> {
        todo!("SmolS3::list_multipart_uploads")
    }
}
