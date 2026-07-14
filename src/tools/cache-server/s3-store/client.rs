// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Low-level S3 REST client built on reqwest.
//!
//! Every operation here is a thin, explicit mapping onto one S3 REST call:
//! requests carry in-memory bodies (so they can be replayed for retries and
//! their SHA-256 payload hash signed), responses map onto `object_store`
//! types, and HTTP statuses map onto `object_store` error variants the same
//! way the upstream AWS implementation does.

use std::ops::Range;
use std::time::Duration;

use bytes::Bytes;
use futures::TryStreamExt as _;
use object_store::path::Path;
use object_store::{
    Attribute, Attributes, GetOptions, GetResult, GetResultPayload, ListResult, ObjectMeta,
    PutPayload, PutResult, TagSet,
};
use percent_encoding::{PercentEncode, utf8_percent_encode};
use reqwest::header::{
    CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_ENCODING, CONTENT_LANGUAGE, CONTENT_LENGTH,
    CONTENT_RANGE, CONTENT_TYPE, ETAG, HeaderMap, IF_MATCH, IF_MODIFIED_SINCE, IF_NONE_MATCH,
    IF_UNMODIFIED_SINCE, LAST_MODIFIED, RANGE,
};
use reqwest::{Method, Response, StatusCode};

use crate::sigv4::{self, Credentials, EMPTY_SHA256, STRICT_ENCODE_SET, STRICT_PATH_ENCODE_SET};
use crate::xml;

/// Store name used in [`object_store::Error::Generic`] errors.
pub(crate) const STORE: &str = "S3";

/// HTTP date format for conditional request headers (RFC 7231 IMF-fixdate).
const HTTP_DATE_FORMAT: &str = "%a, %d %b %Y %H:%M:%S GMT";

const VERSION_HEADER: &str = "x-amz-version-id";
const USER_METADATA_PREFIX: &str = "x-amz-meta-";
const TAGS_HEADER: &str = "x-amz-tagging";
const COPY_SOURCE_HEADER: &str = "x-amz-copy-source";
const STORAGE_CLASS_HEADER: &str = "x-amz-storage-class";

/// How many response body bytes to preserve in error messages.
const ERROR_BODY_CAP: usize = 2048;

type Result<T, E = object_store::Error> = std::result::Result<T, E>;

/// Resolved connection configuration for a bucket.
#[derive(Debug)]
pub(crate) struct S3Config {
    /// Bucket name, used for `x-amz-copy-source` headers.
    pub bucket: String,
    /// Signing region.
    pub region: String,
    /// Base URL addressing the bucket, without a trailing slash: either
    /// `https://{bucket}.{host}` (virtual-hosted style) or
    /// `{endpoint}/{bucket}` (path style).
    pub bucket_endpoint: String,
    /// `None` sends unsigned (anonymous) requests.
    pub credentials: Option<Credentials>,
    /// Maximum request attempts (first try plus retries).
    pub max_attempts: usize,
    /// Base delay for exponential retry backoff.
    pub retry_backoff: Duration,
}

/// A low-level S3 REST client for a single bucket.
#[derive(Debug)]
pub(crate) struct S3Client {
    pub config: S3Config,
    http: reqwest::Client,
}

/// The transport-level failure detail attached to mapped errors.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RequestError {
    #[error("HTTP {status} from {url}: {body}")]
    Status {
        status: StatusCode,
        url: String,
        body: String,
    },
    #[error("request to {url} failed after {attempts} attempt(s): {source}")]
    Transport {
        url: String,
        attempts: usize,
        source: reqwest::Error,
    },
}

