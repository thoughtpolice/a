// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The `s3s` protocol adapter, mapping each S3 operation onto the store.
//!
//! `s3s` generates a separate input type per operation, and related operations
//! name their shared fields identically. The macros below read those fields
//! from whichever input they are handed, so each header is listed once.

use std::collections::BTreeMap;
use std::ops::Bound;

use bytes::{Bytes, BytesMut};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use s3s::dto::*;
use s3s::{S3, S3Request, S3Response, S3Result};

use crate::memory::{
    ChecksumAlgorithm, MIN_PART_SIZE, MemoryS3, MultipartUploadState, ObjectAttributes,
    ReadConditions, StoredObject, StoredPart, check_copy_source_conditions, check_write_conditions,
    collect_body, entity_tag, get_bucket, get_bucket_mut, get_object, get_upload, get_upload_mut,
    md5_digest, now, verify_body_checksums,
};

/// Take the attributes out of a `PutObjectInput`, `CopyObjectInput` or
/// `CreateMultipartUploadInput`.
macro_rules! object_attributes {
    ($input:expr) => {
        ObjectAttributes {
            metadata: $input.metadata,
            cache_control: $input.cache_control,
            content_disposition: $input.content_disposition,
            content_encoding: $input.content_encoding,
            content_language: $input.content_language,
            content_type: $input.content_type,
            expires: $input.expires,
        }
    };
}

/// Echo stored attributes in a `GetObjectOutput` or `HeadObjectOutput`, whose
/// other fields keep their defaults.
macro_rules! attributes_output {
    ($output:ident, $attributes:expr) => {{
        let attributes = $attributes;
        $output {
            cache_control: attributes.cache_control,
            content_disposition: attributes.content_disposition,
            content_encoding: attributes.content_encoding,
            content_language: attributes.content_language,
            content_type: attributes.content_type,
            expires: attributes.expires,
            metadata: attributes.metadata,
            ..Default::default()
        }
    }};
}

#[derive(Clone, Copy)]
enum ListEntry<'a> {
    Object(&'a str, &'a StoredObject),
    CommonPrefix(&'a str),
}

impl<'a> ListEntry<'a> {
    fn name(self) -> &'a str {
        match self {
            Self::Object(key, _) => key,
            Self::CommonPrefix(prefix) => prefix,
        }
    }
}

const URL_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// The integrity headers on a `PutObjectInput` or `UploadPartInput`, with the
/// value the client declared for each.
///
/// Amazon S3 verifies whichever of these are present and answers `BadDigest`
/// when a value does not match the body it received. `s3s` parses the headers
/// but performs no verification, so the store enforces them. Content-MD5 and
/// x-amz-checksum-md5 are both the Base64 MD5 of the body.
macro_rules! declared_checksums {
    ($input:expr) => {
        [
            (
                "Content-MD5",
                $input.content_md5.as_deref(),
                ChecksumAlgorithm::Md5,
            ),
            (
                "x-amz-checksum-md5",
                $input.checksum_md5.as_deref(),
                ChecksumAlgorithm::Md5,
            ),
            (
                "x-amz-checksum-crc32",
                $input.checksum_crc32.as_deref(),
                ChecksumAlgorithm::Crc32,
            ),
            (
                "x-amz-checksum-crc32c",
                $input.checksum_crc32c.as_deref(),
                ChecksumAlgorithm::Crc32c,
            ),
            (
                "x-amz-checksum-crc64nvme",
                $input.checksum_crc64nvme.as_deref(),
                ChecksumAlgorithm::Crc64Nvme,
            ),
            (
                "x-amz-checksum-sha1",
                $input.checksum_sha1.as_deref(),
                ChecksumAlgorithm::Sha1,
            ),
            (
                "x-amz-checksum-sha256",
                $input.checksum_sha256.as_deref(),
                ChecksumAlgorithm::Sha256,
            ),
            (
                "x-amz-checksum-sha512",
                $input.checksum_sha512.as_deref(),
                ChecksumAlgorithm::Sha512,
            ),
            (
                "x-amz-checksum-xxhash64",
                $input.checksum_xxhash64.as_deref(),
                ChecksumAlgorithm::XxHash64,
            ),
            (
                "x-amz-checksum-xxhash3",
                $input.checksum_xxhash3.as_deref(),
                ChecksumAlgorithm::XxHash3,
            ),
            (
                "x-amz-checksum-xxhash128",
                $input.checksum_xxhash128.as_deref(),
                ChecksumAlgorithm::XxHash128,
            ),
        ]
    };
}

