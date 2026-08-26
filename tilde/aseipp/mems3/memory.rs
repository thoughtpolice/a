// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A simple, in-memory-only model of various S3 operations.
//!
//! The state model is intentionally small: named buckets own ordered object
//! maps, while unfinished multipart uploads live in a separate map until
//! completion. ETags are simple MD5 validators.
//!
//! `s3s` generates a separate input type per operation, and related operations
//! name their shared fields identically. The macros below read those fields
//! from whichever input they are handed, so each header is listed once.

use std::collections::{BTreeMap, HashMap};
use std::ops::Bound;
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::{Duration, SystemTime};

use bytes::{Bytes, BytesMut};
use faultline::Injector;
use http_body_util::BodyExt as _;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use s3s::checksum::ChecksumHasher;
use s3s::crypto::{
    Crc32, Crc32c, Crc64Nvme, Md5, Sha1, Sha256, Sha512, XxHash3, XxHash64, XxHash128,
};
use s3s::dto::*;
use s3s::{S3, S3Error, S3Request, S3Response, S3Result};

use crate::faults::{Faults, S3Fault};

/// A cloneable S3 backend whose complete state is shared in process memory.
///
/// Clones share both storage and fault plans. A newly constructed backend has
/// an independent injector with all points bound and no faults enabled.
#[derive(Clone, Debug, Default)]
pub struct MemoryS3 {
    state: Arc<RwLock<State>>,
    faults: Faults,
}

#[derive(Debug, Default)]
struct State {
    buckets: BTreeMap<String, BucketState>,
    uploads: HashMap<String, MultipartUploadState>,
    next_upload: u64,
}

#[derive(Clone, Debug)]
struct BucketState {
    created_at: Timestamp,
    objects: BTreeMap<String, StoredObject>,
}

#[derive(Clone, Debug)]
struct StoredObject {
    body: Bytes,
    e_tag: ETag,
    last_modified: Timestamp,
    attributes: ObjectAttributes,
}

/// Client-supplied headers stored with an object and echoed on every read.
#[derive(Clone, Debug, Default)]
struct ObjectAttributes {
    metadata: Option<Metadata>,
    cache_control: Option<CacheControl>,
    content_disposition: Option<ContentDisposition>,
    content_encoding: Option<ContentEncoding>,
    content_language: Option<ContentLanguage>,
    content_type: Option<ContentType>,
    expires: Option<Expires>,
}

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

impl ObjectAttributes {
    fn get_output(self) -> GetObjectOutput {
        GetObjectOutput {
            cache_control: self.cache_control,
            content_disposition: self.content_disposition,
            content_encoding: self.content_encoding,
            content_language: self.content_language,
            content_type: self.content_type,
            expires: self.expires,
            metadata: self.metadata,
            ..Default::default()
        }
    }

    fn head_output(self) -> HeadObjectOutput {
        HeadObjectOutput {
            cache_control: self.cache_control,
            content_disposition: self.content_disposition,
            content_encoding: self.content_encoding,
            content_language: self.content_language,
            content_type: self.content_type,
            expires: self.expires,
            metadata: self.metadata,
            ..Default::default()
        }
    }
}

#[derive(Clone, Debug)]
struct MultipartUploadState {
    bucket: String,
    key: String,
    attributes: ObjectAttributes,
    parts: BTreeMap<PartNumber, StoredPart>,
}

#[derive(Clone, Debug)]
struct StoredPart {
    body: Bytes,
    /// MD5 of `body`, rendered as the part ETag and folded into the object ETag.
    digest: [u8; 16],
}

impl StoredPart {
    fn e_tag(&self) -> ETag {
        entity_tag(self.digest)
    }
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

pub(crate) const MIN_PART_SIZE: usize = 5 * 1024 * 1024;
const URL_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

impl MemoryS3 {
    /// Construct a store and pre-create every supplied bucket.
    pub fn with_buckets<I, S>(buckets: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self::with_buckets_and_faults(buckets, Injector::new())
    }

