// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The S3 REST operations.
//!
//! Every operation here is a thin, explicit mapping onto one S3 REST call.
//! Requests carry in-memory bodies, so they can be replayed for retries and
//! their SHA-256 payload hash signed.

use std::collections::BTreeMap;
use std::ops::Range;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use chrono::{DateTime, Utc};
use futures::stream::BoxStream;
use futures::{StreamExt as _, TryStreamExt as _};
use percent_encoding::{PercentEncode, utf8_percent_encode};
use reqwest::header::{
    CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_ENCODING, CONTENT_LANGUAGE, CONTENT_LENGTH,
    CONTENT_RANGE, CONTENT_TYPE, ETAG, HeaderMap, HeaderName, HeaderValue, IF_MATCH,
    IF_MODIFIED_SINCE, IF_NONE_MATCH, IF_UNMODIFIED_SINCE, LAST_MODIFIED, RANGE,
};
use reqwest::{Method, Response, StatusCode};

use crate::body::resumable;
use crate::error::{Error, ErrorKind, Result};
use crate::sigv4::{
    self, Credentials, EMPTY_SHA256, STRICT_PATH_ENCODE_SET, UNSIGNED_PAYLOAD, query_string,
};
use crate::types::{
    GetObject, GetObjectOutput, ListObjects, ListPage, ObjectAttributes, ObjectInfo, PutObject,
    PutObjectOutput, WriteCondition,
};
use crate::xml;

/// HTTP date format for conditional request headers (RFC 7231 IMF-fixdate).
const HTTP_DATE_FORMAT: &str = "%a, %d %b %Y %H:%M:%S GMT";

const VERSION_HEADER: &str = "x-amz-version-id";
const USER_METADATA_PREFIX: &str = "x-amz-meta-";
const TAGS_HEADER: &str = "x-amz-tagging";
const COPY_SOURCE_HEADER: &str = "x-amz-copy-source";
const STORAGE_CLASS_HEADER: &str = "x-amz-storage-class";

/// How many response body bytes to preserve in error messages.
const ERROR_BODY_CAP: usize = 2048;

/// Resolved connection configuration for a bucket.
#[derive(Debug)]
pub(crate) struct Config {
    pub bucket: String,
    /// Signing region.
    pub region: String,
    /// Base URL addressing the bucket, without a trailing slash. It is
    /// `https://{bucket}.{host}` for virtual-hosted style and
    /// `{endpoint}/{bucket}` for path style.
    pub bucket_endpoint: String,
    /// `None` sends unsigned (anonymous) requests.
    pub credentials: Option<Credentials>,
    /// Maximum request attempts (first try plus retries), at least 1.
    pub max_attempts: usize,
    /// Whether signatures cover the body's SHA-256 rather than
    /// `UNSIGNED-PAYLOAD`.
    pub sign_payload: bool,
    /// Base delay for exponential retry backoff.
    pub retry_backoff: Duration,
}

impl Config {
    /// The delay before trying again after `failures` consecutive failures.
    pub(crate) fn backoff(&self, failures: usize) -> Duration {
        self.retry_backoff
            .saturating_mul(1u32 << failures.saturating_sub(1).min(16) as u32)
    }
}

/// An S3 client for one bucket.
///
/// Cloning is cheap; clones share one connection pool. Build one with
/// [`ClientBuilder`](crate::ClientBuilder).
///
/// Transient failures (transport errors, 408, 429 and 5xx) are retried with
/// exponential backoff up to the configured attempt count. A retried write
/// can find that an earlier attempt took effect after all. Conditional
/// `PutObject` and `CompleteMultipartUpload` recognize that case and report
/// success, so callers see the outcome of their write rather than the
/// precondition failure its own replay caused.
#[derive(Debug, Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    config: Config,
    http: reqwest::Client,
}

/// The outcome of [`Client::send_reporting_replays`].
struct Sent {
    result: Result<Response>,
    /// An attempt before the last failed in a way that may have taken
    /// effect on the server, so the last attempt may have been a replay.
    replayed_unknown: bool,
}

