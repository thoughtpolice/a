// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! HTTP client for one repository's registry v2 API, built on
//! `egress-http`'s SSRF-guarded transport.
//!
//! Unlike `fetch_http::fetch_http_blob`, this client:
//!
//! - sets custom `Accept` and `Authorization` headers per request,
//! - answers the registry's `401` challenges itself, with a bearer token
//!   from the realm the challenge names (asked for with the configured
//!   credentials, if any) or with the credentials themselves for a `Basic`
//!   challenge, and again whenever a token expires partway through a fetch,
//! - hands back responses with their bodies still streaming, and never reads
//!   a redirect's body (registries put HTML in them, larger than some blobs),
//! - **strips `Authorization` on redirects to another origin** (the
//!   Docker-client convention for blob URLs that 307 to an S3/CloudFront
//!   backend), and answers no challenge but the registry's own.

use std::sync::Mutex;

use bytes::Bytes;
use dial9::Dial9TokioHandle;
use egress_http::Target;
use fetch_http::HttpFetchError;
use http_body_util::Empty;
use hyper::body::Incoming;
use hyper::header::HeaderValue;
use hyper::{HeaderMap, Request, Response, StatusCode};
use openssl::ssl::SslConnector;

use crate::credentials::Credentials;
use crate::{MAX_DOCUMENT_SIZE, OciFetchError, auth};

const USER_AGENT: &str = "cache-server/fetch-oci";

/// HTTP client for one repository on one registry. Holds the SSL
/// configuration, a telemetry handle, the credentials to answer challenges
/// with, and the `Authorization` the registry last asked for.
pub struct RegistryClient<'a> {
    ssl_connector: &'a SslConnector,
    handle: &'a Dial9TokioHandle,
    scheme: &'static str,
    registry: String,
    repository: String,
    credentials: Option<Credentials>,
    /// The `Authorization` header sent to the registry, once a challenge has
    /// asked for one.
    authorization: Mutex<Option<String>>,
}

impl<'a> RegistryClient<'a> {
    pub fn new(
        ssl_connector: &'a SslConnector,
        handle: &'a Dial9TokioHandle,
        scheme: &'static str,
        registry: &str,
        repository: &str,
        credentials: Option<Credentials>,
    ) -> Self {
        Self {
            ssl_connector,
            handle,
            scheme,
            registry: registry.to_string(),
            repository: repository.to_string(),
            credentials,
            authorization: Mutex::new(None),
        }
    }

    /// The URL of `kind` (`manifests` or `blobs`) `digest` in this
    /// repository.
    pub fn url(&self, kind: &str, digest: &str) -> String {
        format!(
            "{}://{}/v2/{}/{kind}/{digest}",
            self.scheme, self.registry, self.repository
        )
    }

    fn authorization(&self) -> Option<String> {
        self.authorization
            .lock()
            .expect("authorization lock never poisoned")
            .clone()
    }

    /// GET `url` from the registry, following redirects. A `401` from the
    /// registry itself is answered once (it may be a token that expired, or
    /// the first request of the fetch) and the request sent again; the
    /// response to that is returned, whatever its status.
    pub async fn get(&self, url: &str, accept: &str) -> Result<Response<Incoming>, OciFetchError> {
        let sent = self.authorization();
        let (response, at_registry) = self.get_following_redirects(url, accept, &sent).await?;
        if response.status() != StatusCode::UNAUTHORIZED || !at_registry {
            return Ok(response);
        }
        // Another request may have answered a challenge since this one was
        // sent; then its answer is the one to retry with.
        if self.authorization() == sent {
            self.authenticate(response.headers()).await?;
        }
        let retry = self.authorization();
        Ok(self.get_following_redirects(url, accept, &retry).await?.0)
    }

    /// Answer the challenge in a `401` response's headers, remembering the
    /// `Authorization` it calls for.
    async fn authenticate(&self, headers: &HeaderMap) -> Result<(), OciFetchError> {
        let header = headers
            .get(hyper::header::WWW_AUTHENTICATE)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| {
                OciFetchError::AuthChallengeMalformed(
                    "401 response missing WWW-Authenticate header".to_string(),
                )
            })?;