    /// Construct a store with a caller-owned fault controller.
    ///
    /// All point names are bound before this returns, so plans can be
    /// configured immediately. Initial bucket creation bypasses request
    /// failpoints. Clone the injector before passing it to retain control
    /// over the running server, or use [`Self::faults`] afterward.
    pub(crate) fn with_buckets_and_faults<I, S>(buckets: I, injector: Injector<S3Fault>) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let store = Self {
            state: Arc::default(),
            faults: Faults::new(injector),
        };
        for bucket in buckets {
            store.add_bucket(bucket);
        }
        store
    }

    /// Attach a campaign before cloning the store for request handling.
    ///
    /// Previously created handles retain their fault settings, which lets an
    /// in-process test inspect shared storage through a healthy handle.
    pub(crate) fn with_chaos(mut self, chaos: crate::chaos::Chaos) -> Self {
        self.faults.set_chaos(chaos);
        self
    }

    /// The fault controller shared by this store and all its clones.
    pub(crate) fn faults(&self) -> &Injector<S3Fault> {
        self.faults.injector()
    }

    /// Add a bucket, returning whether it was newly created.
    pub fn add_bucket(&self, bucket: impl Into<String>) -> bool {
        let bucket = bucket.into();
        let mut state = self.state.write().expect("mems3 state lock poisoned");
        if state.buckets.contains_key(&bucket) {
            return false;
        }
        state.buckets.insert(
            bucket,
            BucketState {
                created_at: now(),
                objects: BTreeMap::new(),
            },
        );
        true
    }

    fn read(&self) -> S3Result<RwLockReadGuard<'_, State>> {
        self.state
            .read()
            .map_err(|_| s3s::s3_error!(InternalError, "mems3 state lock poisoned"))
    }

    fn write(&self) -> S3Result<RwLockWriteGuard<'_, State>> {
        self.state
            .write()
            .map_err(|_| s3s::s3_error!(InternalError, "mems3 state lock poisoned"))
    }

    /// Find an object for GET or HEAD, check its preconditions, then select
    /// the requested byte range. Returns a copy of the record, the selected
    /// body, and the `Content-Range` value when a range was requested.
    fn read_object(
        &self,
        bucket: &str,
        key: &str,
        conditions: ReadConditions<'_>,
        range: Option<Range>,
    ) -> S3Result<(StoredObject, Bytes, Option<String>)> {
        let state = self.read()?;
        let object = get_object(get_bucket(&state, bucket)?, key)?;
        check_read_conditions(object, conditions)?;
        let (body, content_range) = object_output(object, range)?;
        Ok((object.clone(), body, content_range))
    }
}

fn now() -> Timestamp {
    // Last-Modified is an HTTP date, so its validators must use whole seconds.
    let elapsed = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    (SystemTime::UNIX_EPOCH + Duration::from_secs(elapsed.as_secs())).into()
}

/// MD5 digest of `data`, computed through the same crate `s3s` uses.
fn md5_digest(data: &[u8]) -> [u8; 16] {
    use s3s::crypto::Checksum as _;
    Md5::checksum(data)
}

/// The strong ETag of a single-part object or of a part, its MD5 in hex.
fn entity_tag(digest: [u8; 16]) -> ETag {
    ETag::Strong(hex::encode(digest))
}

fn no_such_bucket() -> S3Error {
    s3s::s3_error!(NoSuchBucket, "the bucket does not exist")
}

fn no_such_key() -> S3Error {
    s3s::s3_error!(NoSuchKey, "the object does not exist")
}

fn no_such_upload() -> S3Error {
    s3s::s3_error!(NoSuchUpload, "the multipart upload does not exist")
}

/// One body integrity algorithm. It knows which hasher slot to enable and
/// which output field holds its computed value.
#[derive(Clone, Copy)]
enum ChecksumAlgorithm {
    Crc32,
    Crc32c,
    Crc64Nvme,
    Md5,
    Sha1,
    Sha256,
    Sha512,
    XxHash64,
    XxHash3,
    XxHash128,
}