impl Client {
    pub(crate) fn new(config: Config, http: reqwest::Client) -> Self {
        Self {
            inner: Arc::new(Inner { config, http }),
        }
    }

    pub(crate) fn config(&self) -> &Config {
        &self.inner.config
    }

    /// The bucket this client addresses.
    pub fn bucket(&self) -> &str {
        &self.inner.config.bucket
    }

    /// The URL of `key`, with `query` encoded the way SigV4 signs it.
    fn object_url(&self, key: &str, query: &[(&str, &str)]) -> Result<reqwest::Url> {
        let url = format!("{}/{}", self.config().bucket_endpoint, encode_key(key));
        let mut url = parse_url(&url)?;
        if !query.is_empty() {
            url.set_query(Some(&query_string(query)));
        }
        Ok(url)
    }

    /// Execute `request` with SigV4 signing and bounded retries.
    ///
    /// Transport failures and retryable statuses (408, 429, 5xx, and 409 when
    /// `retry_on_conflict` is set) are retried with exponential backoff, and
    /// the request is re-signed with a fresh timestamp on every attempt. Any
    /// remaining non-success status becomes [`Error::Status`].
    async fn send(&self, request: reqwest::Request, retry_on_conflict: bool) -> Result<Response> {
        self.send_reporting_replays(request, retry_on_conflict)
            .await
            .result
    }

    /// [`send`](Self::send), also reporting whether a failed attempt may
    /// nonetheless have taken effect before a later one replayed it.
    ///
    /// A 5xx status, or a transport error once the request may have reached
    /// the server, leaves the outcome unknown. S3 can apply a write and then
    /// fail to deliver its response. Replaying an idempotent request is
    /// harmless, but a replayed conditional write fails its own precondition
    /// and a replayed multipart completion finds its upload consumed. Callers
    /// of those requests use the report to reconcile such a failure.
    async fn send_reporting_replays(
        &self,
        request: reqwest::Request,
        retry_on_conflict: bool,
    ) -> Sent {
        let config = self.config();
        let url = request.url().to_string();
        // Request bodies are always buffered, so a signature can cover the
        // hash of exactly the bytes being sent.
        let payload_sha256 = match request.body().and_then(reqwest::Body::as_bytes) {
            None | Some([]) => EMPTY_SHA256.to_string(),
            Some(_) if !config.sign_payload => UNSIGNED_PAYLOAD.to_string(),
            Some(body) => sigv4::sha256_hex(body),
        };
        let mut attempt = 0usize;
        let mut replayed_unknown = false;
        let result = loop {
            attempt += 1;
            let mut req = request
                .try_clone()
                .expect("S3 request bodies are buffered and cloneable");
            if let Some(credentials) = &config.credentials {
                sigv4::sign_request(&mut req, credentials, &config.region, &payload_sha256);
            }

            match self.inner.http.execute(req).await {
                Ok(response) => {
                    let status = response.status();
                    if status.is_success() {
                        break Ok(response);
                    }

                    let retryable = status.is_server_error()
                        || status == StatusCode::TOO_MANY_REQUESTS
                        || status == StatusCode::REQUEST_TIMEOUT
                        || (retry_on_conflict && status == StatusCode::CONFLICT);
                    if retryable && attempt < config.max_attempts {
                        tracing::debug!(%url, %status, attempt, "retrying S3 request");
                        replayed_unknown |= status.is_server_error();
                        tokio::time::sleep(config.backoff(attempt)).await;
                        continue;
                    }

                    if retryable {
                        // Out of retries on a failure that should have
                        // passed, so the store is struggling or unreachable.
                        // Plain answers, such as a 404 for an absent object,
                        // are not worth a warning.
                        tracing::warn!(
                            %url,
                            %status,
                            attempts = attempt,
                            "S3 request failed after retries"
                        );
                    }
                    let mut body = response.text().await.unwrap_or_default();
                    body.truncate(body.floor_char_boundary(ERROR_BODY_CAP));
                    break Err(Error::status(status, url, body));
                }
                Err(error) => {
                    if attempt < config.max_attempts && !error.is_builder() {
                        tracing::debug!(%url, %error, attempt, "retrying S3 request");
                        // A failed connection never carried the request.
                        replayed_unknown |= !error.is_connect();
                        tokio::time::sleep(config.backoff(attempt)).await;
                        continue;
                    }
                    tracing::warn!(
                        %url,
                        %error,
                        attempts = attempt,
                        "S3 request failed after retries"
                    );
                    break Err(Error::Transport {
                        url,
                        attempts: attempt,
                        source: error,
                    });
                }
            }
        };
        Sent {
            result,
            replayed_unknown,
        }
    }