macro_rules! read_conditions {
    ($input:expr) => {
        ReadConditions {
            if_match: $input.if_match.as_ref(),
            if_none_match: $input.if_none_match.as_ref(),
            if_modified_since: $input.if_modified_since.as_ref(),
            if_unmodified_since: $input.if_unmodified_since.as_ref(),
        }
    };
}

#[async_trait::async_trait]
impl S3 for MemoryS3 {
    async fn create_bucket(
        &self,
        req: S3Request<CreateBucketInput>,
    ) -> S3Result<S3Response<CreateBucketOutput>> {
        let _visit = self
            .faults
            .before(&self.faults.create_bucket_before)
            .await?;
        // us-east-1 treats re-creating a bucket you already own as a success and
        // leaves its contents intact, unlike the 409 other regions return.
        self.add_bucket(req.input.bucket.clone());
        Ok(S3Response::new(CreateBucketOutput {
            location: Some(format!("/{}", req.input.bucket)),
            ..Default::default()
        }))
    }

    async fn delete_bucket(
        &self,
        req: S3Request<DeleteBucketInput>,
    ) -> S3Result<S3Response<DeleteBucketOutput>> {
        let _visit = self
            .faults
            .before(&self.faults.delete_bucket_before)
            .await?;
        let mut state = self.write()?;
        let bucket = get_bucket(&state, &req.input.bucket)?;
        if !bucket.objects.is_empty() {
            return Err(s3s::s3_error!(BucketNotEmpty, "the bucket is not empty"));
        }
        state.buckets.remove(&req.input.bucket);
        state
            .uploads
            .retain(|_, upload| upload.bucket != req.input.bucket);
        Ok(S3Response::new(DeleteBucketOutput::default()))
    }

    async fn head_bucket(
        &self,
        req: S3Request<HeadBucketInput>,
    ) -> S3Result<S3Response<HeadBucketOutput>> {
        let _visit = self.faults.before(&self.faults.head_bucket_before).await?;
        let state = self.read()?;
        get_bucket(&state, &req.input.bucket)?;
        Ok(S3Response::new(HeadBucketOutput {
            bucket_region: Some("us-east-1".to_owned()),
            ..Default::default()
        }))
    }

    async fn list_buckets(
        &self,
        req: S3Request<ListBucketsInput>,
    ) -> S3Result<S3Response<ListBucketsOutput>> {
        let _visit = self.faults.before(&self.faults.list_buckets_before).await?;
        let state = self.read()?;
        let prefix = req.input.prefix.as_deref().unwrap_or_default();
        let marker = req.input.continuation_token.as_deref().unwrap_or_default();
        let max = req.input.max_buckets.unwrap_or(10_000);
        if !(1..=10_000).contains(&max) {
            return Err(s3s::s3_error!(
                InvalidArgument,
                "max-buckets must be between 1 and 10000"
            ));
        }
        let mut matching = state
            .buckets
            .iter()
            .filter(|(name, _)| name.starts_with(prefix) && name.as_str() > marker);
        let buckets: Vec<_> = matching
            .by_ref()
            .take(max as usize)
            .map(|(name, bucket)| Bucket {
                name: Some(name.clone()),
                creation_date: Some(bucket.created_at.clone()),
                ..Default::default()
            })
            .collect();
        let continuation_token = matching.next().and_then(|_| buckets.last()?.name.clone());
        Ok(S3Response::new(ListBucketsOutput {
            buckets: Some(buckets),
            continuation_token,
            prefix: req.input.prefix,
            ..Default::default()
        }))
    }