impl ChecksumAlgorithm {
    fn enable(self, hasher: &mut ChecksumHasher) {
        match self {
            Self::Crc32 => hasher.crc32 = Some(Crc32::default()),
            Self::Crc32c => hasher.crc32c = Some(Crc32c::default()),
            Self::Crc64Nvme => hasher.crc64nvme = Some(Crc64Nvme::default()),
            Self::Md5 => hasher.md5 = Some(Md5::default()),
            Self::Sha1 => hasher.sha1 = Some(Sha1::default()),
            Self::Sha256 => hasher.sha256 = Some(Sha256::default()),
            Self::Sha512 => hasher.sha512 = Some(Sha512::default()),
            Self::XxHash64 => hasher.xxhash64 = Some(XxHash64::default()),
            Self::XxHash3 => hasher.xxhash3 = Some(XxHash3::default()),
            Self::XxHash128 => hasher.xxhash128 = Some(XxHash128::default()),
        }
    }

    fn computed(self, checksum: &Checksum) -> Option<&str> {
        match self {
            Self::Crc32 => checksum.checksum_crc32.as_deref(),
            Self::Crc32c => checksum.checksum_crc32c.as_deref(),
            Self::Crc64Nvme => checksum.checksum_crc64nvme.as_deref(),
            Self::Md5 => checksum.checksum_md5.as_deref(),
            Self::Sha1 => checksum.checksum_sha1.as_deref(),
            Self::Sha256 => checksum.checksum_sha256.as_deref(),
            Self::Sha512 => checksum.checksum_sha512.as_deref(),
            Self::XxHash64 => checksum.checksum_xxhash64.as_deref(),
            Self::XxHash3 => checksum.checksum_xxhash3.as_deref(),
            Self::XxHash128 => checksum.checksum_xxhash128.as_deref(),
        }
    }
}

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

/// Reject a body whose declared checksums do not match its bytes.
fn verify_body_checksums(
    body: &[u8],
    declared: &[(&str, Option<&str>, ChecksumAlgorithm)],
) -> S3Result<()> {
    let mut hasher = ChecksumHasher::default();
    for (_, expected, algorithm) in declared {
        if expected.is_some() {
            algorithm.enable(&mut hasher);
        }
    }
    hasher.update(body);
    let computed = hasher.finalize();
    for (header, expected, algorithm) in declared {
        if let Some(expected) = *expected
            && algorithm.computed(&computed) != Some(expected)
        {
            return Err(s3s::s3_error!(
                BadDigest,
                "the {header} value does not match the request body"
            ));
        }
    }
    Ok(())
}

fn condition_matches(condition: &ETagCondition, current: Option<&ETag>) -> bool {
    match condition {
        ETagCondition::Any => current.is_some(),
        ETagCondition::ETag(expected) => current.is_some_and(|actual| actual == expected),
    }
}

fn check_write_conditions(
    current: Option<&StoredObject>,
    if_match: Option<&ETagCondition>,
    if_none_match: Option<&ETagCondition>,
) -> S3Result<()> {
    if let Some(condition) = if_match {
        // S3 conditional writes report a missing target as NoSuchKey (404),
        // not a precondition failure. See the AWS "conditional writes" guide.
        match current {
            None => return Err(no_such_key()),
            Some(object) if !condition_matches(condition, Some(&object.e_tag)) => {
                return Err(s3s::s3_error!(
                    PreconditionFailed,
                    "If-Match did not match the current object"
                ));
            }
            Some(_) => {}
        }
    }
    if if_none_match
        .is_some_and(|condition| condition_matches(condition, current.map(|o| &o.e_tag)))
    {
        return Err(s3s::s3_error!(
            PreconditionFailed,
            "If-None-Match matched the current object"
        ));
    }
    Ok(())
}