    /// `GetObject`, honoring every [`GetObject`] field.
    ///
    /// The body resumes after a dropped connection or a short read. Each
    /// failure is followed by a request for just the bytes not yet
    /// delivered, with `If-Match` on the original ETag so the rest comes
    /// from the same version. The read fails instead if the response had no
    /// ETag, the object changed, or resuming runs out of attempts.
    pub async fn get_object(&self, key: &str, options: &GetObject) -> Result<GetObjectOutput> {
        let mut output = self.get_or_head(key, options, false).await?;
        if let Some(e_tag) = output.info.e_tag.clone() {
            output.body = resumable(
                self.clone(),
                key.to_string(),
                e_tag,
                output.info.version.clone(),
                output.range.clone(),
                output.body,
            );
        }
        Ok(output)
    }

    /// `HeadObject`, honoring every [`GetObject`] field. The body of the
    /// output is empty.
    pub async fn head_object(&self, key: &str, options: &GetObject) -> Result<GetObjectOutput> {
        self.get_or_head(key, options, true).await
    }

    /// `GetObject` without resuming, or `HeadObject`.
    pub(crate) async fn get_or_head(
        &self,
        key: &str,
        options: &GetObject,
        head: bool,
    ) -> Result<GetObjectOutput> {
        if let Some(range) = &options.range {
            range.validate()?;
        }

        let method = if head { Method::HEAD } else { Method::GET };
        let url = match &options.version {
            Some(version) => self.object_url(key, &[("versionId", version)])?,
            None => self.object_url(key, &[])?,
        };

        let mut request = reqwest::Request::new(method, url);
        let headers = request.headers_mut();
        if let Some(range) = &options.range {
            headers.insert(RANGE, header_value(&range.to_string())?);
        }
        if let Some(tag) = &options.if_match {
            headers.insert(IF_MATCH, header_value(tag)?);
        }
        if let Some(tag) = &options.if_none_match {
            headers.insert(IF_NONE_MATCH, header_value(tag)?);
        }
        if let Some(date) = &options.if_modified_since {
            headers.insert(IF_MODIFIED_SINCE, http_date(date)?);
        }
        if let Some(date) = &options.if_unmodified_since {
            headers.insert(IF_UNMODIFIED_SINCE, http_date(date)?);
        }

        let response = self.send(request, false).await?;

        let mut info = header_info(key, response.headers())?;
        let range = if let Some(expected) = &options.range {
            if response.status() != StatusCode::PARTIAL_CONTENT {
                return Err(Error::invalid(format!(
                    "range request for {key} returned {} instead of 206 Partial Content",
                    response.status(),
                )));
            }
            let content_range = response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| {
                    Error::invalid(format!("no Content-Range in partial response for {key}"))
                })?;
            let (actual, size) = parse_content_range(content_range).ok_or_else(|| {
                Error::invalid(format!("invalid Content-Range {content_range:?} for {key}"))
            })?;
            // Content-Range reports the size of the whole object, and
            // Content-Length only that of the returned slice.
            info.size = size;
            let expected = expected.resolve(size)?;
            if actual != expected {
                return Err(Error::invalid(format!(
                    "requested range {expected:?} for {key} but got {actual:?}",
                )));
            }
            actual
        } else {
            0..info.size
        };

        let attributes = header_attributes(response.headers())?;
        let body = if head {
            futures::stream::empty().boxed()
        } else {
            let url = response.url().to_string();
            response
                .bytes_stream()
                .map_err(move |source| Error::Body {
                    url: url.clone(),
                    source,
                })
                .boxed()
        };

