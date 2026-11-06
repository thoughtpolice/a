// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Presigned requests: S3 access for processes that hold no credentials.
//!
//! A process with credentials signs a request ahead of time with
//! [`Client::presign_get_object`], [`Client::presign_put_object`] or
//! [`Client::presign_upload_part`], and hands the [`PresignedRequest`] to
//! one without credentials, which sends it until it expires. The signature
//! covers the method, the object, the query and the headers named when
//! signing, and nothing else, so a presigned `GetObject` serves any range of
//! its object and a presigned `PutObject` takes any body.
//!
//! The query of a presigned URL grants access to its object to whoever
//! reads it, so [`PresignedRequest`]'s `Debug` output leaves it out.

use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::Method;
use reqwest::header::HeaderMap;

use crate::client::{Client, apply_attributes, apply_condition};
use crate::error::{Error, Result};
use crate::sigv4;
use crate::transport::redact_query;
use crate::types::PutObject;

/// The longest a presigned request can stay valid, which is what S3
/// accepts.
pub const MAX_PRESIGNED_EXPIRY: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// A request signed ahead of time, which anyone holding it can send until
/// it expires.
///
/// Every field is a plain string or time, so the request can travel in any
/// message format.
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
    /// conditions of [`GetObject`](crate::GetObject), but not choose a
    /// version.
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