fn check_copy_source_conditions(
    source: &StoredObject,
    if_match: Option<&ETagCondition>,
    if_none_match: Option<&ETagCondition>,
    if_modified_since: Option<&Timestamp>,
    if_unmodified_since: Option<&Timestamp>,
) -> S3Result<()> {
    let failed = if_match
        .is_some_and(|condition| !condition_matches(condition, Some(&source.e_tag)))
        || if_unmodified_since.is_some_and(|timestamp| source.last_modified > *timestamp)
        || if_none_match.is_some_and(|condition| condition_matches(condition, Some(&source.e_tag)))
        || if_modified_since.is_some_and(|timestamp| source.last_modified <= *timestamp);
    if failed {
        return Err(s3s::s3_error!(
            PreconditionFailed,
            "a copy-source precondition was not met"
        ));
    }
    Ok(())
}

/// Conditional-read headers, which `GetObjectInput` and `HeadObjectInput` name
/// identically.
#[derive(Clone, Copy)]
struct ReadConditions<'a> {
    if_match: Option<&'a ETagCondition>,
    if_none_match: Option<&'a ETagCondition>,
    if_modified_since: Option<&'a Timestamp>,
    if_unmodified_since: Option<&'a Timestamp>,
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

fn check_read_conditions(object: &StoredObject, conditions: ReadConditions<'_>) -> S3Result<()> {
    let ReadConditions {
        if_match,
        if_none_match,
        if_modified_since,
        if_unmodified_since,
    } = conditions;
    if if_match.is_some_and(|condition| !condition_matches(condition, Some(&object.e_tag))) {
        return Err(s3s::s3_error!(
            PreconditionFailed,
            "If-Match did not match the current object"
        ));
    }
    if if_match.is_none()
        && if_unmodified_since.is_some_and(|timestamp| object.last_modified > *timestamp)
    {
        return Err(s3s::s3_error!(
            PreconditionFailed,
            "the object has been modified"
        ));
    }
    if if_none_match.is_some_and(|condition| condition_matches(condition, Some(&object.e_tag))) {
        return Err(s3s::s3_error!(
            NotModified,
            "If-None-Match matched the current object"
        ));
    }
    if if_none_match.is_none()
        && if_modified_since.is_some_and(|timestamp| object.last_modified <= *timestamp)
    {
        return Err(s3s::s3_error!(
            NotModified,
            "the object has not been modified"
        ));
    }
    Ok(())
}

/// Buffer a request body, which `s3s` streams as the client sends it.
async fn collect_body(body: Option<StreamingBlob>) -> S3Result<Bytes> {
    let Some(body) = body else {
        return Ok(Bytes::new());
    };
    s3s::Body::from(body)
        .collect()
        .await
        .map(|collected| collected.to_bytes())
        .map_err(|_| s3s::s3_error!(InternalError, "failed to read the request body"))
}

fn get_bucket<'a>(state: &'a State, bucket: &str) -> S3Result<&'a BucketState> {
    state.buckets.get(bucket).ok_or_else(no_such_bucket)
}

fn get_bucket_mut<'a>(state: &'a mut State, bucket: &str) -> S3Result<&'a mut BucketState> {
    state.buckets.get_mut(bucket).ok_or_else(no_such_bucket)
}

fn get_object<'a>(bucket: &'a BucketState, key: &str) -> S3Result<&'a StoredObject> {
    bucket.objects.get(key).ok_or_else(no_such_key)
}

/// Find an upload by id, which must belong to the requested bucket and key.
fn get_upload<'a>(
    state: &'a State,
    upload_id: &str,
    bucket: &str,
    key: &str,
) -> S3Result<&'a MultipartUploadState> {
    state
        .uploads
        .get(upload_id)
        .filter(|upload| upload.bucket == bucket && upload.key == key)
        .ok_or_else(no_such_upload)
}

fn get_upload_mut<'a>(
    state: &'a mut State,
    upload_id: &str,
    bucket: &str,
    key: &str,
) -> S3Result<&'a mut MultipartUploadState> {
    state
        .uploads
        .get_mut(upload_id)
        .filter(|upload| upload.bucket == bucket && upload.key == key)
        .ok_or_else(no_such_upload)
}