    async fn put_object(
        &self,
        req: S3Request<PutObjectInput>,
    ) -> S3Result<S3Response<PutObjectOutput>> {
        let visit = self.faults.before(&self.faults.put_object_before).await?;
        let mut input = req.input;
        let body = collect_body(input.body.take()).await?;
        verify_body_checksums(&body, &declared_checksums!(input))?;
        let e_tag = entity_tag(md5_digest(&body));
        let object = StoredObject {
            body,
            e_tag: e_tag.clone(),
            last_modified: now(),
            attributes: object_attributes!(input),
        };
        {
            let mut state = self.write()?;
            let bucket = get_bucket_mut(&mut state, &input.bucket)?;
            check_write_conditions(
                bucket.objects.get(&input.key),
                input.if_match.as_ref(),
                input.if_none_match.as_ref(),
            )?;
            bucket.objects.insert(input.key, object);
        }
        self.faults
            .after_commit(&self.faults.put_object_after_commit, visit.as_ref())
            .await?;
        Ok(S3Response::new(PutObjectOutput {
            e_tag: Some(e_tag),
            ..Default::default()
        }))
    }

    async fn get_object(
        &self,
        req: S3Request<GetObjectInput>,
    ) -> S3Result<S3Response<GetObjectOutput>> {
        let visit = self.faults.before(&self.faults.get_object_before).await?;
        let input = req.input;
        let (object, body, content_range) = self.read_object(
            &input.bucket,
            &input.key,
            read_conditions!(input),
            input.range,
        )?;
        // `s3s` sets 206 for GetObject whenever Content-Range is present.
        Ok(S3Response::new(GetObjectOutput {
            accept_ranges: Some("bytes".to_owned()),
            content_length: Some(body.len() as i64),
            body: Some(self.faults.body(body, visit)),
            content_range,
            e_tag: Some(object.e_tag),
            last_modified: Some(object.last_modified),
            ..attributes_output!(GetObjectOutput, object.attributes)
        }))
    }

    async fn head_object(
        &self,
        req: S3Request<HeadObjectInput>,
    ) -> S3Result<S3Response<HeadObjectOutput>> {
        let _visit = self.faults.before(&self.faults.head_object_before).await?;
        let input = req.input;
        let (object, body, content_range) = self.read_object(
            &input.bucket,
            &input.key,
            read_conditions!(input),
            input.range,
        )?;
        // Unlike GetObject, a ranged HeadObject answers 200 and reports only
        // the selected length, as Amazon S3 does.
        Ok(S3Response::new(HeadObjectOutput {
            accept_ranges: Some("bytes".to_owned()),
            content_length: Some(body.len() as i64),
            content_range,
            e_tag: Some(object.e_tag),
            last_modified: Some(object.last_modified),
            ..attributes_output!(HeadObjectOutput, object.attributes)
        }))
    }

    async fn delete_object(
        &self,
        req: S3Request<DeleteObjectInput>,
    ) -> S3Result<S3Response<DeleteObjectOutput>> {
        let visit = self
            .faults
            .before(&self.faults.delete_object_before)
            .await?;
        let input = req.input;
        {
            let mut state = self.write()?;
            let bucket = get_bucket_mut(&mut state, &input.bucket)?;
            // A conditional delete of an absent object references a key that is
            // not there, so it reports NoSuchKey rather than a silent success.
            check_write_conditions(
                bucket.objects.get(&input.key),
                input.if_match.as_ref(),
                None,
            )?;
            bucket.objects.remove(&input.key);
        }
        self.faults
            .after_commit(&self.faults.delete_object_after_commit, visit.as_ref())
            .await?;
        Ok(S3Response::new(DeleteObjectOutput::default()))
    }

