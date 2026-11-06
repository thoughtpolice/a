// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Sending requests: the connection pool and the retry policy.

use std::time::Duration;

use futures::{StreamExt as _, TryStreamExt as _};
use reqwest::{Response, StatusCode};

use crate::error::{Error, Result};
use crate::types::ByteStream;

/// How many response body bytes to preserve in error messages.
const ERROR_BODY_CAP: usize = 2048;

/// The HTTP client and how often to retry.
#[derive(Debug, Clone)]
pub(crate) struct Transport {
    pub http: reqwest::Client,
    /// Maximum request attempts (first try plus retries), at least 1.
    pub max_attempts: usize,
    /// Base delay for exponential retry backoff.
    pub retry_backoff: Duration,
    /// Leave query strings out of the URLs in errors and logs. A presigned
    /// request's query holds its signature, which grants access to whoever
    /// reads it until it expires.
    pub redact_queries: bool,
}

/// The outcome of [`Transport::send`].
pub(crate) struct Sent {
    pub result: Result<Response>,
    /// An attempt before the last failed in a way that may have taken
    /// effect on the server, so the last attempt may have been a replay.
    pub replayed_unknown: bool,
}

impl Transport {
    /// The delay before trying again after `failures` consecutive failures.
    pub(crate) fn backoff(&self, failures: usize) -> Duration {
        self.retry_backoff
            .saturating_mul(1u32 << failures.saturating_sub(1).min(16) as u32)
    }

    /// `url` as errors and logs show it.
    pub(crate) fn display_url(&self, url: &reqwest::Url) -> String {
        if self.redact_queries {
            redact_query(url.as_str())
        } else {
            url.to_string()
        }
    }

    /// The body of `response`, whose errors show its URL as errors and logs
    /// do.
    pub(crate) fn body(&self, response: Response) -> ByteStream {
        let url = self.display_url(response.url());
        let redact = self.redact_queries;
        response
            .bytes_stream()
            .map_err(move |source| Error::Body {
                url: url.clone(),
                source: display_error(source, redact),
            })
            .boxed()
    }

    /// Execute `request` with bounded retries, calling `prepare` on each
    /// attempt's copy first, which is where a request is signed with a
    /// fresh timestamp.
    ///
    /// Transport failures and retryable statuses (408, 429, 5xx, and 409 when
    /// `retry_on_conflict` is set) are retried with exponential backoff. Any
    /// remaining non-success status becomes [`Error::Status`].
    ///
    /// A 5xx status, or a transport error once the request may have reached
    /// the server, leaves the outcome unknown. S3 can apply a write and then
    /// fail to deliver its response. Replaying an idempotent request is
    /// harmless, but a replayed conditional write fails its own precondition
    /// and a replayed multipart completion finds its upload consumed. The
    /// result reports whether that may have happened, for callers of those
    /// requests to reconcile.
    pub(crate) async fn send(
        &self,
        request: reqwest::Request,
        retry_on_conflict: bool,
        prepare: impl Fn(&mut reqwest::Request),
    ) -> Sent {
        let url = self.display_url(request.url());
        let mut attempt = 0usize;
        let mut replayed_unknown = false;
        let result = loop {
            attempt += 1;
            let mut req = request
                .try_clone()
                .expect("S3 request bodies are buffered and cloneable");
            prepare(&mut req);

            match self.http.execute(req).await {
                Ok(response) => {
                    let status = response.status();
                    if status.is_success() {
                        break Ok(response);
                    }

                    let retryable = status.is_server_error()
                        || status == StatusCode::TOO_MANY_REQUESTS
                        || status == StatusCode::REQUEST_TIMEOUT
                        || (retry_on_conflict && status == StatusCode::CONFLICT);
                    if retryable && attempt < self.max_attempts {
                        tracing::debug!(%url, %status, attempt, "retrying S3 request");
                        replayed_unknown |= status.is_server_error();
                        tokio::time::sleep(self.backoff(attempt)).await;
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
                    let error = display_error(error, self.redact_queries);
                    if attempt < self.max_attempts && !error.is_builder() {
                        tracing::debug!(%url, %error, attempt, "retrying S3 request");
                        // A failed connection never carried the request.
                        replayed_unknown |= !error.is_connect();
                        tokio::time::sleep(self.backoff(attempt)).await;
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
}

/// `url` without its query, which a presigned URL's signature is in.
fn redact_query(url: &str) -> String {
    match url.split_once('?') {
        Some((base, _)) => format!("{base}?<redacted>"),
        None => url.to_string(),
    }
}

/// `error` as errors and logs show it: reqwest's errors carry the URL,
/// which `redact` leaves out.
fn display_error(error: reqwest::Error, redact: bool) -> reqwest::Error {
    if redact { error.without_url() } else { error }
}