fn object_output(object: &StoredObject, range: Option<Range>) -> S3Result<(Bytes, Option<String>)> {
    let Some(range) = range else {
        return Ok((object.body.clone(), None));
    };
    let full_length = object.body.len() as u64;
    let selected = range.check(full_length)?;
    if selected.is_empty() {
        return Err(s3s::s3_error!(InvalidRange, "the requested range is empty"));
    }
    let body = object
        .body
        .slice(selected.start as usize..selected.end as usize);
    let content_range = format!(
        "bytes {}-{}/{full_length}",
        selected.start,
        selected.end - 1
    );
    Ok((body, Some(content_range)))
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
        let _visit = self.faults.before(&self.faults.get_object_before).await?;
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
            body: Some(StreamingBlob::from(body)),
            content_range,
            e_tag: Some(object.e_tag),
            last_modified: Some(object.last_modified),
            ..object.attributes.get_output()
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
            ..object.attributes.head_output()
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
        let (source_bucket, source_key) = match &input.copy_source {
            CopySource::Bucket { bucket, key, .. } => (bucket.to_string(), key.to_string()),
            _ => {
                return Err(s3s::s3_error!(
                    NotImplemented,
                    "only same-server bucket copy sources are supported"
                ));
            }
        };
        let (e_tag, last_modified) = {
            let mut state = self.write()?;
            let source = get_object(get_bucket(&state, &source_bucket)?, &source_key)?.clone();
            check_copy_source_conditions(
                &source,
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
                last_modified: now(),
                attributes: if replace {
                    object_attributes!(input)
                } else {
                    source.attributes
                },
                ..source
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
        let encode = |value: String| {
            if input
                .encoding_type
                .as_ref()
                .is_some_and(|kind| kind.as_str() == EncodingType::URL)
            {
                utf8_percent_encode(&value, URL_ENCODE_SET).to_string()
            } else {
                value
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
                    key: Some(encode(key.to_owned())),
                    last_modified: Some(object.last_modified.clone()),
                    size: Some(object.body.len() as i64),
                    ..Default::default()
                }),
                ListEntry::CommonPrefix(group) => common_prefixes.push(CommonPrefix {
                    prefix: Some(encode(group.to_owned())),
                }),
            }
        }
        Ok(S3Response::new(ListObjectsV2Output {
            name: Some(input.bucket),
            prefix: input.prefix.map(encode),
            max_keys: Some(max as i32),
            key_count: Some(key_count),
            continuation_token: input.continuation_token,
            is_truncated: Some(is_truncated),
            next_continuation_token,
            contents: Some(contents),
            common_prefixes: Some(common_prefixes),
            delimiter: input.delimiter.map(encode),
            start_after: input.start_after.map(encode),
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
        let upload_id = format!("mems3-upload-{}", state.next_upload);
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
        // Snapshot the upload, then validate and assemble the object without
        // holding the lock during the copy. Part bodies are reference-counted,
        // so the clone is cheap and the assembly cannot block other requests.
        let upload = {
            let state = self.read()?;
            get_upload(&state, &input.upload_id, &input.bucket, &input.key)?.clone()
        };
        let requested = input
            .multipart_upload
            .and_then(|upload| upload.parts)
            .unwrap_or_default();
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
            selected.push(&stored.body);
        }
        // The multipart ETag is the MD5 of the concatenated part MD5 digests,
        // suffixed with the part count, matching Amazon S3.
        let e_tag = ETag::Strong(format!(
            "{}-{}",
            hex::encode(md5_digest(&part_digests)),
            requested.len()
        ));
        let body = match selected.as_slice() {
            [part] => Bytes::clone(part),
            parts => {
                let mut body = BytesMut::with_capacity(parts.iter().map(|part| part.len()).sum());
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
                    attributes: upload.attributes,
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