        Ok(GetObjectOutput {
            info,
            attributes,
            range,
            body,
        })
    }

    /// `PutObject`, optionally conditional.
    ///
    /// An `If-Match` write over an object that has since been deleted fails
    /// with [`ErrorKind::PreconditionFailed`], as it does on most
    /// S3-compatible services; S3 itself answers 404.
    pub async fn put_object(
        &self,
        key: &str,
        body: Bytes,
        options: &PutObject,
    ) -> Result<PutObjectOutput> {
        let mut request = reqwest::Request::new(Method::PUT, self.object_url(key, &[])?);
        apply_attributes(
            request.headers_mut(),
            &options.attributes,
            options.tagging.as_deref(),
        )?;
        // S3 occasionally reports transient conflicts for concurrent
        // `If-Match` puts.
        let mut retry_on_conflict = false;
        match &options.condition {
            WriteCondition::None => {}
            WriteCondition::Absent => {
                request
                    .headers_mut()
                    .insert(IF_NONE_MATCH, HeaderValue::from_static("*"));
            }
            WriteCondition::Matches(tag) => {
                request.headers_mut().insert(IF_MATCH, header_value(tag)?);
                retry_on_conflict = true;
            }
        }
        *request.body_mut() = Some(body.clone().into());

        let sent = self
            .send_reporting_replays(request, retry_on_conflict)
            .await;
        let conditional = options.condition != WriteCondition::None;
        match sent.result {
            Ok(response) => Ok(put_output(response.headers())),
            // An earlier attempt may have written the object, so that the
            // replay failed only because it found that write. It succeeded
            // if the object now holds exactly these bytes.
            Err(error)
                if conditional
                    && sent.replayed_unknown
                    && matches!(
                        error.kind(),
                        ErrorKind::PreconditionFailed | ErrorKind::NotModified
                    ) =>
            {
                match self.stored_if_identical(key, &body).await? {
                    Some(result) => Ok(result),
                    None => Err(error),
                }
            }
            Err(error)
                if matches!(options.condition, WriteCondition::Matches(_))
                    && error.kind() == ErrorKind::NotFound =>
            {
                Err(error.with_kind(ErrorKind::PreconditionFailed))
            }
            Err(error) => Err(error),
        }
    }

    /// Read `key` back, returning its version if it holds exactly `body`
    /// and `None` if it holds anything else or nothing.
    ///
    /// This is how a conditional write recognizes its own earlier attempt.
    /// Comparing bytes, rather than an ETag, works for every S3-compatible
    /// service and encryption mode. Another writer storing identical bytes
    /// in between is indistinguishable, and harmless, since the object then
    /// holds what this write would have left.
    async fn stored_if_identical(
        &self,
        key: &str,
        body: &Bytes,
    ) -> Result<Option<PutObjectOutput>> {
        let stored = match self.get_object(key, &GetObject::default()).await {
            Ok(stored) => stored,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        if stored.info.size != body.len() as u64 {
            return Ok(None);
        }
        let info = stored.info.clone();
        let bytes = stored.bytes().await?;
        Ok((bytes == *body).then(|| put_output_of(info)))
    }

    /// `DeleteObject`. Deleting a nonexistent key succeeds, matching S3.
    pub async fn delete_object(&self, key: &str) -> Result<()> {
        let request = reqwest::Request::new(Method::DELETE, self.object_url(key, &[])?);
        self.send(request, false).await?;
        Ok(())
    }

    /// `CopyObject` within the bucket.
    pub async fn copy_object(&self, from: &str, to: &str) -> Result<()> {
        let source = format!("{}/{}", self.config().bucket, encode_key(from));
        let mut request = reqwest::Request::new(Method::PUT, self.object_url(to, &[])?);
        request
            .headers_mut()
            .insert(COPY_SOURCE_HEADER, header_value(&source)?);
        *request.body_mut() = Some(Bytes::new().into());
        self.send(request, false).await?;
        Ok(())
    }

    /// `CreateMultipartUpload`, returning the upload ID. The attributes and
    /// tags in `options` apply to the object the upload completes into; its
    /// condition is ignored.
    pub async fn create_multipart_upload(&self, key: &str, options: &PutObject) -> Result<String> {
        let url = self.object_url(key, &[("uploads", "")])?;
        let mut request = reqwest::Request::new(Method::POST, url);
        apply_attributes(
            request.headers_mut(),
            &options.attributes,
            options.tagging.as_deref(),
        )?;
        *request.body_mut() = Some(Bytes::new().into());

        let response = self.send(request, false).await?;
        let parsed: xml::InitiateMultipartUploadResult = xml_body(response).await?;
        Ok(parsed.upload_id)
    }

    /// `UploadPart`, returning the part's ETag. Part numbers start at 1.
    pub async fn upload_part(
        &self,
        key: &str,
        upload_id: &str,
        part_number: usize,
        body: Bytes,
    ) -> Result<String> {
        let part_number = part_number.to_string();
        let url = self.object_url(
            key,
            &[("partNumber", &part_number), ("uploadId", upload_id)],
        )?;
        let mut request = reqwest::Request::new(Method::PUT, url);
        *request.body_mut() = Some(body.into());

        let response = self.send(request, false).await?;
        let e_tag = response
            .headers()
            .get(ETAG)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| Error::invalid(format!("no ETag in UploadPart response for {key}")))?;
        Ok(e_tag.to_string())
    }

    /// `CompleteMultipartUpload` over the part ETags in part order.
    ///
    /// `size` is the total size of the parts and `attributes` what the
    /// upload was created with. Together they identify the completed object
    /// if a retried completion finds its upload consumed by an earlier
    /// attempt that took effect. A unique user metadata value, such as
    /// SlateDB's put ID, makes that match exact.
    pub async fn complete_multipart_upload(
        &self,
        key: &str,
        upload_id: &str,
        part_etags: Vec<String>,
        size: u64,
        attributes: &ObjectAttributes,
    ) -> Result<PutObjectOutput> {
        let parts = xml::CompleteMultipartUpload {
            part: part_etags
                .into_iter()
                .enumerate()
                .map(|(idx, e_tag)| xml::CompletedPart {
                    e_tag,
                    part_number: idx + 1,
                })
                .collect(),
        };
        let body = xml::serialize(&parts)
            .map_err(|e| Error::invalid_from("could not serialize the part list", e))?;
        let url = self.object_url(key, &[("uploadId", upload_id)])?;
        let mut request = reqwest::Request::new(Method::POST, url);
        *request.body_mut() = Some(Bytes::from(body).into());

        let sent = self.send_reporting_replays(request, false).await;
        let response = match sent.result {
            Ok(response) => response,
            // A replay of a completion that took effect finds its upload
            // consumed. Nothing else consumes an upload this client still
            // holds, so the object now in place is this upload's if it has
            // the size of the parts and the upload's user metadata.
            Err(error) if error.kind() == ErrorKind::NotFound && sent.replayed_unknown => {
                return match self.head_object(key, &GetObject::default()).await {
                    Ok(stored)
                        if stored.info.size == size
                            && stored.attributes.has_metadata(&attributes.metadata) =>
                    {
                        Ok(put_output_of(stored.info))
                    }
                    Ok(_) => Err(error),
                    Err(other) if other.kind() == ErrorKind::NotFound => Err(error),
                    Err(other) => Err(other),
                };
            }
            Err(error) => return Err(error),
        };
        let version = header_string(response.headers(), VERSION_HEADER);
        let parsed: xml::CompleteMultipartUploadResult = xml_body(response).await?;
        Ok(PutObjectOutput {
            e_tag: Some(parsed.e_tag),
            version,
        })
    }

    /// `AbortMultipartUpload`.
    pub async fn abort_multipart_upload(&self, key: &str, upload_id: &str) -> Result<()> {
        let url = self.object_url(key, &[("uploadId", upload_id)])?;
        let request = reqwest::Request::new(Method::DELETE, url);
        self.send(request, false).await?;
        Ok(())
    }

    /// One `ListObjectsV2` page.
    pub async fn list_objects_v2(&self, options: &ListObjects) -> Result<ListPage> {
        let mut query: Vec<(&str, &str)> = Vec::with_capacity(5);
        if let Some(token) = &options.continuation_token {
            query.push(("continuation-token", token));
        }
        if options.delimiter {
            query.push(("delimiter", "/"));
        }
        query.push(("list-type", "2"));
        if let Some(prefix) = &options.prefix {
            query.push(("prefix", prefix));
        }
        if let Some(start_after) = &options.start_after {
            query.push(("start-after", start_after));
        }

        let mut url = parse_url(&self.config().bucket_endpoint)?;
        url.set_query(Some(&query_string(&query)));
        let request = reqwest::Request::new(Method::GET, url);

        let response = self.send(request, false).await?;
        let parsed: xml::ListBucketResult = xml_body(response).await?;
        Ok(ListPage {
            objects: parsed
                .contents
                .into_iter()
                .map(|c| ObjectInfo {
                    key: c.key,
                    size: c.size,
                    last_modified: Some(c.last_modified),
                    e_tag: c.e_tag,
                    version: None,
                })
                .collect(),
            common_prefixes: parsed
                .common_prefixes
                .into_iter()
                .map(|p| p.prefix)
                .collect(),
            next_continuation_token: parsed.next_continuation_token,
        })
    }

    /// Every page of a `ListObjectsV2` listing, starting from `options`.
    pub fn list_pages(&self, options: ListObjects) -> BoxStream<'static, Result<ListPage>> {
        let client = self.clone();
        // The state is the options for the next page, or `None` once the
        // last page is out.
        futures::stream::try_unfold(Some(options), move |options| {
            let client = client.clone();
            async move {
                let Some(mut options) = options else {
                    return Ok(None);
                };
                let page = client.list_objects_v2(&options).await?;
                let next = page.next_continuation_token.clone().map(|token| {
                    options.continuation_token = Some(token);
                    options
                });
                Ok(Some((page, next)))
            }
        })
        .boxed()
    }
}