        let authorization = if auth::is_basic_challenge(header) {
            let credentials = self.credentials.as_ref().ok_or_else(|| {
                OciFetchError::UnsupportedAuth(format!(
                    "{} asks for Basic credentials, and none are configured for it",
                    self.registry
                ))
            })?;
            credentials.basic()
        } else {
            format!("Bearer {}", self.fetch_token(header).await?)
        };
        *self
            .authorization
            .lock()
            .expect("authorization lock never poisoned") = Some(authorization);
        Ok(())
    }

    /// Fetch a bearer token from the realm a `Bearer` challenge names,
    /// presenting the configured credentials, if any, with Basic auth.
    async fn fetch_token(&self, header: &str) -> Result<String, OciFetchError> {
        let mut challenge = auth::parse_bearer_challenge(header)?;
        // Some registries (e.g. ghcr.io) omit scope from the challenge. Fill
        // in a pull scope for the repository so the token endpoint issues a
        // usable token.
        if challenge.scope.is_none() {
            challenge.scope = Some(format!("repository:{}:pull", self.repository));
        }
        let token_url = auth::build_token_url(&challenge);
        let basic = match &self.credentials {
            Some(credentials) => {
                // The registry names the realm; credentials still travel
                // only over TLS, unless the registry itself is plain HTTP.
                if Target::parse(&token_url)?.scheme != "https" && self.scheme == "https" {
                    return Err(OciFetchError::UnsupportedAuth(format!(
                        "not sending credentials to a token realm over plain HTTP: {}",
                        challenge.realm
                    )));
                }
                Some(credentials.basic())
            }
            None => None,
        };

        let (response, _) = self
            .get_following_redirects(&token_url, "application/json", &basic)
            .await?;
        if !response.status().is_success() {
            return Err(OciFetchError::AuthTokenFetchFailed(format!(
                "token endpoint returned HTTP {}",
                response.status().as_u16()
            )));
        }
        let body = egress_http::collect_capped(response, MAX_DOCUMENT_SIZE).await?;
        auth::extract_token(&body)
    }

    /// GET `url`, following redirects, with `authorization` on every request
    /// to the URL's own origin and none elsewhere. Returns the final
    /// response and whether it came from that origin.
    async fn get_following_redirects(
        &self,
        url: &str,
        accept: &str,
        authorization: &Option<String>,
    ) -> Result<(Response<Incoming>, bool), OciFetchError> {
        let target = Target::parse(url)?;
        let origin = (target.scheme, target.host.clone(), target.port);
        let at_origin = |target: &Target| {
            (target.scheme, &target.host, target.port) == (origin.0, &origin.1, origin.2)
        };
        let request = |target: &Target| {
            let auth = authorization.as_deref().filter(|_| at_origin(target));
            request(accept, auth)
        };
        let (response, last) =
            fetch_http::get_following_redirects(self.ssl_connector, target, request, self.handle)
                .await?;
        let at_origin = at_origin(&last);
        Ok((response, at_origin))
    }
}

/// A GET accepting `accept`, with `authorization` if given.
fn request(
    accept: &str,
    authorization: Option<&str>,
) -> Result<Request<Empty<Bytes>>, HttpFetchError> {
    let mut builder = Request::builder()
        .header(hyper::header::USER_AGENT, USER_AGENT)
        .header(hyper::header::ACCEPT, accept);
    if let Some(value) = authorization {
        let value = HeaderValue::from_str(value).map_err(|e| {
            HttpFetchError::RequestFailed(format!("invalid Authorization value: {e}"))
        })?;
        builder = builder.header(hyper::header::AUTHORIZATION, value);
    }
    builder
        .body(Empty::<Bytes>::new())
        .map_err(|e| HttpFetchError::RequestFailed(format!("build request: {e}")))
}