/// Map an HTTP error status onto the corresponding `object_store` error
/// variant, mirroring the upstream AWS implementation.
fn status_error(path: &str, status: StatusCode, url: String, body: String) -> object_store::Error {
    let path = path.to_string();
    let source: Box<dyn std::error::Error + Send + Sync> =
        Box::new(RequestError::Status { status, url, body });
    match status {
        StatusCode::NOT_FOUND => object_store::Error::NotFound { path, source },
        StatusCode::NOT_MODIFIED => object_store::Error::NotModified { path, source },
        StatusCode::PRECONDITION_FAILED => object_store::Error::Precondition { path, source },
        StatusCode::CONFLICT => object_store::Error::AlreadyExists { path, source },
        StatusCode::FORBIDDEN => object_store::Error::PermissionDenied { path, source },
        StatusCode::UNAUTHORIZED => object_store::Error::Unauthenticated { path, source },
        _ => object_store::Error::Generic {
            store: STORE,
            source,
        },
    }
}

fn generic<E: std::error::Error + Send + Sync + 'static>(source: E) -> object_store::Error {
    object_store::Error::Generic {
        store: STORE,
        source: Box::new(source),
    }
}

fn generic_msg(message: impl Into<String>) -> object_store::Error {
    object_store::Error::Generic {
        store: STORE,
        source: message.into().into(),
    }
}

/// Percent-encode an object key for use in a URL path, preserving `/`.
pub(crate) fn encode_path(path: &Path) -> PercentEncode<'_> {
    utf8_percent_encode(path.as_ref(), &STRICT_PATH_ENCODE_SET)
}

/// Build a query string from `pairs` with SigV4-compatible encoding.
///
/// reqwest's `query()` uses form encoding (spaces become `+`), which S3
/// implementations do not uniformly decode; encoding with the strict set
/// (spaces become `%20`) keeps the wire format identical to the canonical
/// form used for signing.
fn query_string(pairs: &[(&str, &str)]) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    for (idx, (key, value)) in pairs.iter().enumerate() {
        if idx != 0 {
            out.push('&');
        }
        let _ = write!(
            out,
            "{}={}",
            utf8_percent_encode(key, &STRICT_ENCODE_SET),
            utf8_percent_encode(value, &STRICT_ENCODE_SET),
        );
    }
    out
}

/// Extra knobs for a `PutObject`-shaped request.
#[derive(Debug, Default)]
pub(crate) struct PutRequestOptions<'a> {
    pub if_none_match: Option<&'a str>,
    pub if_match: Option<&'a str>,
    /// Retry `409 Conflict` responses: S3 occasionally reports transient
    /// conflicts for concurrent `If-Match` puts.
    pub retry_on_conflict: bool,
}

/// One page of a `ListObjectsV2` listing.
pub(crate) struct ListPage {
    pub result: ListResult,
    pub next_token: Option<String>,
}

impl S3Client {
    pub(crate) fn new(config: S3Config, http: reqwest::Client) -> Self {
        Self { config, http }
    }

    fn object_url(&self, location: &Path) -> String {
        format!("{}/{}", self.config.bucket_endpoint, encode_path(location))
    }

    fn parse_url(&self, url: &str) -> Result<reqwest::Url> {
        reqwest::Url::parse(url).map_err(|e| generic_msg(format!("invalid request URL {url}: {e}")))
    }