fn parse_url(url: &str) -> Result<reqwest::Url> {
    reqwest::Url::parse(url)
        .map_err(|e| Error::invalid_from(format!("invalid request URL {url}"), e))
}

/// Percent-encode an object key for use in a URL path, preserving `/`.
fn encode_key(key: &str) -> PercentEncode<'_> {
    utf8_percent_encode(key, &STRICT_PATH_ENCODE_SET)
}

/// `response`'s body, an XML document of a `T`.
async fn xml_body<T: serde::de::DeserializeOwned>(response: Response) -> Result<T> {
    let url = response.url().to_string();
    let body = response.bytes().await.map_err(|source| Error::Body {
        url: url.clone(),
        source,
    })?;
    xml::parse(&body)
        .map_err(|e| Error::invalid_from(format!("invalid XML response from {url}"), e))
}

fn header_value(value: &str) -> Result<HeaderValue> {
    HeaderValue::from_str(value)
        .map_err(|e| Error::invalid_from(format!("invalid header value {value:?}"), e))
}

fn http_date(date: &DateTime<Utc>) -> Result<HeaderValue> {
    header_value(&date.format(HTTP_DATE_FORMAT).to_string())
}

fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

/// Build [`ObjectInfo`] from `GetObject`/`HeadObject` response headers.
///
/// `Content-Length` is required. `ETag`, `Last-Modified`, and the version
/// header are optional, since S3-compatible services differ there.
fn header_info(key: &str, headers: &HeaderMap) -> Result<ObjectInfo> {
    let last_modified = headers
        .get(LAST_MODIFIED)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| DateTime::parse_from_rfc2822(v).ok())
        .map(|v| v.with_timezone(&Utc));

    let size = headers
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| Error::invalid(format!("no valid Content-Length in response for {key}")))?;

    Ok(ObjectInfo {
        key: key.to_string(),
        size,
        last_modified,
        e_tag: header_string(headers, ETAG.as_str()),
        version: header_string(headers, VERSION_HEADER),
    })
}

