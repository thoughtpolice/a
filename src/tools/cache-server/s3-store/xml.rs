// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Serde bindings for the S3 REST XML payloads this crate consumes.
//!
//! Only the fields the client actually reads are modeled; quick-xml skips
//! everything else. The `overlapped-lists` feature is required because
//! `ListObjectsV2` responses interleave `<Contents>` and `<CommonPrefixes>`
//! elements.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// `ListObjectsV2` response body (`<ListBucketResult>`).
///
/// <https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html>
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct ListBucketResult {
    #[serde(default)]
    pub contents: Vec<Contents>,
    #[serde(default)]
    pub common_prefixes: Vec<CommonPrefix>,
    #[serde(default)]
    pub next_continuation_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct Contents {
    pub key: String,
    pub size: u64,
    pub last_modified: DateTime<Utc>,
    #[serde(default, rename = "ETag")]
    pub e_tag: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct CommonPrefix {
    pub prefix: String,
}

/// `CreateMultipartUpload` response body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct InitiateMultipartUploadResult {
    pub upload_id: String,
}

/// `CompleteMultipartUpload` response body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct CompleteMultipartUploadResult {
    #[serde(rename = "ETag")]
    pub e_tag: String,
}

/// `CompleteMultipartUpload` request body.
#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct CompleteMultipartUpload {
    pub part: Vec<CompletedPart>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct CompletedPart {
    #[serde(rename = "ETag")]
    pub e_tag: String,
    pub part_number: usize,
}

/// Deserialize an XML document from `bytes`.
pub(crate) fn parse<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, quick_xml::DeError> {
    quick_xml::de::from_reader(bytes)
}

/// Serialize `value` to an XML document.
pub(crate) fn serialize<T: Serialize>(value: &T) -> Result<String, quick_xml::SeError> {
    quick_xml::se::to_string(value)
}