    async fn copy_object(
        &self,
        req: S3Request<CopyObjectInput>,
    ) -> S3Result<S3Response<CopyObjectOutput>> {
        let visit = self.faults.before(&self.faults.copy_object_before).await?;
        let input = req.input;
        let CopySource::Bucket { bucket, key, .. } = &input.copy_source else {
            return Err(s3s::s3_error!(
                NotImplemented,
                "only same-server bucket copy sources are supported"
            ));
        };
        let (source_bucket, source_key) = (&**bucket, &**key);
        let (e_tag, last_modified) = {
            let mut state = self.write()?;
            let source = get_object(get_bucket(&state, source_bucket)?, source_key)?;
            check_copy_source_conditions(
                source,
                input.copy_source_if_match.as_ref(),
                input.copy_source_if_none_match.as_ref(),
                input.copy_source_if_modified_since.as_ref(),
                input.copy_source_if_unmodified_since.as_ref(),
            )?;
            let replace = input
                .metadata_directive
                .as_ref()
                .is_some_and(|directive| directive.as_str() == MetadataDirective::REPLACE);
            if source_bucket == input.bucket && source_key == input.key && !replace {
                return Err(s3s::s3_error!(
                    InvalidRequest,
                    "the copy source and destination are identical; use a REPLACE metadata directive"
                ));
            }
            // A single-part copy keeps the source ETag; REPLACE swaps metadata and
            // the content headers for the ones supplied on the copy request.
            let stored = StoredObject {
                body: source.body.clone(),
                e_tag: source.e_tag.clone(),
                last_modified: now(),
                attributes: if replace {
                    object_attributes!(input)
                } else {
                    source.attributes.clone()
                },
            };
            let e_tag = stored.e_tag.clone();
            let last_modified = stored.last_modified.clone();
            let bucket = get_bucket_mut(&mut state, &input.bucket)?;
            bucket.objects.insert(input.key, stored);
            (e_tag, last_modified)
        };
        self.faults
            .after_commit(&self.faults.copy_object_after_commit, visit.as_ref())
            .await?;
        Ok(S3Response::new(CopyObjectOutput {
            copy_object_result: Some(CopyObjectResult {
                e_tag: Some(e_tag),
                last_modified: Some(last_modified),
                ..Default::default()
            }),
            ..Default::default()
        }))
    }

    async fn delete_objects(
        &self,
        req: S3Request<DeleteObjectsInput>,
    ) -> S3Result<S3Response<DeleteObjectsOutput>> {
        let visit = self
            .faults
            .before(&self.faults.delete_objects_before)
            .await?;
        let input = req.input;
        let quiet = input.delete.quiet.unwrap_or(false);
        let deleted = {
            let mut state = self.write()?;
            let bucket = get_bucket_mut(&mut state, &input.bucket)?;
            let mut deleted = Vec::with_capacity(input.delete.objects.len());
            for object in input.delete.objects {
                bucket.objects.remove(&object.key);
                if !quiet {
                    deleted.push(DeletedObject {
                        key: Some(object.key),
                        ..Default::default()
                    });
                }
            }
            deleted
        };
        self.faults
            .after_commit(&self.faults.delete_objects_after_commit, visit.as_ref())
            .await?;
        Ok(S3Response::new(DeleteObjectsOutput {
            deleted: (!quiet).then_some(deleted),
            ..Default::default()
        }))
    }