/// The version an existing object's metadata identifies.
fn put_output_of(info: ObjectInfo) -> PutObjectOutput {
    PutObjectOutput {
        e_tag: info.e_tag,
        version: info.version,
    }
}

fn put_output(headers: &HeaderMap) -> PutObjectOutput {
    PutObjectOutput {
        e_tag: header_string(headers, ETAG.as_str()),
        version: header_string(headers, VERSION_HEADER),
    }
}

/// Parse a `Content-Range` header of the form `bytes <start>-<end>/<size>`,
/// returning the half-open returned range and the total object size.
fn parse_content_range(value: &str) -> Option<(Range<u64>, u64)> {
    let rem = value.trim().strip_prefix("bytes ")?;
    let (range, size) = rem.split_once('/')?;
    let size = size.parse().ok()?;
    let (start, end) = range.split_once('-')?;
    let start: u64 = start.parse().ok()?;
    let end: u64 = end.parse().ok()?;
    Some((start..end + 1, size))
}

/// The standard headers [`ObjectAttributes`] carries, besides metadata and
/// storage class.
fn standard_headers(attributes: &ObjectAttributes) -> [(HeaderName, Option<&String>); 5] {
    [
        (CACHE_CONTROL, attributes.cache_control.as_ref()),
        (CONTENT_DISPOSITION, attributes.content_disposition.as_ref()),
        (CONTENT_ENCODING, attributes.content_encoding.as_ref()),
        (CONTENT_LANGUAGE, attributes.content_language.as_ref()),
        (CONTENT_TYPE, attributes.content_type.as_ref()),
    ]
}

