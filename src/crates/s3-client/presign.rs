// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Presigned requests: S3 access for processes that hold no credentials.
//!
//! A process with credentials signs a request ahead of time with
//! [`Client::presign_get_object`], [`Client::presign_put_object`] or
//! [`Client::presign_upload_part`], and hands the [`PresignedRequest`] to
//! one without credentials, which sends it with a [`PresignedClient`] until
//! it expires. The signature covers the method, the object, the query and
//! the headers named when signing, and nothing else, so a presigned
//! `GetObject` serves any range of its object and a presigned `PutObject`
//! takes any body.
//!
//! The query of a presigned URL grants access to its object to whoever
//! reads it, so [`PresignedClient`] leaves it out of errors and logs, and
//! [`PresignedRequest`]'s `Debug` output leaves it out too.

use std::time::Duration;

use bytes::Bytes;
use chrono::{DateTime, Utc};
use reqwest::Method;
use reqwest::header::{HeaderMap, HeaderName, IF_MATCH};

use crate::body::{Source, resumable};
use crate::client::{
    Client, apply_attributes, apply_condition, apply_read_options, header_value, part_e_tag,
    put_output, read_output, write_error,
};
use crate::error::{Error, Result};
use crate::sigv4;
use crate::transport::{Transport, redact_query};
use crate::types::{GetObject, GetObjectOutput, PutObject, PutObjectOutput};

/// The longest a presigned request can stay valid, which is what S3
/// accepts.
pub const MAX_PRESIGNED_EXPIRY: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// A request signed ahead of time, which anyone holding it can send until
/// it expires.
///
/// Every field is a plain string or time, so the request can travel in any
/// message format. Send it with [`PresignedClient`].
#[derive(Clone, PartialEq, Eq)]
pub struct PresignedRequest {
    /// The HTTP method, such as `GET`.
    pub method: String,
    /// The URL, with the signature in its query.
    pub url: String,
    /// The headers the request must carry, exactly as signed, with
    /// lower-case names.
    pub headers: Vec<(String, String)>,
    /// When the signature stops working, by the signer's clock.
    pub expires_at: DateTime<Utc>,
}

impl std::fmt::Debug for PresignedRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PresignedRequest")
            .field("method", &self.method)
            .field("url", &self.display_url())
            .field("headers", &self.headers)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl PresignedRequest {
    /// The URL as errors and logs show it, without the query, which holds
    /// the signature.
    pub(crate) fn display_url(&self) -> String {
        redact_query(&self.url)
    }
}

impl Client {
    /// A presigned `GetObject` of `key`, valid for `expires_in`.
    ///
    /// The holder may ask for any range of the object and add the
    /// conditions of [`GetObject`], but not choose a version.
    pub fn presign_get_object(&self, key: &str, expires_in: Duration) -> Result<PresignedRequest> {
        let url = self.object_url(key, &[])?;
        self.presign_at(Method::GET, url, HeaderMap::new(), expires_in, Utc::now())
    }

    /// A presigned `PutObject` of `key`, valid for `expires_in`.
    ///
    /// The condition, attributes and tags in `options` are signed, so the
    /// holder must send them and cannot change them. `WriteCondition::Absent`
    /// makes the URL good for creating the object and never for replacing
    /// it.
    pub fn presign_put_object(
        &self,
        key: &str,
        options: &PutObject,
        expires_in: Duration,
    ) -> Result<PresignedRequest> {
        let mut headers = HeaderMap::new();
        apply_attributes(
            &mut headers,
            &options.attributes,
            options.tagging.as_deref(),
        )?;
        apply_condition(&mut headers, &options.condition)?;
        let url = self.object_url(key, &[])?;
        self.presign_at(Method::PUT, url, headers, expires_in, Utc::now())
    }

    /// A presigned `UploadPart` of part `part_number` of multipart upload
    /// `upload_id` of `key`, valid for `expires_in`. Part numbers start at
    /// 1.
    ///
    /// Creating and completing the upload take credentials.
    pub fn presign_upload_part(
        &self,
        key: &str,
        upload_id: &str,
        part_number: usize,
        expires_in: Duration,
    ) -> Result<PresignedRequest> {
        let part_number = part_number.to_string();
        let url = self.object_url(
            key,
            &[("partNumber", &part_number), ("uploadId", upload_id)],
        )?;
        self.presign_at(Method::PUT, url, HeaderMap::new(), expires_in, Utc::now())
    }

    /// Presign a request for `method` on `url` with `headers`, as signed at
    /// `date`.
    pub(crate) fn presign_at(
        &self,
        method: Method,
        url: reqwest::Url,
        headers: HeaderMap,
        expires_in: Duration,
        date: DateTime<Utc>,
    ) -> Result<PresignedRequest> {
        let config = self.config();
        let credentials = config
            .credentials
            .as_ref()
            .ok_or_else(|| Error::invalid("presigning a request takes credentials"))?;
        let seconds = expires_in.as_secs();
        if seconds == 0 || expires_in > MAX_PRESIGNED_EXPIRY {
            return Err(Error::invalid(format!(
                "a presigned request must expire in 1 second to 7 days, not {expires_in:?}",
            )));
        }

        let mut request = reqwest::Request::new(method, url);
        *request.headers_mut() = headers;
        sigv4::presign_request_at(
            &mut request,
            credentials,
            "s3",
            &config.region,
            seconds,
            date,
        );
        let headers = request
            .headers()
            .iter()
            .map(|(name, value)| {
                let value = String::from_utf8(value.as_bytes().to_vec())
                    .expect("header values this crate builds come from strings");
                (name.as_str().to_string(), value)
            })
            .collect();
        Ok(PresignedRequest {
            method: request.method().as_str().to_string(),
            url: request.url().to_string(),
            headers,
            expires_at: date + chrono::Duration::seconds(seconds as i64),
        })
    }
}