    async fn list_objects_v2(
        &self,
        req: S3Request<ListObjectsV2Input>,
    ) -> S3Result<S3Response<ListObjectsV2Output>> {
        let _visit = self
            .faults
            .before(&self.faults.list_objects_v2_before)
            .await?;
        let input = req.input;
        let state = self.read()?;
        let bucket = get_bucket(&state, &input.bucket)?;
        let prefix = input.prefix.as_deref().unwrap_or_default();
        let delimiter = input.delimiter.as_deref().filter(|value| !value.is_empty());
        let marker = input
            .continuation_token
            .as_deref()
            .or(input.start_after.as_deref())
            .unwrap_or_default();
        let max = input.max_keys.unwrap_or(1000);
        if max < 0 {
            return Err(s3s::s3_error!(
                InvalidArgument,
                "max-keys cannot be negative"
            ));
        }
        let max = max.min(1000) as usize;
        let url_encoded = input
            .encoding_type
            .as_ref()
            .is_some_and(|kind| kind.as_str() == EncodingType::URL);
        let encode = |value: &str| {
            if url_encoded {
                utf8_percent_encode(value, URL_ENCODE_SET).to_string()
            } else {
                value.to_owned()
            }
        };

        // Keys under a prefix are contiguous in the sorted map, so start at the
        // later of the prefix and the marker and stop once the prefix ends.
        // Entries arrive in listing order with the members of a delimiter
        // group adjacent, so a page is complete after max + 1 entries; the
        // extra entry shows whether the listing is truncated.
        let lower = if !marker.is_empty() && marker >= prefix {
            Bound::Excluded(marker)
        } else {
            Bound::Included(prefix)
        };
        let mut page: Vec<ListEntry<'_>> = Vec::new();
        for (key, object) in bucket.objects.range::<str, _>((lower, Bound::Unbounded)) {
            let Some(remainder) = key.strip_prefix(prefix) else {
                break;
            };
            let group_end = delimiter.and_then(|delimiter| {
                remainder
                    .find(delimiter)
                    .map(|position| position + delimiter.len())
            });
            let entry = match group_end {
                Some(end) => ListEntry::CommonPrefix(&key[..prefix.len() + end]),
                None => ListEntry::Object(key, object),
            };
            // A group whose prefix is the marker (the previous page's last
            // entry) is generated again here, and every member of a group
            // after its first repeats it; both are skipped.
            if entry.name() <= marker || page.last().is_some_and(|last| last.name() == entry.name())
            {
                continue;
            }
            page.push(entry);
            if page.len() > max {
                break;
            }
        }
        let is_truncated = max > 0 && page.len() > max;
        page.truncate(max);
        let next_continuation_token = is_truncated
            .then(|| page.last().map(|entry| entry.name().to_owned()))
            .flatten();
        let key_count = page.len() as i32;
        let mut contents = Vec::new();
        let mut common_prefixes = Vec::new();
        for entry in page {
            match entry {
                ListEntry::Object(key, object) => contents.push(Object {
                    e_tag: Some(object.e_tag.clone()),
                    key: Some(encode(key)),
                    last_modified: Some(object.last_modified.clone()),
                    size: Some(object.body.len() as i64),
                    ..Default::default()
                }),
                ListEntry::CommonPrefix(group) => common_prefixes.push(CommonPrefix {
                    prefix: Some(encode(group)),
                }),
            }
        }
        Ok(S3Response::new(ListObjectsV2Output {
            name: Some(input.bucket),
            prefix: input.prefix.as_deref().map(encode),
            max_keys: Some(max as i32),
            key_count: Some(key_count),
            continuation_token: input.continuation_token,
            is_truncated: Some(is_truncated),
            next_continuation_token,
            contents: Some(contents),
            common_prefixes: Some(common_prefixes),
            delimiter: input.delimiter.as_deref().map(encode),
            start_after: input.start_after.as_deref().map(encode),
            encoding_type: input.encoding_type,
            ..Default::default()
        }))
    }

    async fn create_multipart_upload(
        &self,
        req: S3Request<CreateMultipartUploadInput>,
    ) -> S3Result<S3Response<CreateMultipartUploadOutput>> {
        let _visit = self
            .faults
            .before(&self.faults.create_multipart_upload_before)
            .await?;
        let input = req.input;
        let mut state = self.write()?;
        get_bucket(&state, &input.bucket)?;
        state.next_upload += 1;
        let upload_id = format!("chaos3-upload-{}", state.next_upload);
        state.uploads.insert(
            upload_id.clone(),
            MultipartUploadState {
                bucket: input.bucket.clone(),
                key: input.key.clone(),
                attributes: object_attributes!(input),
                parts: BTreeMap::new(),
            },
        );
        Ok(S3Response::new(CreateMultipartUploadOutput {
            bucket: Some(input.bucket),
            key: Some(input.key),
            upload_id: Some(upload_id),
            ..Default::default()
        }))
    }

    async fn upload_part(
        &self,
        req: S3Request<UploadPartInput>,
    ) -> S3Result<S3Response<UploadPartOutput>> {
        let _visit = self.faults.before(&self.faults.upload_part_before).await?;
        let mut input = req.input;
        if !(1..=10_000).contains(&input.part_number) {
            return Err(s3s::s3_error!(
                InvalidArgument,
                "part numbers must be between 1 and 10000"
            ));
        }
        let body = collect_body(input.body.take()).await?;
        verify_body_checksums(&body, &declared_checksums!(input))?;
        let digest = md5_digest(&body);
        let mut state = self.write()?;
        let upload = get_upload_mut(&mut state, &input.upload_id, &input.bucket, &input.key)?;
        upload
            .parts
            .insert(input.part_number, StoredPart { body, digest });
        Ok(S3Response::new(UploadPartOutput {
            e_tag: Some(entity_tag(digest)),
            ..Default::default()
        }))
    }