/// Map attributes and tags onto their standard HTTP and `x-amz-` request
/// headers.
fn apply_attributes(
    headers: &mut HeaderMap,
    attributes: &ObjectAttributes,
    tagging: Option<&str>,
) -> Result<()> {
    if let Some(tagging) = tagging.filter(|t| !t.is_empty()) {
        headers.insert(TAGS_HEADER, header_value(tagging)?);
    }
    for (name, value) in standard_headers(attributes) {
        if let Some(value) = value {
            headers.insert(name, header_value(value)?);
        }
    }
    if let Some(class) = &attributes.storage_class {
        headers.insert(STORAGE_CLASS_HEADER, header_value(class)?);
    }
    for (key, value) in &attributes.metadata {
        let name = format!("{USER_METADATA_PREFIX}{key}");
        let name: HeaderName = name
            .parse()
            .map_err(|e| Error::invalid_from(format!("invalid metadata key {key:?}"), e))?;
        headers.insert(name, header_value(value)?);
    }
    Ok(())
}

/// Extract [`ObjectAttributes`] from `GetObject`/`HeadObject` response
/// headers.
fn header_attributes(headers: &HeaderMap) -> Result<ObjectAttributes> {
    let text = |name: &HeaderName, value: &HeaderValue| {
        value
            .to_str()
            .map(str::to_string)
            .map_err(|e| Error::invalid_from(format!("non-ASCII {name} header"), e))
    };
    let mut attributes = ObjectAttributes::default();
    let standard = |name: HeaderName| -> Result<Option<String>> {
        headers
            .get(&name)
            .map(|value| text(&name, value))
            .transpose()
    };
    attributes.cache_control = standard(CACHE_CONTROL)?;
    attributes.content_disposition = standard(CONTENT_DISPOSITION)?;
    attributes.content_encoding = standard(CONTENT_ENCODING)?;
    attributes.content_language = standard(CONTENT_LANGUAGE)?;
    attributes.content_type = standard(CONTENT_TYPE)?;
    let mut metadata = BTreeMap::new();
    for (name, value) in headers {
        if let Some(key) = name.as_str().strip_prefix(USER_METADATA_PREFIX) {
            metadata.insert(key.to_string(), text(name, value)?);
        }
    }
    attributes.metadata = metadata;
    Ok(attributes)
}
