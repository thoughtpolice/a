// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Request options and response values.

use std::collections::BTreeMap;
use std::ops::Range;

use bytes::Bytes;
use chrono::{DateTime, Utc};
use futures::TryStreamExt as _;
use futures::stream::BoxStream;

use crate::error::{Error, Result};

/// Headers and user metadata stored with an object.
///
/// User metadata travels as `x-amz-meta-*` headers, whose names are
/// case-insensitive; responses report the keys in lower case.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ObjectAttributes {
    pub cache_control: Option<String>,
    pub content_disposition: Option<String>,
    pub content_encoding: Option<String>,
    pub content_language: Option<String>,
    pub content_type: Option<String>,
    /// `x-amz-storage-class`. Only writes send it; reads never report it.
    pub storage_class: Option<String>,
    pub metadata: BTreeMap<String, String>,
}

impl ObjectAttributes {
    /// Whether these attributes carry every user metadata entry in
    /// `expected`, comparing keys without regard to case.
    pub fn has_metadata(&self, expected: &BTreeMap<String, String>) -> bool {
        expected.iter().all(|(key, value)| {
            self.metadata.iter().any(|(stored, stored_value)| {
                stored.eq_ignore_ascii_case(key) && stored_value == value
            })
        })
    }
}

/// A precondition on a write.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum WriteCondition {
    /// Write whatever is there.
    #[default]
    None,
    /// Write only if no object exists (`If-None-Match: *`).
    Absent,
    /// Write only over the version with this ETag (`If-Match`).
    Matches(String),
}

/// Options for `PutObject`, and the object-level settings of
/// `CreateMultipartUpload`, which ignores `condition`.
#[derive(Debug, Clone, Default)]
pub struct PutObject {
    pub condition: WriteCondition,
    pub attributes: ObjectAttributes,
    /// A URL-encoded tag set for `x-amz-tagging`, such as `a=1&b=2`.
    pub tagging: Option<String>,
}

/// The version a write produced.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PutObjectOutput {
    pub e_tag: Option<String>,
    pub version: Option<String>,
}

/// The bytes of an object a read asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ByteRange {
    /// The bytes in `start..end`. An `end` past the object stops at its end.
    Bounded(Range<u64>),
    /// Every byte from this offset on.
    Offset(u64),
    /// The last this-many bytes.
    Suffix(u64),
}

impl ByteRange {
    /// Whether S3 can serve this range of some object.
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Bounded(range) if range.end <= range.start => Err(Error::invalid(format!(
                "range started at {} and ended at {}",
                range.start, range.end
            ))),
            _ => Ok(()),
        }
    }

    /// The bytes this range selects from an object of `size` bytes.
    pub fn resolve(&self, size: u64) -> Result<Range<u64>> {
        self.validate()?;
        let too_large = |start| {
            Error::invalid(format!(
                "wanted a range starting at {start}, but the object is only {size} bytes long"
            ))
        };
        match self {
            Self::Bounded(range) if range.start >= size => Err(too_large(range.start)),
            Self::Bounded(range) => Ok(range.start..range.end.min(size)),
            Self::Offset(start) if *start >= size => Err(too_large(*start)),
            Self::Offset(start) => Ok(*start..size),
            Self::Suffix(len) => Ok(size.saturating_sub(*len)..size),
        }
    }
}

impl std::fmt::Display for ByteRange {
    /// The `Range` header value.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bounded(range) => write!(f, "bytes={}-{}", range.start, range.end - 1),
            Self::Offset(start) => write!(f, "bytes={start}-"),
            Self::Suffix(len) => write!(f, "bytes=-{len}"),
        }
    }
}

/// Options for `GetObject` and `HeadObject`.
#[derive(Debug, Clone, Default)]
pub struct GetObject {
    pub range: Option<ByteRange>,
    pub if_match: Option<String>,
    pub if_none_match: Option<String>,
    pub if_modified_since: Option<DateTime<Utc>>,
    pub if_unmodified_since: Option<DateTime<Utc>>,
    pub version: Option<String>,
}