    async fn complete_multipart_upload(
        &self,
        req: S3Request<CompleteMultipartUploadInput>,
    ) -> S3Result<S3Response<CompleteMultipartUploadOutput>> {
        let visit = self
            .faults
            .before(&self.faults.complete_multipart_upload_before)
            .await?;
        let input = req.input;
        let requested = input
            .multipart_upload
            .and_then(|upload| upload.parts)
            .unwrap_or_default();
        // Validate the parts under the read lock, keeping only handles to the
        // selected bodies, so assembling the object never blocks other requests.
        let (selected, part_digests, attributes) = {
            let state = self.read()?;
            let upload = get_upload(&state, &input.upload_id, &input.bucket, &input.key)?;
            if requested.is_empty() {
                return Err(s3s::s3_error!(
                    MalformedXML,
                    "a multipart completion must contain at least one part"
                ));
            }
            let mut previous = 0;
            let mut selected = Vec::with_capacity(requested.len());
            let mut part_digests = Vec::with_capacity(requested.len() * 16);
            for (index, part) in requested.iter().enumerate() {
                let number = part.part_number.ok_or_else(|| {
                    s3s::s3_error!(InvalidPart, "a completed part has no part number")
                })?;
                if number <= previous {
                    return Err(s3s::s3_error!(
                        InvalidPartOrder,
                        "multipart parts are not in ascending order"
                    ));
                }
                previous = number;
                let stored = upload
                    .parts
                    .get(&number)
                    .filter(|stored| {
                        part.e_tag
                            .as_ref()
                            .is_some_and(|e_tag| *e_tag == stored.e_tag())
                    })
                    .ok_or_else(|| {
                        s3s::s3_error!(
                            InvalidPart,
                            "a multipart part is missing or has the wrong ETag"
                        )
                    })?;
                if index + 1 < requested.len() && stored.body.len() < MIN_PART_SIZE {
                    return Err(s3s::s3_error!(
                        EntityTooSmall,
                        "all multipart parts except the last must be at least 5 MiB"
                    ));
                }
                part_digests.extend_from_slice(&stored.digest);
                selected.push(stored.body.clone());
            }
            (selected, part_digests, upload.attributes.clone())
        };
        // The multipart ETag is the MD5 of the concatenated part MD5 digests,
        // suffixed with the part count, matching Amazon S3.
        let e_tag = ETag::Strong(format!(
            "{}-{}",
            hex::encode(md5_digest(&part_digests)),
            requested.len()
        ));
        let body = match selected.as_slice() {
            [part] => part.clone(),
            parts => {
                let mut body = BytesMut::with_capacity(parts.iter().map(Bytes::len).sum());
                for part in parts {
                    body.extend_from_slice(part);
                }
                body.freeze()
            }
        };
        {
            let mut state = self.write()?;
            // Another request may have completed or aborted the upload while the
            // lock was released; a conditional write is still applied atomically.
            get_upload(&state, &input.upload_id, &input.bucket, &input.key)?;
            let bucket = get_bucket_mut(&mut state, &input.bucket)?;
            check_write_conditions(
                bucket.objects.get(&input.key),
                input.if_match.as_ref(),
                input.if_none_match.as_ref(),
            )?;
            bucket.objects.insert(
                input.key.clone(),
                StoredObject {
                    body,
                    e_tag: e_tag.clone(),
                    last_modified: now(),
                    attributes,
                },
            );
            state.uploads.remove(&input.upload_id);
        }
        self.faults
            .after_commit(
                &self.faults.complete_multipart_upload_after_commit,
                visit.as_ref(),
            )
            .await?;
        let location = format!("/{}/{}", input.bucket, input.key);
        Ok(S3Response::new(CompleteMultipartUploadOutput {
            bucket: Some(input.bucket),
            key: Some(input.key),
            location: Some(location),
            e_tag: Some(e_tag),
            ..Default::default()
        }))
    }

    async fn abort_multipart_upload(
        &self,
        req: S3Request<AbortMultipartUploadInput>,
    ) -> S3Result<S3Response<AbortMultipartUploadOutput>> {
        let _visit = self
            .faults
            .before(&self.faults.abort_multipart_upload_before)
            .await?;
        let input = req.input;
        let mut state = self.write()?;
        get_upload(&state, &input.upload_id, &input.bucket, &input.key)?;
        state.uploads.remove(&input.upload_id);
        Ok(S3Response::new(AbortMultipartUploadOutput::default()))
    }
}