/// Sends [`PresignedRequest`]s, holding no credentials of its own.
///
/// Requests are retried and response bodies resumed as [`Client`] does,
/// until the signature expires. URLs in errors and logs leave out their
/// queries, where the signatures are. Cloning is cheap; clones share one
/// connection pool. Build one with
/// [`ClientBuilder::build_presigned`](crate::ClientBuilder::build_presigned).
#[derive(Debug, Clone)]
pub struct PresignedClient {
    transport: Transport,
}

impl PresignedClient {
    pub(crate) fn new(transport: Transport) -> Self {
        Self {
            transport: Transport {
                redact_queries: true,
                ..transport
            },
        }
    }

    pub(crate) fn transport(&self) -> &Transport {
        &self.transport
    }

    /// Send a presigned `GetObject`, honoring every [`GetObject`] field but
    /// the version, which only the signer can choose.
    ///
    /// The body resumes after a dropped connection or a short read, as
    /// [`Client::get_object`]'s does.
    pub async fn get_object(
        &self,
        request: &PresignedRequest,
        options: &GetObject,
    ) -> Result<GetObjectOutput> {
        let output = self.get_once(request, options).await?;
        let source = Source::Presigned {
            client: self.clone(),
            request: request.clone(),
        };
        Ok(resumable(source, output))
    }

    /// [`get_object`](Self::get_object) without resuming the body.
    pub(crate) async fn get_once(
        &self,
        request: &PresignedRequest,
        options: &GetObject,
    ) -> Result<GetObjectOutput> {
        if options.version.is_some() {
            return Err(Error::invalid(
                "a presigned GetObject reads the version it was signed for",
            ));
        }
        let mut http = self.build(request, Method::GET)?;
        let mut added = HeaderMap::new();
        apply_read_options(&mut added, options)?;
        for (name, value) in added {
            let name = name.expect("each header was inserted once");
            if http.headers().contains_key(&name) {
                return Err(Error::invalid(format!(
                    "{name} is fixed by the presigned request's signature",
                )));
            }
            http.headers_mut().insert(name, value);
        }

        let response = self.transport.send(http, false, |_| {}).await.result?;
        let label = request.display_url();
        read_output(
            &self.transport,
            &label,
            response,
            options.range.as_ref(),
            false,
        )
    }

    /// Send a presigned `PutObject` with `body`.
    ///
    /// A conditional write that fails its precondition reports
    /// [`ErrorKind::PreconditionFailed`](crate::ErrorKind::PreconditionFailed).
    /// Unlike [`Client::put_object`], this cannot reconcile a replay. When an
    /// attempt fails without knowing whether it took effect, and the retry
    /// then fails the precondition, the object may be this write's or
    /// another's. Without read access the holder cannot tell, so it reports
    /// the failure, and the signer can read the object to decide.
    pub async fn put_object(
        &self,
        request: &PresignedRequest,
        body: Bytes,
    ) -> Result<PutObjectOutput> {
        let mut http = self.build(request, Method::PUT)?;
        // S3 occasionally reports transient conflicts for concurrent
        // `If-Match` puts.
        let if_match = http.headers().contains_key(IF_MATCH);
        *http.body_mut() = Some(body.into());
        let response = self
            .transport
            .send(http, if_match, |_| {})
            .await
            .result
            .map_err(|error| write_error(error, if_match))?;
        Ok(put_output(response.headers()))
    }

    /// Send a presigned `UploadPart` with `body`, returning the part's ETag
    /// for the signer to complete the upload with.
    pub async fn upload_part(&self, request: &PresignedRequest, body: Bytes) -> Result<String> {
        let mut http = self.build(request, Method::PUT)?;
        *http.body_mut() = Some(body.into());
        let response = self.transport.send(http, false, |_| {}).await.result?;
        part_e_tag(&request.display_url(), &response)
    }

    /// The HTTP request for `request`, which must be for `method`.
    fn build(&self, request: &PresignedRequest, method: Method) -> Result<reqwest::Request> {
        if request.method != method.as_str() {
            return Err(Error::invalid(format!(
                "the presigned request is for {}, not {method}",
                request.method,
            )));
        }
        let url = reqwest::Url::parse(&request.url).map_err(|e| {
            Error::invalid_from(
                format!("invalid presigned URL {}", request.display_url()),
                e,
            )
        })?;
        let mut http = reqwest::Request::new(method, url);
        for (name, value) in &request.headers {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|e| Error::invalid_from(format!("invalid header name {name:?}"), e))?;
            let value = header_value(value)?;
            http.headers_mut().append(name, value);
        }
        Ok(http)
    }
}