/// What S3 reports about one object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectInfo {
    pub key: String,
    /// The size of the whole object, even when a read asked for a range.
    pub size: u64,
    pub last_modified: Option<DateTime<Utc>>,
    pub e_tag: Option<String>,
    pub version: Option<String>,
}

/// A streamed object body.
pub type ByteStream = BoxStream<'static, Result<Bytes>>;

/// A `GetObject` or `HeadObject` response.
pub struct GetObjectOutput {
    pub info: ObjectInfo,
    pub attributes: ObjectAttributes,
    /// The bytes of the object `body` delivers.
    pub range: Range<u64>,
    /// The body, empty for `HeadObject`. A `GetObject` body that breaks off
    /// resumes from where it stopped, as long as the object has not changed.
    pub body: ByteStream,
}

impl std::fmt::Debug for GetObjectOutput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GetObjectOutput")
            .field("info", &self.info)
            .field("attributes", &self.attributes)
            .field("range", &self.range)
            .finish_non_exhaustive()
    }
}

impl GetObjectOutput {
    /// Collect the whole body.
    pub async fn bytes(self) -> Result<Bytes> {
        let capacity = (self.range.end - self.range.start) as usize;
        let mut buf = Vec::with_capacity(capacity);
        let mut body = self.body;
        while let Some(chunk) = body.try_next().await? {
            buf.extend_from_slice(&chunk);
        }
        Ok(buf.into())
    }
}

/// Options for one `ListObjectsV2` page.
#[derive(Debug, Clone, Default)]
pub struct ListObjects {
    /// Only keys starting with this, passed through verbatim.
    pub prefix: Option<String>,
    /// Roll keys up to their first `/` after the prefix.
    pub delimiter: bool,
    /// Only keys after this one (`start-after`).
    pub start_after: Option<String>,
    /// The token from the previous page.
    pub continuation_token: Option<String>,
}

/// One page of a `ListObjectsV2` listing.
#[derive(Debug, Clone, Default)]
pub struct ListPage {
    pub objects: Vec<ObjectInfo>,
    pub common_prefixes: Vec<String>,
    /// The token that asks for the next page, or `None` on the last one.
    pub next_continuation_token: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_must_all_be_present_and_equal() {
        let metadata = |pairs: &[(&str, &str)]| -> BTreeMap<String, String> {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        let stored = ObjectAttributes {
            metadata: metadata(&[("slatedbputid", "01ABC"), ("other", "x")]),
            ..Default::default()
        };
        assert!(stored.has_metadata(&BTreeMap::new()));
        assert!(stored.has_metadata(&metadata(&[("slatedbputid", "01ABC")])));
        assert!(stored.has_metadata(&metadata(&[("SlateDBPutID", "01ABC")])));
        assert!(!stored.has_metadata(&metadata(&[("slatedbputid", "01XYZ")])));
        assert!(!stored.has_metadata(&metadata(&[("missing", "x")])));
    }

    #[test]
    fn ranges_resolve_like_s3() {
        assert_eq!(ByteRange::Bounded(2..5).resolve(10).unwrap(), 2..5);
        assert_eq!(ByteRange::Bounded(2..50).resolve(10).unwrap(), 2..10);
        assert!(ByteRange::Bounded(10..12).resolve(10).is_err());
        assert!(ByteRange::Bounded(5..5).validate().is_err());
        assert_eq!(ByteRange::Offset(3).resolve(10).unwrap(), 3..10);
        assert!(ByteRange::Offset(10).resolve(10).is_err());
        assert_eq!(ByteRange::Suffix(4).resolve(10).unwrap(), 6..10);
        assert_eq!(ByteRange::Suffix(40).resolve(10).unwrap(), 0..10);
        assert_eq!(ByteRange::Bounded(2..5).to_string(), "bytes=2-4");
        assert_eq!(ByteRange::Offset(3).to_string(), "bytes=3-");
        assert_eq!(ByteRange::Suffix(4).to_string(), "bytes=-4");
    }
}