    /// Execute `request` with SigV4 signing and bounded retries.
    ///
    /// Transport failures and retryable statuses (408, 429, 5xx, and 409 when
    /// `retry_on_conflict` is set) are retried with exponential backoff, and
    /// the request is re-signed with a fresh timestamp on every attempt. Any
    /// remaining non-success status maps onto an `object_store` error via
    /// [`status_error`].
    async fn send(
        &self,
        request: reqwest::Request,
        payload_sha256: &str,
        retry_on_conflict: bool,
        op_path: &str,
    ) -> Result<Response> {
        let url = request.url().to_string();
        let max_attempts = self.config.max_attempts.max(1);
        let mut attempt = 0usize;
        loop {
            attempt += 1;
            let mut req = request
                .try_clone()
                .expect("S3 request bodies are buffered and cloneable");
            if let Some(credentials) = &self.config.credentials {
                sigv4::sign_request(&mut req, credentials, &self.config.region, payload_sha256);
            }

            let backoff = self
                .config
                .retry_backoff
                .saturating_mul(1u32 << (attempt - 1).min(16) as u32);

            match self.http.execute(req).await {
                Ok(response) => {
                    let status = response.status();
                    if status.is_success() {
                        return Ok(response);
                    }

                    let retryable = status.is_server_error()
                        || status == StatusCode::TOO_MANY_REQUESTS
                        || status == StatusCode::REQUEST_TIMEOUT
                        || (retry_on_conflict && status == StatusCode::CONFLICT);
                    if retryable && attempt < max_attempts {
                        tracing::debug!(%url, %status, attempt, "retrying S3 request");
                        tokio::time::sleep(backoff).await;
                        continue;
                    }

                    let body = match response.text().await {
                        Ok(mut text) => {
                            text.truncate(ERROR_BODY_CAP);
                            text
                        }
                        Err(_) => String::new(),
                    };
                    return Err(status_error(op_path, status, url, body));
                }
                Err(error) => {
                    if attempt < max_attempts && !error.is_builder() {
                        tracing::debug!(%url, %error, attempt, "retrying S3 request");
                        tokio::time::sleep(backoff).await;
                        continue;
                    }
                    return Err(generic(RequestError::Transport {
                        url,
                        attempts: attempt,
                        source: error,
                    }));
                }
            }
        }
    }

    /// `GetObject`/`HeadObject`, honoring every [`GetOptions`] field.
    pub(crate) async fn get_opts(&self, location: &Path, options: GetOptions) -> Result<GetResult> {
        if let Some(range) = &options.range {
            range.is_valid().map_err(generic)?;
        }

        let method = if options.head {
            Method::HEAD
        } else {
            Method::GET
        };
        let mut url = self.parse_url(&self.object_url(location))?;
        if let Some(version) = &options.version {
            url.set_query(Some(&query_string(&[("versionId", version)])));
        }

        let mut request = reqwest::Request::new(method, url);
        let headers = request.headers_mut();
        if let Some(range) = &options.range {
            headers.insert(RANGE, try_header_value(&range.to_string())?);
        }
        if let Some(tag) = &options.if_match {
            headers.insert(IF_MATCH, try_header_value(tag)?);
        }
        if let Some(tag) = &options.if_none_match {
            headers.insert(IF_NONE_MATCH, try_header_value(tag)?);
        }
        if let Some(date) = &options.if_modified_since {
            let value = date.format(HTTP_DATE_FORMAT).to_string();
            headers.insert(IF_MODIFIED_SINCE, try_header_value(&value)?);
        }
        if let Some(date) = &options.if_unmodified_since {
            let value = date.format(HTTP_DATE_FORMAT).to_string();
            headers.insert(IF_UNMODIFIED_SINCE, try_header_value(&value)?);
        }

        let response = self
            .send(request, EMPTY_SHA256, false, location.as_ref())
            .await?;

        let mut meta = header_meta(location, response.headers())?;
        let range = if let Some(expected) = &options.range {
            if response.status() != StatusCode::PARTIAL_CONTENT {
                return Err(generic_msg(format!(
                    "range request for {location} returned {} instead of 206 Partial Content",
                    response.status(),
                )));
            }
            let content_range = response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| {
                    generic_msg(format!(
                        "no Content-Range in partial response for {location}"
                    ))
                })?;
            let parsed = parse_content_range(content_range).ok_or_else(|| {
                generic_msg(format!(
                    "invalid Content-Range {content_range:?} for {location}"
                ))
            })?;
            // the size parsed from Content-Range reflects the whole object,
            // Content-Length only the returned slice
            meta.size = parsed.1;
            let actual = parsed.0;
            let expected = expected.as_range(meta.size).map_err(generic)?;
            if actual != expected {
                return Err(generic_msg(format!(
                    "requested range {expected:?} for {location} but got {actual:?}",
                )));
            }
            actual
        } else {
            0..meta.size
        };

        let attributes = header_attributes(response.headers())?;
        let payload = if options.head {
            GetResultPayload::Stream(Box::pin(futures::stream::empty()))
        } else {
            GetResultPayload::Stream(Box::pin(response.bytes_stream().map_err(generic)))
        };

