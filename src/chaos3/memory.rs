// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A simple, in-memory-only model of various S3 operations.
//!
//! The state model is intentionally small: named buckets own ordered object
//! maps, while unfinished multipart uploads live in a separate map until
//! completion. ETags are simple MD5 validators. The protocol adapter in
//! `handlers.rs` maps each S3 operation onto this model.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::{Duration, SystemTime};

use bytes::Bytes;
use faultline::Injector;
use http_body_util::BodyExt as _;
use s3s::checksum::ChecksumHasher;
use s3s::crypto::{
    Crc32, Crc32c, Crc64Nvme, Md5, Sha1, Sha256, Sha512, XxHash3, XxHash64, XxHash128,
};
use s3s::dto::*;
use s3s::{S3Error, S3Result};

use crate::faults::{Faults, S3Fault};

/// A cloneable S3 backend whose complete state is shared in process memory.
///
/// Clones share both storage and fault plans. A newly constructed backend has
/// an independent injector with all points bound and no faults enabled.
#[derive(Clone, Debug, Default)]
pub struct MemoryS3 {
    state: Arc<RwLock<State>>,
    pub(crate) faults: Faults,
}

#[derive(Debug, Default)]
pub(crate) struct State {
    pub(crate) buckets: BTreeMap<String, BucketState>,
    pub(crate) uploads: HashMap<String, MultipartUploadState>,
    pub(crate) next_upload: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct BucketState {
    pub(crate) created_at: Timestamp,
    pub(crate) objects: BTreeMap<String, StoredObject>,
}

#[derive(Clone, Debug)]
pub(crate) struct StoredObject {
    pub(crate) body: Bytes,
    pub(crate) e_tag: ETag,
    pub(crate) last_modified: Timestamp,
    pub(crate) attributes: ObjectAttributes,
}

/// Client-supplied headers stored with an object and echoed on every read.
#[derive(Clone, Debug, Default)]
pub(crate) struct ObjectAttributes {
    pub(crate) metadata: Option<Metadata>,
    pub(crate) cache_control: Option<CacheControl>,
    pub(crate) content_disposition: Option<ContentDisposition>,
    pub(crate) content_encoding: Option<ContentEncoding>,
    pub(crate) content_language: Option<ContentLanguage>,
    pub(crate) content_type: Option<ContentType>,
    pub(crate) expires: Option<Expires>,
}

#[derive(Clone, Debug)]
pub(crate) struct MultipartUploadState {
    pub(crate) bucket: String,
    pub(crate) key: String,
    pub(crate) attributes: ObjectAttributes,
    pub(crate) parts: BTreeMap<PartNumber, StoredPart>,
}

#[derive(Clone, Debug)]
pub(crate) struct StoredPart {
    pub(crate) body: Bytes,
    /// MD5 of `body`, rendered as the part ETag and folded into the object ETag.
    pub(crate) digest: [u8; 16],
}

impl StoredPart {
    pub(crate) fn e_tag(&self) -> ETag {
        entity_tag(self.digest)
    }
}

pub(crate) const MIN_PART_SIZE: usize = 5 * 1024 * 1024;

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

    /// The fault layer shared by this store and all its clones.
    pub(crate) fn faults(&self) -> &Faults {
        &self.faults
    }

    /// Add a bucket, returning whether it was newly created.
    pub fn add_bucket(&self, bucket: impl Into<String>) -> bool {
        let bucket = bucket.into();
        let mut state = self.state.write().expect("chaos3 state lock poisoned");
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

    pub(crate) fn read(&self) -> S3Result<RwLockReadGuard<'_, State>> {
        self.state
            .read()
            .map_err(|_| s3s::s3_error!(InternalError, "chaos3 state lock poisoned"))
    }

    pub(crate) fn write(&self) -> S3Result<RwLockWriteGuard<'_, State>> {
        self.state
            .write()
            .map_err(|_| s3s::s3_error!(InternalError, "chaos3 state lock poisoned"))
    }

    /// Find an object for GET or HEAD, check its preconditions, then select
    /// the requested byte range. Returns a copy of the record, the selected
    /// body, and the `Content-Range` value when a range was requested.
    pub(crate) fn read_object(
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

pub(crate) fn now() -> Timestamp {
    // Last-Modified is an HTTP date, so its validators must use whole seconds.
    let elapsed = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    (SystemTime::UNIX_EPOCH + Duration::from_secs(elapsed.as_secs())).into()
}

/// MD5 digest of `data`, computed through the same crate `s3s` uses.
pub(crate) fn md5_digest(data: &[u8]) -> [u8; 16] {
    use s3s::crypto::Checksum as _;
    Md5::checksum(data)
}

/// The strong ETag of a single-part object or of a part, its MD5 in hex.
pub(crate) fn entity_tag(digest: [u8; 16]) -> ETag {
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
pub(crate) enum ChecksumAlgorithm {
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

/// Reject a body whose declared checksums do not match its bytes.
pub(crate) fn verify_body_checksums(
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

pub(crate) fn check_write_conditions(
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

pub(crate) fn check_copy_source_conditions(
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
pub(crate) struct ReadConditions<'a> {
    pub(crate) if_match: Option<&'a ETagCondition>,
    pub(crate) if_none_match: Option<&'a ETagCondition>,
    pub(crate) if_modified_since: Option<&'a Timestamp>,
    pub(crate) if_unmodified_since: Option<&'a Timestamp>,
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
pub(crate) async fn collect_body(body: Option<StreamingBlob>) -> S3Result<Bytes> {
    let Some(body) = body else {
        return Ok(Bytes::new());
    };
    s3s::Body::from(body)
        .collect()
        .await
        .map(|collected| collected.to_bytes())
        .map_err(|_| s3s::s3_error!(InternalError, "failed to read the request body"))
}

pub(crate) fn get_bucket<'a>(state: &'a State, bucket: &str) -> S3Result<&'a BucketState> {
    state.buckets.get(bucket).ok_or_else(no_such_bucket)
}

pub(crate) fn get_bucket_mut<'a>(
    state: &'a mut State,
    bucket: &str,
) -> S3Result<&'a mut BucketState> {
    state.buckets.get_mut(bucket).ok_or_else(no_such_bucket)
}

pub(crate) fn get_object<'a>(bucket: &'a BucketState, key: &str) -> S3Result<&'a StoredObject> {
    bucket.objects.get(key).ok_or_else(no_such_key)
}

/// Find an upload by id, which must belong to the requested bucket and key.
pub(crate) fn get_upload<'a>(
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

pub(crate) fn get_upload_mut<'a>(
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