        Ok(GetResult {
            payload,
            meta,
            range,
            attributes,
            extensions: Default::default(),
        })
    }

    /// `PutObject`, optionally conditional.
    pub(crate) async fn put(
        &self,
        location: &Path,
        payload: PutPayload,
        attributes: &Attributes,
        tags: &TagSet,
        options: PutRequestOptions<'_>,
    ) -> Result<PutResult> {
        let body = Bytes::from(payload);
        let payload_sha256 = sigv4::sha256_hex(&body);

        let url = self.parse_url(&self.object_url(location))?;
        let mut request = reqwest::Request::new(Method::PUT, url);
        apply_attributes(request.headers_mut(), attributes)?;
        if !tags.encoded().is_empty() {
            let value = try_header_value(tags.encoded())?;
            request.headers_mut().insert(TAGS_HEADER, value);
        }
        if let Some(tag) = options.if_none_match {
            request
                .headers_mut()
                .insert(IF_NONE_MATCH, try_header_value(tag)?);
        }
        if let Some(tag) = options.if_match {
            request
                .headers_mut()
                .insert(IF_MATCH, try_header_value(tag)?);
        }
        *request.body_mut() = Some(body.into());

        let response = self
            .send(
                request,
                &payload_sha256,
                options.retry_on_conflict,
                location.as_ref(),
            )
            .await?;
        Ok(put_result(response.headers()))
    }

    /// `DeleteObject`. Deleting a nonexistent key succeeds, matching S3.
    pub(crate) async fn delete(&self, location: &Path) -> Result<()> {
        let url = self.parse_url(&self.object_url(location))?;
        let request = reqwest::Request::new(Method::DELETE, url);
        self.send(request, EMPTY_SHA256, false, location.as_ref())
            .await?;
        Ok(())
    }

    /// `CopyObject` (server-side, within the bucket).
    pub(crate) async fn copy(&self, from: &Path, to: &Path) -> Result<()> {
        let source = format!("{}/{}", self.config.bucket, encode_path(from));
        let url = self.parse_url(&self.object_url(to))?;
        let mut request = reqwest::Request::new(Method::PUT, url);
        request
            .headers_mut()
            .insert(COPY_SOURCE_HEADER, try_header_value(&source)?);
        *request.body_mut() = Some(Bytes::new().into());
        self.send(request, EMPTY_SHA256, false, to.as_ref()).await?;
        Ok(())
    }

    /// `CreateMultipartUpload`, returning the upload ID.
    pub(crate) async fn create_multipart(&self, location: &Path) -> Result<String> {
        let mut url = self.parse_url(&self.object_url(location))?;
        url.set_query(Some("uploads="));
        let mut request = reqwest::Request::new(Method::POST, url);
        *request.body_mut() = Some(Bytes::new().into());

        let response = self
            .send(request, EMPTY_SHA256, false, location.as_ref())
            .await?;
        let body = response.bytes().await.map_err(generic)?;
        let parsed: xml::InitiateMultipartUploadResult = xml::parse(&body).map_err(generic)?;
        Ok(parsed.upload_id)
    }

    /// `UploadPart`; `part_idx` is zero-based, part numbers are one-based.
    pub(crate) async fn put_part(
        &self,
        location: &Path,
        upload_id: &str,
        part_idx: usize,
        payload: PutPayload,
    ) -> Result<String> {
        let body = Bytes::from(payload);
        let payload_sha256 = sigv4::sha256_hex(&body);

        let part_number = (part_idx + 1).to_string();
        let mut url = self.parse_url(&self.object_url(location))?;
        url.set_query(Some(&query_string(&[
            ("partNumber", &part_number),
            ("uploadId", upload_id),
        ])));
        let mut request = reqwest::Request::new(Method::PUT, url);
        *request.body_mut() = Some(body.into());

        let response = self
            .send(request, &payload_sha256, false, location.as_ref())
            .await?;
        let e_tag = response
            .headers()
            .get(ETAG)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| generic_msg(format!("no ETag in UploadPart response for {location}")))?;
        Ok(e_tag.to_string())
    }

    /// `CompleteMultipartUpload` over the ordered part ETags.
    pub(crate) async fn complete_multipart(
        &self,
        location: &Path,
        upload_id: &str,
        part_etags: Vec<String>,
    ) -> Result<PutResult> {
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
        let body = Bytes::from(xml::serialize(&parts).map_err(generic)?);
        let payload_sha256 = sigv4::sha256_hex(&body);

        let mut url = self.parse_url(&self.object_url(location))?;
        url.set_query(Some(&query_string(&[("uploadId", upload_id)])));
        let mut request = reqwest::Request::new(Method::POST, url);
        *request.body_mut() = Some(body.into());

        let response = self
            .send(request, &payload_sha256, false, location.as_ref())
            .await?;
        let version = header_string(response.headers(), VERSION_HEADER);
        let body = response.bytes().await.map_err(generic)?;
        let parsed: xml::CompleteMultipartUploadResult = xml::parse(&body).map_err(generic)?;
        Ok(PutResult {
            e_tag: Some(parsed.e_tag),
            version,
            extensions: Default::default(),
        })
    }

    /// `AbortMultipartUpload`.
    pub(crate) async fn abort_multipart(&self, location: &Path, upload_id: &str) -> Result<()> {
        let mut url = self.parse_url(&self.object_url(location))?;
        url.set_query(Some(&query_string(&[("uploadId", upload_id)])));
        let request = reqwest::Request::new(Method::DELETE, url);
        self.send(request, EMPTY_SHA256, false, location.as_ref())
            .await?;
        Ok(())
    }

    /// One `ListObjectsV2` page.
    ///
    /// `prefix` is passed through verbatim (callers append the delimiter),
    /// `offset` maps onto `start-after`, and `token` onto
    /// `continuation-token`.
    pub(crate) async fn list_page(
        &self,
        prefix: Option<&str>,
        delimiter: bool,
        offset: Option<&str>,
        token: Option<&str>,
    ) -> Result<ListPage> {
        let mut query: Vec<(&str, &str)> = Vec::with_capacity(5);
        if let Some(token) = token {
            query.push(("continuation-token", token));
        }
        if delimiter {
            query.push(("delimiter", "/"));
        }
        query.push(("list-type", "2"));
        if let Some(prefix) = prefix {
            query.push(("prefix", prefix));
        }
        if let Some(offset) = offset {
            query.push(("start-after", offset));
        }

        let mut url = self.parse_url(&self.config.bucket_endpoint)?;
        url.set_query(Some(&query_string(&query)));
        let request = reqwest::Request::new(Method::GET, url);

        let response = self
            .send(request, EMPTY_SHA256, false, prefix.unwrap_or_default())
            .await?;
        let body = response.bytes().await.map_err(generic)?;
        let mut parsed: xml::ListBucketResult = xml::parse(&body).map_err(generic)?;
        let next_token = parsed.next_continuation_token.take();

        let common_prefixes = parsed
            .common_prefixes
            .into_iter()
            .map(|p| Ok(Path::parse(p.prefix)?))
            .collect::<Result<Vec<_>>>()?;
        let objects = parsed
            .contents
            .into_iter()
            .map(|c| {
                Ok(ObjectMeta {
                    location: Path::parse(c.key)?,
                    last_modified: c.last_modified,
                    size: c.size,
                    e_tag: c.e_tag,
                    version: None,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        Ok(ListPage {
            result: ListResult {
                common_prefixes,
                objects,
                extensions: Default::default(),
            },
            next_token,
        })
    }
}

fn try_header_value(value: &str) -> Result<reqwest::header::HeaderValue> {
    reqwest::header::HeaderValue::from_str(value)
        .map_err(|e| generic_msg(format!("invalid header value {value:?}: {e}")))
}

fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

/// Build [`ObjectMeta`] from `GetObject`/`HeadObject` response headers.
///
/// `Content-Length` is required; `ETag`, `Last-Modified`, and the version
/// header are optional, matching how lenient the upstream S3 implementation
/// is about S3-compatible services.
fn header_meta(location: &Path, headers: &HeaderMap) -> Result<ObjectMeta> {
    let last_modified = headers
        .get(LAST_MODIFIED)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| chrono::DateTime::parse_from_rfc2822(v).ok())
        .map(|v| v.with_timezone(&chrono::Utc))
        .unwrap_or_default();

    let size = headers
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| {
            generic_msg(format!(
                "no valid Content-Length in response for {location}"
            ))
        })?;

    Ok(ObjectMeta {
        location: location.clone(),
        last_modified,
        size,
        e_tag: header_string(headers, ETAG.as_str()),
        version: header_string(headers, VERSION_HEADER),
    })
}

fn put_result(headers: &HeaderMap) -> PutResult {
    PutResult {
        e_tag: header_string(headers, ETAG.as_str()),
        version: header_string(headers, VERSION_HEADER),
        extensions: Default::default(),
    }
}

/// Parse a `Content-Range` header of the form `bytes <start>-<end>/<size>`,
/// returning the (half-open) returned range and the total object size.
fn parse_content_range(value: &str) -> Option<(Range<u64>, u64)> {
    let rem = value.trim().strip_prefix("bytes ")?;
    let (range, size) = rem.split_once('/')?;
    let size = size.parse().ok()?;
    let (start, end) = range.split_once('-')?;
    let start: u64 = start.parse().ok()?;
    let end: u64 = end.parse().ok()?;
    Some((start..end + 1, size))
}

/// Map [`Attributes`] onto their standard HTTP / `x-amz-` request headers.
fn apply_attributes(headers: &mut HeaderMap, attributes: &Attributes) -> Result<()> {
    for (attribute, value) in attributes {
        let name = match attribute {
            Attribute::CacheControl => CACHE_CONTROL,
            Attribute::ContentDisposition => CONTENT_DISPOSITION,
            Attribute::ContentEncoding => CONTENT_ENCODING,
            Attribute::ContentLanguage => CONTENT_LANGUAGE,
            Attribute::ContentType => CONTENT_TYPE,
            Attribute::StorageClass => {
                headers.insert(STORAGE_CLASS_HEADER, try_header_value(value)?);
                continue;
            }
            Attribute::Metadata(key) => {
                let name = format!("{USER_METADATA_PREFIX}{key}");
                let name: reqwest::header::HeaderName = name
                    .parse()
                    .map_err(|e| generic_msg(format!("invalid metadata key {key:?}: {e}")))?;
                headers.insert(name, try_header_value(value)?);
                continue;
            }
            other => {
                return Err(object_store::Error::NotSupported {
                    source: format!("unsupported attribute {other:?}").into(),
                });
            }
        };
        headers.insert(name, try_header_value(value)?);
    }
    Ok(())
}

/// Extract [`Attributes`] from `GetObject`/`HeadObject` response headers.
fn header_attributes(headers: &HeaderMap) -> Result<Attributes> {
    let mut attributes = Attributes::new();
    let known = [
        (CACHE_CONTROL, Attribute::CacheControl),
        (CONTENT_DISPOSITION, Attribute::ContentDisposition),
        (CONTENT_ENCODING, Attribute::ContentEncoding),
        (CONTENT_LANGUAGE, Attribute::ContentLanguage),
        (CONTENT_TYPE, Attribute::ContentType),
    ];
    for (name, attribute) in known {
        if let Some(value) = headers.get(&name) {
            let value = value
                .to_str()
                .map_err(|e| generic_msg(format!("non-ASCII {name} header: {e}")))?;
            attributes.insert(attribute, value.to_string().into());
        }
    }
    for (name, value) in headers {
        if let Some(key) = name.as_str().strip_prefix(USER_METADATA_PREFIX) {
            let value = value
                .to_str()
                .map_err(|e| generic_msg(format!("non-ASCII {name} header: {e}")))?;
            attributes.insert(
                Attribute::Metadata(key.to_string().into()),
                value.to_string().into(),
            );
        }
    }
    Ok(attributes)
}
